import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { SourceFile } from './types';

/**
 * Repository file discovery and language detection.
 *
 * Walks a checkout, skipping vendored/generated directories and anything that
 * is binary or unreasonably large. Everything downstream operates on the
 * SourceFile[] this produces, so scanners never touch the filesystem directly
 * and are trivially testable with synthetic inputs.
 */

/** Never analysed: dependencies, build output, VCS metadata, caches. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.idea',
  '.vscode',
  '.data',
]);

/** Skip lockfiles: huge, generated, and their deps come from the manifest. */
const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.wasm', '.class', '.jar',
  '.pyc', '.pyo', '.db', '.sqlite', '.sqlite3',
]);

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.java': 'java',
  '.php': 'php',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.sql': 'sql',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.env': 'dotenv',
};

const FILENAME_LANGUAGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  'docker-compose.yml': 'yaml',
  'docker-compose.yaml': 'yaml',
  makefile: 'makefile',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.production': 'dotenv',
};

/** 1 MB: beyond this a "source file" is almost certainly generated data. */
const MAX_FILE_BYTES = 1_000_000;

export function detectLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (FILENAME_LANGUAGE[base]) return FILENAME_LANGUAGE[base];
  if (base.startsWith('dockerfile')) return 'dockerfile';
  if (base.startsWith('.env')) return 'dotenv';
  const ext = path.extname(base);
  return EXTENSION_LANGUAGE[ext] ?? 'other';
}

/** Recognises the common test-file conventions across ecosystems. */
export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(normalized);
  if (/(^|[./-])(test|spec)[./-]/.test(base)) return true;
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base) || /_test\.(py|go|rb)$/.test(base)) return true;
  return /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/.test(normalized);
}

/** Heuristic binary check: a NUL byte in the first 8 KB. */
function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  return window.includes(0);
}

export interface DiscoverOptions {
  /** Hard cap so a pathological repository can't exhaust memory. */
  maxFiles?: number;
  maxFileBytes?: number;
}

/**
 * Recursively collects analysable files under rootDir.
 * Returned paths are repository-relative and POSIX-separated.
 */
export async function discoverFiles(rootDir: string, options: DiscoverOptions = {}): Promise<SourceFile[]> {
  const maxFiles = options.maxFiles ?? 5000;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const results: SourceFile[] = [];

  /*
   * The root is validated up front and hard-fails.
   *
   * Unreadable directories *inside* the tree are skipped so one bad permission
   * can't lose an entire scan — but that tolerance must not extend to the root.
   * A missing checkout, a failed clone or a bad path would otherwise walk zero
   * files and be reported as a completed scan with no findings and a perfect
   * health score. "We could not read your repository" and "your repository is
   * clean" must never look the same to a user.
   */
  try {
    const rootInfo = await stat(rootDir);
    if (!rootInfo.isDirectory()) {
      throw new Error(`Scan root is not a directory: ${rootDir}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Scan root is not a directory')) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Scan root is not readable: ${rootDir} (${reason})`);
  }

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) — skip, don't fail the scan
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maxFiles) return;
      const absolute = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks are not followed
      if (IGNORED_FILES.has(entry.name)) continue;
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const info = await stat(absolute);
        if (info.size > maxFileBytes) continue;

        const buffer = await readFile(absolute);
        if (looksBinary(buffer)) continue;

        const content = buffer.toString('utf8');
        const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
        const lines = content.split(/\r?\n/);

        results.push({
          path: relative,
          language: detectLanguage(relative),
          content,
          lines,
          loc: lines.filter((line) => line.trim().length > 0).length,
          bytes: info.size,
          isTest: isTestPath(relative),
          contentHash: createHash('sha256').update(content).digest('hex').slice(0, 32),
        });
      } catch {
        continue; // unreadable file — skip rather than abort the whole scan
      }
    }
  }

  await walk(rootDir);
  return results;
}

export interface RepositoryStats {
  fileCount: number;
  totalLoc: number;
  totalBytes: number;
  testFileCount: number;
  languages: Array<{ language: string; files: number; loc: number }>;
}

export function summarizeFiles(files: readonly SourceFile[]): RepositoryStats {
  const byLanguage = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;
  let totalBytes = 0;
  let testFileCount = 0;

  for (const file of files) {
    totalLoc += file.loc;
    totalBytes += file.bytes;
    if (file.isTest) testFileCount += 1;
    const entry = byLanguage.get(file.language) ?? { files: 0, loc: 0 };
    entry.files += 1;
    entry.loc += file.loc;
    byLanguage.set(file.language, entry);
  }

  return {
    fileCount: files.length,
    totalLoc,
    totalBytes,
    testFileCount,
    languages: [...byLanguage.entries()]
      .map(([language, v]) => ({ language, ...v }))
      .sort((a, b) => b.loc - a.loc),
  };
}

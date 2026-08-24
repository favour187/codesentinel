import { sha256 } from '@/lib/crypto';
import { summarizeFiles, type RepositoryStats } from '@/scanner/discovery';
import { OfflineAdvisoryProvider } from '@/scanner/providers/vulnerability-provider';
import type { Finding, ScanContext, SourceFile } from '@/scanner/types';

/** Builds an in-memory SourceFile so rule tests never touch the filesystem. */
export function sourceFile(path: string, content: string, overrides: Partial<SourceFile> = {}): SourceFile {
  const lines = content.split('\n');
  return {
    path,
    language: inferLanguage(path),
    content,
    lines,
    loc: lines.filter((line) => line.trim().length > 0).length,
    bytes: Buffer.byteLength(content, 'utf8'),
    isTest: /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path),
    contentHash: sha256(content),
    ...overrides,
  };
}

function inferLanguage(path: string): string {
  const lower = path.toLowerCase();
  if (/\.tsx?$/.test(lower)) return 'typescript';
  if (/\.jsx?$/.test(lower)) return 'javascript';
  if (/\.py$/.test(lower)) return 'python';
  if (lower.includes('dockerfile')) return 'dockerfile';
  if (/\.ya?ml$/.test(lower)) return 'yaml';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.md$/.test(lower)) return 'markdown';
  return 'other';
}

export function statsFor(files: readonly SourceFile[]): RepositoryStats {
  return summarizeFiles(files);
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function scanContext(files: SourceFile[], overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    repositoryId: 'test-repository',
    rootDir: '/repo',
    files,
    fileByPath: new Map(files.map((file) => [file.path, file])),
    logger: silentLogger,
    vulnerabilityProvider: new OfflineAdvisoryProvider(),
    ...overrides,
  };
}

/** Convenience: run a scanner over a single synthetic file. */
export async function scanSource(
  scanner: { scan(ctx: ScanContext): Promise<Finding[]> },
  path: string,
  content: string,
): Promise<Finding[]> {
  return scanner.scan(scanContext([sourceFile(path, content)]));
}

export function ruleIds(findings: readonly Finding[]): string[] {
  return findings.map((finding) => finding.ruleId);
}

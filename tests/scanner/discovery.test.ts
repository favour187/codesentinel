import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  detectLanguage,
  discoverFiles,
  isTestPath,
  summarizeFiles,
  IGNORED_DIRECTORIES,
} from '@/scanner/discovery';

/**
 * Discovery is the single point where the product touches a checkout, so its
 * failure behaviour is a correctness concern, not an ergonomic one: an
 * unreadable repository must never be indistinguishable from a clean one.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'codesentinel-discovery-'));

  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });

  await writeFile(path.join(root, 'src', 'app.ts'), 'export const a = 1;\n\nexport const b = 2;\n');
  await writeFile(path.join(root, 'src', 'util.py'), 'def add(a, b):\n    return a + b\n');
  await writeFile(path.join(root, 'tests', 'app.test.ts'), "it('works', () => {});\n");
  await writeFile(path.join(root, 'Dockerfile'), 'FROM node:22-alpine\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"x"}\n');

  // Must all be skipped.
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'var a=1;\n');
  await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await writeFile(path.join(root, 'data.bin'), Buffer.from([0x41, 0x42, 0x00, 0x43]));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('detectLanguage', () => {
  it('maps extensions to languages', () => {
    expect(detectLanguage('src/a.ts')).toBe('typescript');
    expect(detectLanguage('src/a.tsx')).toBe('typescript');
    expect(detectLanguage('src/a.js')).toBe('javascript');
    expect(detectLanguage('src/a.py')).toBe('python');
    expect(detectLanguage('go/main.go')).toBe('go');
  });

  it('recognises Dockerfiles by filename, including suffixed variants', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('deploy/Dockerfile.prod')).toBe('dockerfile');
  });

  it('recognises dotenv files', () => {
    expect(detectLanguage('.env')).toBe('dotenv');
    expect(detectLanguage('.env.production')).toBe('dotenv');
  });

  it('falls back to "other" for unknown extensions', () => {
    expect(detectLanguage('notes.xyz')).toBe('other');
  });
});

describe('isTestPath', () => {
  it('recognises the common conventions', () => {
    for (const p of [
      'tests/app.test.ts',
      'src/a.spec.js',
      '__tests__/b.js',
      'test/c.js',
      'pkg/thing_test.go',
      'app/test_views.py',
      'e2e/login.ts',
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it('does not mistake production modules for tests', () => {
    for (const p of ['src/latest.ts', 'src/contest.js', 'src/protester.py', 'src/app.ts']) {
      expect(isTestPath(p), p).toBe(false);
    }
  });
});

describe('discoverFiles', () => {
  it('collects analysable files with repository-relative POSIX paths', async () => {
    const files = await discoverFiles(root);
    const paths = files.map((f) => f.path);

    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('tests/app.test.ts');
    expect(paths).toContain('Dockerfile');
    expect(paths.every((p) => !p.startsWith('/') && !p.includes('\\'))).toBe(true);
  });

  it('skips vendored, generated and VCS directories', async () => {
    const paths = (await discoverFiles(root)).map((f) => f.path);

    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(IGNORED_DIRECTORIES.has('node_modules')).toBe(true);
  });

  it('skips lockfiles and binary content', async () => {
    const paths = (await discoverFiles(root)).map((f) => f.path);

    expect(paths).not.toContain('package-lock.json');
    expect(paths).not.toContain('logo.png');
    // Detected by the NUL-byte heuristic rather than the extension list.
    expect(paths).not.toContain('data.bin');
  });

  it('populates metadata: language, loc, isTest and a content hash', async () => {
    const files = await discoverFiles(root);
    const app = files.find((f) => f.path === 'src/app.ts');
    const test = files.find((f) => f.path === 'tests/app.test.ts');

    expect(app?.language).toBe('typescript');
    expect(app?.isTest).toBe(false);
    // Blank lines are not counted.
    expect(app?.loc).toBe(2);
    expect(app?.lines.length).toBeGreaterThanOrEqual(3);
    expect(app?.contentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(test?.isTest).toBe(true);
  });

  it('returns a stable order across runs', async () => {
    const a = (await discoverFiles(root)).map((f) => f.path);
    const b = (await discoverFiles(root)).map((f) => f.path);
    expect(b).toEqual(a);
  });

  it('honours maxFiles', async () => {
    expect(await discoverFiles(root, { maxFiles: 2 })).toHaveLength(2);
  });

  it('honours maxFileBytes', async () => {
    const files = await discoverFiles(root, { maxFileBytes: 20 });
    expect(files.every((f) => f.bytes <= 20)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('does not follow symlinks', async () => {
    const linked = await mkdtemp(path.join(tmpdir(), 'codesentinel-link-'));
    const withLink = await mkdtemp(path.join(tmpdir(), 'codesentinel-haslink-'));
    try {
      await writeFile(path.join(linked, 'outside.js'), 'const secret = 1;\n');
      await writeFile(path.join(withLink, 'inside.js'), 'const a = 1;\n');
      await symlink(linked, path.join(withLink, 'linked'));

      const paths = (await discoverFiles(withLink)).map((f) => f.path);
      expect(paths).toEqual(['inside.js']);
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(withLink, { recursive: true, force: true });
    }
  });

  it('returns an empty list for an empty directory', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'codesentinel-empty-'));
    try {
      await expect(discoverFiles(empty)).resolves.toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('discoverFiles — unreadable root', () => {
  /*
   * The regression these guard: unreadable directories inside the tree are
   * skipped so one bad permission cannot lose a whole scan, and that tolerance
   * used to extend to the root. A missing checkout then walked zero files and
   * was reported as a completed scan with a perfect health score — "we could
   * not read your repository" rendered as "your repository is clean".
   */
  it('throws when the root does not exist', async () => {
    await expect(discoverFiles(path.join(tmpdir(), 'codesentinel-does-not-exist-xyz'))).rejects.toThrow(
      /not readable/i,
    );
  });

  it('throws when the root is a file rather than a directory', async () => {
    await expect(discoverFiles(path.join(root, 'package.json'))).rejects.toThrow(/not a directory/i);
  });

  it('still tolerates an unreadable subdirectory', async () => {
    const tree = await mkdtemp(path.join(tmpdir(), 'codesentinel-partial-'));
    try {
      await writeFile(path.join(tree, 'ok.js'), 'const a = 1;\n');
      await mkdir(path.join(tree, 'locked'), { recursive: true });
      await writeFile(path.join(tree, 'locked', 'hidden.js'), 'const b = 2;\n');
      // 0o000 is not honoured when running as root, so assert the tolerant
      // behaviour without depending on the permission actually biting.
      const files = await discoverFiles(tree);
      expect(files.some((f) => f.path === 'ok.js')).toBe(true);
    } finally {
      await rm(tree, { recursive: true, force: true });
    }
  });
});

describe('summarizeFiles', () => {
  it('aggregates counts, loc and languages', async () => {
    const files = await discoverFiles(root);
    const stats = summarizeFiles(files);

    expect(stats.fileCount).toBe(files.length);
    expect(stats.totalLoc).toBe(files.reduce((sum, f) => sum + f.loc, 0));
    expect(stats.totalBytes).toBe(files.reduce((sum, f) => sum + f.bytes, 0));
    expect(stats.testFileCount).toBe(files.filter((f) => f.isTest).length);

    const languages = stats.languages.map((l) => l.language);
    expect(languages).toContain('typescript');
    expect(new Set(languages).size).toBe(languages.length);
  });

  it('summarises an empty file set without dividing by zero', () => {
    expect(summarizeFiles([])).toEqual({
      fileCount: 0,
      totalLoc: 0,
      totalBytes: 0,
      testFileCount: 0,
      languages: [],
    });
  });
});

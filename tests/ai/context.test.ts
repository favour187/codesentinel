import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commits } from '@/db/schema';
import {
  detectTestFramework,
  getFileHistory,
  getFileNeighbourhood,
  getFindingById,
  getFindingsForFile,
  getMemory,
  getRepositoryContext,
  getTestsCovering,
  latestScanId,
  renderExcerpt,
} from '@/ai/context';
import { createMemory } from '@/lib/memory-queries';
import { createTestDb, seedRepository, seedScan } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';

/**
 * Context retrieval is what makes AI answers grounded rather than plausible.
 * These tests hold it to that: it must return real rows from the latest scan,
 * and return nothing rather than something approximate.
 */

let db: TestDb;
let repositoryId: string;
let userId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

beforeEach(async () => {
  db = await createTestDb();
  ({ repositoryId, userId } = await seedRepository(db, { fullName: 'acme/webapp' }));
});

describe('latestScanId', () => {
  it('returns null when nothing has been scanned', async () => {
    expect(await latestScanId(repositoryId)).toBeNull();
  });

  it('returns the most recent completed scan', async () => {
    await seedScan(db, repositoryId, { files: [{ path: 'a.ts' }] });
    const second = await seedScan(db, repositoryId, { files: [{ path: 'b.ts' }] });

    expect(await latestScanId(repositoryId)).toBe(second.scanId);
  });

  it('ignores scans that are still running or failed', async () => {
    const good = await seedScan(db, repositoryId, { files: [{ path: 'a.ts' }] });
    await seedScan(db, repositoryId, { files: [{ path: 'b.ts' }], status: 'running' });
    await seedScan(db, repositoryId, { files: [{ path: 'c.ts' }], status: 'failed' });

    expect(await latestScanId(repositoryId)).toBe(good.scanId);
  });
});

describe('getRepositoryContext', () => {
  it('returns null for an unknown repository', async () => {
    expect(await getRepositoryContext('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('summarises the repository from its latest scan', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/a.ts', language: 'typescript', loc: 100 },
        { path: 'src/b.ts', language: 'typescript', loc: 50 },
        { path: 'src/c.py', language: 'python', loc: 30 },
      ],
      health: 72,
    });

    const context = await getRepositoryContext(repositoryId);

    expect(context?.fullName).toBe('acme/webapp');
    expect(context?.fileCount).toBe(3);
    expect(context?.totalLoc).toBe(180);
    expect(context?.languages).toContain('typescript');
    expect(context?.health).toBe(72);
  });

  it('detects frameworks from direct dependencies', async () => {
    await seedScan(db, repositoryId, {
      files: [{ path: 'src/a.tsx' }],
      dependencies: [
        { name: 'next', isDirect: true },
        { name: 'react', isDirect: true },
        { name: 'left-pad', isDirect: true },
      ],
    });

    const context = await getRepositoryContext(repositoryId);
    expect(context?.frameworks).toContain('Next.js');
  });

  it('reports an unscanned repository honestly rather than guessing', async () => {
    const context = await getRepositoryContext(repositoryId);

    expect(context?.scanId).toBeNull();
    expect(context?.fileCount).toBe(0);
    expect(context?.health).toBeNull();
  });
});

describe('getFileNeighbourhood', () => {
  beforeEach(async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/lib/db.ts', imports: [], loc: 90 },
        { path: 'src/services/user.ts', imports: ['src/lib/db.ts'] },
        { path: 'src/services/order.ts', imports: ['src/lib/db.ts'] },
      ],
    });
  });

  it('returns the file with its importers and imports', async () => {
    const hood = await getFileNeighbourhood(repositoryId, 'src/lib/db.ts');

    expect(hood.file?.path).toBe('src/lib/db.ts');
    expect(hood.file?.loc).toBe(90);
    expect(hood.dependents.map((d) => d.path).sort()).toEqual(['src/services/order.ts', 'src/services/user.ts']);
    expect(hood.imports).toEqual([]);
  });

  it('resolves what a file imports', async () => {
    const hood = await getFileNeighbourhood(repositoryId, 'src/services/user.ts');
    expect(hood.imports.map((f) => f.path)).toEqual(['src/lib/db.ts']);
  });

  it('returns an empty neighbourhood for an unknown file', async () => {
    const hood = await getFileNeighbourhood(repositoryId, 'src/nope.ts');

    expect(hood.file).toBeNull();
    expect(hood.dependents).toEqual([]);
  });
});

describe('getFindingsForFile', () => {
  it('returns open findings ordered by severity', async () => {
    await seedScan(db, repositoryId, {
      findings: [
        { filePath: 'src/a.ts', severity: 'low', title: 'low one' },
        { filePath: 'src/a.ts', severity: 'critical', title: 'critical one' },
        { filePath: 'src/a.ts', severity: 'medium', title: 'medium one' },
      ],
    });

    const found = await getFindingsForFile(repositoryId, 'src/a.ts');
    expect(found.map((f) => f.severity)).toEqual(['critical', 'medium', 'low']);
  });

  it('excludes resolved and ignored findings', async () => {
    await seedScan(db, repositoryId, {
      findings: [
        { filePath: 'src/a.ts', title: 'open one', status: 'open' },
        { filePath: 'src/a.ts', title: 'resolved one', status: 'resolved' },
        { filePath: 'src/a.ts', title: 'ignored one', status: 'ignored' },
        { filePath: 'src/a.ts', title: 'false positive', status: 'false_positive' },
      ],
    });

    const found = await getFindingsForFile(repositoryId, 'src/a.ts');
    expect(found.map((f) => f.title)).toEqual(['open one']);
  });

  it('returns nothing for a file with no findings', async () => {
    await seedScan(db, repositoryId, { findings: [{ filePath: 'src/a.ts' }] });
    expect(await getFindingsForFile(repositoryId, 'src/clean.ts')).toEqual([]);
  });
});

describe('getFindingById', () => {
  it('returns the full finding', async () => {
    const { findingIds } = await seedScan(db, repositoryId, {
      findings: [{ filePath: 'src/a.ts', title: 'SQLi', severity: 'critical', lineStart: 42 }],
    });

    const finding = await getFindingById(findingIds[0]!);

    expect(finding?.title).toBe('SQLi');
    expect(finding?.lineStart).toBe(42);
    expect(finding?.repositoryId).toBe(repositoryId);
  });

  it('returns null for an unknown id', async () => {
    expect(await getFindingById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('getTestsCovering / detectTestFramework', () => {
  it('finds tests that cover a file', async () => {
    await seedScan(db, repositoryId, {
      files: [{ path: 'src/user.ts' }],
      tests: [
        { filePath: 'tests/user.test.ts', coversPaths: ['src/user.ts'] },
        { filePath: 'tests/order.test.ts', coversPaths: ['src/order.ts'] },
      ],
    });

    expect(await getTestsCovering(repositoryId, 'src/user.ts')).toEqual(['tests/user.test.ts']);
  });

  it('detects the dominant framework', async () => {
    await seedScan(db, repositoryId, {
      tests: [
        { filePath: 'tests/a.test.ts', framework: 'vitest' },
        { filePath: 'tests/b.test.ts', framework: 'vitest' },
        { filePath: 'tests/c.test.js', framework: 'jest' },
      ],
    });

    expect(await detectTestFramework(repositoryId)).toBe('vitest');
  });

  it('returns null when no tests exist, rather than guessing a framework', async () => {
    await seedScan(db, repositoryId, { files: [{ path: 'src/a.ts' }] });
    expect(await detectTestFramework(repositoryId)).toBeNull();
  });
});

describe('getFileHistory', () => {
  async function insertCommit(sha: string, message: string, paths: string[], daysAgo: number) {
    await db.insert(commits).values({
      repositoryId,
      sha,
      message,
      authorName: 'Dev',
      authoredAt: new Date(Date.now() - daysAgo * 86_400_000),
      additions: 10,
      deletions: 2,
      changedFiles: paths.length,
      changedPaths: paths,
    });
  }

  it('returns commits touching the file, newest first', async () => {
    await insertCommit('aaa1111', 'add user service', ['src/user.ts'], 3);
    await insertCommit('bbb2222', 'fix user bug', ['src/user.ts', 'src/other.ts'], 1);
    await insertCommit('ccc3333', 'unrelated change', ['src/other.ts'], 2);

    const history = await getFileHistory(repositoryId, 'src/user.ts');

    expect(history.map((c) => c.sha)).toEqual(['bbb2222', 'aaa1111']);
    expect(history.every((c) => c.touchesPath)).toBe(true);
  });

  it('carries commit metadata through', async () => {
    await insertCommit('aaa1111', 'add user service', ['src/user.ts'], 1);

    const [entry] = await getFileHistory(repositoryId, 'src/user.ts');

    expect(entry?.message).toBe('add user service');
    expect(entry?.authorName).toBe('Dev');
    expect(entry?.additions).toBe(10);
    expect(entry?.authoredAt).toBeInstanceOf(Date);
  });

  it('falls back to repository history but marks it as not file-specific', async () => {
    await insertCommit('ccc3333', 'unrelated change', ['src/other.ts'], 1);

    const history = await getFileHistory(repositoryId, 'src/user.ts');

    expect(history).toHaveLength(1);
    // The flag is what stops the archaeologist claiming a link that isn't there.
    expect(history[0]?.touchesPath).toBe(false);
  });

  it('returns nothing when no history was recorded', async () => {
    expect(await getFileHistory(repositoryId, 'src/user.ts')).toEqual([]);
  });

  it('supports repository-wide history with no path', async () => {
    await insertCommit('aaa1111', 'first', ['a.ts'], 2);
    await insertCommit('bbb2222', 'second', ['b.ts'], 1);

    const history = await getFileHistory(repositoryId, null);
    expect(history.map((c) => c.sha)).toEqual(['bbb2222', 'aaa1111']);
  });
});

describe('getMemory', () => {
  it('returns unscoped facts for any path', async () => {
    await createMemory(repositoryId, userId, {
      kind: 'policy',
      title: 'No raw SQL',
      body: 'Always use the query builder.',
    });

    const forFile = await getMemory(repositoryId, ['src/anything.ts']);
    expect(forFile.map((m) => m.title)).toEqual(['No raw SQL']);
  });

  it('returns a scoped fact only for matching paths', async () => {
    await createMemory(repositoryId, userId, {
      kind: 'exception',
      title: 'Legacy adapter is intentional',
      body: 'This module predates the policy.',
      paths: ['src/legacy/'],
    });

    expect(await getMemory(repositoryId, ['src/legacy/adapter.ts'])).toHaveLength(1);
    expect(await getMemory(repositoryId, ['src/modern/service.ts'])).toHaveLength(0);
  });

  it('returns everything when no paths are given', async () => {
    await createMemory(repositoryId, userId, { kind: 'policy', title: 'A', body: 'x' });
    await createMemory(repositoryId, userId, { kind: 'decision', title: 'B', body: 'y', paths: ['src/x.ts'] });

    expect(await getMemory(repositoryId)).toHaveLength(2);
  });
});

describe('renderExcerpt', () => {
  const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

  it('windows around the focus line with line numbers', () => {
    const excerpt = renderExcerpt(content, 50, 5);

    expect(excerpt.firstLine).toBe(45);
    expect(excerpt.lastLine).toBe(55);
    expect(excerpt.text).toContain('50');
    expect(excerpt.text).toContain('line 50');
  });

  it('clamps at the start of the file', () => {
    const excerpt = renderExcerpt(content, 2, 10);
    expect(excerpt.firstLine).toBe(1);
  });

  it('clamps at the end of the file', () => {
    const excerpt = renderExcerpt(content, 98, 10);
    expect(excerpt.lastLine).toBe(100);
  });

  it('returns the whole file when there is no focus line', () => {
    const short = 'a\nb\nc';
    const excerpt = renderExcerpt(short, null);

    expect(excerpt.firstLine).toBe(1);
    expect(excerpt.lastLine).toBe(3);
  });
});

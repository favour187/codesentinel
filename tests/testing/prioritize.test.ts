import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prioritizeTests, scoreTestRelevance } from '@/testing/prioritize';
import * as schema from '@/db/schema';
import { createTestDb, seedRepository, seedScan } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';

let db: TestDb;
let repositoryId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

beforeEach(async () => {
  db = await createTestDb();
  ({ repositoryId } = await seedRepository(db));
});

describe('scoreTestRelevance', () => {
  const base = { nearestDepth: 1, directHits: 1, totalHits: 1, testCount: 1, hasAssertions: true };

  it('ranks a nearer test above a more distant one', () => {
    const near = scoreTestRelevance({ ...base, nearestDepth: 1 });
    const far = scoreTestRelevance({ ...base, nearestDepth: 3 });
    expect(near).toBeGreaterThan(far);
  });

  it('prefers breadth once distance ties', () => {
    const broad = scoreTestRelevance({ ...base, directHits: 4, totalHits: 4 });
    const narrow = scoreTestRelevance({ ...base, directHits: 1, totalHits: 1 });
    expect(broad).toBeGreaterThan(narrow);
  });

  it('caps a test with no assertions, however well connected', () => {
    const score = scoreTestRelevance({ nearestDepth: 1, directHits: 9, totalHits: 9, testCount: 30, hasAssertions: false });
    expect(score).toBeLessThanOrEqual(25);
  });

  it('still scores an assertion-less test above zero', () => {
    expect(scoreTestRelevance({ ...base, hasAssertions: false })).toBeGreaterThan(0);
  });

  it('stays within 0-100', () => {
    const max = scoreTestRelevance({ nearestDepth: 0, directHits: 50, totalHits: 50, testCount: 500, hasAssertions: true });
    expect(max).toBeLessThanOrEqual(100);
    expect(max).toBeGreaterThanOrEqual(0);
  });

  it('gives a test beyond the traversal horizon no score', () => {
    expect(
      scoreTestRelevance({ nearestDepth: 9, directHits: 0, totalHits: 0, testCount: 1, hasAssertions: true }),
    ).toBe(0);
  });
});

describe('prioritizeTests', () => {
  async function seedGraph() {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/auth/session.ts', loc: 100 },
        { path: 'src/auth/permissions.ts', loc: 60 },
        { path: 'src/unrelated.ts', loc: 30 },
        { path: 'tests/session.test.ts', loc: 50, kind: 'test' },
        { path: 'tests/permissions.test.ts', loc: 40, kind: 'test' },
        { path: 'tests/unrelated.test.ts', loc: 20, kind: 'test' },
        { path: 'tests/smoke.test.ts', loc: 10, kind: 'test' },
      ],
      tests: [
        { filePath: 'tests/session.test.ts', coversPaths: ['src/auth/session.ts'], testCount: 6 },
        { filePath: 'tests/permissions.test.ts', coversPaths: ['src/auth/permissions.ts'], testCount: 3 },
        { filePath: 'tests/unrelated.test.ts', coversPaths: ['src/unrelated.ts'], testCount: 2 },
        { filePath: 'tests/smoke.test.ts', coversPaths: [], testCount: 1 },
      ],
    });

    await db.insert(schema.codeEdges).values(
      [
        { type: 'imports' as const, fromKey: 'src/auth/permissions.ts', toKey: 'src/auth/session.ts' },
        { type: 'imports' as const, fromKey: 'tests/session.test.ts', toKey: 'src/auth/session.ts' },
        { type: 'imports' as const, fromKey: 'tests/permissions.test.ts', toKey: 'src/auth/permissions.ts' },
        { type: 'imports' as const, fromKey: 'tests/unrelated.test.ts', toKey: 'src/unrelated.ts' },
        { type: 'tests' as const, fromKey: 'tests/session.test.ts', toKey: 'src/auth/session.ts' },
        { type: 'tests' as const, fromKey: 'tests/permissions.test.ts', toKey: 'src/auth/permissions.ts' },
        { type: 'tests' as const, fromKey: 'tests/unrelated.test.ts', toKey: 'src/unrelated.ts' },
      ].map((e) => ({
        repositoryId,
        ...e,
        confidence: 'certain' as const,
        evidence: `${e.fromKey} -> ${e.toKey}`,
        lineNumber: 1,
      })),
    );
  }

  it('puts the directly covering test first', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts']);

    expect(ranked[0]?.testPath).toBe('tests/session.test.ts');
  });

  it('includes a transitively related test below the direct one', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts']);
    const paths = ranked.map((r) => r.testPath);

    expect(paths).toContain('tests/permissions.test.ts');
    expect(paths.indexOf('tests/session.test.ts')).toBeLessThan(paths.indexOf('tests/permissions.test.ts'));
  });

  it('omits tests with no path to the change', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts']);

    expect(ranked.map((r) => r.testPath)).not.toContain('tests/unrelated.test.ts');
    expect(ranked.map((r) => r.testPath)).not.toContain('tests/smoke.test.ts');
  });

  it('gives every recommendation a justification naming the change', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts']);

    expect(ranked.length).toBeGreaterThan(0);
    for (const entry of ranked) {
      expect(entry.justification.length).toBeGreaterThan(0);
    }
    expect(ranked[0]?.justification).toContain('src/auth/session.ts');
  });

  it('returns a descending score order', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts']);
    const scores = ranked.map((r) => r.score);

    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('honours the limit', async () => {
    await seedGraph();
    const ranked = await prioritizeTests(repositoryId, ['src/auth/session.ts'], { limit: 1 });
    expect(ranked).toHaveLength(1);
  });

  it('returns nothing when no files changed', async () => {
    await seedGraph();
    expect(await prioritizeTests(repositoryId, [])).toEqual([]);
  });

  it('returns nothing rather than failing on an unknown path', async () => {
    await seedGraph();
    expect(await prioritizeTests(repositoryId, ['src/ghost.ts'])).toEqual([]);
  });

  it('handles a repository that has never been indexed', async () => {
    expect(await prioritizeTests(repositoryId, ['src/auth/session.ts'])).toEqual([]);
  });
});

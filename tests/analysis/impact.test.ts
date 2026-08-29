import { beforeEach, describe, expect, it, vi } from 'vitest';

import { analyseImpact } from '@/analysis/impact';
import { previewChangeImpact } from '@/analysis/change-impact';
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

interface EdgeSeed {
  type: schema.EdgeType;
  fromKey: string;
  toKey: string;
  evidence?: string;
  confidence?: schema.EdgeConfidence;
}

async function seedEdges(edges: EdgeSeed[]): Promise<void> {
  await db.insert(schema.codeEdges).values(
    edges.map((e) => ({
      repositoryId,
      type: e.type,
      fromKey: e.fromKey,
      toKey: e.toKey,
      confidence: e.confidence ?? ('certain' as const),
      evidence: e.evidence ?? `${e.type} ${e.fromKey} -> ${e.toKey}`,
      lineNumber: 1,
    })),
  );
}

async function seedSymbol(filePath: string, name: string, extra: Partial<typeof schema.symbols.$inferInsert> = {}) {
  await db.insert(schema.symbols).values({
    repositoryId,
    filePath,
    name,
    kind: 'function',
    lineStart: 1,
    lineEnd: 10,
    isExported: true,
    isAsync: false,
    parameters: ['input'],
    parentName: null,
    complexity: 1,
    signature: `function ${name}(input)`,
    ...extra,
  });
}






async function seedGraph() {
  await seedScan(db, repositoryId, {
    files: [
      { path: 'src/lib/db.ts', loc: 80 },
      { path: 'src/services/user.ts', loc: 120 },
      { path: 'src/services/order.ts', loc: 90 },
      { path: 'src/routes/users.ts', loc: 60, kind: 'route' },
      { path: 'src/lib/unused.ts', loc: 20 },
      { path: 'tests/user.test.ts', loc: 40, kind: 'test' },
    ],
    tests: [{ filePath: 'tests/user.test.ts', coversPaths: ['src/services/user.ts'], testCount: 4 }],
  });

  await seedEdges([
    { type: 'imports', fromKey: 'src/services/user.ts', toKey: 'src/lib/db.ts', evidence: "imports './db'" },
    { type: 'imports', fromKey: 'src/services/order.ts', toKey: 'src/lib/db.ts', evidence: "imports './db'" },
    { type: 'imports', fromKey: 'src/routes/users.ts', toKey: 'src/services/user.ts' },
    { type: 'imports', fromKey: 'tests/user.test.ts', toKey: 'src/services/user.ts' },
    { type: 'tests', fromKey: 'tests/user.test.ts', toKey: 'src/services/user.ts' },
    { type: 'exposes_api', fromKey: 'src/routes/users.ts', toKey: 'api:GET /users' },
    { type: 'uses_database', fromKey: 'src/lib/db.ts', toKey: 'db:users' },
  ]);
}

describe('analyseImpact — file targets', () => {
  it('reports direct and indirect dependents at the right depth', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });

    expect(result.resolved).toBe(true);
    expect(result.directDependents.map((d) => d.path).sort()).toEqual([
      'src/services/order.ts',
      'src/services/user.ts',
    ]);
    expect(result.indirectDependents.map((d) => d.path).sort()).toEqual([
      'src/routes/users.ts',
      'tests/user.test.ts',
    ]);
    expect(result.indirectDependents.every((d) => d.depth === 2)).toBe(true);
  });

  it('attaches the stored evidence for each hop', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });

    const user = result.directDependents.find((d) => d.path === 'src/services/user.ts');
    expect(user?.evidence).toBe("imports './db'");
  });

  it('finds the API surface reachable from the change', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });

    expect(result.affectedRoutes.map((r) => r.route)).toEqual(['GET /users']);
    expect(result.affectedRoutes[0]?.direct).toBe(false);
  });

  it('marks a route on the changed file itself as direct', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/routes/users.ts' });

    expect(result.affectedRoutes[0]?.direct).toBe(true);
  });

  it('finds databases and tests in the radius', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });

    expect(result.affectedDatabases.map((d) => d.target)).toEqual(['users']);
    expect(result.affectedTests.map((t) => t.testPath)).toEqual(['tests/user.test.ts']);
  });

  it('lists files with no test edge as untested and excludes test files', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });

    expect(result.untestedFiles).toContain('src/lib/db.ts');
    expect(result.untestedFiles).toContain('src/services/order.ts');
    expect(result.untestedFiles).not.toContain('src/services/user.ts');
    expect(result.untestedFiles).not.toContain('tests/user.test.ts');
  });

  it('returns nothing for a file with no edges rather than guessing', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/unused.ts' });

    expect(result.resolved).toBe(true);
    expect(result.directDependents).toEqual([]);
    expect(result.indirectDependents).toEqual([]);
  });

  it('explains why an unknown path could not be analysed', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/nope.ts' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/no indexed file/i);
    expect(result.impactScore).toBe(0);
  });

  it('terminates on an import cycle', async () => {
    await seedScan(db, repositoryId, { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] });
    await seedEdges([
      { type: 'imports', fromKey: 'src/a.ts', toKey: 'src/b.ts' },
      { type: 'imports', fromKey: 'src/b.ts', toKey: 'src/a.ts' },
    ]);

    const result = await analyseImpact(repositoryId, { type: 'file', value: 'src/a.ts' });
    expect(result.directDependents.map((d) => d.path)).toEqual(['src/b.ts']);
  });

  it('scores a central file above an isolated one', async () => {
    await seedGraph();
    const central = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/db.ts' });
    const isolated = await analyseImpact(repositoryId, { type: 'file', value: 'src/lib/unused.ts' });

    expect(central.impactScore).toBeGreaterThan(isolated.impactScore);
  });
});

describe('analyseImpact — symbol targets', () => {
  it('resolves a symbol and lists its callers with evidence', async () => {
    await seedGraph();
    await seedSymbol('src/lib/db.ts', 'query');
    await seedEdges([
      {
        type: 'calls',
        fromKey: 'src/services/user.ts#findUser',
        toKey: 'src/lib/db.ts#query',
        evidence: 'query() at line 12',
      },
    ]);

    const result = await analyseImpact(repositoryId, { type: 'symbol', value: 'src/lib/db.ts#query' });

    expect(result.resolved).toBe(true);
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0]?.filePath).toBe('src/services/user.ts');
    expect(result.callers[0]?.evidence).toBe('query() at line 12');
    expect(result.originSymbols.map((s) => s.name)).toEqual(['query']);
  });

  it('rejects a symbol that is not indexed', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'symbol', value: 'src/lib/db.ts#ghost' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/no indexed symbol/i);
  });

  it('rejects a malformed symbol target', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'symbol', value: 'src/lib/db.ts' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/path#symbolName/);
  });
});

describe('analyseImpact — commit and pull request targets', () => {
  it('analyses every file a commit touched', async () => {
    await seedGraph();
    await db.insert(schema.commits).values({
      repositoryId,
      sha: 'a'.repeat(40),
      message: 'change db',
      changedPaths: ['src/lib/db.ts'],
      changedFiles: 1,
      authoredAt: new Date(),
    });

    const result = await analyseImpact(repositoryId, { type: 'commit', value: 'a'.repeat(40) });

    expect(result.resolved).toBe(true);
    expect(result.originFiles).toEqual(['src/lib/db.ts']);
    expect(result.directDependents.length).toBe(2);
  });

  it('reports an unknown commit instead of analysing nothing', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'commit', value: 'b'.repeat(40) });

    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/not in the recorded history/i);
  });

  it('resolves a pull request through its head commit', async () => {
    await seedGraph();
    const sha = 'c'.repeat(40);
    await db.insert(schema.commits).values({
      repositoryId,
      sha,
      changedPaths: ['src/services/user.ts'],
      changedFiles: 1,
      authoredAt: new Date(),
    });
    await db.insert(schema.pullRequests).values({ repositoryId, number: 7, title: 'x', headSha: sha });

    const result = await analyseImpact(repositoryId, { type: 'pull_request', value: '7' });

    expect(result.resolved).toBe(true);
    expect(result.originFiles).toEqual(['src/services/user.ts']);
    expect(result.affectedRoutes.map((r) => r.route)).toEqual(['GET /users']);
  });

  it('reports a pull request the guardian has not seen', async () => {
    await seedGraph();
    const result = await analyseImpact(repositoryId, { type: 'pull_request', value: '99' });

    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/has not been seen/i);
  });
});

describe('previewChangeImpact', () => {
  it('merges radii and keeps the nearest depth per file', async () => {
    await seedGraph();
    const preview = await previewChangeImpact(repositoryId, ['src/lib/db.ts', 'src/services/user.ts']);

    expect(preview.resolved).toBe(true);

    const route = preview.affectedFiles.find((f) => f.path === 'src/routes/users.ts');
    expect(route?.depth).toBe(1);
  });

  it('never lists a changed file as affected by itself', async () => {
    await seedGraph();
    const preview = await previewChangeImpact(repositoryId, ['src/lib/db.ts', 'src/services/user.ts']);

    expect(preview.affectedFiles.map((f) => f.path)).not.toContain('src/lib/db.ts');
    expect(preview.affectedFiles.map((f) => f.path)).not.toContain('src/services/user.ts');
  });

  it('raises risk factors that name their evidence', async () => {
    await seedGraph();
    const preview = await previewChangeImpact(repositoryId, ['src/lib/db.ts']);

    const api = preview.riskFactors.find((f) => f.label === 'Reaches the API surface');
    expect(api?.detail).toContain('GET /users');
  });

  it('recommends the test that covers the change', async () => {
    await seedGraph();
    const preview = await previewChangeImpact(repositoryId, ['src/services/user.ts']);

    expect(preview.recommendedTests.map((t) => t.testPath)).toEqual(['tests/user.test.ts']);
  });

  it('explains itself when nothing was supplied', async () => {
    const preview = await previewChangeImpact(repositoryId, []);
    expect(preview.resolved).toBe(false);
    expect(preview.reason).toMatch(/no changed files/i);
  });

  it('explains itself when the files are not in the latest scan', async () => {
    await seedGraph();
    const preview = await previewChangeImpact(repositoryId, ['src/brand/new.ts']);

    expect(preview.resolved).toBe(false);
    expect(preview.reason).toBeTruthy();
  });
});

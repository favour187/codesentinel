import { beforeEach, describe, expect, it, vi } from 'vitest';

import { detectTestGaps, gapSeverity, getTestIntelligence, scenariosFor } from '@/testing/gaps';
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

describe('gapSeverity', () => {
  const base = { complexity: 1, dependents: 0, exposesRoute: false, touchesDb: false, sensitive: false };

  it('rates an isolated trivial helper low', () => {
    expect(gapSeverity(base)).toBe('low');
  });

  it('rates a branchy widely-imported route handler high', () => {
    expect(gapSeverity({ ...base, complexity: 8, dependents: 4, exposesRoute: true })).toBe('high');
  });

  it('escalates a sensitive symbol above an equivalent ordinary one', () => {

    expect(gapSeverity({ ...base, complexity: 3 })).toBe('low');
    expect(gapSeverity({ ...base, complexity: 3, sensitive: true })).toBe('medium');
  });

  it('treats reaching an HTTP route as more serious than touching the database', () => {
    expect(gapSeverity({ ...base, exposesRoute: true })).toBe('medium');
    expect(gapSeverity({ ...base, touchesDb: true })).toBe('low');
  });
});

describe('scenariosFor', () => {
  const symbol = {
    name: 'transfer',
    kind: 'function' as const,
    parameters: ['from', 'to', 'amount'],
    complexity: 4,
    signature: 'function transfer(from, to, amount)',
  };

  it('always proposes the happy path first, citing the signature', () => {
    const [first] = scenariosFor(symbol);
    expect(first?.description).toContain('transfer');
    expect(first?.rationale).toContain('function transfer(from, to, amount)');
  });

  it('proposes an invalid-argument case grounded in the real parameters', () => {
    const scenarios = scenariosFor(symbol);
    const invalid = scenarios.find((s) => s.description.includes('missing or invalid'));
    expect(invalid?.rationale).toContain('from, to, amount');
  });

  it('does not invent an argument case for a zero-parameter symbol', () => {
    const scenarios = scenariosFor({ ...symbol, parameters: [] });
    expect(scenarios.some((s) => s.description.includes('missing or invalid'))).toBe(false);
  });

  it('adds an authorization scenario only for sensitive code', () => {
    const plain = scenariosFor(symbol);
    const sensitive = scenariosFor(symbol, { sensitive: true });
    const denies = (list: ReturnType<typeof scenariosFor>) => list.some((s) => s.description.includes('denies'));

    expect(denies(plain)).toBe(false);
    expect(denies(sensitive)).toBe(true);
  });

  it('gives every scenario a non-empty rationale', () => {
    for (const s of scenariosFor(symbol, { exposesRoute: true, touchesDb: true, sensitive: true })) {
      expect(s.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe('detectTestGaps', () => {
  async function seedRepo() {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/auth/session.ts', loc: 120, language: 'typescript' },
        { path: 'src/lib/covered.ts', loc: 60, language: 'typescript' },
        { path: 'README.md', loc: 40, language: 'markdown' },
        { path: 'tests/covered.test.ts', loc: 30, kind: 'test', language: 'typescript' },
      ],
      tests: [{ filePath: 'tests/covered.test.ts', coversPaths: ['src/lib/covered.ts'], testCount: 3 }],
    });

    await db.insert(schema.symbols).values([
      {
        repositoryId,
        filePath: 'src/auth/session.ts',
        name: 'createSession',
        kind: 'function',
        lineStart: 5,
        lineEnd: 25,
        isExported: true,
        isAsync: false,
        parameters: ['userId'],
        parentName: null,
        complexity: 5,
        signature: 'function createSession(userId)',
      },
      {
        repositoryId,
        filePath: 'src/auth/session.ts',
        name: 'internalHash',
        kind: 'function',
        lineStart: 30,
        lineEnd: 34,
        isExported: false,
        isAsync: false,
        parameters: ['value'],
        parentName: null,
        complexity: 1,
        signature: 'function internalHash(value)',
      },
      {
        repositoryId,
        filePath: 'src/auth/session.ts',
        name: 'SessionOptions',
        kind: 'interface',
        lineStart: 1,
        lineEnd: 4,
        isExported: true,
        isAsync: false,
        parameters: [],
        parentName: null,
        complexity: 0,
        signature: 'interface SessionOptions',
      },
      {
        repositoryId,
        filePath: 'src/lib/covered.ts',
        name: 'helper',
        kind: 'function',
        lineStart: 1,
        lineEnd: 10,
        isExported: true,
        isAsync: false,
        parameters: [],
        parentName: null,
        complexity: 1,
        signature: 'function helper()',
      },
    ]);

    await db.insert(schema.codeEdges).values(
      [
        { type: 'imports' as const, fromKey: 'tests/covered.test.ts', toKey: 'src/lib/covered.ts' },
        { type: 'tests' as const, fromKey: 'tests/covered.test.ts', toKey: 'src/lib/covered.ts' },
      ].map((e) => ({
        repositoryId,
        ...e,
        confidence: 'certain' as const,
        evidence: `${e.fromKey} -> ${e.toKey}`,
        lineNumber: 1,
      })),
    );
  }

  it('reports an exported symbol in an untested file', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId);

    expect(gaps.map((g) => g.symbolName)).toContain('createSession');
  });

  it('ignores files a test already covers', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId);

    expect(gaps.map((g) => g.filePath)).not.toContain('src/lib/covered.ts');
  });

  it('ignores unexported symbols — they are tested through their callers', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId);

    expect(gaps.map((g) => g.symbolName)).not.toContain('internalHash');
  });

  it('ignores types, which carry no runtime behaviour', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId);

    expect(gaps.map((g) => g.symbolName)).not.toContain('SessionOptions');
  });

  it('never demands tests for documentation', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId);

    expect(gaps.map((g) => g.filePath)).not.toContain('README.md');
  });

  it('grounds the reason in the file it is talking about', async () => {
    await seedRepo();
    const gap = (await detectTestGaps(repositoryId)).find((g) => g.symbolName === 'createSession');

    expect(gap?.reason).toContain('src/auth/session.ts');
    expect(gap?.scenarios.length).toBeGreaterThan(0);
  });

  it('escalates a sensitive path', async () => {
    await seedRepo();
    const gap = (await detectTestGaps(repositoryId)).find((g) => g.symbolName === 'createSession');



    expect(gap?.severity).toBe('medium');
  });

  it('can be scoped to changed files', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId, ['src/lib/covered.ts']);

    expect(gaps).toEqual([]);
  });

  it('honours the limit', async () => {
    await seedRepo();
    const gaps = await detectTestGaps(repositoryId, undefined, { limit: 1 });

    expect(gaps.length).toBeLessThanOrEqual(1);
  });

  it('returns nothing for a repository with no scan', async () => {
    expect(await detectTestGaps(repositoryId)).toEqual([]);
  });






  it('finds gaps in a CommonJS file whose exports come from module.exports', async () => {
    const { parseFile } = await import('@/twin/parsers');
    const parsed = parseFile(
      'src/auth/session.js',
      ['function createSession(userId) {', '  return { userId };', '}', '', 'module.exports = { createSession };'].join(
        '\n',
      ),
      'javascript',
    );

    const symbol = parsed.symbols.find((s) => s.name === 'createSession');
    expect(symbol?.isExported).toBe(true);
    expect(parsed.exports).toContain('createSession');
  });
});

describe('getTestIntelligence', () => {
  it('reports detected frameworks and honest linkage, never coverage', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/a.ts', language: 'typescript' },
        { path: 'src/b.ts', language: 'typescript' },
        { path: 'tests/a.test.ts', kind: 'test', language: 'typescript' },
      ],
      tests: [{ filePath: 'tests/a.test.ts', framework: 'vitest', coversPaths: ['src/a.ts'], testCount: 4 }],
    });
    await db.insert(schema.codeEdges).values({
      repositoryId,
      type: 'tests',
      fromKey: 'tests/a.test.ts',
      toKey: 'src/a.ts',
      confidence: 'certain',
      evidence: 'imports',
      lineNumber: 1,
    });

    const intel = await getTestIntelligence(repositoryId);

    expect(intel.frameworks).toContain('vitest');
    expect(intel.testFileCount).toBe(1);
    expect(intel.testCaseCount).toBe(4);
    expect(intel.coverageAvailable).toBe(false);
    expect(intel.sourceFileCount).toBe(2);
    expect(intel.untestedFiles).toEqual(['src/b.ts']);
    expect(intel.linkageRatio).toBeCloseTo(0.5, 5);
  });

  it('is empty and honest for a repository with no scan', async () => {
    const intel = await getTestIntelligence(repositoryId);

    expect(intel.testFileCount).toBe(0);
    expect(intel.linkageRatio).toBe(0);
    expect(intel.coverageAvailable).toBe(false);
  });
});

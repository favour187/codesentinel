import path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { codeEdges, indexState, symbols as symbolsTable } from '@/db/schema';
import { discoverFiles } from '@/scanner/discovery';
import type { SourceFile } from '@/scanner/types';

import { createTestDb, seedRepository, type TestDb } from '../helpers/test-db';

let db: TestDb;

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return { ...actual, getDb: async () => db };
});

const { indexRepository, buildFileEdges, symbolKey, packageKey, routeKey, databaseKey } = await import(
  '@/twin/indexer'
);

const FIXTURE_ROOT = path.join(process.cwd(), 'fixtures', 'demo-repo');

let repositoryId: string;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedRepository(db, { fullName: 'codesentinel/demo-repo' });
  repositoryId = seeded.repositoryId;
});

/** Build a SourceFile without touching disk. */
function sourceFile(overrides: Partial<SourceFile> & { path: string; content: string }): SourceFile {
  const content = overrides.content;
  const lines = content.split('\n');
  return {
    language: 'javascript',
    lines,
    loc: lines.filter((l) => l.trim().length > 0).length,
    bytes: Buffer.byteLength(content),
    isTest: /\.test\./.test(overrides.path),
    contentHash: `hash-${overrides.path}-${content.length}`,
    ...overrides,
  };
}

describe('indexRepository against the demo fixture', () => {
  it('indexes real files, symbols and edges', async () => {
    const files = await discoverFiles(FIXTURE_ROOT);
    const result = await indexRepository(repositoryId, files);

    expect(result.filesTotal).toBe(files.length);
    expect(result.filesParsed).toBe(files.length);
    expect(result.filesUnchanged).toBe(0);
    expect(result.symbolCount).toBeGreaterThan(10);
    expect(result.edgeCount).toBeGreaterThan(10);
    expect(result.parseErrors).toEqual([]);

    const stored = await db.select().from(symbolsTable).where(eq(symbolsTable.repositoryId, repositoryId));
    const authSymbols = stored.filter((s) => s.filePath === 'src/routes/auth.js').map((s) => s.name);
    expect(authSymbols).toEqual(expect.arrayContaining(['hashPassword', 'verifyToken', 'login']));
  });

  it('creates IMPORTS edges only between files that really exist', async () => {
    const files = await discoverFiles(FIXTURE_ROOT);
    await indexRepository(repositoryId, files);

    const imports = await db
      .select()
      .from(codeEdges)
      .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.type, 'imports')));

    expect(imports.length).toBeGreaterThan(0);
    const knownPaths = new Set(files.map((f) => f.path));
    for (const edge of imports) {
      expect(knownPaths.has(edge.fromKey)).toBe(true);
      expect(knownPaths.has(edge.toKey)).toBe(true);
      expect(edge.evidence).toBeTruthy();
    }

    // auth.js requires ../lib/config — a real file in the fixture.
    const authToConfig = imports.find(
      (e) => e.fromKey === 'src/routes/auth.js' && e.toKey === 'src/lib/config.js',
    );
    expect(authToConfig).toBeDefined();
    expect(authToConfig?.evidence).toContain('../lib/config');
  });

  it('records external packages as DEPENDS_ON, not as file imports', async () => {
    const files = await discoverFiles(FIXTURE_ROOT);
    await indexRepository(repositoryId, files);

    const deps = await db
      .select()
      .from(codeEdges)
      .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.type, 'depends_on')));

    const targets = deps.map((d) => d.toKey);
    expect(targets).toContain(packageKey('jsonwebtoken'));
    expect(targets).toContain(packageKey('crypto'));
    // A package must never appear as an IMPORTS target.
    const imports = await db
      .select()
      .from(codeEdges)
      .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.type, 'imports')));
    expect(imports.map((i) => i.toKey).some((k) => k.startsWith('pkg:'))).toBe(false);
  });

  it('maps test files to the sources they exercise', async () => {
    const files = await discoverFiles(FIXTURE_ROOT);
    await indexRepository(repositoryId, files);

    const testEdges = await db
      .select()
      .from(codeEdges)
      .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.type, 'tests')));

    expect(testEdges.length).toBeGreaterThan(0);
    for (const edge of testEdges) {
      expect(edge.fromKey).toMatch(/test/);
      expect(edge.toKey).not.toMatch(/\.test\./);
    }
  });

  it('every edge carries evidence', async () => {
    const files = await discoverFiles(FIXTURE_ROOT);
    await indexRepository(repositoryId, files);

    const all = await db.select().from(codeEdges).where(eq(codeEdges.repositoryId, repositoryId));
    expect(all.length).toBeGreaterThan(0);
    const withoutEvidence = all.filter((e) => !e.evidence || e.evidence.trim().length === 0);
    expect(withoutEvidence).toEqual([]);
  });
});

describe('incremental indexing', () => {
  const base: SourceFile[] = [
    sourceFile({ path: 'src/a.js', content: "const { b } = require('./b');\nfunction a() { return b(); }\nmodule.exports = { a };\n" }),
    sourceFile({ path: 'src/b.js', content: 'function b() { return 1; }\nmodule.exports = { b };\n' }),
    sourceFile({ path: 'src/c.js', content: 'function c() { return 2; }\nmodule.exports = { c };\n' }),
  ];

  it('reparses nothing when no content changed', async () => {
    await indexRepository(repositoryId, base);
    const second = await indexRepository(repositoryId, base);

    expect(second.filesParsed).toBe(0);
    expect(second.filesUnchanged).toBe(3);
    expect(second.symbolCount).toBeGreaterThan(0);
  });

  it('reparses only the file whose hash changed', async () => {
    await indexRepository(repositoryId, base);

    const modified = base.map((f) =>
      f.path === 'src/c.js'
        ? sourceFile({ path: 'src/c.js', content: 'function c() { return 3; }\nfunction extra() {}\nmodule.exports = { c, extra };\n' })
        : f,
    );

    const result = await indexRepository(repositoryId, modified);
    expect(result.filesParsed).toBe(1);
    expect(result.filesUnchanged).toBe(2);

    const cSymbols = await db
      .select()
      .from(symbolsTable)
      .where(and(eq(symbolsTable.repositoryId, repositoryId), eq(symbolsTable.filePath, 'src/c.js')));
    expect(cSymbols.map((s) => s.name).sort()).toEqual(['c', 'extra']);
  });

  it('does not disturb rows belonging to unchanged files', async () => {
    await indexRepository(repositoryId, base);
    const before = await db
      .select()
      .from(symbolsTable)
      .where(and(eq(symbolsTable.repositoryId, repositoryId), eq(symbolsTable.filePath, 'src/b.js')));

    const modified = base.map((f) =>
      f.path === 'src/a.js' ? sourceFile({ path: 'src/a.js', content: 'function a() { return 9; }\n' }) : f,
    );
    await indexRepository(repositoryId, modified);

    const after = await db
      .select()
      .from(symbolsTable)
      .where(and(eq(symbolsTable.repositoryId, repositoryId), eq(symbolsTable.filePath, 'src/b.js')));

    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('invalidates the cache when a file is deleted', async () => {
    await indexRepository(repositoryId, base);

    const remaining = base.filter((f) => f.path !== 'src/c.js');
    const result = await indexRepository(repositoryId, remaining);

    expect(result.filesRemoved).toBe(1);

    const cSymbols = await db
      .select()
      .from(symbolsTable)
      .where(and(eq(symbolsTable.repositoryId, repositoryId), eq(symbolsTable.filePath, 'src/c.js')));
    expect(cSymbols).toEqual([]);

    const ledger = await db
      .select()
      .from(indexState)
      .where(and(eq(indexState.repositoryId, repositoryId), eq(indexState.filePath, 'src/c.js')));
    expect(ledger).toEqual([]);
  });

  it('removes stale edges when an import is deleted from a file', async () => {
    await indexRepository(repositoryId, base);

    const importEdge = () =>
      db
        .select()
        .from(codeEdges)
        .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.fromKey, 'src/a.js'), eq(codeEdges.type, 'imports')));

    expect((await importEdge()).length).toBe(1);

    const modified = base.map((f) =>
      f.path === 'src/a.js' ? sourceFile({ path: 'src/a.js', content: 'function a() { return 0; }\n' }) : f,
    );
    await indexRepository(repositoryId, modified);

    expect(await importEdge()).toEqual([]);
  });

  it('force re-indexes everything when asked', async () => {
    await indexRepository(repositoryId, base);
    const forced = await indexRepository(repositoryId, base, { force: true });
    expect(forced.filesParsed).toBe(3);
    expect(forced.filesUnchanged).toBe(0);
  });

  it('records a content hash and parse cost per file', async () => {
    await indexRepository(repositoryId, base);
    const rows = await db.select().from(indexState).where(eq(indexState.repositoryId, repositoryId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.contentHash).toBeTruthy();
      expect(row.parseMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildFileEdges', () => {
  const knownPaths = new Set(['src/app.js', 'src/lib/db.js', 'src/routes/users.js']);
  const fileByPath = new Map<string, SourceFile>();

  it('records EXPOSES_API edges with the route literal as evidence', () => {
    const file = sourceFile({
      path: 'src/routes/users.js',
      content: "app.get('/users/:id', handler);",
    });
    const parsed = {
      path: file.path,
      language: 'javascript',
      symbols: [],
      imports: [],
      exports: [],
      routes: [{ method: 'GET', path: '/users/:id', line: 1, evidence: "app.get('/users/:id', …)" }],
      databaseUses: [],
      calls: [],
    };

    const edges = buildFileEdges(file, parsed, knownPaths, fileByPath);
    const api = edges.find((e) => e.type === 'exposes_api');
    expect(api?.toKey).toBe(routeKey('GET', '/users/:id'));
    expect(api?.evidence).toContain('/users/:id');
  });

  it('marks a client-import database edge as probable, a named table as certain', () => {
    const file = sourceFile({ path: 'src/lib/db.js', content: '' });
    const parsed = {
      path: file.path,
      language: 'javascript',
      symbols: [],
      imports: [],
      exports: [],
      routes: [],
      databaseUses: [
        { target: null, via: 'client' as const, line: 1, evidence: "imports 'pg'" },
        { target: 'accounts', via: 'sql' as const, line: 4, evidence: 'SELECT * FROM accounts' },
      ],
      calls: [],
    };

    const edges = buildFileEdges(file, parsed, knownPaths, fileByPath).filter((e) => e.type === 'uses_database');
    expect(edges.find((e) => e.toKey === databaseKey(null))?.confidence).toBe('probable');
    expect(edges.find((e) => e.toKey === databaseKey('accounts'))?.confidence).toBe('certain');
  });

  it('resolves a call to an imported function', () => {
    const file = sourceFile({
      path: 'src/app.js',
      content: "const { query } = require('./lib/db');",
    });
    const parsed = {
      path: file.path,
      language: 'javascript',
      symbols: [{ name: 'main', kind: 'function' as const, lineStart: 1, lineEnd: 5, isExported: true, isAsync: false, parameters: [], parentName: null, complexity: 0, signature: 'function main()' }],
      imports: [{ specifier: './lib/db', imported: ['query'], line: 1, isRelative: true }],
      exports: [],
      routes: [],
      databaseUses: [],
      calls: [{ callee: 'query', receiver: null, line: 3, enclosingSymbol: 'main' }],
    };

    const edges = buildFileEdges(file, parsed, knownPaths, fileByPath);
    const call = edges.find((e) => e.type === 'calls');
    expect(call?.fromKey).toBe(symbolKey('src/app.js', 'main'));
    expect(call?.toKey).toBe(symbolKey('src/lib/db.js', 'query'));
    expect(call?.confidence).toBe('certain');
  });

  it('drops calls that cannot be resolved rather than guessing', () => {
    const file = sourceFile({ path: 'src/app.js', content: '' });
    const parsed = {
      path: file.path,
      language: 'javascript',
      symbols: [],
      imports: [],
      exports: [],
      routes: [],
      databaseUses: [],
      calls: [
        { callee: 'mysteryHelper', receiver: null, line: 2, enclosingSymbol: null },
        { callee: 'log', receiver: 'console', line: 3, enclosingSymbol: null },
      ],
    };

    const edges = buildFileEdges(file, parsed, knownPaths, fileByPath).filter((e) => e.type === 'calls');
    expect(edges).toEqual([]);
  });

  it('does not create an import edge for an unresolvable relative path', () => {
    const file = sourceFile({ path: 'src/app.js', content: '' });
    const parsed = {
      path: file.path,
      language: 'javascript',
      symbols: [],
      imports: [{ specifier: './does-not-exist', imported: [], line: 1, isRelative: true }],
      exports: [],
      routes: [],
      databaseUses: [],
      calls: [],
    };

    const edges = buildFileEdges(file, parsed, knownPaths, fileByPath);
    expect(edges.filter((e) => e.type === 'imports')).toEqual([]);
    // …and it must not silently become a package dependency either.
    expect(edges.filter((e) => e.type === 'depends_on')).toEqual([]);
  });
});

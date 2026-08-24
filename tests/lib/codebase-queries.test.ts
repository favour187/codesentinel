import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDependencyInventory } from '@/lib/codebase-queries';
import { searchDocuments, type SearchDocument } from '@/lib/codebase-search';
import { createTestDb, seedRepository, seedScan, type TestDb } from '../helpers/test-db';

type DbGlobal = {
  __codesentinel_db?: unknown;
  __codesentinel_db_kind?: string;
  __codesentinel_db_ready?: Promise<void>;
};

const g = globalThis as unknown as DbGlobal;

let database: TestDb;
let repositoryId: string;
let previous: DbGlobal;

beforeEach(async () => {
  previous = {
    __codesentinel_db: g.__codesentinel_db,
    __codesentinel_db_kind: g.__codesentinel_db_kind,
    __codesentinel_db_ready: g.__codesentinel_db_ready,
  };

  database = await createTestDb();
  ({ repositoryId } = await seedRepository(database));

  g.__codesentinel_db = database;
  g.__codesentinel_db_kind = 'pglite';
  g.__codesentinel_db_ready = Promise.resolve();
});

afterEach(() => {
  g.__codesentinel_db = previous.__codesentinel_db;
  g.__codesentinel_db_kind = previous.__codesentinel_db_kind;
  g.__codesentinel_db_ready = previous.__codesentinel_db_ready;
});

describe('searchDocuments', () => {
  const docs: SearchDocument[] = [
    { kind: 'file', id: '1', title: 'src/auth/login.ts', subtitle: '', path: 'src/auth/login.ts', haystack: 'login authenticate' },
    { kind: 'symbol', id: '2', title: 'login', subtitle: '', path: 'src/auth/login.ts', haystack: 'export function login' },
    { kind: 'package', id: '3', title: 'express', subtitle: '', path: 'package.json', haystack: 'express npm' },
  ];

  it('returns nothing for an empty query instead of dumping the index', () => {
    expect(searchDocuments(docs, '   ')).toEqual([]);
  });

  it('ranks an exact title above a substring in another document', () => {
    const hits = searchDocuments(docs, 'login');
    expect(hits[0]?.title).toBe('login');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('does not invent hits that are not in the index', () => {
    expect(searchDocuments(docs, 'django')).toEqual([]);
  });
});

describe('getDependencyInventory', () => {
  it('returns zeros when no scan has completed', async () => {
    await expect(getDependencyInventory(repositoryId)).resolves.toMatchObject({
      total: 0,
      vulnerable: 0,
      packages: [],
    });
  });

  it('counts vulnerable packages from the latest completed scan only', async () => {
    await seedScan(database, repositoryId, {
      dependencies: [
        {
          name: 'lodash',
          version: '4.17.20',
          vulnerabilities: [{ id: 'GHSA-1', severity: 'high', summary: 'Prototype pollution' }],
        },
        { name: 'react', version: '18.2.0', vulnerabilities: [] },
      ],
    });

    const inventory = await getDependencyInventory(repositoryId);

    expect(inventory.total).toBe(2);
    expect(inventory.vulnerable).toBe(1);
    expect(inventory.packages[0]?.name).toBe('lodash');
  });

  it('ignores dependencies attached to an older completed scan', async () => {
    await seedScan(database, repositoryId, {
      dependencies: [{ name: 'old-pkg', version: '1.0.0' }],
    });
    await new Promise((r) => setTimeout(r, 5));
    await seedScan(database, repositoryId, {
      dependencies: [{ name: 'new-pkg', version: '2.0.0' }],
    });

    const inventory = await getDependencyInventory(repositoryId);
    expect(inventory.packages.map((p) => p.name)).toEqual(['new-pkg']);
  });
});

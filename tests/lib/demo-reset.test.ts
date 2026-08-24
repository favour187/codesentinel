import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDemoRepository } from '@/lib/demo/register';
import { createTestDb, seedRepository, seedScan, type TestDb } from '../helpers/test-db';
import * as schema from '@/db/schema';
import { eq } from 'drizzle-orm';

type DbGlobal = {
  __codesentinel_db?: unknown;
  __codesentinel_db_kind?: string;
  __codesentinel_db_ready?: Promise<void>;
};

const g = globalThis as unknown as DbGlobal;
let database: TestDb;
let previous: DbGlobal;

beforeEach(async () => {
  previous = {
    __codesentinel_db: g.__codesentinel_db,
    __codesentinel_db_kind: g.__codesentinel_db_kind,
    __codesentinel_db_ready: g.__codesentinel_db_ready,
  };
  database = await createTestDb();
  g.__codesentinel_db = database;
  g.__codesentinel_db_kind = 'pglite';
  g.__codesentinel_db_ready = Promise.resolve();
});

afterEach(() => {
  g.__codesentinel_db = previous.__codesentinel_db;
  g.__codesentinel_db_kind = previous.__codesentinel_db_kind;
  g.__codesentinel_db_ready = previous.__codesentinel_db_ready;
});

describe('resetDemoRepository', () => {
  it('refuses to reset a real GitHub repository', async () => {
    const { repositoryId } = await seedRepository(database, { source: 'github', fullName: 'acme/app' });
    await expect(resetDemoRepository(repositoryId)).rejects.toThrow(/only available for the bundled fixture/);
  });

  it('does not delete findings from another repository', async () => {
    const github = await seedRepository(database, { source: 'github', fullName: 'acme/app', githubId: 9 });
    await seedScan(database, github.repositoryId, {
      findings: [{ title: 'keep-me', status: 'open' }],
    });

    const demo = await seedRepository(database, {
      source: 'demo',
      fullName: 'codesentinel/demo-repo',
      login: 'demo',
      githubId: -2,
    });
    await seedScan(database, demo.repositoryId, {
      findings: [{ title: 'wipe-me', status: 'open' }],
    });

    await resetDemoRepository(demo.repositoryId);

    const leftover = await database
      .select()
      .from(schema.findings)
      .where(eq(schema.findings.repositoryId, github.repositoryId));
    expect(leftover.some((f) => f.title === 'keep-me')).toBe(true);
  });
});

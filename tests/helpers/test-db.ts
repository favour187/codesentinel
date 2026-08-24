import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { BOOTSTRAP_SQL, splitStatements } from '@/db/bootstrap';

/**
 * Creates a fresh, fully-migrated, in-memory PostgreSQL database per test.
 *
 * PGlite is real PostgreSQL (WASM), so these tests exercise the same SQL,
 * constraints and JSONB behaviour as production — not a mock.
 */
export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Every PGlite instance holds a WASM heap that is not reclaimed by GC. Left
 * open, a handful of per-test databases exhaust the worker and Vitest reports
 * "Worker exited unexpectedly" even though all assertions passed. The registry
 * lets the global afterEach hook in tests/setup.ts close them deterministically.
 */
const openClients = new Set<PGlite>();

export async function closeTestDbs(): Promise<void> {
  await Promise.all([...openClients].map((c) => c.close().catch(() => undefined)));
  openClients.clear();
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  openClients.add(client);
  const database = drizzle(client, { schema });

  // Reuse the production splitter rather than re-implementing it: a second
  // copy here is how the test harness and the real bootstrap drift apart.
  for (const statement of splitStatements(BOOTSTRAP_SQL)) {
    await database.execute(sql.raw(statement));
  }
  return database;
}

/** Insert a user + repository and return their ids. */
export async function seedRepository(
  database: TestDb,
  opts: { login?: string; githubId?: number; fullName?: string; source?: 'github' | 'demo' } = {},
) {
  const [user] = await database
    .insert(schema.users)
    .values({
      githubId: opts.githubId ?? 1001,
      login: opts.login ?? 'tester',
      name: 'Test User',
    })
    .returning();

  const fullName = opts.fullName ?? 'tester/example';
  const [owner, name] = fullName.split('/') as [string, string];

  const [repo] = await database
    .insert(schema.repositories)
    .values({
      source: opts.source ?? 'github',
      owner,
      name,
      fullName,
      ownerUserId: user!.id,
    })
    .returning();

  return { userId: user!.id, repositoryId: repo!.id };
}

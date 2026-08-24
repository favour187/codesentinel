import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

/**
 * Database access layer.
 *
 * CodeSentinel targets PostgreSQL. Two drivers, one schema, one query API:
 *
 *  - DATABASE_URL set  -> `postgres-js` against a real PostgreSQL server
 *                         (docker compose / Neon / Supabase / RDS).
 *  - DATABASE_URL unset -> PGlite, which is genuine PostgreSQL compiled to
 *                         WASM, persisted to ./.data/pglite. This makes
 *                         `npm run dev` work with zero infrastructure while
 *                         running the *same* SQL and migrations.
 *
 * Because both are Postgres, Drizzle queries and migrations are identical.
 */

const log = createLogger('db');

export type Database =
  | ReturnType<typeof drizzlePostgres<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

// Cache across HMR reloads in dev to avoid exhausting connections.
const globalForDb = globalThis as unknown as {
  __codesentinel_db?: Database;
  __codesentinel_db_kind?: 'postgres' | 'pglite';
  __codesentinel_db_ready?: Promise<void>;
};

export type DbKind = 'postgres' | 'pglite';

function createDatabase(): { db: Database; kind: DbKind } {
  const env = getEnv();
  const url = env.DATABASE_URL.trim();

  if (url) {
    const client = postgres(url, {
      // Render free is 512 MB — a 10-connection pool plus Next.js OOMs.
      max: env.DB_POOL_MAX ?? (env.NODE_ENV === 'production' ? 2 : 3),
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    log.info('Using PostgreSQL server', { host: safeHost(url) });
    return { db: drizzlePostgres(client, { schema }), kind: 'postgres' };
  }

  // Loaded through createRequire rather than a bare `require`: this package is
  // ESM ("type": "module"), so `require` is undefined outside the Next bundler
  // and `npm run db:migrate` (plain node/tsx) crashed with
  // "ReferenceError: require is not defined".
  // A synchronous load keeps getDb() synchronous, and the CJS entry is only
  // touched when no DATABASE_URL is configured, so production Postgres
  // deployments never pay for the WASM bundle.
  const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
  const dataDir = process.env.PGLITE_DATA_DIR ?? './.data/pglite';

  // PGlite calls mkdir non-recursively, so it fails if the parent directory is
  // absent (e.g. a fresh clone, or after `rm -rf .data`). Create it ourselves.
  mkdirSync(dataDir, { recursive: true });

  const client = new PGlite(dataDir);
  log.info('Using embedded PGlite database', { dataDir });
  return { db: drizzlePglite(client, { schema }), kind: 'pglite' };
}

export function getDb(): Database {
  if (!globalForDb.__codesentinel_db) {
    const { db, kind } = createDatabase();
    globalForDb.__codesentinel_db = db;
    globalForDb.__codesentinel_db_kind = kind;
  }
  return globalForDb.__codesentinel_db;
}

export function getDbKind(): DbKind {
  getDb();
  return globalForDb.__codesentinel_db_kind ?? 'pglite';
}

/**
 * Ensure the schema exists before the first query.
 * Runs the idempotent bootstrap DDL exactly once per process.
 */
export async function ensureSchema(): Promise<void> {
  if (!globalForDb.__codesentinel_db_ready) {
    globalForDb.__codesentinel_db_ready = (async () => {
      const { bootstrapSchema } = await import('./bootstrap');
      await bootstrapSchema(getDb());
    })().catch((err) => {
      globalForDb.__codesentinel_db_ready = undefined;
      throw err;
    });
  }
  return globalForDb.__codesentinel_db_ready;
}

/** Convenience: schema-guaranteed database handle. */
export async function db(): Promise<Database> {
  await ensureSchema();
  return getDb();
}

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return 'unknown';
  }
}

export { schema };
export * from './schema';

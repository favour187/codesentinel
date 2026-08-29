import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from './schema';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
















const log = createLogger('db');

export type Database =
  | ReturnType<typeof drizzlePostgres<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;


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

      max: env.DB_POOL_MAX ?? (env.NODE_ENV === 'production' ? 2 : 3),
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
    log.info('Using PostgreSQL server', { host: safeHost(url) });
    return { db: drizzlePostgres(client, { schema }), kind: 'postgres' };
  }








  const { PGlite } = createRequire(import.meta.url)('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
  const dataDir = process.env.PGLITE_DATA_DIR ?? './.data/pglite';



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

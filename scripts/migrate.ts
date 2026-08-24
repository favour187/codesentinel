/**
 * Applies the schema to the configured database.
 *
 *  - PostgreSQL (DATABASE_URL set): runs versioned drizzle-kit migrations from ./drizzle
 *  - PGlite (local dev):            applies the idempotent bootstrap DDL
 *
 * Usage: npm run db:migrate
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, getDbKind } from '../src/db/index';
import { bootstrapSchema, TABLE_NAMES } from '../src/db/bootstrap';

async function main(): Promise<void> {
  const kind = getDbKind();
  console.log(`[migrate] target database: ${kind}`);

  const db = await getDb();

  if (kind === 'postgres') {
    const migrationsFolder = path.join(process.cwd(), 'drizzle');
    if (!existsSync(migrationsFolder)) {
      console.warn('[migrate] no ./drizzle folder found — run `npm run db:generate` first.');
      console.warn('[migrate] falling back to bootstrap DDL.');
      await bootstrapSchema(db);
    } else {
      const { migrate } = await import('drizzle-orm/postgres-js/migrator');
      await migrate(db as any, { migrationsFolder });
      console.log('[migrate] drizzle migrations applied.');
    }
  } else {
    await bootstrapSchema(db);
    console.log('[migrate] bootstrap DDL applied.');
  }

  console.log(`[migrate] done — ${TABLE_NAMES.length} tables expected.`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });

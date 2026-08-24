import type { Config } from 'drizzle-kit';

/**
 * Production migrations only. Local development and tests use the idempotent
 * bootstrap DDL in src/db/bootstrap.ts (kept in sync by tests/db/schema-sync.test.ts).
 */
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/codesentinel',
  },
  strict: true,
  verbose: true,
} satisfies Config;

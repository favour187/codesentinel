import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, seedRepository } from '../helpers/test-db';
import { TABLE_NAMES } from '@/db/bootstrap';
import * as schema from '@/db/schema';
import { getTableName, getTableColumns } from 'drizzle-orm';






describe('database schema', () => {
  it('bootstrap DDL creates exactly the declared tables', async () => {
    const db = await createTestDb();
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    const rows = (Array.isArray(result) ? result : result.rows) as { table_name: string }[];
    const actual = rows.map((r) => r.table_name).sort();

    expect(actual).toEqual([...TABLE_NAMES].sort());
  });

  it('every Drizzle table in schema.ts exists in the bootstrap DDL', () => {
    const drizzleTables = Object.values(schema)
      .filter((v): v is never => typeof v === 'object' && v !== null && Symbol.for('drizzle:Name') in (v as object))
      .map((t) => getTableName(t));

    for (const name of drizzleTables) {
      expect(TABLE_NAMES, `table "${name}" is missing from bootstrap.ts`).toContain(name);
    }
    expect(drizzleTables.length).toBe(TABLE_NAMES.length);
  });

  it('every column declared in schema.ts exists in the bootstrapped database', async () => {
    const db = await createTestDb();
    const result = await db.execute<{ table_name: string; column_name: string }>(
      sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`,
    );
    const rows = (Array.isArray(result) ? result : result.rows) as {
      table_name: string;
      column_name: string;
    }[];

    const live = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

    const tables = Object.values(schema).filter(
      (v): v is never => typeof v === 'object' && v !== null && Symbol.for('drizzle:Name') in (v as object),
    );

    const missing: string[] = [];
    for (const table of tables) {
      const tableName = getTableName(table);
      const columns: Record<string, { name: string }> = getTableColumns(table);
      for (const column of Object.values(columns)) {
        const key = `${tableName}.${column.name}`;
        if (!live.has(key)) missing.push(key);
      }
    }

    expect(missing, `columns in schema.ts missing from bootstrap DDL: ${missing.join(', ')}`).toEqual([]);
  });

  it('enforces repository uniqueness on (fullName, source)', async () => {
    const db = await createTestDb();
    const { userId } = await seedRepository(db, { fullName: 'acme/app' });

    await expect(
      db.insert(schema.repositories).values({
        source: 'github',
        owner: 'acme',
        name: 'app',
        fullName: 'acme/app',
        ownerUserId: userId,
      }),
    ).rejects.toThrow();


    await expect(
      db.insert(schema.repositories).values({
        source: 'demo',
        owner: 'acme',
        name: 'app',
        fullName: 'acme/app',
        ownerUserId: userId,
      }),
    ).resolves.toBeDefined();
  });

  it('cascades deletes from repository to scans and findings', async () => {
    const db = await createTestDb();
    const { repositoryId } = await seedRepository(db);

    const [scan] = await db
      .insert(schema.scans)
      .values({ repositoryId, status: 'completed', trigger: 'manual' })
      .returning();

    await db.insert(schema.findings).values({
      repositoryId,
      scanId: scan!.id,
      ruleId: 'secrets/aws-key',
      severity: 'critical',
      category: 'secrets',
      title: 'Hardcoded AWS key',
      description: 'An AWS access key literal is committed to source control.',
      scannerId: 'secrets',
      filePath: 'src/config.js',
      fingerprint: 'abc123',
    });

    await db.delete(schema.repositories).where(sql`id = ${repositoryId}`);

    const remaining = await db.select().from(schema.findings);
    expect(remaining).toHaveLength(0);
  });
});

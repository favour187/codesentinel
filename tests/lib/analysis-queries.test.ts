import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedRepository, type TestDb } from '../helpers/test-db';
import * as schema from '@/db/schema';
import {
  getLatestSnapshot,
  getOpenFindings,
  getRecentScans,
  getSnapshotHistory,
  SEVERITY_ORDER,
} from '@/lib/analysis-queries';

/**
 * The read-side queries are what the dashboard renders. They run against the
 * process-wide `db()` handle, so each test installs a fresh PGlite database
 * into that cache. PGlite is real PostgreSQL, so ordering, JSONB and the
 * status filter behave exactly as they will in production.
 */

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
  // The bootstrap DDL already ran inside createTestDb; mark the schema ready so
  // db() does not try to re-bootstrap through a different handle.
  g.__codesentinel_db_ready = Promise.resolve();
});

afterEach(() => {
  g.__codesentinel_db = previous.__codesentinel_db;
  g.__codesentinel_db_kind = previous.__codesentinel_db_kind;
  g.__codesentinel_db_ready = previous.__codesentinel_db_ready;
});

async function createScan(overrides: Partial<typeof schema.scans.$inferInsert> = {}) {
  const [scan] = await database
    .insert(schema.scans)
    .values({ repositoryId, status: 'completed', trigger: 'manual', ...overrides })
    .returning();
  return scan!;
}

async function insertFinding(
  scanId: string,
  overrides: Partial<typeof schema.findings.$inferInsert> = {},
) {
  const [row] = await database
    .insert(schema.findings)
    .values({
      scanId,
      repositoryId,
      fingerprint: `fp-${Math.random().toString(36).slice(2)}`,
      ruleId: 'security/sql-injection',
      scannerId: 'security',
      severity: 'high',
      category: 'security',
      status: 'open',
      title: 'SQL injection',
      description: 'Concatenated query',
      filePath: 'src/a.js',
      lineStart: 10,
      confidence: 0.9,
      ...overrides,
    })
    .returning();
  return row!;
}

describe('getOpenFindings', () => {
  it('returns only open findings, excluding every retired status', async () => {
    const scan = await createScan();
    await insertFinding(scan.id, { status: 'open', title: 'Still open' });
    await insertFinding(scan.id, { status: 'superseded', title: 'Superseded' });
    await insertFinding(scan.id, { status: 'resolved', title: 'Resolved' });
    await insertFinding(scan.id, { status: 'ignored', title: 'Ignored' });
    await insertFinding(scan.id, { status: 'false_positive', title: 'False positive' });

    const rows = await getOpenFindings(repositoryId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Still open');
  });

  it('excludes superseded rows even when they far outnumber the open ones', async () => {
    // This is the realistic shape after several scans: persistence retires the
    // previous scan's rows as `superseded`, so the table is mostly history.
    const oldScan = await createScan();
    for (let i = 0; i < 40; i += 1) {
      await insertFinding(oldScan.id, { status: 'superseded', title: `old-${i}` });
    }

    const newScan = await createScan();
    await insertFinding(newScan.id, { status: 'open', title: 'current-a' });
    await insertFinding(newScan.id, { status: 'open', title: 'current-b' });

    const rows = await getOpenFindings(repositoryId);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.title).sort()).toEqual(['current-a', 'current-b']);
  });

  it('does not leak findings from another repository', async () => {
    const scan = await createScan();
    await insertFinding(scan.id, { title: 'mine' });

    const other = await seedRepository(database, {
      login: 'someone-else',
      githubId: 2002,
      fullName: 'someone-else/other',
    });
    const [otherScan] = await database
      .insert(schema.scans)
      .values({ repositoryId: other.repositoryId, status: 'completed', trigger: 'manual' })
      .returning();
    await database.insert(schema.findings).values({
      scanId: otherScan!.id,
      repositoryId: other.repositoryId,
      fingerprint: 'fp-other',
      ruleId: 'security/sql-injection',
      scannerId: 'security',
      severity: 'critical',
      category: 'security',
      status: 'open',
      title: 'theirs',
      description: 'x',
    });

    const rows = await getOpenFindings(repositoryId);

    expect(rows.map((r) => r.title)).toEqual(['mine']);
  });

  it('orders by severity, most severe first', async () => {
    const scan = await createScan();
    await insertFinding(scan.id, { severity: 'low', title: 'low' });
    await insertFinding(scan.id, { severity: 'critical', title: 'critical' });
    await insertFinding(scan.id, { severity: 'info', title: 'info' });
    await insertFinding(scan.id, { severity: 'medium', title: 'medium' });
    await insertFinding(scan.id, { severity: 'high', title: 'high' });

    const rows = await getOpenFindings(repositoryId);

    expect(rows.map((r) => r.severity)).toEqual(['critical', 'high', 'medium', 'low', 'info']);
  });

  it('keeps the most severe findings when more exist than the limit', async () => {
    // Severity ordering must be applied by the database, not only to the page
    // that happened to be fetched. Otherwise a critical finding that is older
    // than `limit` newer findings silently disappears from the dashboard.
    const scan = await createScan();
    await insertFinding(scan.id, { severity: 'critical', title: 'oldest-critical' });
    for (let i = 0; i < 20; i += 1) {
      await insertFinding(scan.id, { severity: 'info', title: `noise-${i}` });
    }

    const rows = await getOpenFindings(repositoryId, 5);

    expect(rows).toHaveLength(5);
    expect(rows[0]?.title).toBe('oldest-critical');
  });

  it('returns an empty list for a repository with no findings', async () => {
    await expect(getOpenFindings(repositoryId)).resolves.toEqual([]);
  });
});

describe('getRecentScans', () => {
  it('returns scans newest first and scoped to the repository', async () => {
    const first = await createScan({ trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await createScan({ trigger: 'push' });

    const rows = await getRecentScans(repositoryId);

    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('returns an empty list when nothing has been scanned', async () => {
    await expect(getRecentScans(repositoryId)).resolves.toEqual([]);
  });
});

describe('health snapshots', () => {
  async function snapshot(health: number) {
    const scan = await createScan();
    const [row] = await database
      .insert(schema.healthSnapshots)
      .values({
        repositoryId,
        scanId: scan.id,
        health,
        security: health,
        reliability: health,
        quality: health,
        testing: health,
        performance: health,
        counts: { critical: 1, high: 2, medium: 3, low: 4, info: 5 },
        issuesResolved: 2,
        issuesIntroduced: 1,
        debtHours: 12.5,
      })
      .returning();
    return row!;
  }

  it('getLatestSnapshot returns null before any scan has completed', async () => {
    await expect(getLatestSnapshot(repositoryId)).resolves.toBeNull();
  });

  it('getLatestSnapshot returns the newest snapshot with counts intact', async () => {
    await snapshot(40);
    await new Promise((r) => setTimeout(r, 5));
    await snapshot(72.5);

    const latest = await getLatestSnapshot(repositoryId);

    expect(latest?.health).toBeCloseTo(72.5, 3);
    expect(latest?.counts).toEqual({ critical: 1, high: 2, medium: 3, low: 4, info: 5 });
    expect(latest?.issuesResolved).toBe(2);
    expect(latest?.debtHours).toBeCloseTo(12.5, 3);
  });

  it('getSnapshotHistory respects the limit and returns an empty list when there is nothing', async () => {
    await expect(getSnapshotHistory(repositoryId)).resolves.toEqual([]);

    for (const value of [10, 20, 30]) {
      await snapshot(value);
      await new Promise((r) => setTimeout(r, 5));
    }

    const limited = await getSnapshotHistory(repositoryId, 2);
    expect(limited).toHaveLength(2);
  });
});

describe('SEVERITY_ORDER', () => {
  it('ranks critical highest and info lowest', () => {
    expect(SEVERITY_ORDER.critical).toBeLessThan(SEVERITY_ORDER.high);
    expect(SEVERITY_ORDER.high).toBeLessThan(SEVERITY_ORDER.medium);
    expect(SEVERITY_ORDER.medium).toBeLessThan(SEVERITY_ORDER.low);
    expect(SEVERITY_ORDER.low).toBeLessThan(SEVERITY_ORDER.info);
  });
});

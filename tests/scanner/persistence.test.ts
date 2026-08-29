import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import {
  classifyFile,
  complexityOf,
  executeScan,
  extractExports,
  fileRisk,
  openFingerprints,
} from '@/scanner/persistence';
import { createTestDb, seedRepository, type TestDb } from '../helpers/test-db';
import { sourceFile } from './helpers/source';













type DbGlobal = {
  __codesentinel_db?: unknown;
  __codesentinel_db_kind?: string;
  __codesentinel_db_ready?: Promise<void>;
};

const g = globalThis as unknown as DbGlobal;

let database: TestDb;
let repositoryId: string;
let repoDir: string;
let previous: DbGlobal;

const VULNERABLE_APP = [
  "const { exec } = require('child_process');",
  'function ping(req) {',
  "  exec('ping -c 1 ' + req.query.host);",
  '}',
  'module.exports = { ping };',
].join('\n');

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

  repoDir = await mkdtemp(path.join(tmpdir(), 'codesentinel-persist-'));
  await mkdir(path.join(repoDir, 'src'), { recursive: true });
  await writeFile(path.join(repoDir, 'src', 'app.js'), VULNERABLE_APP);
  await writeFile(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'fixture', dependencies: { lodash: '4.17.15' } }, null, 2),
  );
});

afterEach(async () => {
  g.__codesentinel_db = previous.__codesentinel_db;
  g.__codesentinel_db_kind = previous.__codesentinel_db_kind;
  g.__codesentinel_db_ready = previous.__codesentinel_db_ready;
  await rm(repoDir, { recursive: true, force: true });
});

function scan() {
  return executeScan({ repositoryId, rootDir: repoDir });
}

async function findingRows() {
  return database
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.repositoryId, repositoryId));
}

async function statusCounts(): Promise<Record<string, number>> {
  const rows = await findingRows();
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

describe('executeScan — first scan', () => {
  it('creates a completed scan row with file and line counts', async () => {
    const { scanId, result } = await scan();

    const [row] = await database.select().from(schema.scans).where(eq(schema.scans.id, scanId));

    expect(row?.status).toBe('completed');
    expect(row?.filesScanned).toBe(result.stats.fileCount);
    expect(row?.linesScanned).toBe(result.stats.totalLoc);
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.scannerRuns.length).toBeGreaterThan(0);
  });

  it('stores every finding as open and counts them all as introduced', async () => {
    const { result, introduced, resolved, previousHealth, healthDelta } = await scan();

    const rows = await findingRows();
    expect(rows).toHaveLength(result.findings.length);
    expect(rows.every((r) => r.status === 'open')).toBe(true);

    expect(introduced).toBe(result.findings.length);
    expect(resolved).toBe(0);

    expect(previousHealth).toBeNull();
    expect(healthDelta).toBeNull();
  });

  it('writes a health snapshot matching the computed scores', async () => {
    const { scanId, result, introduced } = await scan();

    const [snapshot] = await database
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.scanId, scanId));

    expect(snapshot?.health).toBeCloseTo(result.scores.health, 3);
    expect(snapshot?.security).toBeCloseTo(result.scores.security, 3);
    expect(snapshot?.counts).toEqual(result.severityCounts);
    expect(snapshot?.issuesIntroduced).toBe(introduced);
    expect(snapshot?.issuesResolved).toBe(0);
  });

  it('marks first-scan findings as new and records when they were first seen', async () => {
    await scan();
    const rows = await findingRows();

    for (const row of rows) {
      expect(row.metadata['isNew']).toBe(true);
      expect(typeof row.metadata['firstSeenAt']).toBe('string');
    }
  });

  it('touches the repository lastScanAt', async () => {
    await scan();
    const [repo] = await database
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId));

    expect(repo?.lastScanAt).toBeInstanceOf(Date);
  });
});

describe('executeScan — re-scan with no changes', () => {
  it('supersedes the previous rows instead of reporting them as fixed', async () => {
    const first = await scan();
    const second = await scan();

    expect(second.resolved).toBe(0);
    expect(second.introduced).toBe(0);

    const counts = await statusCounts();
    expect(counts['open']).toBe(second.result.findings.length);
    expect(counts['superseded']).toBe(first.result.findings.length);

    expect(counts['resolved']).toBeUndefined();
  });

  it('never sets resolvedAt on a superseded row', async () => {
    await scan();
    await scan();

    const superseded = (await findingRows()).filter((r) => r.status === 'superseded');

    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.every((r) => r.resolvedAt === null)).toBe(true);
  });

  it('keeps exactly one open row per fingerprint', async () => {
    await scan();
    await scan();
    await scan();

    const open = (await findingRows()).filter((r) => r.status === 'open');
    const fingerprints = open.map((r) => r.fingerprint);

    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('carries firstSeenAt forward so age is preserved across scans', async () => {
    await scan();
    const before = (await findingRows()).find((r) => r.status === 'open');
    const firstSeen = before?.metadata['firstSeenAt'];

    await scan();
    const after = (await findingRows()).find(
      (r) => r.status === 'open' && r.fingerprint === before?.fingerprint,
    );

    expect(after?.metadata['firstSeenAt']).toBe(firstSeen);
    expect(after?.metadata['isNew']).toBe(false);
  });

  it('reports a health delta once a previous snapshot exists', async () => {
    const first = await scan();
    const second = await scan();

    expect(second.previousHealth).toBeCloseTo(first.result.scores.health, 3);
    expect(second.healthDelta).toBeCloseTo(0, 3);
  });
});

describe('executeScan — fixing an issue', () => {
  it('marks a finding resolved with resolvedAt once it stops reproducing', async () => {
    await scan();


    await writeFile(
      path.join(repoDir, 'src', 'app.js'),
      [
        "const { execFile } = require('child_process');",
        'function ping(req) {',
        "  execFile('ping', ['-c', '1', req.query.host]);",
        '}',
        'module.exports = { ping };',
      ].join('\n'),
    );

    const second = await scan();

    expect(second.resolved).toBeGreaterThan(0);

    const resolved = (await findingRows()).filter((r) => r.status === 'resolved');
    expect(resolved.length).toBe(second.resolved);
    expect(resolved.every((r) => r.resolvedAt instanceof Date)).toBe(true);

    const [snapshot] = await database
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.scanId, second.scanId));
    expect(snapshot?.issuesResolved).toBe(second.resolved);
  });

  it('counts a newly introduced issue and leaves the existing ones alone', async () => {
    const first = await scan();

    await writeFile(
      path.join(repoDir, 'src', 'danger.js'),
      [
        "const { exec } = require('child_process');",
        'function trace(req) {',
        "  exec('traceroute ' + req.query.host);",
        '}',
        'module.exports = { trace };',
      ].join('\n'),
    );

    const second = await scan();

    expect(second.introduced).toBeGreaterThan(0);
    expect(second.resolved).toBe(0);
    expect(second.result.findings.length).toBeGreaterThan(first.result.findings.length);

    const [snapshot] = await database
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.scanId, second.scanId));
    expect(snapshot?.issuesIntroduced).toBe(second.introduced);
  });
});

describe('openFingerprints', () => {
  it('returns only the currently open fingerprints', async () => {
    const { result } = await scan();

    const open = await openFingerprints(repositoryId);
    expect(open.sort()).toEqual(result.findings.map((f) => f.fingerprint).sort());

    await scan();
    const afterRescan = await openFingerprints(repositoryId);


    expect(afterRescan.length).toBe(new Set(afterRescan).size);
  });

  it('returns an empty list for a repository that has never been scanned', async () => {
    await expect(openFingerprints(repositoryId)).resolves.toEqual([]);
  });
});

describe('repository intelligence', () => {
  it('records files, dependencies and tests for the newest scan only', async () => {
    await scan();
    const { scanId } = await scan();

    const files = await database
      .select()
      .from(schema.files)
      .where(eq(schema.files.repositoryId, repositoryId));
    const deps = await database
      .select()
      .from(schema.dependencies)
      .where(eq(schema.dependencies.repositoryId, repositoryId));

    expect(files.length).toBeGreaterThan(0);

    expect(files.every((f) => f.scanId === scanId)).toBe(true);
    expect(deps.every((d) => d.scanId === scanId)).toBe(true);
  });

  it('attaches known advisories to the dependency row', async () => {
    const { scanId } = await scan();

    const [lodash] = await database
      .select()
      .from(schema.dependencies)
      .where(and(eq(schema.dependencies.scanId, scanId), eq(schema.dependencies.name, 'lodash')));

    expect(lodash).toBeDefined();
    expect(lodash?.version).toBe('4.17.15');
    expect(lodash?.vulnerabilities.length).toBeGreaterThan(0);
  });

  it('keeps finding history while pruning the per-scan snapshot tables', async () => {
    await scan();
    await scan();

    const findings = await findingRows();
    const scanIds = new Set(findings.map((f) => f.scanId));



    expect(scanIds.size).toBe(2);
  });
});

describe('file classification helpers', () => {
  it('classifies files by role', () => {
    expect(classifyFile(sourceFile('tests/a.test.js', 'x'))).toBe('test');
    expect(classifyFile(sourceFile('Dockerfile', 'FROM node:22'))).toBe('infra');
    expect(classifyFile(sourceFile('config.json', '{}'))).toBe('config');
    expect(classifyFile(sourceFile('src/routes/admin.js', 'x'))).toBe('route');
    expect(classifyFile(sourceFile('src/components/Button.tsx', 'x'))).toBe('component');
    expect(classifyFile(sourceFile('src/services/user.js', 'x'))).toBe('service');
    expect(classifyFile(sourceFile('src/main.js', 'x'))).toBe('source');
  });

  it('extracts exported symbol names from both module systems', () => {
    const esm = sourceFile(
      'src/a.ts',
      'export function alpha() {}\nexport const beta = 1;\nexport class Gamma {}',
    );
    expect(extractExports(esm).sort()).toEqual(['Gamma', 'alpha', 'beta']);

    const cjs = sourceFile('src/b.js', 'function one() {}\nmodule.exports = { one, two: 2 };');
    expect(extractExports(cjs).sort()).toEqual(['one', 'two']);
  });

  it('returns no exports for a module that exports nothing', () => {
    expect(extractExports(sourceFile('src/c.js', 'const x = 1;\nconsole.log(x);'))).toEqual([]);
  });

  it('scores complexity above one only when branches exist', () => {
    expect(complexityOf(sourceFile('src/flat.js', 'const a = 1;\nconst b = 2;'))).toBe(1);
    expect(
      complexityOf(sourceFile('src/branchy.js', 'if (a) {}\nfor (;;) {}\nwhile (b) {}')),
    ).toBeGreaterThan(3);
  });

  it('scores risk in 0..1 and penalises untested modules', () => {
    const file = sourceFile('src/a.js', `${'if (a) { b(); }\n'.repeat(20)}`);

    const untested = fileRisk(file, 3, false);
    const covered = fileRisk(file, 3, true);

    expect(untested).toBeGreaterThan(covered);
    for (const score of [untested, covered]) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('never exceeds 1 even for a pathological file', () => {
    const file = sourceFile('src/awful.js', `${'if (a && b || c) { d(); }\n'.repeat(200)}`);
    expect(fileRisk(file, 500, false)).toBeLessThanOrEqual(1);
  });
});

describe('executeScan — failure handling', () => {
  it('marks the scan failed and records the error when scanning throws', async () => {
    await rm(repoDir, { recursive: true, force: true });

    await expect(executeScan({ repositoryId, rootDir: repoDir })).rejects.toThrow();

    const rows = await database
      .select()
      .from(schema.scans)
      .where(eq(schema.scans.repositoryId, repositoryId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toBeTruthy();
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
  });
});

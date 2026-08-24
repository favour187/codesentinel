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

export interface SeedFile {
  path: string;
  language?: string | null;
  loc?: number;
  imports?: string[];
  exports?: string[];
  kind?: string | null;
  complexity?: number;
  riskScore?: number;
}

export interface SeedFinding {
  ruleId?: string;
  scannerId?: string;
  severity?: schema.Severity;
  category?: schema.Category;
  status?: schema.FindingStatus;
  title?: string;
  description?: string;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  evidence?: string | null;
  confidence?: number;
  remediation?: string | null;
}

/**
 * Seed a completed scan with files, findings and tests.
 *
 * Retrieval, blast radius and debt all read from the *latest completed scan*,
 * so anything exercising them needs a realistic scan row rather than bare
 * findings. Returns the ids the caller needs to assert against.
 */
export async function seedScan(
  database: TestDb,
  repositoryId: string,
  opts: {
    files?: SeedFile[];
    findings?: SeedFinding[];
    tests?: Array<{ filePath: string; framework?: string; coversPaths?: string[]; testCount?: number }>;
    dependencies?: Array<{
      name: string;
      version?: string;
      isDirect?: boolean;
      isDev?: boolean;
      ecosystem?: string;
      vulnerabilities?: Array<Record<string, unknown>>;
      latestVersion?: string | null;
    }>;
    status?: schema.ScanStatus;
    health?: number;
  } = {},
) {
  const [scan] = await database
    .insert(schema.scans)
    .values({
      repositoryId,
      status: opts.status ?? 'completed',
      trigger: 'manual',
      filesScanned: opts.files?.length ?? 0,
      linesScanned: (opts.files ?? []).reduce((sum, f) => sum + (f.loc ?? 0), 0),
      finishedAt: new Date(),
    })
    .returning();

  const scanId = scan!.id;

  if (opts.files?.length) {
    await database.insert(schema.files).values(
      opts.files.map((f) => ({
        repositoryId,
        scanId,
        path: f.path,
        language: f.language === undefined ? 'typescript' : f.language,
        loc: f.loc ?? 50,
        bytes: (f.loc ?? 50) * 30,
        imports: f.imports ?? [],
        exports: f.exports ?? [],
        kind: f.kind ?? 'source',
        complexity: f.complexity ?? 5,
        riskScore: f.riskScore ?? 0,
      })),
    );
  }

  const findingIds: string[] = [];
  if (opts.findings?.length) {
    const rows = await database
      .insert(schema.findings)
      .values(
        opts.findings.map((f, i) => ({
          scanId,
          repositoryId,
          fingerprint: `fp-${i}-${f.ruleId ?? 'rule'}-${f.filePath ?? 'global'}`,
          ruleId: f.ruleId ?? 'security/sql-injection',
          scannerId: f.scannerId ?? 'security',
          severity: f.severity ?? ('critical' as schema.Severity),
          category: f.category ?? ('security' as schema.Category),
          status: f.status ?? ('open' as schema.FindingStatus),
          title: f.title ?? 'SQL injection via string concatenation',
          description: f.description ?? 'User input is concatenated directly into a SQL query.',
          filePath: f.filePath === undefined ? 'src/db/users.ts' : f.filePath,
          lineStart: f.lineStart === undefined ? 12 : f.lineStart,
          lineEnd: f.lineEnd === undefined ? 12 : f.lineEnd,
          evidence: f.evidence === undefined ? 'const q = "SELECT * FROM users WHERE id = " + id;' : f.evidence,
          confidence: f.confidence ?? 0.9,
          remediation: f.remediation === undefined ? 'Use a parameterised query.' : f.remediation,
        })),
      )
      .returning();

    findingIds.push(...rows.map((r) => r.id));
  }

  if (opts.tests?.length) {
    await database.insert(schema.tests).values(
      opts.tests.map((t) => ({
        repositoryId,
        scanId,
        filePath: t.filePath,
        framework: t.framework ?? 'vitest',
        testCount: t.testCount ?? 3,
        coversPaths: t.coversPaths ?? [],
        hasAssertions: true,
      })),
    );
  }

  if (opts.dependencies?.length) {
    await database.insert(schema.dependencies).values(
      opts.dependencies.map((d) => ({
        repositoryId,
        scanId,
        ecosystem: d.ecosystem ?? 'npm',
        name: d.name,
        version: d.version ?? '1.0.0',
        versionSpec: `^${d.version ?? '1.0.0'}`,
        isDev: d.isDev ?? false,
        isDirect: d.isDirect ?? true,
        manifestPath: 'package.json',
        vulnerabilities: (d.vulnerabilities ?? []) as never,
        latestVersion: d.latestVersion ?? null,
      })),
    );
  }

  if (opts.health !== undefined) {
    await database.insert(schema.healthSnapshots).values({
      repositoryId,
      scanId,
      health: opts.health,
      security: opts.health,
      reliability: opts.health,
      quality: opts.health,
      testing: opts.health,
      performance: opts.health,
    });
  }

  return { scanId, findingIds };
}

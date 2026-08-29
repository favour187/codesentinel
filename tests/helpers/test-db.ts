import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { BOOTSTRAP_SQL, splitStatements } from '@/db/bootstrap';







export type TestDb = ReturnType<typeof drizzle<typeof schema>>;












let shared: TestDb | null = null;
let sharedClient: PGlite | null = null;

let truncatable: string[] = [];

export async function closeTestDbs(): Promise<void> {

  if (!shared || truncatable.length === 0) return;
  await shared.execute(sql.raw(`TRUNCATE TABLE ${truncatable.join(', ')} RESTART IDENTITY CASCADE`));
}


export async function destroyTestDb(): Promise<void> {
  await sharedClient?.close().catch(() => undefined);
  shared = null;
  sharedClient = null;
  truncatable = [];
}

export async function createTestDb(): Promise<TestDb> {
  if (shared) return shared;

  const client = new PGlite();
  const database = drizzle(client, { schema });



  for (const statement of splitStatements(BOOTSTRAP_SQL)) {
    await database.execute(sql.raw(statement));
  }



  const rows = await database.execute<{ tablename: string }>(
    sql.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"),
  );
  truncatable = (rows.rows ?? []).map((r) => `"${r.tablename}"`);

  shared = database;
  sharedClient = client;
  return database;
}


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

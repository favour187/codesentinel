import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  commits,
  dependencies,
  files,
  findings,
  healthSnapshots,
  repositories,
  repositoryMemory,
  scans,
  tests,
} from '@/db/schema';
import type { Severity } from '@/db/schema';
import { createLogger } from '@/lib/logger';

/**
 * Repository-grounded context retrieval.
 *
 * The whole point of CodeSentinel's AI layer: answers come from what is
 * actually in this repository, retrieved from deterministic scan data, not
 * from what a model remembers about code in general.
 *
 * Two rules shape everything here:
 *  1. **Never send the whole repository.** Retrieval is targeted — the file in
 *     question, its immediate graph neighbours, the relevant findings.
 *  2. **Everything returned is citable.** Each piece carries the path, id or
 *     SHA it came from, so the UI can show its evidence and the activity log
 *     can record what grounded the answer.
 */

const log = createLogger('ai:context');

export interface FileContext {
  readonly path: string;
  readonly language: string | null;
  readonly loc: number;
  readonly kind: string | null;
  readonly complexity: number;
  readonly imports: readonly string[];
  readonly exports: readonly string[];
}

export interface FindingContext {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly filePath: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly description: string;
  readonly evidence: string | null;
  readonly scannerId: string;
  readonly category: string;
  readonly confidence: number;
  readonly remediation: string | null;
}

export interface MemoryFact {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly paths: readonly string[];
}

export interface RepositoryContext {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly scanId: string | null;
  readonly fileCount: number;
  readonly totalLoc: number;
  readonly health: number | null;
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly memory: readonly MemoryFact[];
}

/** The latest completed scan that owns the repository's live state. */
export async function latestScanId(repositoryId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.repositoryId, repositoryId), eq(scans.status, 'completed')))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getRepositoryContext(repositoryId: string): Promise<RepositoryContext | null> {
  const db = await getDb();

  const repoRows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const repo = repoRows[0];
  if (!repo) return null;

  const scanId = await latestScanId(repositoryId);

  const [stats] = scanId
    ? await db
        .select({
          fileCount: sql<number>`count(*)::int`,
          totalLoc: sql<number>`coalesce(sum(${files.loc}), 0)::int`,
        })
        .from(files)
        .where(eq(files.scanId, scanId))
    : [{ fileCount: 0, totalLoc: 0 }];

  const languageRows = scanId
    ? await db
        .select({ language: files.language, n: sql<number>`count(*)::int` })
        .from(files)
        .where(and(eq(files.scanId, scanId), ne(files.language, '')))
        .groupBy(files.language)
        .orderBy(desc(sql`count(*)`))
        .limit(6)
    : [];

  const snapshotRows = await db
    .select({ health: healthSnapshots.health })
    .from(healthSnapshots)
    .where(eq(healthSnapshots.repositoryId, repositoryId))
    .orderBy(desc(healthSnapshots.createdAt))
    .limit(1);

  // Direct dependencies double as the framework signal — far more reliable
  // than guessing a stack from file names.
  const frameworkRows = scanId
    ? await db
        .select({ name: dependencies.name })
        .from(dependencies)
        .where(and(eq(dependencies.scanId, scanId), eq(dependencies.isDirect, true)))
        .limit(40)
    : [];

  return {
    repositoryId,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    scanId,
    fileCount: stats?.fileCount ?? 0,
    totalLoc: stats?.totalLoc ?? 0,
    health: snapshotRows[0]?.health ?? null,
    languages: languageRows.map((r) => r.language).filter((l): l is string => Boolean(l)),
    frameworks: detectFrameworks(frameworkRows.map((r) => r.name)),
    memory: await getMemory(repositoryId),
  };
}

/** Human-authored facts about this repository. Authoritative context. */
export async function getMemory(repositoryId: string, paths?: readonly string[]): Promise<MemoryFact[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(repositoryMemory)
    .where(eq(repositoryMemory.repositoryId, repositoryId))
    .orderBy(desc(repositoryMemory.createdAt))
    .limit(50);

  const facts = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    paths: r.paths,
  }));

  if (!paths || paths.length === 0) return facts;

  /*
   * A fact scoped to specific paths only applies when one of those paths is in
   * play. Unscoped facts (repository-wide policies) always apply.
   */
  return facts.filter(
    (f) => f.paths.length === 0 || f.paths.some((p) => paths.some((q) => q === p || q.startsWith(`${p}/`))),
  );
}

/**
 * Files that matter for a given path: the file itself, what it imports, and
 * what imports it.
 *
 * This is the blast-radius graph and the chat retrieval set at once, because
 * "what else does this touch" is the same question in both features.
 */
export async function getFileNeighbourhood(
  repositoryId: string,
  path: string,
  limit = 25,
): Promise<{ file: FileContext | null; imports: FileContext[]; dependents: FileContext[] }> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return { file: null, imports: [], dependents: [] };

  const rows = await db.select().from(files).where(eq(files.scanId, scanId));

  const toContext = (r: (typeof rows)[number]): FileContext => ({
    path: r.path,
    language: r.language,
    loc: r.loc,
    kind: r.kind,
    complexity: r.complexity ?? 0,
    imports: r.imports,
    exports: r.exports,
  });

  const self = rows.find((r) => r.path === path);
  if (!self) return { file: null, imports: [], dependents: [] };

  const importPaths = new Set(self.imports);
  const imported = rows.filter((r) => importPaths.has(r.path)).slice(0, limit);
  const dependents = rows.filter((r) => r.imports.includes(path)).slice(0, limit);

  return {
    file: toContext(self),
    imports: imported.map(toContext),
    dependents: dependents.map(toContext),
  };
}

/** Findings for one file, most severe first. */
export async function getFindingsForFile(
  repositoryId: string,
  path: string,
  limit = 20,
): Promise<FindingContext[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.repositoryId, repositoryId),
        eq(findings.filePath, path),
        inArray(findings.status, ['open', 'proposed']),
      ),
    )
    .orderBy(SEVERITY_RANK, desc(findings.createdAt))
    .limit(limit);

  return rows.map(toFindingContext);
}

export async function getFindingById(findingId: string): Promise<
  (FindingContext & { repositoryId: string; whyItMatters: string | null; relatedTests: readonly string[] }) | null
> {
  const db = await getDb();
  const rows = await db.select().from(findings).where(eq(findings.id, findingId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    ...toFindingContext(row),
    repositoryId: row.repositoryId,
    whyItMatters: row.whyItMatters,
    relatedTests: row.relatedTests,
  };
}

/** Tests that appear to cover a path — used to recommend what to run. */
export async function getTestsCovering(repositoryId: string, path: string): Promise<string[]> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return [];

  const rows = await db.select().from(tests).where(eq(tests.scanId, scanId));
  return rows.filter((r) => r.coversPaths.includes(path)).map((r) => r.filePath);
}

/** The detected test framework, or null when the repository has no tests. */
export async function detectTestFramework(repositoryId: string): Promise<string | null> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return null;

  const rows = await db
    .select({ framework: tests.framework, n: sql<number>`count(*)::int` })
    .from(tests)
    .where(eq(tests.scanId, scanId))
    .groupBy(tests.framework)
    .orderBy(desc(sql`count(*)`))
    .limit(1);

  return rows[0]?.framework ?? null;
}

/** Commit history touching a path — the Code Archaeologist's evidence. */
export interface CommitContext {
  readonly sha: string;
  readonly message: string;
  readonly authorName: string | null;
  readonly authoredAt: Date | null;
  readonly additions: number;
  readonly deletions: number;
  /** True when this commit is known to touch the requested path. */
  readonly touchesPath: boolean;
}

export async function getFileHistory(
  repositoryId: string,
  path: string | null,
  limit = 20,
): Promise<CommitContext[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .orderBy(desc(commits.authoredAt))
    .limit(200);

  /*
   * Filter in application code: changed_paths is JSONB and the portable SQL for
   * "array contains" varies across the Postgres versions this runs on. 200 rows
   * is small enough that the simpler, definitely-correct path wins.
   */
  const toContext = (r: (typeof rows)[number], touchesPath: boolean): CommitContext => ({
    sha: r.sha,
    message: r.message ?? '',
    authorName: r.authorName,
    authoredAt: r.authoredAt,
    additions: r.additions ?? 0,
    deletions: r.deletions ?? 0,
    touchesPath,
  });

  if (!path) return rows.slice(0, limit).map((r) => toContext(r, false));

  const touching = rows.filter((r) => r.changedPaths.includes(path));
  if (touching.length > 0) return touching.slice(0, limit).map((r) => toContext(r, true));

  /*
   * No commit is recorded as touching this file. That is a real possibility
   * (history predates guardian, or paths were capped), so fall back to recent
   * repository history — but flag it, so the archaeologist can say the
   * evidence is repository-level rather than file-level instead of implying a
   * link that was never established.
   */
  return rows.slice(0, limit).map((r) => toContext(r, false));
}

/* -------------------------------------------------------------------------- */
/* Prompt rendering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Render a code excerpt with line numbers and a bounded window.
 *
 * Line numbers let the model refer to real locations instead of guessing, and
 * the window keeps a 4000-line file from consuming the whole context budget.
 */
export function renderExcerpt(
  content: string,
  focusLine: number | null,
  radius = 25,
): { text: string; firstLine: number; lastLine: number } {
  const lines = content.split('\n');
  const centre = focusLine ?? 1;
  const first = Math.max(1, centre - radius);
  const last = Math.min(lines.length, centre + radius);

  const body = lines
    .slice(first - 1, last)
    .map((line, i) => `${String(first + i).padStart(5)} | ${line}`)
    .join('\n');

  return { text: body, firstLine: first, lastLine: last };
}

/** Compact file list for a prompt. */
export function renderFileList(list: readonly FileContext[]): string {
  if (list.length === 0) return '(none)';
  return list
    .map((f) => `- ${f.path} (${f.language ?? 'unknown'}, ${f.loc} LOC, role: ${f.kind ?? 'unclassified'})`)
    .join('\n');
}

export function renderFindingList(list: readonly FindingContext[]): string {
  if (list.length === 0) return '(none)';
  return list
    .map(
      (f) =>
        `- [${f.severity.toUpperCase()}] ${f.title} (${f.ruleId}) at ${f.filePath ?? 'unknown'}:${f.lineStart ?? '?'}`,
    )
    .join('\n');
}

export function renderMemory(facts: readonly MemoryFact[]): string {
  if (facts.length === 0) return '(no recorded decisions)';
  return facts.map((f) => `- [${f.kind}] ${f.title}: ${f.body}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Order by real severity, not alphabetically. */
const SEVERITY_RANK = sql`
  case ${findings.severity}
    when 'critical' then 0
    when 'high' then 1
    when 'medium' then 2
    when 'low' then 3
    else 4
  end`;

function toFindingContext(row: typeof findings.$inferSelect): FindingContext {
  return {
    id: row.id,
    ruleId: row.ruleId,
    severity: row.severity,
    title: row.title,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    description: row.description,
    evidence: row.evidence,
    scannerId: row.scannerId,
    category: row.category,
    confidence: row.confidence,
    remediation: row.remediation,
  };
}

const FRAMEWORK_HINTS: Record<string, string> = {
  next: 'Next.js',
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  '@nestjs/core': 'NestJS',
  vitest: 'Vitest',
  jest: 'Jest',
  mocha: 'Mocha',
  drizzle_orm: 'Drizzle ORM',
  'drizzle-orm': 'Drizzle ORM',
  prisma: 'Prisma',
  typeorm: 'TypeORM',
  sequelize: 'Sequelize',
  mongoose: 'Mongoose',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  pytest: 'Pytest',
};

function detectFrameworks(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const hit = FRAMEWORK_HINTS[name.toLowerCase()];
    if (hit) found.add(hit);
  }
  return [...found].sort();
}

export { log as contextLog };

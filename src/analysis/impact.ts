import { and, desc, eq, inArray } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { commits, files, findings, pullRequests } from '@/db/schema';
import type { Severity } from '@/db/schema';
import { componentKeyOf } from '@/twin/components';
import { fileOfKey, TwinGraph } from '@/twin/graph';
import { loadSymbols } from '@/twin/graph';

/**
 * Blast Radius 2.0 — impact analysis over the Digital Twin.
 *
 * The v1 engine (`blast-radius.ts`) walked `files.imports`, which only knows
 * "file A imported file B". This one walks `code_edges`, so it can answer at
 * symbol granularity, attach the evidence that justified each hop, and reach
 * the API, database and test surfaces that the twin records separately.
 *
 * Design rules, unchanged from v1 and worth restating because everything here
 * depends on them:
 *
 *   - Deterministic. No model is consulted. AI may narrate a result afterwards.
 *   - Grounded. Every entry carries the stored evidence that produced it. If
 *     the graph does not justify a relationship, it is not reported.
 *   - Bounded. Traversal stops at a depth and a node cap, because an "impact"
 *     list containing the whole repository is not an answer.
 *
 * Scoring reuses `scoreImpact` from v1 deliberately: the bands are already
 * documented and tested, and changing the numbers underneath users mid-phase
 * would invalidate every score they have seen.
 */

import { impactBand, scoreImpact } from './blast-radius';

export type ImpactTargetType = 'file' | 'symbol' | 'commit' | 'pull_request';

export interface ImpactTarget {
  readonly type: ImpactTargetType;
  /** File path, `path#symbol`, commit SHA, or PR number as a string. */
  readonly value: string;
}

/** A file pulled into the radius, with the reason it was pulled in. */
export interface ImpactedFile {
  readonly path: string;
  /** 1 = imports the origin directly; 2+ = reached through another file. */
  readonly depth: number;
  /** The file one hop closer to the origin. */
  readonly via: string;
  /** The stored edge evidence for the hop that reached this file. */
  readonly evidence: string | null;
  readonly component: string;
  readonly loc: number;
  readonly kind: string | null;
  readonly isTested: boolean;
  readonly openFindings: number;
}

export interface ImpactedRoute {
  readonly route: string;
  readonly filePath: string;
  readonly evidence: string | null;
  /** True when the route's file is the origin rather than a dependent. */
  readonly direct: boolean;
}

export interface ImpactedTest {
  readonly testPath: string;
  readonly covers: string;
  readonly evidence: string | null;
  /** Tests covering the origin itself run first. */
  readonly direct: boolean;
}

export interface SensitiveArea {
  readonly label: string;
  readonly paths: readonly string[];
}

export interface HistoricalSignal {
  readonly kind: 'recurring_finding' | 'high_churn' | 'recent_failure';
  readonly detail: string;
  /** What in the record supports this — a count, a date, a SHA. */
  readonly evidence: string;
}

export interface ImpactAnalysis {
  readonly target: ImpactTarget;
  readonly resolved: boolean;
  /** Files the target actually consists of (1 for a file, N for a commit/PR). */
  readonly originFiles: readonly string[];
  /** Symbols in the origin, when the target is a symbol or a small change. */
  readonly originSymbols: ReadonlyArray<{ key: string; name: string; kind: string; signature: string | null }>;
  readonly directDependents: readonly ImpactedFile[];
  readonly indirectDependents: readonly ImpactedFile[];
  /** Direct callers of the target symbol. Empty for file-level targets. */
  readonly callers: ReadonlyArray<{ fromKey: string; filePath: string | null; evidence: string | null; line: number | null }>;
  readonly affectedRoutes: readonly ImpactedRoute[];
  readonly affectedDatabases: ReadonlyArray<{ target: string; filePath: string; evidence: string | null }>;
  readonly affectedComponents: ReadonlyArray<{ key: string; fileCount: number }>;
  readonly affectedTests: readonly ImpactedTest[];
  /** Files in the radius with no test covering them. */
  readonly untestedFiles: readonly string[];
  readonly sensitiveAreas: readonly SensitiveArea[];
  readonly openFindings: ReadonlyArray<{ id: string; title: string; severity: Severity; filePath: string | null }>;
  readonly history: readonly HistoricalSignal[];
  readonly impactScore: number;
  readonly impactLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Set when the traversal hit its cap — the true radius may be larger. */
  readonly truncated: boolean;
  /** Populated when `resolved` is false, so the UI can explain why. */
  readonly reason?: string;
}

const SENSITIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)(auth|authentication|authorization|session|login|oauth)/i, label: 'authentication' },
  { pattern: /(^|\/)(payment|billing|checkout|stripe|invoice)/i, label: 'payments' },
  { pattern: /(^|\/)(crypto|secret|token|credential|password)/i, label: 'secrets and cryptography' },
  { pattern: /(^|\/)(migration|migrations|schema)/i, label: 'database schema' },
  { pattern: /(^|\/)(middleware|guard|permission|rbac|acl)/i, label: 'access control' },
  { pattern: /(^|\/)(webhook|api|routes?)\//i, label: 'external interfaces' },
];

const MAX_NODES = 200;
const MAX_DEPTH = 3;

/**
 * Analyse the impact of changing a file, a symbol, a commit or a pull request.
 *
 * All four target types collapse to the same question — "given this set of
 * origin files, what else is involved" — so they share one traversal. What
 * differs is how the origin set is derived and, for symbols, that the caller
 * list is exact rather than file-level.
 */
export async function analyseImpact(repositoryId: string, target: ImpactTarget): Promise<ImpactAnalysis> {
  const db = await getDb();
  const graph = await TwinGraph.load(repositoryId);

  const origin = await resolveOrigin(repositoryId, target);
  if (!origin.ok) return emptyAnalysis(target, origin.reason);

  const originFiles = origin.files;
  const scanId = await latestScanId(repositoryId);

  const fileRows = scanId ? await db.select().from(files).where(eq(files.scanId, scanId)) : [];
  const byPath = new Map(fileRows.map((r) => [r.path, r]));

  /* ---------------- Traversal ---------------- */

  const reached = graph.reachableDependents(originFiles, { maxDepth: MAX_DEPTH, maxNodes: MAX_NODES });
  const truncated = reached.length >= MAX_NODES;

  const tested = graph.testedFiles();
  const affectedPaths = [...originFiles, ...reached.map((r) => r.path)];

  /* ---------------- Findings ---------------- */

  const findingRows =
    affectedPaths.length > 0
      ? await db
          .select({
            id: findings.id,
            title: findings.title,
            severity: findings.severity,
            filePath: findings.filePath,
          })
          .from(findings)
          .where(
            and(
              eq(findings.repositoryId, repositoryId),
              inArray(findings.filePath, affectedPaths.slice(0, 100)),
              inArray(findings.status, ['open', 'proposed']),
            ),
          )
      : [];

  const findingsByPath = new Map<string, number>();
  for (const f of findingRows) {
    if (!f.filePath) continue;
    findingsByPath.set(f.filePath, (findingsByPath.get(f.filePath) ?? 0) + 1);
  }

  const toImpacted = (r: { path: string; depth: number; via: string }): ImpactedFile => {
    const row = byPath.get(r.path);
    // The evidence for this hop is the edge from the dependent into `via`.
    const edge = graph
      .edgesFrom(r.path)
      .find((e) => (e.type === 'imports' || e.type === 'calls') && fileOfKey(e.toKey) === r.via);
    return {
      path: r.path,
      depth: r.depth,
      via: r.via,
      evidence: edge?.evidence ?? null,
      component: componentKeyOf(r.path),
      loc: row?.loc ?? 0,
      kind: row?.kind ?? null,
      isTested: tested.has(r.path),
      openFindings: findingsByPath.get(r.path) ?? 0,
    };
  };

  const directDependents = reached.filter((r) => r.depth === 1).map(toImpacted);
  const indirectDependents = reached.filter((r) => r.depth > 1).map(toImpacted);

  /* ---------------- Surfaces ---------------- */

  const originSet = new Set(originFiles);
  const affectedRoutes: ImpactedRoute[] = graph
    .routesOf(affectedPaths)
    .map((r) => ({ ...r, direct: originSet.has(r.filePath) }))
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.route.localeCompare(b.route));

  const affectedDatabases = graph.databasesOf(affectedPaths);

  const componentCounts = new Map<string, number>();
  for (const p of affectedPaths) {
    const key = componentKeyOf(p);
    componentCounts.set(key, (componentCounts.get(key) ?? 0) + 1);
  }
  const affectedComponents = [...componentCounts.entries()]
    .map(([key, fileCount]) => ({ key, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.key.localeCompare(b.key));

  const affectedTests: ImpactedTest[] = graph
    .testsCovering(affectedPaths)
    .map((t) => ({ ...t, direct: originSet.has(t.covers) }))
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.testPath.localeCompare(b.testPath));

  const untestedFiles = affectedPaths.filter((p) => !tested.has(p) && !isTestish(p)).sort();

  /* ---------------- Sensitivity ---------------- */

  const sensitiveAreas: SensitiveArea[] = SENSITIVE_PATTERNS.map(({ pattern, label }) => ({
    label,
    paths: affectedPaths.filter((p) => pattern.test(p)).sort(),
  })).filter((a) => a.paths.length > 0);

  /* ---------------- History ---------------- */

  const history = await historicalSignals(repositoryId, originFiles, findingRows);

  /* ---------------- Score ---------------- */

  const impactScore = scoreImpact({
    directDependents: directDependents.length,
    transitiveDependents: reached.length,
    routes: affectedRoutes.length,
    sensitiveAreas: sensitiveAreas.length,
    hasTests: affectedTests.length > 0,
    findingSeverities: findingRows.map((f) => f.severity),
  });

  /* ---------------- Origin symbols ---------------- */

  const originSymbols = origin.symbolKey
    ? (await loadSymbols(repositoryId, originFiles))
        .filter((s) => `${s.filePath}#${s.name}` === origin.symbolKey)
        .map((s) => ({ key: `${s.filePath}#${s.name}`, name: s.name, kind: s.kind, signature: s.signature }))
    : (await loadSymbols(repositoryId, originFiles))
        .filter((s) => s.isExported)
        .slice(0, 25)
        .map((s) => ({ key: `${s.filePath}#${s.name}`, name: s.name, kind: s.kind, signature: s.signature }));

  const callers = origin.symbolKey ? graph.callersOfSymbol(origin.symbolKey) : [];

  return {
    target,
    resolved: true,
    originFiles,
    originSymbols,
    directDependents,
    indirectDependents,
    callers,
    affectedRoutes,
    affectedDatabases,
    affectedComponents,
    affectedTests,
    untestedFiles,
    sensitiveAreas,
    openFindings: findingRows,
    history,
    impactScore,
    impactLevel: impactBand(impactScore),
    truncated,
  };
}

/* -------------------------------------------------------------------------- */
/* Origin resolution                                                          */
/* -------------------------------------------------------------------------- */

type OriginResult =
  | { ok: true; files: string[]; symbolKey?: string }
  | { ok: false; reason: string };

/**
 * Turn a target into the set of files it touches.
 *
 * A commit or PR resolves through stored git records, so an unindexed commit
 * reports "not found" rather than silently analysing nothing.
 */
async function resolveOrigin(repositoryId: string, target: ImpactTarget): Promise<OriginResult> {
  const db = await getDb();

  switch (target.type) {
    case 'file': {
      const known = await fileExists(repositoryId, target.value);
      return known
        ? { ok: true, files: [target.value] }
        : { ok: false, reason: `No indexed file at ${target.value}. Run a scan first.` };
    }

    case 'symbol': {
      const filePath = fileOfKey(target.value);
      if (!filePath || !target.value.includes('#')) {
        return { ok: false, reason: 'A symbol target must be written as path#symbolName.' };
      }
      const symbolName = target.value.slice(target.value.indexOf('#') + 1);
      const matches = await loadSymbols(repositoryId, [filePath]);
      if (!matches.some((s) => s.name === symbolName)) {
        return { ok: false, reason: `No indexed symbol named ${symbolName} in ${filePath}.` };
      }
      return { ok: true, files: [filePath], symbolKey: target.value };
    }

    case 'commit': {
      const [row] = await db
        .select({ changedPaths: commits.changedPaths, sha: commits.sha })
        .from(commits)
        .where(and(eq(commits.repositoryId, repositoryId), eq(commits.sha, target.value)))
        .limit(1);
      if (!row) return { ok: false, reason: `Commit ${target.value.slice(0, 8)} is not in the recorded history.` };
      if (row.changedPaths.length === 0) {
        return { ok: false, reason: `No changed paths recorded for commit ${row.sha.slice(0, 8)}.` };
      }
      return { ok: true, files: row.changedPaths };
    }

    case 'pull_request': {
      const number = Number.parseInt(target.value, 10);
      if (!Number.isFinite(number)) return { ok: false, reason: 'A pull request target must be a number.' };
      const [pr] = await db
        .select({ headSha: pullRequests.headSha, number: pullRequests.number })
        .from(pullRequests)
        .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.number, number)))
        .limit(1);
      if (!pr) return { ok: false, reason: `Pull request #${number} has not been seen by the guardian.` };
      if (!pr.headSha) return { ok: false, reason: `No head commit recorded for pull request #${number}.` };

      const [commit] = await db
        .select({ changedPaths: commits.changedPaths })
        .from(commits)
        .where(and(eq(commits.repositoryId, repositoryId), eq(commits.sha, pr.headSha)))
        .limit(1);
      if (!commit || commit.changedPaths.length === 0) {
        return { ok: false, reason: `No changed files recorded for pull request #${number}.` };
      }
      return { ok: true, files: commit.changedPaths };
    }
  }
}

async function fileExists(repositoryId: string, path: string): Promise<boolean> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return false;
  const [row] = await db
    .select({ path: files.path })
    .from(files)
    .where(and(eq(files.scanId, scanId), eq(files.path, path)))
    .limit(1);
  return Boolean(row);
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Historical signals for the origin files.
 *
 * These are facts drawn from stored records — how often a file changed, how
 * many findings it has accumulated — and the caller is expected to present
 * them as history rather than as prediction.
 */
async function historicalSignals(
  repositoryId: string,
  originFiles: readonly string[],
  currentFindings: ReadonlyArray<{ severity: Severity; filePath: string | null }>,
): Promise<HistoricalSignal[]> {
  const db = await getDb();
  const signals: HistoricalSignal[] = [];
  const originSet = new Set(originFiles);

  const commitRows = await db
    .select({ sha: commits.sha, changedPaths: commits.changedPaths, authoredAt: commits.authoredAt })
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .orderBy(desc(commits.authoredAt))
    .limit(500);

  const touching = commitRows.filter((c) => c.changedPaths.some((p) => originSet.has(p)));
  if (touching.length >= 5) {
    const newest = touching[0]?.authoredAt;
    signals.push({
      kind: 'high_churn',
      detail: `Changed in ${touching.length} of the last ${commitRows.length} recorded commits.`,
      evidence: newest
        ? `Most recent: ${touching[0]?.sha.slice(0, 8)} on ${newest.toISOString().slice(0, 10)}`
        : `Most recent: ${touching[0]?.sha.slice(0, 8)}`,
    });
  }

  const recurring = currentFindings.filter((f) => f.filePath && originSet.has(f.filePath));
  if (recurring.length >= 3) {
    signals.push({
      kind: 'recurring_finding',
      detail: `${recurring.length} open findings already sit in the changed files.`,
      evidence: `Severities: ${recurring.map((f) => f.severity).join(', ')}`,
    });
  }

  return signals;
}

function isTestish(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path);
}

function emptyAnalysis(target: ImpactTarget, reason: string): ImpactAnalysis {
  return {
    target,
    resolved: false,
    originFiles: [],
    originSymbols: [],
    directDependents: [],
    indirectDependents: [],
    callers: [],
    affectedRoutes: [],
    affectedDatabases: [],
    affectedComponents: [],
    affectedTests: [],
    untestedFiles: [],
    sensitiveAreas: [],
    openFindings: [],
    history: [],
    impactScore: 0,
    impactLevel: 'low',
    truncated: false,
    reason,
  };
}

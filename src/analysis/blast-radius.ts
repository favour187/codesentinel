import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { files, findings, tests } from '@/db/schema';
import type { Severity } from '@/db/schema';
import { latestScanId } from '@/ai/context';

/**
 * Blast radius: what else is affected if this file changes.
 *
 * Entirely deterministic. The import graph, the dependents, the covering tests
 * and the impact score are computed from scan data; AI is only ever asked to
 * explain the result in prose. That ordering matters — a model asked to guess
 * dependencies will confidently invent them, and a wrong blast radius is worse
 * than none because people act on it.
 */

export interface BlastRadiusNode {
  readonly path: string;
  readonly kind: string | null;
  readonly loc: number;
  /** Graph distance from the origin file: 1 = direct importer, 2 = indirect. */
  readonly depth: number;
}

export interface BlastRadius {
  readonly path: string;
  readonly exists: boolean;
  /** Files this file imports (what it depends on). */
  readonly dependencies: readonly BlastRadiusNode[];
  /** Files that import this file, transitively (what depends on it). */
  readonly dependents: readonly BlastRadiusNode[];
  readonly directDependentCount: number;
  readonly transitiveDependentCount: number;
  /** Routes/API surfaces reachable from the dependents. */
  readonly affectedRoutes: readonly string[];
  readonly affectedComponents: readonly string[];
  readonly relatedTests: readonly string[];
  /** Dependents that sit in security-sensitive areas. */
  readonly sensitiveAreas: readonly string[];
  readonly openFindings: number;
  /** 0-100. Documented in docs/ai-analysis.md. */
  readonly impactScore: number;
  readonly impactLevel: 'low' | 'medium' | 'high' | 'critical';
}

const SENSITIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)(auth|authentication|authorization|session|login|oauth)/i, label: 'authentication' },
  { pattern: /(^|\/)(payment|billing|checkout|stripe|invoice)/i, label: 'payments' },
  { pattern: /(^|\/)(crypto|secret|token|credential|password)/i, label: 'secrets and cryptography' },
  { pattern: /(^|\/)(migration|migrations|schema)/i, label: 'database schema' },
  { pattern: /(^|\/)(middleware|guard|permission|rbac|acl)/i, label: 'access control' },
  { pattern: /(^|\/)(webhook|api)\//i, label: 'external interfaces' },
];

/** Cap traversal so a hub file (a shared util) cannot pull in the whole repo. */
const MAX_NODES = 200;
const MAX_DEPTH = 3;

export async function computeBlastRadius(repositoryId: string, path: string): Promise<BlastRadius> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);

  const empty: BlastRadius = {
    path,
    exists: false,
    dependencies: [],
    dependents: [],
    directDependentCount: 0,
    transitiveDependentCount: 0,
    affectedRoutes: [],
    affectedComponents: [],
    relatedTests: [],
    sensitiveAreas: [],
    openFindings: 0,
    impactScore: 0,
    impactLevel: 'low',
  };

  if (!scanId) return empty;

  const rows = await db.select().from(files).where(eq(files.scanId, scanId));
  const self = rows.find((r) => r.path === path);
  if (!self) return empty;

  const byPath = new Map(rows.map((r) => [r.path, r]));

  /*
   * Reverse index: path -> files importing it. Built once, because walking the
   * forward `imports` arrays per level would be quadratic on large repos.
   */
  const importers = new Map<string, string[]>();
  for (const row of rows) {
    for (const imported of row.imports) {
      const list = importers.get(imported);
      if (list) list.push(row.path);
      else importers.set(imported, [row.path]);
    }
  }

  // Breadth-first so the first time a file is reached is its true shortest depth.
  const dependents: BlastRadiusNode[] = [];
  const seen = new Set<string>([path]);
  let frontier = [path];
  let directCount = 0;

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && seen.size < MAX_NODES; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const importer of importers.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        next.push(importer);
        if (depth === 1) directCount += 1;
        const row = byPath.get(importer);
        dependents.push({
          path: importer,
          kind: row?.kind ?? null,
          loc: row?.loc ?? 0,
          depth,
        });
        if (seen.size >= MAX_NODES) break;
      }
      if (seen.size >= MAX_NODES) break;
    }
    frontier = next;
  }

  const dependencies: BlastRadiusNode[] = self.imports
    .map((p) => {
      const row = byPath.get(p);
      return row ? { path: row.path, kind: row.kind, loc: row.loc, depth: 1 } : null;
    })
    .filter((n): n is BlastRadiusNode => n !== null);

  const affectedPaths = [path, ...dependents.map((d) => d.path)];

  const affectedRoutes = affectedPaths.filter(
    (p) => byPath.get(p)?.kind === 'route' || /(^|\/)(route|page|api)\.(t|j)sx?$/.test(p),
  );
  const affectedComponents = affectedPaths.filter((p) => byPath.get(p)?.kind === 'component');

  const sensitiveAreas = [
    ...new Set(
      affectedPaths.flatMap((p) =>
        SENSITIVE_PATTERNS.filter(({ pattern }) => pattern.test(p)).map(({ label }) => label),
      ),
    ),
  ].sort();

  // Tests are relevant when they cover the file OR anything downstream of it.
  const testRows = await db.select().from(tests).where(eq(tests.scanId, scanId));
  const affectedSet = new Set(affectedPaths);
  const relatedTests = testRows
    .filter((t) => t.coversPaths.some((p) => affectedSet.has(p)) || affectedSet.has(t.filePath))
    .map((t) => t.filePath)
    .sort();

  const findingRows = await db
    .select({ severity: findings.severity })
    .from(findings)
    .where(
      and(
        eq(findings.repositoryId, repositoryId),
        inArray(findings.filePath, affectedPaths.slice(0, 100)),
        inArray(findings.status, ['open', 'proposed']),
      ),
    );

  const impactScore = scoreImpact({
    directDependents: directCount,
    transitiveDependents: dependents.length,
    routes: affectedRoutes.length,
    sensitiveAreas: sensitiveAreas.length,
    hasTests: relatedTests.length > 0,
    findingSeverities: findingRows.map((f) => f.severity),
  });

  return {
    path,
    exists: true,
    dependencies,
    dependents: dependents.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
    directDependentCount: directCount,
    transitiveDependentCount: dependents.length,
    affectedRoutes: [...new Set(affectedRoutes)].sort(),
    affectedComponents: [...new Set(affectedComponents)].sort(),
    relatedTests,
    sensitiveAreas,
    openFindings: findingRows.length,
    impactScore,
    impactLevel: impactBand(impactScore),
  };
}

/**
 * Impact score, 0-100. Pure function, exported for direct testing.
 *
 * Dependent counts use a logarithm because the difference between 1 and 5
 * dependents matters far more than between 60 and 65 — past a point a file is
 * simply "central" and more importers do not change the decision.
 */
export function scoreImpact(input: {
  directDependents: number;
  transitiveDependents: number;
  routes: number;
  sensitiveAreas: number;
  hasTests: boolean;
  findingSeverities: readonly Severity[];
}): number {
  let score = 0;

  score += Math.min(30, Math.log2(input.directDependents + 1) * 10);
  score += Math.min(15, Math.log2(input.transitiveDependents + 1) * 4);
  score += Math.min(15, input.routes * 5);
  score += Math.min(20, input.sensitiveAreas * 10);

  const severityPoints: Record<Severity, number> = { critical: 6, high: 3, medium: 1.5, low: 0.5, info: 0 };
  score += Math.min(15, input.findingSeverities.reduce((sum, s) => sum + severityPoints[s], 0));

  // No covering test means a regression here ships silently.
  if (!input.hasTests && input.directDependents > 0) score += 8;

  return Math.round(Math.max(0, Math.min(100, score)));
}

export function impactBand(score: number): BlastRadius['impactLevel'] {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

/** Most-depended-upon files: the natural entry points for the Codebase view. */
export async function hotspotPaths(repositoryId: string, limit = 10): Promise<Array<{ path: string; dependents: number }>> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return [];

  const rows = await db
    .select({ path: files.path, imports: files.imports })
    .from(files)
    .where(eq(files.scanId, scanId))
    .orderBy(desc(files.riskScore));

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const imported of row.imports) {
      counts.set(imported, (counts.get(imported) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([path, dependents]) => ({ path, dependents }))
    .sort((a, b) => b.dependents - a.dependents || a.path.localeCompare(b.path))
    .slice(0, limit);
}

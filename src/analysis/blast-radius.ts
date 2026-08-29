import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { files, findings, tests } from '@/db/schema';
import type { Severity } from '@/db/schema';
import { latestScanId } from '@/ai/context';











export interface BlastRadiusNode {
  readonly path: string;
  readonly kind: string | null;
  readonly loc: number;

  readonly depth: number;
}

export interface BlastRadius {
  readonly path: string;
  readonly exists: boolean;

  readonly dependencies: readonly BlastRadiusNode[];

  readonly dependents: readonly BlastRadiusNode[];
  readonly directDependentCount: number;
  readonly transitiveDependentCount: number;

  readonly affectedRoutes: readonly string[];
  readonly affectedComponents: readonly string[];
  readonly relatedTests: readonly string[];

  readonly sensitiveAreas: readonly string[];
  readonly openFindings: number;

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





  const importers = new Map<string, string[]>();
  for (const row of rows) {
    for (const imported of row.imports) {
      const list = importers.get(imported);
      if (list) list.push(row.path);
      else importers.set(imported, [row.path]);
    }
  }


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


  if (!input.hasTests && input.directDependents > 0) score += 8;

  return Math.round(Math.max(0, Math.min(100, score)));
}

export function impactBand(score: number): BlastRadius['impactLevel'] {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}


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

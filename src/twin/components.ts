/**
 * Component grouping — turns a file-level graph into an architecture-level one.
 *
 * A repository with 800 files produces an 800-node graph that nobody can read.
 * Grouping files into logical components by directory gives a diagram with tens
 * of nodes instead of hundreds, which is the only version worth rendering.
 *
 * Everything here is deterministic and derived from rows the indexer and the
 * scanners already wrote. No AI, no guesses: a component's dependency count is
 * the number of distinct components its files genuinely import.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db';
import {
  codeEdges,
  components,
  commits as commitsTable,
  files as filesTable,
  findings as findingsTable,
  scans,
} from '@/db/schema';
import { createLogger } from '@/lib/logger';

const log = createLogger('twin:components');

/** Architectural layer, in the order they should be drawn top-to-bottom. */
export const LAYERS = ['Frontend', 'API', 'Services', 'Data', 'Infrastructure', 'Tests', 'Config', 'Other'] as const;
export type Layer = (typeof LAYERS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface RiskFactor {
  readonly label: string;
  readonly points: number;
  readonly detail: string;
}

export interface ComponentSummary {
  readonly key: string;
  readonly name: string;
  readonly layer: Layer;
  readonly rootPath: string;
  readonly filePaths: string[];
  readonly fileCount: number;
  readonly loc: number;
  readonly dependencyCount: number;
  readonly dependentCount: number;
  readonly findingCount: number;
  readonly criticalCount: number;
  readonly testCount: number;
  readonly untestedFiles: number;
  readonly changeFrequency: number;
  readonly securitySensitive: boolean;
  readonly riskScore: number;
  readonly riskLevel: RiskLevel;
  readonly riskFactors: RiskFactor[];
}

/**
 * Directory-prefix rules, first match wins. Ordered most-specific first so
 * `src/api/routes` lands in API rather than Services.
 */
const LAYER_RULES: ReadonlyArray<{ layer: Layer; test: (path: string) => boolean }> = [
  {
    layer: 'Tests',
    test: (p) => /(^|\/)(tests?|__tests__|spec|e2e)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.py$/.test(p),
  },
  {
    layer: 'Infrastructure',
    test: (p) => /(^|\/)(\.github|infra|deploy|terraform|k8s|helm|ansible)\//.test(p) || /^(Dockerfile|docker-compose|Makefile)/.test(p),
  },
  {
    layer: 'Config',
    test: (p) => /(^|\/)(config|settings)\//.test(p) || /^[^/]*\.(config|conf)\.[cm]?[jt]s$/.test(p) || /^(package\.json|tsconfig\.json|requirements\.txt|pyproject\.toml)$/.test(p),
  },
  {
    layer: 'Frontend',
    test: (p) => /\.(tsx|jsx|vue|svelte)$/.test(p) || /(^|\/)(components?|views?|pages|ui|frontend|client|screens)\//.test(p),
  },
  {
    layer: 'API',
    test: (p) => /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|resolvers?)\//.test(p),
  },
  {
    layer: 'Data',
    test: (p) => /(^|\/)(db|database|models?|repositories|entities|migrations?|dal|store|persistence)\//.test(p) || /schema\.(ts|js|sql|prisma|py)$/.test(p),
  },
  {
    layer: 'Services',
    test: (p) => /(^|\/)(services?|lib|domain|core|usecases?|business|auth|utils?|helpers?|workers?|jobs)\//.test(p),
  },
];

/** Paths whose compromise has outsized consequences. */
const SECURITY_SENSITIVE = /(^|\/)(auth|authentication|authorization|login|session|password|crypto|payment|billing|checkout|token|secret|permission|admin)/i;

export function layerOf(path: string): Layer {
  for (const rule of LAYER_RULES) {
    if (rule.test(path)) return rule.layer;
  }
  return 'Other';
}

/**
 * The directory a file's component is keyed on.
 *
 * Two levels below the source root keeps related files together
 * (`src/services/auth/*` → one component) without collapsing a whole
 * repository into `src`. Root-level files group under `(root)`.
 */
export function componentRootOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';

  // Drop a leading source-root directory so `src/routes` reads as `routes`.
  const isSourceRoot = /^(src|lib|app|packages|source)$/i.test(parts[0] ?? '');
  const stripped = isSourceRoot && parts.length > 2 ? parts.slice(1) : parts;
  const dirs = stripped.slice(0, -1);
  if (dirs.length === 0) return '(root)';
  /*
   * `src/index.ts` groups with the root, not into a component called "Src".
   * A bare source root is a location, not a logical component.
   */
  if (dirs.length === 1 && isSourceRoot && dirs[0] === parts[0]) return '(root)';
  return dirs.slice(0, 2).join('/');
}

export function componentKeyOf(path: string): string {
  const root = componentRootOf(path);
  return root === '(root)' ? 'root' : root.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
}

function humanName(root: string): string {
  if (root === '(root)') return 'Root';
  return root
    .split('/')
    .map((s) => s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' / ');
}

/**
 * Component risk — 0-100, documented in docs/digital-twin.md.
 *
 * Every factor is measured, never inferred. The bands are deliberately
 * conservative: a component only reaches `critical` if it combines unresolved
 * critical findings with real exposure.
 */
export function scoreComponentRisk(input: {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  dependentCount: number;
  untestedFiles: number;
  fileCount: number;
  changeFrequency: number;
  securitySensitive: boolean;
}): { score: number; level: RiskLevel; factors: RiskFactor[] } {
  const factors: RiskFactor[] = [];

  // Findings, weighted by severity. Capped so one noisy area cannot dominate.
  const findingPoints = Math.min(
    35,
    input.criticalCount * 10 + input.highCount * 5 + input.mediumCount * 2 + input.lowCount * 0.5,
  );
  if (findingPoints > 0) {
    factors.push({
      label: 'Open findings',
      points: round1(findingPoints),
      detail: `${input.criticalCount} critical, ${input.highCount} high, ${input.mediumCount} medium, ${input.lowCount} low`,
    });
  }

  // Blast radius: how much of the system leans on this component.
  const dependentPoints = Math.min(20, Math.log2(input.dependentCount + 1) * 7);
  if (dependentPoints > 0) {
    factors.push({
      label: 'Depended upon',
      points: round1(dependentPoints),
      detail: `${input.dependentCount} component${input.dependentCount === 1 ? '' : 's'} import from here`,
    });
  }

  // Test gap, as a proportion of the component.
  const untestedRatio = input.fileCount === 0 ? 0 : input.untestedFiles / input.fileCount;
  const testPoints = Math.min(20, untestedRatio * 20);
  if (testPoints > 0) {
    factors.push({
      label: 'Test gap',
      points: round1(testPoints),
      detail: `${input.untestedFiles} of ${input.fileCount} files have no test reaching them`,
    });
  }

  // Churn: recently and frequently changed code fails more often.
  const churnPoints = Math.min(12, Math.log10(input.changeFrequency + 1) * 8);
  if (churnPoints > 0) {
    factors.push({
      label: 'Change frequency',
      points: round1(churnPoints),
      detail: `${input.changeFrequency} commit touches in the indexed history`,
    });
  }

  // Security sensitivity is a multiplier on consequence, not a finding.
  const sensitivePoints = input.securitySensitive ? 13 : 0;
  if (sensitivePoints > 0) {
    factors.push({
      label: 'Security sensitive',
      points: sensitivePoints,
      detail: 'Handles authentication, payments, permissions or crypto',
    });
  }

  const score = Math.min(100, findingPoints + dependentPoints + testPoints + churnPoints + sensitivePoints);
  return { score: round1(score), level: bandRisk(score), factors: factors.sort((a, b) => b.points - a.points) };
}

export function bandRisk(score: number): RiskLevel {
  if (score >= 65) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 18) return 'medium';
  return 'low';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Rebuild the component table for a repository from current twin + scan rows.
 *
 * Cheap enough to run after every index: it is a handful of aggregate queries
 * over rows already in the database, with no parsing and no file I/O.
 */
export async function rebuildComponents(
  repositoryId: string,
  /*
   * The scan whose file rows describe the repository. Passed explicitly by the
   * scan pipeline, which calls this while its own scan is still `running` —
   * looking up the latest *completed* scan there would find the previous one,
   * whose file rows persistRepositoryIntelligence has already pruned.
   */
  scanId?: string,
): Promise<ComponentSummary[]> {
  const startedAt = Date.now();
  const db = await getDb();

  let sourceScanId = scanId;
  if (!sourceScanId) {
    const [latestScan] = await db
      .select({ id: scans.id })
      .from(scans)
      .where(and(eq(scans.repositoryId, repositoryId), eq(scans.status, 'completed')))
      .orderBy(desc(scans.startedAt))
      .limit(1);
    sourceScanId = latestScan?.id;
  }

  const fileRows = sourceScanId
    ? await db
        .select({ path: filesTable.path, loc: filesTable.loc })
        .from(filesTable)
        .where(eq(filesTable.scanId, sourceScanId))
    : [];

  if (fileRows.length === 0) {
    log.info('No scanned files; skipping component rebuild', { repositoryId });
    return [];
  }

  const edges = await db
    .select({ type: codeEdges.type, fromKey: codeEdges.fromKey, toKey: codeEdges.toKey })
    .from(codeEdges)
    .where(eq(codeEdges.repositoryId, repositoryId));

  const openFindings = await db
    .select({ filePath: findingsTable.filePath, severity: findingsTable.severity })
    .from(findingsTable)
    .where(and(eq(findingsTable.repositoryId, repositoryId), inArray(findingsTable.status, ['open', 'proposed'])));

  const commitRows = await db
    .select({ changedPaths: commitsTable.changedPaths })
    .from(commitsTable)
    .where(eq(commitsTable.repositoryId, repositoryId));

  /* ---- group files ---- */
  const byKey = new Map<string, { root: string; layer: Layer; paths: string[]; loc: number }>();
  const keyForPath = new Map<string, string>();

  for (const row of fileRows) {
    const key = componentKeyOf(row.path);
    keyForPath.set(row.path, key);
    const existing = byKey.get(key);
    if (existing) {
      existing.paths.push(row.path);
      existing.loc += row.loc ?? 0;
      // A component's layer is the one most of its files agree on; keeping the
      // first non-Other wins is close enough and stable.
      if (existing.layer === 'Other') existing.layer = layerOf(row.path);
    } else {
      byKey.set(key, {
        root: componentRootOf(row.path),
        layer: layerOf(row.path),
        paths: [row.path],
        loc: row.loc ?? 0,
      });
    }
  }

  /* ---- component-to-component dependencies from real IMPORTS edges ---- */
  const dependsOn = new Map<string, Set<string>>();
  const dependedBy = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (edge.type !== 'imports') continue;
    const from = keyForPath.get(edge.fromKey);
    const to = keyForPath.get(edge.toKey);
    if (!from || !to || from === to) continue;
    if (!dependsOn.has(from)) dependsOn.set(from, new Set());
    if (!dependedBy.has(to)) dependedBy.set(to, new Set());
    dependsOn.get(from)?.add(to);
    dependedBy.get(to)?.add(from);
  }

  /* ---- which files a test actually reaches (direct TESTS edges) ---- */
  const testedPaths = new Set<string>();
  for (const edge of edges) {
    if (edge.type === 'tests') testedPaths.add(edge.toKey);
  }

  /* ---- findings per component ---- */
  const severityByKey = new Map<string, { critical: number; high: number; medium: number; low: number; total: number }>();
  for (const finding of openFindings) {
    if (!finding.filePath) continue;
    const key = keyForPath.get(finding.filePath);
    if (!key) continue;
    const bucket = severityByKey.get(key) ?? { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    if (finding.severity === 'critical') bucket.critical += 1;
    else if (finding.severity === 'high') bucket.high += 1;
    else if (finding.severity === 'medium') bucket.medium += 1;
    else if (finding.severity === 'low') bucket.low += 1;
    bucket.total += 1;
    severityByKey.set(key, bucket);
  }

  /* ---- churn per component from commit changedPaths ---- */
  const churnByKey = new Map<string, number>();
  for (const commit of commitRows) {
    for (const path of commit.changedPaths ?? []) {
      const key = keyForPath.get(path);
      if (!key) continue;
      churnByKey.set(key, (churnByKey.get(key) ?? 0) + 1);
    }
  }

  /* ---- assemble ---- */
  const summaries: ComponentSummary[] = [];
  for (const [key, group] of byKey) {
    const sev = severityByKey.get(key) ?? { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    const isTestComponent = group.layer === 'Tests';
    const untestedFiles = isTestComponent ? 0 : group.paths.filter((p) => !testedPaths.has(p)).length;
    const testCount = group.paths.filter((p) => testedPaths.has(p)).length;
    /*
     * A test file that exercises auth is not itself a security-sensitive
     * surface — marking it so inflates the risk of the Tests component and
     * pushes real hotspots down the heatmap.
     */
    const securitySensitive = !isTestComponent && group.paths.some((p) => SECURITY_SENSITIVE.test(p));
    const dependentCount = dependedBy.get(key)?.size ?? 0;
    const changeFrequency = churnByKey.get(key) ?? 0;

    const risk = scoreComponentRisk({
      criticalCount: sev.critical,
      highCount: sev.high,
      mediumCount: sev.medium,
      lowCount: sev.low,
      dependentCount,
      untestedFiles,
      fileCount: group.paths.length,
      changeFrequency,
      securitySensitive,
    });

    summaries.push({
      key,
      name: humanName(group.root),
      layer: group.layer,
      rootPath: group.root,
      filePaths: group.paths.sort(),
      fileCount: group.paths.length,
      loc: group.loc,
      dependencyCount: dependsOn.get(key)?.size ?? 0,
      dependentCount,
      findingCount: sev.total,
      criticalCount: sev.critical,
      testCount,
      untestedFiles,
      changeFrequency,
      securitySensitive,
      riskScore: risk.score,
      riskLevel: risk.level,
      riskFactors: risk.factors,
    });
  }

  summaries.sort((a, b) => b.riskScore - a.riskScore || a.key.localeCompare(b.key));

  /* ---- persist: full replace, the set is small and always derived ---- */
  await db.delete(components).where(eq(components.repositoryId, repositoryId));
  if (summaries.length > 0) {
    await db.insert(components).values(
      summaries.map((s) => ({
        repositoryId,
        key: s.key,
        name: s.name,
        layer: s.layer,
        rootPath: s.rootPath,
        filePaths: s.filePaths,
        fileCount: s.fileCount,
        loc: s.loc,
        dependencyCount: s.dependencyCount,
        dependentCount: s.dependentCount,
        findingCount: s.findingCount,
        criticalCount: s.criticalCount,
        testCount: s.testCount,
        untestedFiles: s.untestedFiles,
        changeFrequency: s.changeFrequency,
        securitySensitive: s.securitySensitive,
        riskScore: s.riskScore,
        riskLevel: s.riskLevel,
        riskFactors: s.riskFactors,
      })),
    );
  }

  log.info('Components rebuilt', {
    repositoryId,
    components: summaries.length,
    files: fileRows.length,
    durationMs: Date.now() - startedAt,
  });

  return summaries;
}

/** Component-level dependency edges, for the architecture graph. */
export async function componentGraph(repositoryId: string): Promise<{
  nodes: ComponentSummary[];
  edges: Array<{ from: string; to: string; fileCount: number }>;
}> {
  const db = await getDb();
  const rows = await db.select().from(components).where(eq(components.repositoryId, repositoryId));

  const nodes: ComponentSummary[] = rows.map((r) => ({
    key: r.key,
    name: r.name,
    layer: (LAYERS as readonly string[]).includes(r.layer) ? (r.layer as Layer) : 'Other',
    rootPath: r.rootPath,
    filePaths: r.filePaths,
    fileCount: r.fileCount,
    loc: r.loc,
    dependencyCount: r.dependencyCount,
    dependentCount: r.dependentCount,
    findingCount: r.findingCount,
    criticalCount: r.criticalCount,
    testCount: r.testCount,
    untestedFiles: r.untestedFiles,
    changeFrequency: r.changeFrequency,
    securitySensitive: r.securitySensitive,
    riskScore: r.riskScore,
    riskLevel: (RISK_LEVELS as readonly string[]).includes(r.riskLevel) ? (r.riskLevel as RiskLevel) : 'low',
    riskFactors: r.riskFactors,
  }));

  const pathToKey = new Map<string, string>();
  for (const node of nodes) {
    for (const path of node.filePaths) pathToKey.set(path, node.key);
  }

  const importEdges = await db
    .select({ fromKey: codeEdges.fromKey, toKey: codeEdges.toKey })
    .from(codeEdges)
    .where(and(eq(codeEdges.repositoryId, repositoryId), eq(codeEdges.type, 'imports')));

  const counts = new Map<string, number>();
  for (const edge of importEdges) {
    const from = pathToKey.get(edge.fromKey);
    const to = pathToKey.get(edge.toKey);
    if (!from || !to || from === to) continue;
    const id = `${from}\u0000${to}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  nodes.sort((a, b) => b.riskScore - a.riskScore || a.key.localeCompare(b.key));

  const edges = [...counts.entries()].map(([id, fileCount]) => {
    const [from = '', to = ''] = id.split('\u0000');
    return { from, to, fileCount };
  });

  return { nodes, edges };
}

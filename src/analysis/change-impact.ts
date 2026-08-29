import { analyseImpact } from './impact';
import type { ImpactAnalysis } from './impact';
import { detectTestGaps } from '@/testing/gaps';
import type { TestGap } from '@/testing/gaps';
import { prioritizeTests } from '@/testing/prioritize';
import type { PrioritizedTest } from '@/testing/prioritize';













export interface RiskFactor {
  readonly label: string;

  readonly detail: string;
  readonly weight: 'low' | 'medium' | 'high';
}

export interface ChangeImpactPreview {
  readonly resolved: boolean;
  readonly reason?: string;
  readonly impactLevel: ImpactAnalysis['impactLevel'];
  readonly impactScore: number;
  readonly changedFiles: readonly string[];

  readonly affectedFiles: ReadonlyArray<{ path: string; depth: number; evidence: string | null }>;
  readonly affectedApis: ReadonlyArray<{ route: string; filePath: string }>;
  readonly affectedComponents: ReadonlyArray<{ key: string; fileCount: number }>;
  readonly affectedDatabases: ReadonlyArray<{ target: string; filePath: string }>;
  readonly riskFactors: readonly RiskFactor[];
  readonly recommendedTests: readonly PrioritizedTest[];
  readonly testGaps: readonly TestGap[];
  readonly truncated: boolean;
}







export async function previewChangeImpact(
  repositoryId: string,
  changedFiles: readonly string[],
): Promise<ChangeImpactPreview> {
  if (changedFiles.length === 0) {
    return {
      resolved: false,
      reason: 'No changed files were supplied.',
      impactLevel: 'low',
      impactScore: 0,
      changedFiles: [],
      affectedFiles: [],
      affectedApis: [],
      affectedComponents: [],
      affectedDatabases: [],
      riskFactors: [],
      recommendedTests: [],
      testGaps: [],
      truncated: false,
    };
  }







  const analyses: ImpactAnalysis[] = [];
  for (const path of changedFiles.slice(0, 50)) {
    analyses.push(await analyseImpact(repositoryId, { type: 'file', value: path }));
  }

  const resolvedAnalyses = analyses.filter((a) => a.resolved);
  if (resolvedAnalyses.length === 0) {
    return {
      resolved: false,
      reason:
        analyses[0]?.reason ??
        'None of the changed files are in the latest scan. Run a scan so the Digital Twin knows about them.',
      impactLevel: 'low',
      impactScore: 0,
      changedFiles: [...changedFiles],
      affectedFiles: [],
      affectedApis: [],
      affectedComponents: [],
      affectedDatabases: [],
      riskFactors: [],
      recommendedTests: [],
      testGaps: [],
      truncated: false,
    };
  }

  const changedSet = new Set(changedFiles);


  const affected = new Map<string, { path: string; depth: number; evidence: string | null }>();
  for (const analysis of resolvedAnalyses) {
    for (const dep of [...analysis.directDependents, ...analysis.indirectDependents]) {
      if (changedSet.has(dep.path)) continue;
      const existing = affected.get(dep.path);
      if (!existing || dep.depth < existing.depth) {
        affected.set(dep.path, { path: dep.path, depth: dep.depth, evidence: dep.evidence });
      }
    }
  }

  const apis = new Map<string, { route: string; filePath: string }>();
  for (const analysis of resolvedAnalyses) {
    for (const r of analysis.affectedRoutes) apis.set(`${r.route}|${r.filePath}`, { route: r.route, filePath: r.filePath });
  }

  const databases = new Map<string, { target: string; filePath: string }>();
  for (const analysis of resolvedAnalyses) {
    for (const d of analysis.affectedDatabases) {
      databases.set(`${d.target}|${d.filePath}`, { target: d.target, filePath: d.filePath });
    }
  }

  const components = new Map<string, number>();
  for (const analysis of resolvedAnalyses) {
    for (const c of analysis.affectedComponents) components.set(c.key, Math.max(components.get(c.key) ?? 0, c.fileCount));
  }

  const impactScore = Math.max(...resolvedAnalyses.map((a) => a.impactScore));
  const worst = resolvedAnalyses.reduce((a, b) => (b.impactScore > a.impactScore ? b : a));

  const testGaps = await detectTestGaps(repositoryId, changedFiles);
  const recommendedTests = await prioritizeTests(repositoryId, changedFiles);

  return {
    resolved: true,
    impactLevel: worst.impactLevel,
    impactScore,
    changedFiles: [...changedFiles],
    affectedFiles: [...affected.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)),
    affectedApis: [...apis.values()].sort((a, b) => a.route.localeCompare(b.route)),
    affectedComponents: [...components.entries()]
      .map(([key, fileCount]) => ({ key, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount || a.key.localeCompare(b.key)),
    affectedDatabases: [...databases.values()].sort((a, b) => a.target.localeCompare(b.target)),
    riskFactors: collectRiskFactors(resolvedAnalyses, changedFiles, testGaps),
    recommendedTests,
    testGaps,
    truncated: resolvedAnalyses.some((a) => a.truncated),
  };
}







function collectRiskFactors(
  analyses: readonly ImpactAnalysis[],
  changedFiles: readonly string[],
  gaps: readonly TestGap[],
): RiskFactor[] {
  const factors: RiskFactor[] = [];

  const sensitive = new Map<string, Set<string>>();
  for (const analysis of analyses) {
    for (const area of analysis.sensitiveAreas) {
      const set = sensitive.get(area.label) ?? new Set<string>();
      for (const p of area.paths) set.add(p);
      sensitive.set(area.label, set);
    }
  }
  for (const [label, paths] of sensitive) {
    factors.push({
      label: `Touches ${label}`,
      detail: `${paths.size} file${paths.size === 1 ? '' : 's'} in the impact radius match this area: ${[...paths].slice(0, 3).join(', ')}${paths.size > 3 ? '…' : ''}`,
      weight: label === 'authentication' || label === 'payments' || label === 'access control' ? 'high' : 'medium',
    });
  }

  const totalDirect = new Set(analyses.flatMap((a) => a.directDependents.map((d) => d.path))).size;
  if (totalDirect >= 5) {
    factors.push({
      label: 'Wide dependent surface',
      detail: `${totalDirect} files import the changed code directly.`,
      weight: totalDirect >= 12 ? 'high' : 'medium',
    });
  }

  const routes = new Set(analyses.flatMap((a) => a.affectedRoutes.map((r) => r.route)));
  if (routes.size > 0) {
    factors.push({
      label: 'Reaches the API surface',
      detail: `${routes.size} endpoint${routes.size === 1 ? '' : 's'} sit downstream: ${[...routes].slice(0, 3).join(', ')}${routes.size > 3 ? '…' : ''}`,
      weight: routes.size >= 3 ? 'high' : 'medium',
    });
  }

  const untested = changedFiles.filter((p) => analyses.some((a) => a.untestedFiles.includes(p)));
  if (untested.length > 0) {
    factors.push({
      label: 'Changed code without tests',
      detail: `${untested.length} changed file${untested.length === 1 ? ' has' : 's have'} no test importing them: ${untested.slice(0, 3).join(', ')}`,
      weight: 'high',
    });
  }

  const findingCount = new Set(analyses.flatMap((a) => a.openFindings.map((f) => f.id))).size;
  if (findingCount > 0) {
    const worstSeverity = analyses
      .flatMap((a) => a.openFindings.map((f) => f.severity))
      .some((s) => s === 'critical' || s === 'high');
    factors.push({
      label: 'Existing findings in the radius',
      detail: `${findingCount} open finding${findingCount === 1 ? '' : 's'} already affect these files.`,
      weight: worstSeverity ? 'high' : 'low',
    });
  }

  const dbTargets = new Set(analyses.flatMap((a) => a.affectedDatabases.map((d) => d.target)));
  if (dbTargets.size > 0) {
    factors.push({
      label: 'Touches persisted data',
      detail: `Database access detected for: ${[...dbTargets].slice(0, 4).join(', ')}`,
      weight: 'medium',
    });
  }

  const highGaps = gaps.filter((g) => g.severity === 'high').length;
  if (highGaps > 0) {
    factors.push({
      label: 'Untested high-complexity code',
      detail: `${highGaps} exported symbol${highGaps === 1 ? '' : 's'} with branching logic and no covering test.`,
      weight: 'high',
    });
  }

  const history = analyses.flatMap((a) => a.history);
  for (const signal of history.slice(0, 3)) {
    factors.push({
      label: signal.kind === 'high_churn' ? 'Frequently changed area' : 'Recurring problem area',
      detail: signal.detail,
      weight: 'low',
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return factors.sort((a, b) => order[a.weight] - order[b.weight]);
}

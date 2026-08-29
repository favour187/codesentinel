import type { Category, Severity } from '@/db/schema';
import type { Finding } from './types';
import type { RepositoryStats } from './discovery';






































export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0.5,
};


export const CATEGORY_DIMENSION: Record<Category, ScoreDimension> = {
  security: 'security',
  secrets: 'security',
  infrastructure: 'security',
  bugs: 'reliability',
  reliability: 'reliability',
  quality: 'quality',
  architecture: 'quality',
  testing: 'testing',
  dependencies: 'security',
  performance: 'performance',
};

export type ScoreDimension = 'security' | 'reliability' | 'quality' | 'testing' | 'performance';


export const DIMENSION_WEIGHTS: Record<ScoreDimension, number> = {
  security: 0.35,
  reliability: 0.25,
  quality: 0.15,
  testing: 0.15,
  performance: 0.1,
};

export interface HealthScores {
  health: number;
  security: number;
  reliability: number;
  quality: number;
  testing: number;
  performance: number;
}

export interface ScoreBreakdownEntry {
  dimension: ScoreDimension;
  score: number;
  deduction: number;
  findings: number;
  topContributors: Array<{ ruleId: string; severity: Severity; count: number; points: number }>;
}

export interface ScoringResult extends HealthScores {
  counts: Record<Severity, number>;
  breakdown: ScoreBreakdownEntry[];
  debtHours: number;

  summary: string;
}






export function sizeAllowance(totalLoc: number): number {
  if (totalLoc <= 0) return 1;
  return Math.max(1, Math.min(3, Math.log10(Math.max(totalLoc, 100) / 50)));
}


const DEBT_HOURS: Record<Severity, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
  info: 0.15,
};

function round(value: number): number {
  return Math.round(value * 10) / 10;
}






const DECAY = 25;


export function deductionToScore(deduction: number): number {
  if (deduction <= 0) return 100;




  return Math.max(0.1, round(100 / (1 + deduction / DECAY)));
}

export function calculateScores(findings: readonly Finding[], stats: RepositoryStats): ScoringResult {
  const allowance = sizeAllowance(stats.totalLoc);

  const dimensions: ScoreDimension[] = ['security', 'reliability', 'quality', 'testing', 'performance'];
  const deductions = new Map<ScoreDimension, number>(dimensions.map((d) => [d, 0]));
  const perDimensionFindings = new Map<ScoreDimension, Finding[]>(dimensions.map((d) => [d, []]));

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  let debtHours = 0;

  for (const finding of findings) {
    counts[finding.severity] += 1;
    debtHours += DEBT_HOURS[finding.severity];

    const dimension = CATEGORY_DIMENSION[finding.category];
    const points = (SEVERITY_WEIGHTS[finding.severity] * finding.confidence) / allowance;
    deductions.set(dimension, (deductions.get(dimension) ?? 0) + points);
    perDimensionFindings.get(dimension)?.push(finding);
  }

  const breakdown: ScoreBreakdownEntry[] = dimensions.map((dimension) => {
    const deduction = deductions.get(dimension) ?? 0;
    const dimensionFindings = perDimensionFindings.get(dimension) ?? [];


    const byRule = new Map<string, { severity: Severity; count: number; points: number }>();
    for (const finding of dimensionFindings) {
      const entry = byRule.get(finding.ruleId) ?? { severity: finding.severity, count: 0, points: 0 };
      entry.count += 1;
      entry.points += (SEVERITY_WEIGHTS[finding.severity] * finding.confidence) / allowance;
      byRule.set(finding.ruleId, entry);
    }

    return {
      dimension,
      score: deductionToScore(deduction),
      deduction: round(deduction),
      findings: dimensionFindings.length,
      topContributors: [...byRule.entries()]
        .map(([ruleId, v]) => ({ ruleId, severity: v.severity, count: v.count, points: round(v.points) }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 3),
    };
  });

  const scoreFor = (dimension: ScoreDimension): number =>
    breakdown.find((entry) => entry.dimension === dimension)?.score ?? 100;

  const scores: Omit<HealthScores, 'health'> = {
    security: scoreFor('security'),
    reliability: scoreFor('reliability'),
    quality: scoreFor('quality'),
    testing: scoreFor('testing'),
    performance: scoreFor('performance'),
  };

  const weighted = round(
    dimensions.reduce((total, dimension) => total + scores[dimension] * DIMENSION_WEIGHTS[dimension], 0),
  );
  const health = weighted;

  const worst = [...breakdown].sort((a, b) => b.deduction - a.deduction)[0];
  let summary: string;
  if (!worst || worst.deduction === 0) {
    summary = 'No issues were detected in this scan.';
  } else if (counts.critical > 0 || counts.high > 0) {
    const sev = counts.critical > 0 ? 'critical' : 'high';
    const n = counts[sev];
    summary = `${n} unresolved ${sev} ${n === 1 ? 'issue' : 'issues'} ${n === 1 ? 'needs' : 'need'} attention; ${worst.dimension} is the largest drag on health (−${worst.deduction} points).`;
  } else {
    summary =
      `${worst.dimension} is the largest drag on health (−${worst.deduction} points from ${worst.findings} ${worst.findings === 1 ? 'finding' : 'findings'})` +
      (worst.topContributors[0] ? `, led by ${worst.topContributors[0].ruleId}.` : '.');
  }

  return { health, ...scores, counts, breakdown, debtHours: round(debtHours), summary };
}





export interface FindingDelta {
  introduced: Finding[];
  resolved: string[];
  unchanged: string[];
}







export function diffFindings(
  previousFingerprints: readonly string[],
  currentFindings: readonly Finding[],
): FindingDelta {
  const previous = new Set(previousFingerprints);
  const current = new Set(currentFindings.map((f) => f.fingerprint));

  return {
    introduced: currentFindings.filter((f) => !previous.has(f.fingerprint)),
    resolved: [...previous].filter((fingerprint) => !current.has(fingerprint)),
    unchanged: [...current].filter((fingerprint) => previous.has(fingerprint)),
  };
}













export function scoreGrade(
  score: number,
  counts?: Record<Severity, number>,
): { label: string; tone: 'critical' | 'warning' | 'good' | 'excellent' } {
  if (counts?.critical) return { label: 'At risk', tone: 'critical' };
  if (counts?.high) {
    return score >= 50
      ? { label: 'Needs attention', tone: 'warning' }
      : { label: 'At risk', tone: 'critical' };
  }
  if (score >= 90) return { label: 'Excellent', tone: 'excellent' };
  if (score >= 75) return { label: 'Good', tone: 'good' };
  if (score >= 50) return { label: 'Needs attention', tone: 'warning' };
  return { label: 'At risk', tone: 'critical' };
}

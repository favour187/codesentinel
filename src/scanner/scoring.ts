import type { Category, Severity } from '@/db/schema';
import type { Finding } from './types';
import type { RepositoryStats } from './discovery';

/**
 * Health scoring.
 *
 * Deterministic and fully explainable — no randomness, no AI. The same findings
 * always produce the same scores, and every score can be traced back to the
 * findings that caused it. This matters because a score that moves for reasons
 * the user can't reconstruct is worse than no score at all.
 *
 * Model
 * -----
 * Each dimension starts at 100 and loses points per finding:
 *
 *   critical -25   high -12   medium -5   low -2   info -0.5
 *
 * Deductions are weighted by the finding's confidence, so a 0.55-confidence
 * heuristic costs roughly half of what a 0.95-confidence match does. The total
 * is then scaled by repository size: 3 criticals in a 200-line project is a far
 * worse ratio than 3 in a 200k-line monorepo, but the raw deduction alone would
 * treat them identically, so a size allowance softens the penalty for large
 * codebases without ever erasing critical issues.
 *
 * The deduction is mapped to a score through a saturating curve rather than
 * plain subtraction:
 *
 *     score = 100 / (1 + deduction / DECAY)
 *
 * Straight subtraction clamps to zero, and once a repository bottoms out the
 * score stops responding — fixing five critical issues in a badly compromised
 * codebase would show no progress at all, which is exactly when feedback
 * matters most. The hyperbolic curve is strictly monotonic and never reaches
 * zero, so every fix moves the number while still separating "one issue" from
 * "fifty" in a way that matches intuition.
 *
 * Overall health is a weighted mean of the dimensions, with security weighted
 * highest because a security failure is the least recoverable.
 */

export const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0.5,
};

/** Which dimension each finding category contributes to. */
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

/** Overall health weighting. Must sum to 1. */
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
  /** Plain-language summary of the biggest score driver. */
  summary: string;
}

/**
 * Larger repositories get a proportionally larger allowance, because raw
 * finding counts scale with size. Uses a log curve: 1.0 at ~500 LOC, ~2.0 at
 * 50k LOC — generous enough to be fair, never enough to hide criticals.
 */
export function sizeAllowance(totalLoc: number): number {
  if (totalLoc <= 0) return 1;
  return Math.max(1, Math.min(3, Math.log10(Math.max(totalLoc, 100) / 50)));
}

/** Rough remediation effort, used for the technical-debt estimate. */
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

/**
 * Controls how fast the curve falls. At `deduction === DECAY` the score is 50,
 * so one unfixed critical (25 points) lands around 67 and a wall of them
 * approaches — but never reaches — zero.
 */
const DECAY = 25;

/** Maps an accumulated deduction to a 0..100 score. Monotonic, never negative. */
export function deductionToScore(deduction: number): number {
  if (deduction <= 0) return 100;
  // Floored at 0.1 rather than allowed to round to 0.0. The curve never
  // actually reaches zero, and a displayed 0 reads as "measurement failed" or
  // "nothing here works", which is a different claim from "very bad". Keeping
  // the floor also preserves the invariant that 0 is unreachable.
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

    // Group by rule so the breakdown names the actual driver.
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

/* -------------------------------------------------------------------------- */
/* Scan-to-scan deltas                                                        */
/* -------------------------------------------------------------------------- */

export interface FindingDelta {
  introduced: Finding[];
  resolved: string[];
  unchanged: string[];
}

/**
 * Compares two scans by fingerprint.
 *
 * Because fingerprints exclude line numbers, adding a line above an issue does
 * not report it as resolved-and-reintroduced — the delta reflects real changes.
 */
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

/** Grade band for display. */
/**
 * Grades a score for display.
 *
 * `counts` is optional but should be passed for the overall health grade. A
 * weighted mean can sit in the high 80s while a critical RCE is open, because
 * healthy tests and performance average the number back up. The number itself
 * stays honest and responsive (clamping it would make fixing 9 of 10 criticals
 * show no movement), so the severity gate lives here in the label instead:
 * a repository with unresolved critical or high findings is never presented
 * as "Excellent" or "Good", whatever the arithmetic says.
 */
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

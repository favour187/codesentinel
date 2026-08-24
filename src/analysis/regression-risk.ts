import type { Severity } from '@/db/schema';

/**
 * Regression risk model.
 *
 * A transparent, fully deterministic scoring function. Every input is a number
 * we measured, every weight is written down here, and the output carries the
 * factors that produced it so a user can see exactly why a change scored the
 * way it did.
 *
 * AI never produces this score. A language model asked "how risky is this
 * change" gives a plausible-sounding number with no basis, and it will not
 * give the same answer twice for the same diff. Reviewers need a number they
 * can argue with, so the model is arithmetic and the AI only explains it.
 *
 * The algorithm is documented in docs/ai-analysis.md.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RegressionRiskInput {
  /** Files touched by the change. */
  readonly changedPaths: readonly string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Severities of findings newly introduced by this change. */
  readonly newFindingSeverities: readonly Severity[];
  /** Findings historically recorded against the changed files. */
  readonly historicalFindingCount: number;
  /** Highest blast-radius impact score among the changed files (0-100). */
  readonly maxBlastRadius: number;
  /** Changed files that have at least one covering test. */
  readonly testedPathCount: number;
  /** Repository test coverage proxy: tested files / source files, 0-1. */
  readonly coverageRatio: number | null;
  /** Times a previous scan of these files reported a failure/regression. */
  readonly priorFailureCount: number;
}

export interface RiskFactor {
  readonly label: string;
  readonly points: number;
  readonly detail: string;
}

export interface RegressionRisk {
  readonly score: number;
  readonly level: RiskLevel;
  readonly factors: readonly RiskFactor[];
  readonly summary: string;
}

/** Weights are constants, not tuning knobs sprinkled through the function. */
const WEIGHTS = {
  severity: { critical: 25, high: 12, medium: 5, low: 2, info: 0.5 } satisfies Record<Severity, number>,
  maxSeverityPoints: 40,
  churnCap: 15,
  breadthCap: 12,
  sensitiveCap: 20,
  blastCap: 15,
  untestedCap: 12,
  historyCap: 8,
  priorFailureCap: 10,
} as const;

const SENSITIVE_AREAS: ReadonlyArray<{ pattern: RegExp; label: string; points: number }> = [
  { pattern: /(^|\/)(auth|session|login|oauth|permission|rbac)/i, label: 'authentication or access control', points: 12 },
  { pattern: /(^|\/)(payment|billing|checkout|stripe)/i, label: 'payments', points: 12 },
  { pattern: /(^|\/)(migration|migrations)\//i, label: 'database migrations', points: 10 },
  { pattern: /(^|\/)(crypto|secret|credential)/i, label: 'cryptography or credentials', points: 10 },
  { pattern: /\.(sql)$|(^|\/)schema\.(ts|js|prisma|sql)$/i, label: 'database schema', points: 8 },
  { pattern: /(^|\/)(\.github|Dockerfile|docker-compose|terraform|k8s)/i, label: 'infrastructure or CI', points: 8 },
];

export function assessRegressionRisk(input: RegressionRiskInput): RegressionRisk {
  const factors: RiskFactor[] = [];
  const add = (label: string, points: number, detail: string) => {
    if (points > 0) factors.push({ label, points: round(points), detail });
  };

  // 1. New findings — the strongest signal, since these are measured defects.
  const severityPoints = Math.min(
    WEIGHTS.maxSeverityPoints,
    input.newFindingSeverities.reduce((sum, s) => sum + WEIGHTS.severity[s], 0),
  );
  if (severityPoints > 0) {
    const counts = countBy(input.newFindingSeverities);
    add(
      'New findings introduced',
      severityPoints,
      Object.entries(counts)
        .map(([sev, n]) => `${n} ${sev}`)
        .join(', '),
    );
  }

  // 2. Change size. Logarithmic: the 50th changed line is not as informative
  //    as the 5th, and large mechanical diffs would otherwise dominate.
  const churn = input.linesAdded + input.linesRemoved;
  const churnPoints = churn > 0 ? Math.min(WEIGHTS.churnCap, Math.log10(churn + 1) * 6) : 0;
  add('Change size', churnPoints, `${input.linesAdded} added, ${input.linesRemoved} removed`);

  // 3. Breadth — a change spread over many files is harder to reason about.
  const breadthPoints =
    input.changedPaths.length > 0 ? Math.min(WEIGHTS.breadthCap, Math.log2(input.changedPaths.length + 1) * 3) : 0;
  add('Files touched', breadthPoints, `${input.changedPaths.length} file(s)`);

  // 4. Sensitive areas.
  const hitAreas = new Map<string, number>();
  for (const path of input.changedPaths) {
    for (const area of SENSITIVE_AREAS) {
      if (area.pattern.test(path)) hitAreas.set(area.label, area.points);
    }
  }
  const sensitivePoints = Math.min(WEIGHTS.sensitiveCap, [...hitAreas.values()].reduce((a, b) => a + b, 0));
  if (sensitivePoints > 0) add('Sensitive areas touched', sensitivePoints, [...hitAreas.keys()].join(', '));

  // 5. Blast radius of the most connected changed file.
  const blastPoints = (Math.max(0, Math.min(100, input.maxBlastRadius)) / 100) * WEIGHTS.blastCap;
  add('Blast radius', blastPoints, `highest impact score among changed files: ${Math.round(input.maxBlastRadius)}`);

  // 6. Untested changes. Coverage the change itself lacks matters more than
  //    the repository average, so the per-path count leads.
  const untestedCount = Math.max(0, input.changedPaths.length - input.testedPathCount);
  const untestedPoints =
    input.changedPaths.length > 0
      ? Math.min(WEIGHTS.untestedCap, (untestedCount / input.changedPaths.length) * WEIGHTS.untestedCap)
      : 0;
  add(
    'Changes without covering tests',
    untestedPoints,
    `${untestedCount} of ${input.changedPaths.length} changed file(s) have no detected test`,
  );

  if (input.coverageRatio !== null && input.coverageRatio < 0.3) {
    add(
      'Low repository test coverage',
      4,
      `roughly ${Math.round(input.coverageRatio * 100)}% of source files have a detected test`,
    );
  }

  // 7. History — files that have produced findings before tend to again.
  const historyPoints =
    input.historicalFindingCount > 0
      ? Math.min(WEIGHTS.historyCap, Math.log2(input.historicalFindingCount + 1) * 2)
      : 0;
  add('Historical findings in these files', historyPoints, `${input.historicalFindingCount} previously recorded`);

  const priorFailurePoints = Math.min(WEIGHTS.priorFailureCap, input.priorFailureCount * 3);
  add('Previous failures in these files', priorFailurePoints, `${input.priorFailureCount} prior failure(s)`);

  const score = Math.round(Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  const level = riskBand(score);

  return {
    score,
    level,
    factors: [...factors].sort((a, b) => b.points - a.points),
    summary: summarize(level, score, factors),
  };
}

export function riskBand(score: number): RiskLevel {
  if (score >= 65) return 'critical';
  if (score >= 40) return 'high';
  if (score >= 18) return 'medium';
  return 'low';
}

function summarize(level: RiskLevel, score: number, factors: readonly RiskFactor[]): string {
  if (factors.length === 0) return 'No regression risk signals detected for this change.';
  const top = [...factors].sort((a, b) => b.points - a.points).slice(0, 2);
  return `${level.toUpperCase()} regression risk (${score}/100), driven mainly by ${top
    .map((f) => f.label.toLowerCase())
    .join(' and ')}.`;
}

function countBy(severities: readonly Severity[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of severities) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

import type { Severity } from '@/db/schema';

















export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RegressionRiskInput {

  readonly changedPaths: readonly string[];
  readonly linesAdded: number;
  readonly linesRemoved: number;

  readonly newFindingSeverities: readonly Severity[];

  readonly historicalFindingCount: number;

  readonly maxBlastRadius: number;

  readonly testedPathCount: number;

  readonly coverageRatio: number | null;

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



  const churn = input.linesAdded + input.linesRemoved;
  const churnPoints = churn > 0 ? Math.min(WEIGHTS.churnCap, Math.log10(churn + 1) * 6) : 0;
  add('Change size', churnPoints, `${input.linesAdded} added, ${input.linesRemoved} removed`);


  const breadthPoints =
    input.changedPaths.length > 0 ? Math.min(WEIGHTS.breadthCap, Math.log2(input.changedPaths.length + 1) * 3) : 0;
  add('Files touched', breadthPoints, `${input.changedPaths.length} file(s)`);


  const hitAreas = new Map<string, number>();
  for (const path of input.changedPaths) {
    for (const area of SENSITIVE_AREAS) {
      if (area.pattern.test(path)) hitAreas.set(area.label, area.points);
    }
  }
  const sensitivePoints = Math.min(WEIGHTS.sensitiveCap, [...hitAreas.values()].reduce((a, b) => a + b, 0));
  if (sensitivePoints > 0) add('Sensitive areas touched', sensitivePoints, [...hitAreas.keys()].join(', '));


  const blastPoints = (Math.max(0, Math.min(100, input.maxBlastRadius)) / 100) * WEIGHTS.blastCap;
  add('Blast radius', blastPoints, `highest impact score among changed files: ${Math.round(input.maxBlastRadius)}`);



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

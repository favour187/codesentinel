import type { Severity } from '@/db/schema';


















export type RepoRiskLevel = Severity;

export interface RepoRiskFactor {
  readonly id: string;
  readonly label: string;
  readonly points: number;
  readonly detail: string;
}

export interface RepoRiskInput {
  readonly health: number | null;
  readonly counts: Record<Severity, number>;
  readonly secretCount: number;
  readonly sourceFileCount: number;
  readonly untestedFileCount: number;
  readonly vulnerablePackages: number;
  readonly highRiskComponents: number;
  readonly sensitiveComponents: number;
  readonly recentRegressions: number;
}

export interface RepoRiskResult {
  readonly score: number;
  readonly level: RepoRiskLevel;
  readonly factors: RepoRiskFactor[];
}

const BANDS: Array<{ min: number; level: RepoRiskLevel }> = [
  { min: 70, level: 'critical' },
  { min: 45, level: 'high' },
  { min: 22, level: 'medium' },
  { min: 8, level: 'low' },
  { min: 0, level: 'info' },
];

export function assessRepositoryRisk(input: RepoRiskInput): RepoRiskResult {
  const factors: RepoRiskFactor[] = [];

  const findingPoints = Math.min(
    40,
    input.counts.critical * 10 +
      input.counts.high * 5 +
      input.counts.medium * 2 +
      input.counts.low * 0.5,
  );
  if (findingPoints > 0) {
    factors.push({
      id: 'findings',
      label: 'Open findings',
      points: round(findingPoints),
      detail: `${input.counts.critical} critical, ${input.counts.high} high, ${input.counts.medium} medium`,
    });
  }

  const secretPoints = Math.min(20, input.secretCount * 8);
  if (secretPoints > 0) {
    factors.push({
      id: 'secrets',
      label: 'Committed secrets',
      points: round(secretPoints),
      detail: `${input.secretCount} open secret finding${input.secretCount === 1 ? '' : 's'}`,
    });
  }

  const untestedRatio =
    input.sourceFileCount === 0 ? 0 : input.untestedFileCount / input.sourceFileCount;
  const testPoints = Math.min(15, untestedRatio * 15);
  if (testPoints > 0) {
    factors.push({
      id: 'tests',
      label: 'Test gap',
      points: round(testPoints),
      detail: `${input.untestedFileCount} of ${input.sourceFileCount} source files have no test import`,
    });
  }

  const depPoints = Math.min(15, input.vulnerablePackages * 4);
  if (depPoints > 0) {
    factors.push({
      id: 'dependencies',
      label: 'Vulnerable dependencies',
      points: round(depPoints),
      detail: `${input.vulnerablePackages} package${input.vulnerablePackages === 1 ? '' : 's'} with published advisories`,
    });
  }

  const archPoints = Math.min(12, input.highRiskComponents * 3);
  if (archPoints > 0) {
    factors.push({
      id: 'architecture',
      label: 'High-risk components',
      points: round(archPoints),
      detail: `${input.highRiskComponents} component${input.highRiskComponents === 1 ? '' : 's'} scored high or critical`,
    });
  }

  const sensitivePoints = Math.min(10, input.sensitiveComponents * 2);
  if (sensitivePoints > 0) {
    factors.push({
      id: 'sensitive',
      label: 'Sensitive surface',
      points: round(sensitivePoints),
      detail: `${input.sensitiveComponents} component${input.sensitiveComponents === 1 ? '' : 's'} handle auth, payments or crypto`,
    });
  }

  if (input.recentRegressions > 0) {
    factors.push({
      id: 'regression',
      label: 'Recent regressions',
      points: Math.min(12, input.recentRegressions * 6),
      detail: `${input.recentRegressions} previously resolved finding${input.recentRegressions === 1 ? '' : 's'} returned`,
    });
  }

  if (input.health !== null && input.health < 90) {
    const healthPoints = Math.min(15, ((100 - input.health) / 100) * 15);
    factors.push({
      id: 'health',
      label: 'Health deficit',
      points: round(healthPoints),
      detail: `Latest health score is ${Math.round(input.health)}/100`,
    });
  }

  const score = Math.max(0, Math.min(100, round(factors.reduce((s, f) => s + f.points, 0))));
  const level = BANDS.find((b) => score >= b.min)?.level ?? 'info';

  return {
    score,
    level,
    factors: factors.sort((a, b) => b.points - a.points),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

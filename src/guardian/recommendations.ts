import type { RepoRiskFactor } from './repo-risk';

export interface Recommendation {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly weight: 'high' | 'medium' | 'low';
}

export function buildRecommendations(input: {
  readonly secretCount: number;
  readonly untestedFileCount: number;
  readonly sourceFileCount: number;
  readonly vulnerablePackages: number;
  readonly highRiskComponents: Array<{ name: string; untestedFiles: number; changeFrequency: number }>;
  readonly recentRegressions: number;
  readonly riskFactors: readonly RepoRiskFactor[];
}): Recommendation[] {
  const out: Recommendation[] = [];

  if (input.secretCount > 0) {
    out.push({
      id: 'rotate-secrets',
      title: 'Rotate committed credentials',
      detail: `${input.secretCount} secret finding${input.secretCount === 1 ? '' : 's'} remain open. Rotate the credential and remove it from history.`,
      weight: 'high',
    });
  }

  if (input.recentRegressions > 0) {
    out.push({
      id: 'regressions',
      title: 'Previously fixed issues returned',
      detail: `${input.recentRegressions} fingerprint${input.recentRegressions === 1 ? '' : 's'} were resolved and are open again.`,
      weight: 'high',
    });
  }

  if (input.vulnerablePackages > 0) {
    out.push({
      id: 'deps',
      title: 'Upgrade packages with published advisories',
      detail: `${input.vulnerablePackages} dependenc${input.vulnerablePackages === 1 ? 'y has' : 'ies have'} known advisories from the configured data source.`,
      weight: 'high',
    });
  }

  const gap = input.sourceFileCount === 0 ? 0 : input.untestedFileCount / input.sourceFileCount;
  if (gap >= 0.4 && input.untestedFileCount >= 3) {
    out.push({
      id: 'tests',
      title: 'Large test gap',
      detail: `${input.untestedFileCount} of ${input.sourceFileCount} source files are not imported by any test.`,
      weight: 'medium',
    });
  }

  for (const component of input.highRiskComponents.slice(0, 3)) {
    if (component.untestedFiles > 0 && component.changeFrequency >= 2) {
      out.push({
        id: `hotspot:${component.name}`,
        title: `${component.name} is changing faster than it is tested`,
        detail: `${component.changeFrequency} recorded touches and ${component.untestedFiles} untested file${component.untestedFiles === 1 ? '' : 's'}.`,
        weight: 'medium',
      });
    }
  }

  return out;
}

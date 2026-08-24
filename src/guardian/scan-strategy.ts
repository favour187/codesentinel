/**
 * Targeted scanner selection.
 *
 * A full scan is always valid. When we know which paths changed, skip
 * scanners that cannot produce a finding on those paths. Safety first:
 * unknown or mixed changes fall back to every scanner.
 */

export const ALL_SCANNER_IDS = [
  'secrets',
  'security',
  'dependencies',
  'quality',
  'testing',
  'infrastructure',
  'cicd',
  'config',
] as const;

export type ScannerId = (typeof ALL_SCANNER_IDS)[number];

export interface ScanStrategy {
  readonly mode: 'full' | 'targeted';
  readonly scanners: readonly ScannerId[];
  readonly reason: string;
}

const RULES: Array<{ test: (path: string) => boolean; scanners: readonly ScannerId[] }> = [
  {
    test: (p) => /(^|\/)(\.env|secrets?|credentials?)/i.test(p),
    scanners: ['secrets', 'config', 'security'],
  },
  {
    test: (p) => /(^|\/)(auth|session|login|permission|token)/i.test(p),
    scanners: ['security', 'secrets', 'testing', 'quality'],
  },
  {
    test: (p) => /package\.json$|requirements.*\.txt$|pyproject\.toml$/.test(p),
    scanners: ['dependencies', 'security'],
  },
  {
    test: (p) => /(^|\/)\.github\/workflows\//.test(p),
    scanners: ['cicd', 'secrets', 'config'],
  },
  {
    test: (p) => /dockerfile|docker-compose/i.test(p),
    scanners: ['infrastructure', 'secrets', 'config'],
  },
  {
    test: (p) => /\.(ya?ml|toml|ini|json)$/i.test(p) && !/package\.json$/.test(p),
    scanners: ['config', 'cicd', 'secrets'],
  },
  {
    test: (p) => /\.(test|spec)\./.test(p) || /(^|\/)tests?\//.test(p),
    scanners: ['testing', 'quality'],
  },
  {
    test: (p) => /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(p),
    scanners: ['security', 'quality', 'testing', 'secrets'],
  },
];

export function selectScanners(changedPaths: readonly string[]): ScanStrategy {
  if (changedPaths.length === 0) {
    return {
      mode: 'full',
      scanners: [...ALL_SCANNER_IDS],
      reason: 'No changed-path list; every scanner runs.',
    };
  }

  const selected = new Set<ScannerId>();
  for (const path of changedPaths) {
    let matched = false;
    for (const rule of RULES) {
      if (rule.test(path)) {
        for (const id of rule.scanners) selected.add(id);
        matched = true;
      }
    }
    if (!matched) {
      return {
        mode: 'full',
        scanners: [...ALL_SCANNER_IDS],
        reason: `${path} matched no targeting rule; falling back to a full scan.`,
      };
    }
  }

  const scanners = ALL_SCANNER_IDS.filter((id) => selected.has(id));
  return {
    mode: 'targeted',
    scanners,
    reason: `${changedPaths.length} changed file${changedPaths.length === 1 ? '' : 's'} mapped to ${scanners.length} scanner${scanners.length === 1 ? '' : 's'}.`,
  };
}

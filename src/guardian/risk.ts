import type { Severity } from '@/db/schema';
import type { Finding } from '@/scanner/types';
import type { PullRequestFile } from '@/github/client';













export interface RiskFactor {
  id: string;
  label: string;

  points: number;
  detail: string;
}

export interface BlastRadius {

  changedFiles: string[];

  impactedFiles: string[];

  affectedComponents: string[];

  coveringTests: string[];

  uncoveredChanges: string[];
}

export interface PullRequestRisk {
  score: number;
  level: Severity;
  factors: RiskFactor[];
  blastRadius: BlastRadius;
  newFindings: Finding[];
  resolvedFingerprints: string[];

  shouldBlock: boolean;
  recommendedTests: string[];
  summary: string;
}


const NEW_FINDING_POINTS: Record<Severity, number> = {
  critical: 30,
  high: 15,
  medium: 6,
  low: 2,
  info: 0.5,
};


const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string; points: number }> = [
  { pattern: /(^|\/)(auth|authn|authz|session|login|permission|role)/i, label: 'authentication/authorization', points: 12 },
  { pattern: /(^|\/)(payment|billing|charge|invoice|checkout)/i, label: 'payment handling', points: 12 },
  { pattern: /(^|\/)(crypto|secret|token|credential|password)/i, label: 'cryptography/secrets', points: 10 },
  { pattern: /(^|\/)(migration|migrations|schema)\b/i, label: 'database schema', points: 8 },
  { pattern: /\.(ya?ml|tf|tfvars)$|dockerfile|docker-compose|\.github\/workflows/i, label: 'infrastructure/CI', points: 8 },
  { pattern: /(^|\/)(middleware|gateway|proxy|router|routes?)\b/i, label: 'request routing', points: 6 },
  { pattern: /package\.json$|requirements\.txt$|go\.mod$|pyproject\.toml$/i, label: 'dependency manifest', points: 5 },
  { pattern: /\.env|config|settings/i, label: 'configuration', points: 4 },
];

const SEVERITY_FLOOR: Array<{ min: number; level: Severity }> = [
  { min: 70, level: 'critical' },
  { min: 45, level: 'high' },
  { min: 22, level: 'medium' },
  { min: 8, level: 'low' },
  { min: 0, level: 'info' },
];

export interface AssessRiskInput {
  files: PullRequestFile[];

  newFindings: Finding[];

  resolvedFingerprints: string[];

  importGraph?: Map<string, string[]>;

  testFiles?: string[];

  failOnSeverity?: Severity;

  truncatedDiff?: boolean;
}

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

function meetsThreshold(level: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER.indexOf(level) >= SEVERITY_ORDER.indexOf(threshold);
}

export function assessPullRequestRisk(input: AssessRiskInput): PullRequestRisk {
  const {
    files,
    newFindings,
    resolvedFingerprints,
    importGraph = new Map(),
    testFiles = [],
    failOnSeverity = 'high',
    truncatedDiff = false,
  } = input;

  const factors: RiskFactor[] = [];
  const changedFiles = files.filter((f) => f.status !== 'removed').map((f) => f.filename);
  const allTouched = files.map((f) => f.filename);


  const bySeverity = new Map<Severity, number>();
  for (const finding of newFindings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }
  let findingPoints = 0;
  for (const [severity, count] of bySeverity) {


    const points = NEW_FINDING_POINTS[severity] * Math.sqrt(count);
    findingPoints += points;
  }
  if (findingPoints > 0) {
    const parts = SEVERITY_ORDER.slice()
      .reverse()
      .filter((s) => bySeverity.get(s))
      .map((s) => `${bySeverity.get(s)} ${s}`)
      .join(', ');
    factors.push({
      id: 'new-findings',
      label: 'New findings introduced',
      points: round(findingPoints),
      detail: `This change introduces ${parts}.`,
    });
  }


  const matchedAreas = new Map<string, { points: number; files: string[] }>();
  for (const file of allTouched) {
    for (const rule of SENSITIVE_PATTERNS) {
      if (rule.pattern.test(file)) {
        const entry = matchedAreas.get(rule.label) ?? { points: rule.points, files: [] };
        entry.files.push(file);
        matchedAreas.set(rule.label, entry);
      }
    }
  }
  for (const [label, entry] of matchedAreas) {
    factors.push({
      id: `sensitive:${label}`,
      label: `Touches ${label}`,
      points: entry.points,
      detail: `${entry.files.length} file(s): ${entry.files.slice(0, 3).join(', ')}${entry.files.length > 3 ? '…' : ''}`,
    });
  }


  const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);


  const sizePoints = Math.min(15, Math.max(0, Math.log10(Math.max(totalChanges, 1) / 20) * 10));
  if (sizePoints >= 1) {
    factors.push({
      id: 'diff-size',
      label: 'Change size',
      points: round(sizePoints),
      detail: `${files.length} file(s), ${totalChanges} line(s) changed — larger diffs are reviewed less thoroughly.`,
    });
  }


  const dependents = new Map<string, string[]>();
  for (const [file, imports] of importGraph) {
    for (const target of imports) {
      const list = dependents.get(target) ?? [];
      list.push(file);
      dependents.set(target, list);
    }
  }
  const impacted = new Set<string>();
  for (const changed of changedFiles) {
    for (const dependent of dependents.get(changed) ?? []) {
      if (!changedFiles.includes(dependent)) impacted.add(dependent);
    }
  }
  const impactedFiles = [...impacted].sort();
  if (impactedFiles.length > 0) {
    const points = Math.min(12, Math.log2(impactedFiles.length + 1) * 4);
    factors.push({
      id: 'blast-radius',
      label: 'Blast radius',
      points: round(points),
      detail: `${impactedFiles.length} other file(s) import the changed code and could break.`,
    });
  }


  const testSet = new Set(testFiles);
  const coveringTests = new Set<string>();
  const uncoveredChanges: string[] = [];

  for (const changed of changedFiles) {
    if (testSet.has(changed)) continue;
    const covering = findCoveringTests(changed, testFiles, importGraph);
    if (covering.length === 0) {
      if (isSourceFile(changed)) uncoveredChanges.push(changed);
    } else {
      for (const t of covering) coveringTests.add(t);
    }
  }

  if (uncoveredChanges.length > 0) {
    const points = Math.min(14, uncoveredChanges.length * 3.5);
    factors.push({
      id: 'untested-changes',
      label: 'Untested changes',
      points: round(points),
      detail: `${uncoveredChanges.length} changed source file(s) have no covering test: ${uncoveredChanges
        .slice(0, 3)
        .join(', ')}${uncoveredChanges.length > 3 ? '…' : ''}`,
    });
  }


  if (truncatedDiff) {
    factors.push({
      id: 'truncated-diff',
      label: 'Diff too large to analyse fully',
      points: 10,
      detail: 'GitHub truncated the file list; some changes were not analysed. Treat this assessment as a lower bound.',
    });
  }


  if (resolvedFingerprints.length > 0) {
    const credit = -Math.min(10, resolvedFingerprints.length * 2);
    factors.push({
      id: 'resolved-findings',
      label: 'Findings resolved',
      points: round(credit),
      detail: `${resolvedFingerprints.length} existing finding(s) are fixed by this change.`,
    });
  }

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, round(raw)));
  const bandLevel = SEVERITY_FLOOR.find((band) => score >= band.min)?.level ?? 'info';




  const worstNew = newFindings.reduce<Severity | null>(
    (worst, f) => (worst === null || meetsThreshold(f.severity, worst) ? f.severity : worst),
    null,
  );
  const shouldBlock = worstNew !== null && meetsThreshold(worstNew, failOnSeverity);









  const level: Severity =
    worstNew !== null && meetsThreshold(worstNew, bandLevel) ? worstNew : bandLevel;

  return {
    score,
    level,
    factors: factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)),
    blastRadius: {
      changedFiles,
      impactedFiles,
      affectedComponents: [...matchedAreas.keys()].sort(),
      coveringTests: [...coveringTests].sort(),
      uncoveredChanges,
    },
    newFindings,
    resolvedFingerprints,
    shouldBlock,
    recommendedTests: recommendTests(uncoveredChanges, newFindings, impactedFiles),
    summary: buildSummary(score, level, newFindings.length, resolvedFingerprints.length, shouldBlock),
  };
}


function findCoveringTests(
  filePath: string,
  testFiles: string[],
  importGraph: Map<string, string[]>,
): string[] {
  const covering: string[] = [];
  const base = filePath.replace(/\.[^./]+$/, '').split('/').pop() ?? filePath;

  for (const test of testFiles) {
    const imports = importGraph.get(test) ?? [];
    if (imports.includes(filePath)) {
      covering.push(test);
      continue;
    }
    const testBase = test.replace(/\.(test|spec)\.[^./]+$/, '').split('/').pop();
    if (testBase && base && testBase === base) covering.push(test);
  }
  return covering;
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|php)$/i.test(path) && !/\.(test|spec)\./i.test(path);
}


function recommendTests(uncovered: string[], newFindings: Finding[], impacted: string[]): string[] {
  const out: string[] = [];

  for (const finding of newFindings.slice(0, 5)) {
    if (!finding.filePath) continue;
    out.push(
      `Regression test for ${finding.ruleId} in ${finding.filePath}` +
        (finding.lineStart ? ` (line ${finding.lineStart})` : '') +
        ': assert the unsafe path is rejected.',
    );
  }
  for (const file of uncovered.slice(0, 4)) {
    out.push(`Unit test for ${file} — it changed in this PR and has no covering test.`);
  }
  if (impacted.length > 0) {
    out.push(
      `Integration test across ${impacted.slice(0, 3).join(', ')} — ${impacted.length} file(s) depend on the changed code.`,
    );
  }
  return out;
}

function buildSummary(
  score: number,
  level: Severity,
  newCount: number,
  resolvedCount: number,
  blocked: boolean,
): string {
  const verdict = blocked
    ? 'This pull request is blocked by policy'
    : level === 'critical' || level === 'high'
      ? 'This pull request needs careful review'
      : level === 'medium'
        ? 'This pull request carries moderate risk'
        : 'This pull request looks low risk';

  const bits = [`${verdict} (risk ${score}/100, ${level}).`];
  if (newCount > 0) bits.push(`${newCount} new finding${newCount === 1 ? '' : 's'} introduced.`);
  if (resolvedCount > 0) bits.push(`${resolvedCount} finding${resolvedCount === 1 ? '' : 's'} resolved.`);
  if (newCount === 0 && resolvedCount === 0) bits.push('No change in findings.');
  return bits.join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

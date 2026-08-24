import type { Severity } from '@/db/schema';
import type { Finding } from '@/scanner/types';
import type { PullRequestFile } from '@/github/client';

/**
 * Deterministic pull-request risk assessment.
 *
 * This is arithmetic over the diff and the finding delta — no LLM. Two runs on
 * the same PR always produce the same number, which is what makes it fit to
 * gate a merge. Every point is attributed to a named factor so the UI and the
 * PR comment can explain *why* a PR is risky instead of showing a bare score.
 *
 * The score is intentionally NOT the health score: health answers "how is the
 * repository doing?", risk answers "how dangerous is merging this change?".
 */

export interface RiskFactor {
  id: string;
  label: string;
  /** Contribution to the 0..100 risk score. */
  points: number;
  detail: string;
}

export interface BlastRadius {
  /** Files directly edited by the PR. */
  changedFiles: string[];
  /** Files that import a changed file (first-order dependents). */
  impactedFiles: string[];
  /** Architectural areas touched, e.g. "auth", "routes", "config". */
  affectedComponents: string[];
  /** Test files covering changed or impacted files. */
  coveringTests: string[];
  /** Changed source files with no covering test — the dangerous set. */
  uncoveredChanges: string[];
}

export interface PullRequestRisk {
  score: number;
  level: Severity;
  factors: RiskFactor[];
  blastRadius: BlastRadius;
  newFindings: Finding[];
  resolvedFingerprints: string[];
  /** Whether policy says this PR should block the merge. */
  shouldBlock: boolean;
  recommendedTests: string[];
  summary: string;
}

/** Severity weights for findings introduced by the PR. */
const NEW_FINDING_POINTS: Record<Severity, number> = {
  critical: 30,
  high: 15,
  medium: 6,
  low: 2,
  info: 0.5,
};

/** Paths whose modification carries inherent risk regardless of diff size. */
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
  /** Findings present on the PR head that were absent from the base scan. */
  newFindings: Finding[];
  /** Fingerprints present on base but gone on head. */
  resolvedFingerprints: string[];
  /** Import graph of the head tree: file path -> internal imports. */
  importGraph?: Map<string, string[]>;
  /** All known test file paths in the head tree. */
  testFiles?: string[];
  /** Severity at/above which policy blocks the merge. */
  failOnSeverity?: Severity;
  /** True when the diff was too large to fetch completely. */
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

  /* --- 1. Findings introduced by this PR -------------------------------- */
  const bySeverity = new Map<Severity, number>();
  for (const finding of newFindings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }
  let findingPoints = 0;
  for (const [severity, count] of bySeverity) {
    // sqrt-damped: the 5th medium matters less than the 1st, but a single
    // critical still dominates the score.
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

  /* --- 2. Sensitive areas touched --------------------------------------- */
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

  /* --- 3. Diff size ------------------------------------------------------ */
  const totalChanges = files.reduce((sum, f) => sum + f.changes, 0);
  // Large diffs are harder to review; log-scaled so a 5000-line PR is not 50x
  // a 100-line one, capped at 15.
  const sizePoints = Math.min(15, Math.max(0, Math.log10(Math.max(totalChanges, 1) / 20) * 10));
  if (sizePoints >= 1) {
    factors.push({
      id: 'diff-size',
      label: 'Change size',
      points: round(sizePoints),
      detail: `${files.length} file(s), ${totalChanges} line(s) changed — larger diffs are reviewed less thoroughly.`,
    });
  }

  /* --- 4. Blast radius via the import graph ----------------------------- */
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

  /* --- 5. Test coverage of the change ----------------------------------- */
  const testSet = new Set(testFiles);
  const coveringTests = new Set<string>();
  const uncoveredChanges: string[] = [];

  for (const changed of changedFiles) {
    if (testSet.has(changed)) continue; // the change IS a test
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

  /* --- 6. Truncated diff -------------------------------------------------- */
  if (truncatedDiff) {
    factors.push({
      id: 'truncated-diff',
      label: 'Diff too large to analyse fully',
      points: 10,
      detail: 'GitHub truncated the file list; some changes were not analysed. Treat this assessment as a lower bound.',
    });
  }

  /* --- 7. Credit for fixes ------------------------------------------------ */
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

  // A PR that introduces a finding at/above the policy threshold blocks the
  // merge regardless of the aggregate score: one critical secret in a tiny diff
  // must not be averaged away by an otherwise-clean change.
  const worstNew = newFindings.reduce<Severity | null>(
    (worst, f) => (worst === null || meetsThreshold(f.severity, worst) ? f.severity : worst),
    null,
  );
  const shouldBlock = worstNew !== null && meetsThreshold(worstNew, failOnSeverity);

  /*
   * The level is floored by the worst finding this PR introduces.
   *
   * Without this, a two-line diff that adds a hardcoded credential scores in
   * the "low" band on points alone and gets labelled low risk while the check
   * blocks the merge — a contradiction that destroys trust in the label. The
   * numeric score stays untouched; only the human-readable level is corrected.
   */
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

/** A test covers a file if it imports it, or matches it by name convention. */
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

/** Concrete, path-specific test suggestions — never generic advice. */
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

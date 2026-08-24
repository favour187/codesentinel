import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { dependencies, files, findings, tests } from '@/db/schema';
import type { Severity } from '@/db/schema';
import { latestScanId } from '@/ai/context';

/**
 * Technical debt estimate.
 *
 * Deterministic metrics first: every hour in the total traces back to a
 * counted thing (a finding, a stale dependency, an untested file). The number
 * is an *estimate* and is labelled as one everywhere it is shown — the value
 * is in the relative ranking of contributors, not in the absolute hours.
 */

export interface DebtContributor {
  readonly id: string;
  readonly label: string;
  readonly hours: number;
  readonly count: number;
  readonly detail: string;
}

export interface TechnicalDebt {
  readonly totalHours: number;
  readonly contributors: readonly DebtContributor[];
  readonly metrics: {
    readonly fileCount: number;
    readonly totalLoc: number;
    readonly complexFiles: number;
    readonly untestedSourceFiles: number;
    readonly staleDependencies: number;
    readonly vulnerableDependencies: number;
    readonly openFindings: number;
    readonly recurringFindings: number;
  };
}

/** Remediation effort per finding severity. Mirrors scanner/scoring.ts. */
const FINDING_HOURS: Record<Severity, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
  info: 0.15,
};

/** A file above this complexity is treated as needing refactoring effort. */
const COMPLEXITY_THRESHOLD = 25;
const HOURS_PER_COMPLEX_FILE = 1.5;
const HOURS_PER_UNTESTED_FILE = 0.75;
const HOURS_PER_STALE_DEPENDENCY = 0.5;
const HOURS_PER_VULNERABLE_DEPENDENCY = 1.5;

export async function computeTechnicalDebt(repositoryId: string): Promise<TechnicalDebt> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);

  const emptyMetrics = {
    fileCount: 0,
    totalLoc: 0,
    complexFiles: 0,
    untestedSourceFiles: 0,
    staleDependencies: 0,
    vulnerableDependencies: 0,
    openFindings: 0,
    recurringFindings: 0,
  };

  if (!scanId) return { totalHours: 0, contributors: [], metrics: emptyMetrics };

  const [fileRows, depRows, testRows, findingRows] = await Promise.all([
    db.select().from(files).where(eq(files.scanId, scanId)),
    db.select().from(dependencies).where(eq(dependencies.scanId, scanId)),
    db.select().from(tests).where(eq(tests.scanId, scanId)),
    db
      .select({
        severity: findings.severity,
        ruleId: findings.ruleId,
        fingerprint: findings.fingerprint,
        filePath: findings.filePath,
      })
      .from(findings)
      .where(and(eq(findings.repositoryId, repositoryId), inArray(findings.status, ['open', 'proposed']))),
  ]);

  const contributors: DebtContributor[] = [];

  /* 1. Open findings — the largest and best-evidenced component. */
  const findingHours = findingRows.reduce((sum, f) => sum + FINDING_HOURS[f.severity], 0);
  if (findingRows.length > 0) {
    const bySeverity = new Map<Severity, number>();
    for (const f of findingRows) bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    contributors.push({
      id: 'findings',
      label: 'Open findings',
      hours: round(findingHours),
      count: findingRows.length,
      detail: [...bySeverity.entries()]
        .sort((a, b) => FINDING_HOURS[b[0]] - FINDING_HOURS[a[0]])
        .map(([sev, n]) => `${n} ${sev}`)
        .join(', '),
    });
  }

  /* 2. Complexity. */
  const complexFiles = fileRows.filter((f) => (f.complexity ?? 0) >= COMPLEXITY_THRESHOLD);
  if (complexFiles.length > 0) {
    contributors.push({
      id: 'complexity',
      label: 'High-complexity files',
      hours: round(complexFiles.length * HOURS_PER_COMPLEX_FILE),
      count: complexFiles.length,
      detail: `files with estimated complexity ≥ ${COMPLEXITY_THRESHOLD}, e.g. ${complexFiles
        .slice(0, 3)
        .map((f) => f.path)
        .join(', ')}`,
    });
  }

  /* 3. Test gaps. Only source files count — configs and generated files
   *    would inflate this into meaninglessness. */
  const coveredPaths = new Set(testRows.flatMap((t) => t.coversPaths));
  const testFilePaths = new Set(testRows.map((t) => t.filePath));
  const sourceFiles = fileRows.filter(
    (f) => f.kind !== 'test' && f.kind !== 'config' && !testFilePaths.has(f.path) && f.loc >= 20,
  );
  const untested = sourceFiles.filter((f) => !coveredPaths.has(f.path));
  if (untested.length > 0) {
    contributors.push({
      id: 'test-gaps',
      label: 'Untested source files',
      hours: round(untested.length * HOURS_PER_UNTESTED_FILE),
      count: untested.length,
      detail: `${untested.length} of ${sourceFiles.length} source file(s) have no detected covering test`,
    });
  }

  /* 4. Dependencies. */
  const vulnerable = depRows.filter((d) => d.vulnerabilities.length > 0);
  if (vulnerable.length > 0) {
    contributors.push({
      id: 'vulnerable-deps',
      label: 'Vulnerable dependencies',
      hours: round(vulnerable.length * HOURS_PER_VULNERABLE_DEPENDENCY),
      count: vulnerable.length,
      detail: vulnerable
        .slice(0, 4)
        .map((d) => `${d.name}@${d.version ?? d.versionSpec ?? '?'}`)
        .join(', '),
    });
  }

  const stale = depRows.filter(
    (d) => d.latestVersion && d.version && isMajorBehind(d.version, d.latestVersion),
  );
  if (stale.length > 0) {
    contributors.push({
      id: 'stale-deps',
      label: 'Outdated dependencies',
      hours: round(stale.length * HOURS_PER_STALE_DEPENDENCY),
      count: stale.length,
      detail: `${stale.length} package(s) at least one major version behind`,
    });
  }

  /* 5. Recurring findings: the same rule firing across many files is a
   *    systemic issue, and fixing it one file at a time is how debt sticks. */
  const byRule = new Map<string, number>();
  for (const f of findingRows) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  const recurring = [...byRule.entries()].filter(([, n]) => n >= 3);
  const recurringCount = recurring.reduce((sum, [, n]) => sum + n, 0);

  const totalHours = round(contributors.reduce((sum, c) => sum + c.hours, 0));

  return {
    totalHours,
    contributors: [...contributors].sort((a, b) => b.hours - a.hours),
    metrics: {
      fileCount: fileRows.length,
      totalLoc: fileRows.reduce((sum, f) => sum + f.loc, 0),
      complexFiles: complexFiles.length,
      untestedSourceFiles: untested.length,
      staleDependencies: stale.length,
      vulnerableDependencies: vulnerable.length,
      openFindings: findingRows.length,
      recurringFindings: recurringCount,
    },
  };
}

/** True when `current` is at least one major version behind `latest`. */
export function isMajorBehind(current: string, latest: string): boolean {
  const major = (v: string) => Number.parseInt(v.replace(/^[^\d]*/, '').split('.')[0] ?? '', 10);
  const a = major(current);
  const b = major(latest);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return b > a;
}

/** Count of TODO/FIXME markers recorded by the quality scanner. */
export async function countDebtMarkers(repositoryId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .where(
      and(
        eq(findings.repositoryId, repositoryId),
        inArray(findings.status, ['open', 'proposed']),
        sql`${findings.ruleId} like '%todo%' or ${findings.ruleId} like '%fixme%'`,
      ),
    );
  return rows[0]?.n ?? 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

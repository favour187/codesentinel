import { desc, eq, and, sql } from 'drizzle-orm';
import { db, scans, findings, healthSnapshots } from '@/db';
import type { Severity, Category, ScanStatus } from '@/db/schema';

/**
 * Read-side queries shared by the dashboard pages.
 * Kept separate from the scanning engine so UI code never imports scanner
 * internals (and cannot accidentally trigger a scan during render).
 */

export interface HealthSnapshotView {
  id: string;
  health: number;
  security: number;
  reliability: number;
  quality: number;
  testing: number;
  performance: number;
  counts: Record<Severity, number>;
  issuesResolved: number;
  issuesIntroduced: number;
  debtHours: number;
  createdAt: Date;
}

export async function getLatestSnapshot(repositoryId: string): Promise<HealthSnapshotView | null> {
  const database = await db();
  const [row] = await database
    .select()
    .from(healthSnapshots)
    .where(eq(healthSnapshots.repositoryId, repositoryId))
    .orderBy(desc(healthSnapshots.createdAt))
    .limit(1);

  return row
    ? {
        id: row.id,
        health: row.health,
        security: row.security,
        reliability: row.reliability,
        quality: row.quality,
        testing: row.testing,
        performance: row.performance,
        counts: row.counts,
        issuesResolved: row.issuesResolved,
        issuesIntroduced: row.issuesIntroduced,
        debtHours: row.debtHours,
        createdAt: row.createdAt,
      }
    : null;
}

export async function getSnapshotHistory(repositoryId: string, limit = 30): Promise<HealthSnapshotView[]> {
  const database = await db();
  const rows = await database
    .select()
    .from(healthSnapshots)
    .where(eq(healthSnapshots.repositoryId, repositoryId))
    .orderBy(desc(healthSnapshots.createdAt))
    .limit(limit);

  return rows
    .map((row) => ({
      id: row.id,
      health: row.health,
      security: row.security,
      reliability: row.reliability,
      quality: row.quality,
      testing: row.testing,
      performance: row.performance,
      counts: row.counts,
      issuesResolved: row.issuesResolved,
      issuesIntroduced: row.issuesIntroduced,
      debtHours: row.debtHours,
      createdAt: row.createdAt,
    }))
    .reverse();
}

export interface ScanView {
  id: string;
  status: ScanStatus;
  trigger: string;
  commitSha: string | null;
  filesScanned: number;
  durationMs: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export async function getRecentScans(repositoryId: string, limit = 10): Promise<ScanView[]> {
  const database = await db();
  const rows = await database
    .select()
    .from(scans)
    .where(eq(scans.repositoryId, repositoryId))
    .orderBy(desc(scans.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    commitSha: r.commitSha,
    filesScanned: r.filesScanned,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));
}

export interface FindingView {
  id: string;
  ruleId: string;
  scannerId: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  evidence: string | null;
  confidence: number;
  whyItMatters: string | null;
  remediation: string | null;
  createdAt: Date;
}

/** Open findings for a repository, most severe first. */
/**
 * Severity ranking expressed in SQL.
 *
 * This must be applied by the database, not by sorting the result in JS. The
 * query is limited, so sorting after the fact only reorders whichever page was
 * fetched: a critical finding older than `limit` newer low-severity findings
 * would be dropped before the sort ever saw it, and would vanish from the
 * dashboard entirely.
 */
const SEVERITY_RANK_SQL = sql`
  case ${findings.severity}
    when 'critical' then 0
    when 'high' then 1
    when 'medium' then 2
    when 'low' then 3
    else 4
  end
`;

/**
 * Findings currently live for a repository.
 *
 * Only `open` counts: `superseded` rows are the previous scan's copy of a
 * still-present issue, and `resolved` / `ignored` / `false_positive` are
 * retired. After a few scans the table is mostly history, so this filter is
 * what keeps the dashboard showing the present rather than the archive.
 */
export async function getOpenFindings(repositoryId: string, limit = 100): Promise<FindingView[]> {
  const database = await db();
  const rows = await database
    .select()
    .from(findings)
    .where(and(eq(findings.repositoryId, repositoryId), eq(findings.status, 'open')))
    .orderBy(SEVERITY_RANK_SQL, desc(findings.createdAt))
    .limit(limit);

  return rows.map(toFindingView);
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

type FindingRow = typeof findings.$inferSelect;

function toFindingView(row: FindingRow): FindingView {
  return {
    id: row.id,
    ruleId: row.ruleId,
    scannerId: row.scannerId,
    severity: row.severity,
    category: row.category,
    title: row.title,
    description: row.description,
    filePath: row.filePath,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    evidence: row.evidence,
    confidence: row.confidence,
    whyItMatters: row.whyItMatters,
    remediation: row.remediation,
    createdAt: row.createdAt,
  };
}

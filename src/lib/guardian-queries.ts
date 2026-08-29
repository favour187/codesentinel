import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { findings, pullRequests, repositories, scanJobs, scans, webhookDeliveries } from '@/db/schema';
import type { Severity } from '@/db/schema';
import type { RiskFactor } from '@/guardian/risk';
import { getRepositoryPolicy } from './repositories';
import type { RepositoryPolicy } from './repositories';









export interface GuardianConnectionStatus {
  repositoryId: string;
  fullName: string;
  source: string;
  guardianEnabled: boolean;

  installed: boolean;
  defaultBranch: string;
  lastScanAt: Date | null;
}

export interface WebhookDeliverySummary {
  id: string;
  deliveryId: string;
  event: string;
  action: string | null;
  status: string;
  message: string | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface ScanJobSummary {
  id: string;
  status: string;
  trigger: string;
  commitSha: string | null;
  ref: string | null;
  pullRequestNumber: number | null;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface GuardedPullRequest {
  id: string;
  number: number;
  title: string | null;
  authorLogin: string | null;
  state: string;
  headRef: string | null;
  baseRef: string | null;
  headSha: string | null;
  riskLevel: Severity | null;
  riskScore: number | null;
  riskFactors: RiskFactor[];
  filesChanged: number;
  additions: number;
  deletions: number;
  updatedAt: Date;





  findingsOnHead: number;
  checkConclusion: string | null;
}

export interface GuardianOverview {
  connection: GuardianConnectionStatus;
  policy: RepositoryPolicy;
  deliveries: WebhookDeliverySummary[];
  jobs: ScanJobSummary[];
  pullRequests: GuardedPullRequest[];
  stats: {
    deliveriesLast7Days: number;
    processedLast7Days: number;
    failedLast7Days: number;
    queuedJobs: number;
    runningJobs: number;
    openRiskyPullRequests: number;
  };
}

export async function getGuardianOverview(repositoryId: string): Promise<GuardianOverview | null> {
  const db = await getDb();

  const repoRows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      source: repositories.source,
      guardianEnabled: repositories.guardianEnabled,
      installationId: repositories.installationId,
      defaultBranch: repositories.defaultBranch,
      lastScanAt: repositories.lastScanAt,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const repo = repoRows[0];
  if (!repo) return null;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [policy, deliveries, jobs, prRows, deliveryStats, jobStats] = await Promise.all([
    getRepositoryPolicy(repositoryId),
    db
      .select({
        id: webhookDeliveries.id,
        deliveryId: webhookDeliveries.deliveryId,
        event: webhookDeliveries.event,
        action: webhookDeliveries.action,
        status: webhookDeliveries.status,
        message: webhookDeliveries.message,
        durationMs: webhookDeliveries.durationMs,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.repositoryFullName, repo.fullName))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(15),
    db
      .select({
        id: scanJobs.id,
        status: scanJobs.status,
        trigger: scanJobs.trigger,
        commitSha: scanJobs.commitSha,
        ref: scanJobs.ref,
        pullRequestNumber: scanJobs.pullRequestNumber,
        attempts: scanJobs.attempts,
        maxAttempts: scanJobs.maxAttempts,
        error: scanJobs.error,
        createdAt: scanJobs.createdAt,
        finishedAt: scanJobs.finishedAt,
      })
      .from(scanJobs)
      .where(eq(scanJobs.repositoryId, repositoryId))
      .orderBy(desc(scanJobs.createdAt))
      .limit(15),
    db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        authorLogin: pullRequests.authorLogin,
        state: pullRequests.state,
        headRef: pullRequests.headRef,
        baseRef: pullRequests.baseRef,
        headSha: pullRequests.headSha,
        riskLevel: pullRequests.riskLevel,
        riskScore: pullRequests.riskScore,
        riskFactors: pullRequests.riskFactors,
        filesChanged: pullRequests.filesChanged,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        updatedAt: pullRequests.updatedAt,
      })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repositoryId))


      .orderBy(desc(pullRequests.riskScore), desc(pullRequests.updatedAt))
      .limit(10),
    db
      .select({
        total: sql<number>`count(*)::int`,
        processed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'processed')::int`,
        failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')::int`,
      })
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.repositoryFullName, repo.fullName), gte(webhookDeliveries.createdAt, since)),
      ),
    db
      .select({
        queued: sql<number>`count(*) filter (where ${scanJobs.status} = 'queued')::int`,
        running: sql<number>`count(*) filter (where ${scanJobs.status} = 'running')::int`,
      })
      .from(scanJobs)
      .where(eq(scanJobs.repositoryId, repositoryId)),
  ]);







  const perPullRequest = await db
    .select({
      pullRequestId: scans.pullRequestId,
      scanId: scans.id,
      checkConclusion: scans.checkConclusion,
      findingCount: sql<number>`(
        select count(*)::int from ${findings} where ${findings.scanId} = ${scans.id}
      )`,
    })
    .from(scans)
    .where(
      and(
        eq(scans.repositoryId, repositoryId),
        eq(scans.trigger, 'pull_request'),
        eq(scans.status, 'completed'),
      ),
    )
    .orderBy(scans.pullRequestId, desc(scans.createdAt));


  const latestByPr = new Map<string, { checkConclusion: string | null; findingCount: number }>();
  for (const row of perPullRequest) {
    if (!row.pullRequestId || latestByPr.has(row.pullRequestId)) continue;
    latestByPr.set(row.pullRequestId, {
      checkConclusion: row.checkConclusion,
      findingCount: row.findingCount,
    });
  }

  const stats = deliveryStats[0] ?? { total: 0, processed: 0, failed: 0 };
  const jobCounts = jobStats[0] ?? { queued: 0, running: 0 };

  const guardedPullRequests: GuardedPullRequest[] = prRows.map((row) => ({
    ...row,
    riskFactors: Array.isArray(row.riskFactors) ? (row.riskFactors as RiskFactor[]) : [],
    filesChanged: row.filesChanged ?? 0,
    additions: row.additions ?? 0,
    deletions: row.deletions ?? 0,
    findingsOnHead: latestByPr.get(row.id)?.findingCount ?? 0,
    checkConclusion: latestByPr.get(row.id)?.checkConclusion ?? null,
  }));

  return {
    connection: {
      repositoryId: repo.id,
      fullName: repo.fullName,
      source: repo.source,
      guardianEnabled: repo.guardianEnabled,
      installed: repo.installationId !== null,
      defaultBranch: repo.defaultBranch,
      lastScanAt: repo.lastScanAt,
    },
    policy,
    deliveries,
    jobs,
    pullRequests: guardedPullRequests,
    stats: {
      deliveriesLast7Days: stats.total,
      processedLast7Days: stats.processed,
      failedLast7Days: stats.failed,
      queuedJobs: jobCounts.queued,
      runningJobs: jobCounts.running,
      openRiskyPullRequests: guardedPullRequests.filter(
        (pr) => pr.state === 'open' && (pr.riskLevel === 'critical' || pr.riskLevel === 'high'),
      ).length,
    },
  };
}

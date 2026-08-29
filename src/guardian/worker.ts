import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { installations, repositories } from '@/db/schema';
import { claimNextJob, completeJob, failJob } from './jobs';
import type { ScanJob } from './jobs';
import { scanBranch, scanPullRequest } from './pipeline';
import type { RepositoryRef } from './pipeline';
import { GitHubClient } from '@/github/client';
import { isGitHubAppConfigured } from '@/github/app-auth';
import { createLogger } from '@/lib/logger';












const log = createLogger('guardian:worker');

export interface WorkerResult {
  processed: number;
  succeeded: number;
  failed: number;
  jobs: Array<{ jobId: string; status: 'completed' | 'failed'; message: string }>;
}

export interface RunWorkerOptions {

  maxJobs?: number;

  budgetMs?: number;
  workerId?: string;

  clientFactory?: (installationId: number) => Promise<GitHubClient>;
}

export async function runWorker(options: RunWorkerOptions = {}): Promise<WorkerResult> {
  const { maxJobs = 5, budgetMs = 4 * 60 * 1000, clientFactory } = options;
  const workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + budgetMs;

  const result: WorkerResult = { processed: 0, succeeded: 0, failed: 0, jobs: [] };

  for (let i = 0; i < maxJobs; i++) {
    if (Date.now() > deadline) {
      log.info('Worker budget exhausted', { workerId, processed: result.processed });
      break;
    }

    const job = await claimNextJob(workerId);
    if (!job) break;

    result.processed++;
    try {
      const message = await processJob(job, clientFactory);
      result.succeeded++;
      result.jobs.push({ jobId: job.id, status: 'completed', message });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failJob(job.id, message);
      result.failed++;
      result.jobs.push({ jobId: job.id, status: 'failed', message });
      log.error('Job processing failed', { jobId: job.id, error: message });
    }
  }

  return result;
}

async function processJob(
  job: ScanJob,
  clientFactory?: (installationId: number) => Promise<GitHubClient>,
): Promise<string> {
  const repository = await loadRepositoryRef(job.repositoryId);
  if (!repository) throw new Error(`Repository ${job.repositoryId} no longer exists`);

  if (repository.installationId === null) {
    throw new Error(
      `Repository ${repository.fullName} has no GitHub App installation — reinstall the app to enable guardian scans`,
    );
  }

  if (!clientFactory && !isGitHubAppConfigured()) {
    throw new Error('GitHub App is not configured on this deployment; cannot fetch repository contents');
  }

  const client = clientFactory
    ? await clientFactory(repository.installationId)
    : await GitHubClient.forInstallation(repository.installationId);

  if (job.pullRequestNumber) {
    const pr = await fetchPullRequestRefs(client, repository, job.pullRequestNumber);
    const outcome = await scanPullRequest({
      repository,
      number: job.pullRequestNumber,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      title: pr.title,
      authorLogin: pr.authorLogin,
      client,
    });
    await completeJob(job.id, outcome.scanId);
    return `PR #${job.pullRequestNumber}: risk ${outcome.risk.score} (${outcome.risk.level}), ${outcome.risk.newFindings.length} new finding(s), check ${outcome.conclusion}`;
  }

  let commitSha = job.commitSha;
  if (!commitSha) {
    const head = await client.getCommit(repository.owner, repository.name, repository.defaultBranch);
    commitSha = head.sha;
  }

  const outcome = await scanBranch({
    repository,
    ref: job.ref ?? `refs/heads/${repository.defaultBranch}`,
    commitSha,
    trigger: job.trigger,
    client,
  });
  await completeJob(job.id, outcome.scanId);
  return `Branch scan: ${outcome.findings} finding(s), health ${outcome.health}`;
}








async function loadRepositoryRef(repositoryId: string): Promise<RepositoryRef | null> {
  const db = await getDb();
  const rows = await db
    .select({
      id: repositories.id,
      owner: repositories.owner,
      name: repositories.name,
      fullName: repositories.fullName,
      defaultBranch: repositories.defaultBranch,
      githubInstallationId: installations.installationId,
      suspendedAt: installations.suspendedAt,
    })
    .from(repositories)
    .leftJoin(installations, eq(repositories.installationId, installations.id))
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.suspendedAt) {
    throw new Error(`GitHub App installation for ${row.fullName} is suspended or removed`);
  }

  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    installationId: row.githubInstallationId ?? null,
    defaultBranch: row.defaultBranch,
  };
}

interface PullRequestRefs {
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  title: string | null;
  authorLogin: string | null;
}








async function fetchPullRequestRefs(
  client: GitHubClient,
  repository: RepositoryRef,
  number: number,
): Promise<PullRequestRefs> {
  const pr = await client.getPullRequest(repository.owner, repository.name, number);

  return {
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    title: pr.title ?? null,
    authorLogin: pr.user?.login ?? null,
  };
}

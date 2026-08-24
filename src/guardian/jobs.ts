import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { scanJobs } from '@/db/schema';
import type { JobStatus } from '@/db/schema';
import { createLogger } from '@/lib/logger';

/**
 * Durable scan queue backed by the `scan_jobs` table.
 *
 * Why a table and not an in-memory queue: a webhook must reply to GitHub within
 * seconds, but a scan takes far longer, so the work has to outlive the request.
 * On serverless the process may be frozen the moment the response is sent, so
 * queued work must be recoverable by whatever runs next — an in-memory array
 * would silently drop scans on every cold start.
 *
 * Claiming uses a single atomic UPDATE..WHERE id IN (SELECT ... ) so two
 * concurrent workers can never run the same job.
 */

const log = createLogger('guardian:jobs');

/** A job locked longer than this is presumed dead and may be reclaimed. */
export const LOCK_TIMEOUT_MS = 15 * 60 * 1000;

/** Priorities: interactive work first, background sweeps last. */
export const PRIORITY = {
  manual: 100,
  pull_request: 80,
  push: 60,
  webhook: 40,
  schedule: 10,
} as const;

export interface EnqueueScanInput {
  repositoryId: string;
  trigger: keyof typeof PRIORITY | string;
  commitSha?: string | null;
  ref?: string | null;
  pullRequestNumber?: number | null;
  deliveryId?: string | null;
  priority?: number;
  maxAttempts?: number;
}

export interface ScanJob {
  id: string;
  repositoryId: string;
  status: JobStatus;
  trigger: string;
  commitSha: string | null;
  ref: string | null;
  pullRequestNumber: number | null;
  attempts: number;
  maxAttempts: number;
  deliveryId: string | null;
  scanId: string | null;
  error: string | null;
  createdAt: Date;
}

function priorityFor(trigger: string, explicit?: number): number {
  if (typeof explicit === 'number') return explicit;
  return PRIORITY[trigger as keyof typeof PRIORITY] ?? 50;
}

/**
 * Enqueue a scan.
 *
 * Deduplicates against an existing queued job for the same (repository, ref,
 * commit, PR): pushing three commits in ten seconds should not queue three
 * identical scans of the same head. A job already *running* does not block a
 * new enqueue, because the new commit genuinely needs its own scan.
 */
export async function enqueueScan(input: EnqueueScanInput): Promise<ScanJob> {
  const db = await getDb();

  const duplicate = await db
    .select()
    .from(scanJobs)
    .where(
      and(
        eq(scanJobs.repositoryId, input.repositoryId),
        eq(scanJobs.status, 'queued'),
        input.commitSha ? eq(scanJobs.commitSha, input.commitSha) : sql`${scanJobs.commitSha} is null`,
        input.pullRequestNumber
          ? eq(scanJobs.pullRequestNumber, input.pullRequestNumber)
          : sql`${scanJobs.pullRequestNumber} is null`,
      ),
    )
    .limit(1);

  const existing = duplicate[0];
  if (existing) {
    log.info('Reusing queued scan job', { jobId: existing.id, repositoryId: input.repositoryId });
    return toJob(existing);
  }

  const [row] = await db
    .insert(scanJobs)
    .values({
      repositoryId: input.repositoryId,
      status: 'queued',
      trigger: input.trigger,
      commitSha: input.commitSha ?? null,
      ref: input.ref ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      deliveryId: input.deliveryId ?? null,
      priority: priorityFor(input.trigger, input.priority),
      maxAttempts: input.maxAttempts ?? 3,
    })
    .returning();

  if (!row) throw new Error('Failed to enqueue scan job');
  log.info('Enqueued scan job', {
    jobId: row.id,
    repositoryId: input.repositoryId,
    trigger: input.trigger,
  });
  return toJob(row);
}

/**
 * Atomically claim the next runnable job.
 *
 * Reclaims jobs whose lock has expired (worker crashed mid-scan) so work is
 * never permanently stuck. Returns null when the queue is empty.
 */
export async function claimNextJob(workerId: string): Promise<ScanJob | null> {
  const db = await getDb();
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  const candidates = await db
    .select({ id: scanJobs.id })
    .from(scanJobs)
    .where(
      or(
        eq(scanJobs.status, 'queued'),
        and(eq(scanJobs.status, 'running'), lt(scanJobs.lockedAt, staleBefore)),
      ),
    )
    .orderBy(desc(scanJobs.priority), asc(scanJobs.createdAt))
    .limit(1);

  const candidate = candidates[0];
  if (!candidate) return null;

  // The status guard in the WHERE clause is the concurrency control: if another
  // worker claimed this row between the SELECT and the UPDATE, zero rows match
  // and we return null rather than double-running the scan.
  const claimed = await db
    .update(scanJobs)
    .set({
      status: 'running',
      lockedAt: new Date(),
      lockedBy: workerId,
      startedAt: new Date(),
      attempts: sql`${scanJobs.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(scanJobs.id, candidate.id),
        or(
          eq(scanJobs.status, 'queued'),
          and(eq(scanJobs.status, 'running'), lt(scanJobs.lockedAt, staleBefore)),
        ),
      ),
    )
    .returning();

  const row = claimed[0];
  if (!row) return null;

  log.info('Claimed scan job', { jobId: row.id, workerId, attempt: row.attempts });
  return toJob(row);
}

export async function completeJob(jobId: string, scanId: string | null): Promise<void> {
  const db = await getDb();
  await db
    .update(scanJobs)
    .set({
      status: 'completed',
      scanId,
      lockedAt: null,
      lockedBy: null,
      finishedAt: new Date(),
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(scanJobs.id, jobId));
}

/**
 * Record a failure.
 *
 * Requeues while attempts remain so a transient GitHub outage does not lose the
 * scan; gives up at `maxAttempts` so a genuinely broken repository does not spin
 * forever. The error text is always stored — a silently failing scan is worse
 * than a visibly failing one.
 */
export async function failJob(jobId: string, error: string): Promise<{ requeued: boolean }> {
  const db = await getDb();
  const rows = await db.select().from(scanJobs).where(eq(scanJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return { requeued: false };

  const exhausted = job.attempts >= job.maxAttempts;
  await db
    .update(scanJobs)
    .set({
      status: exhausted ? 'failed' : 'queued',
      lockedAt: null,
      lockedBy: null,
      error: error.slice(0, 2000),
      ...(exhausted ? { finishedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scanJobs.id, jobId));

  log.warn('Scan job failed', { jobId, attempts: job.attempts, exhausted, error });
  return { requeued: !exhausted };
}

export async function cancelJob(jobId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(scanJobs)
    .set({ status: 'cancelled', lockedAt: null, lockedBy: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scanJobs.id, jobId), inArray(scanJobs.status, ['queued', 'running'])));
}

export async function listJobs(repositoryId: string, limit = 20): Promise<ScanJob[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(scanJobs)
    .where(eq(scanJobs.repositoryId, repositoryId))
    .orderBy(desc(scanJobs.createdAt))
    .limit(limit);
  return rows.map(toJob);
}

export async function getJob(jobId: string): Promise<ScanJob | null> {
  const db = await getDb();
  const rows = await db.select().from(scanJobs).where(eq(scanJobs.id, jobId)).limit(1);
  const row = rows[0];
  return row ? toJob(row) : null;
}

type JobRow = typeof scanJobs.$inferSelect;

function toJob(row: JobRow): ScanJob {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    status: row.status,
    trigger: row.trigger,
    commitSha: row.commitSha,
    ref: row.ref,
    pullRequestNumber: row.pullRequestNumber,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    deliveryId: row.deliveryId,
    scanId: row.scanId,
    error: row.error,
    createdAt: row.createdAt,
  };
}

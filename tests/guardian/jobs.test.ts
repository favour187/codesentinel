import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedRepository } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';
import { scanJobs } from '@/db/schema';
import {
  enqueueScan,
  claimNextJob,
  completeJob,
  failJob,
  cancelJob,
  listJobs,
  getJob,
  PRIORITY,
  LOCK_TIMEOUT_MS,
} from '@/guardian/jobs';






declare global {
  var __codesentinel_db: unknown;
  var __codesentinel_db_kind: unknown;
  var __codesentinel_db_ready: unknown;
}

let db: TestDb;
let repositoryId: string;

beforeEach(async () => {
  db = await createTestDb();
  globalThis.__codesentinel_db = db;
  globalThis.__codesentinel_db_kind = 'pglite';
  globalThis.__codesentinel_db_ready = Promise.resolve();
  ({ repositoryId } = await seedRepository(db));
});

describe('enqueueScan', () => {
  it('creates a queued job', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'a'.repeat(40) });
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(job.trigger).toBe('push');
  });

  it('assigns priority from the trigger so interactive work runs first', async () => {
    await enqueueScan({ repositoryId, trigger: 'schedule', commitSha: 's1' });
    const manual = await enqueueScan({ repositoryId, trigger: 'manual', commitSha: 'm1' });

    const claimed = await claimNextJob('worker-1');
    expect(claimed?.id).toBe(manual.id);
    expect(PRIORITY.manual).toBeGreaterThan(PRIORITY.schedule);
  });

  it('deduplicates a repeated enqueue for the same commit', async () => {

    const first = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'dup' });
    const second = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'dup' });
    expect(second.id).toBe(first.id);
    expect(await listJobs(repositoryId)).toHaveLength(1);
  });

  it('does not deduplicate distinct commits', async () => {
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'c1' });
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'c2' });
    expect(await listJobs(repositoryId)).toHaveLength(2);
  });

  it('keeps pull request jobs separate from branch jobs on the same commit', async () => {
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'shared' });
    await enqueueScan({ repositoryId, trigger: 'pull_request', commitSha: 'shared', pullRequestNumber: 7 });
    expect(await listJobs(repositoryId)).toHaveLength(2);
  });
});

describe('claimNextJob', () => {
  it('returns null on an empty queue', async () => {
    expect(await claimNextJob('worker-1')).toBeNull();
  });

  it('marks the job running and increments attempts', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'x' });
    const claimed = await claimNextJob('worker-1');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
  });

  it('never hands the same job to two workers', async () => {


    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'only-one' });
    const [a, b] = await Promise.all([claimNextJob('worker-a'), claimNextJob('worker-b')]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it('claims in priority order, then oldest first', async () => {
    const older = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'new' });

    const first = await claimNextJob('w1');
    expect(first?.id).toBe(older.id);
  });

  it('does not claim a job that is already running', async () => {
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'busy' });
    await claimNextJob('w1');
    expect(await claimNextJob('w2')).toBeNull();
  });

  it('reclaims a job whose worker died mid-scan', async () => {

    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'stale' });
    await claimNextJob('dead-worker');

    await db
      .update(scanJobs)
      .set({ lockedAt: new Date(Date.now() - LOCK_TIMEOUT_MS - 60_000) })
      .where(eq(scanJobs.id, job.id));

    const reclaimed = await claimNextJob('fresh-worker');
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('does not reclaim a job whose lock is still fresh', async () => {
    await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'fresh' });
    await claimNextJob('w1');
    expect(await claimNextJob('w2')).toBeNull();
  });
});

describe('completeJob / failJob', () => {
  it('marks a job completed and records the scan id', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'ok' });
    await claimNextJob('w1');
    await completeJob(job.id, null);

    const stored = await getJob(job.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.error).toBeNull();
    expect(await claimNextJob('w2')).toBeNull();
  });

  it('requeues a failed job while attempts remain', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'retry', maxAttempts: 3 });
    await claimNextJob('w1');
    const { requeued } = await failJob(job.id, 'GitHub API timeout');

    expect(requeued).toBe(true);
    const stored = await getJob(job.id);
    expect(stored?.status).toBe('queued');
    expect(stored?.error).toContain('GitHub API timeout');
  });

  it('gives up after maxAttempts instead of retrying forever', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'doomed', maxAttempts: 2 });

    await claimNextJob('w1');
    expect((await failJob(job.id, 'boom 1')).requeued).toBe(true);
    await claimNextJob('w1');
    expect((await failJob(job.id, 'boom 2')).requeued).toBe(false);

    const stored = await getJob(job.id);
    expect(stored?.status).toBe('failed');
    expect(await claimNextJob('w2')).toBeNull();
  });

  it('always records the error text — a silent failure is worse than a loud one', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'err' });
    await claimNextJob('w1');
    await failJob(job.id, 'repository tarball exceeded size limit');
    expect((await getJob(job.id))?.error).toContain('tarball exceeded size limit');
  });

  it('truncates a pathologically long error rather than failing the write', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'long' });
    await claimNextJob('w1');
    await failJob(job.id, 'x'.repeat(10_000));
    expect((await getJob(job.id))?.error?.length).toBeLessThanOrEqual(2000);
  });
});

describe('cancelJob', () => {
  it('cancels a queued job', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'cancel-me' });
    await cancelJob(job.id);
    expect((await getJob(job.id))?.status).toBe('cancelled');
    expect(await claimNextJob('w1')).toBeNull();
  });

  it('does not resurrect an already completed job', async () => {
    const job = await enqueueScan({ repositoryId, trigger: 'push', commitSha: 'done' });
    await claimNextJob('w1');
    await completeJob(job.id, null);
    await cancelJob(job.id);
    expect((await getJob(job.id))?.status).toBe('completed');
  });
});

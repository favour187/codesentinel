import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedRepository } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';
import { repositories, repositoryPolicies, webhookDeliveries, scanJobs } from '@/db/schema';
import { handleWebhook } from '@/guardian/webhook-handler';

declare global {
  var __codesentinel_db: unknown;
  var __codesentinel_db_kind: unknown;
  var __codesentinel_db_ready: unknown;
}

const FULL_NAME = 'tester/example';

let db: TestDb;
let repositoryId: string;

beforeEach(async () => {
  db = await createTestDb();
  globalThis.__codesentinel_db = db;
  globalThis.__codesentinel_db_kind = 'pglite';
  globalThis.__codesentinel_db_ready = Promise.resolve();
  ({ repositoryId } = await seedRepository(db, { fullName: FULL_NAME }));
  await db
    .update(repositories)
    .set({ guardianEnabled: true, defaultBranch: 'main' })
    .where(eq(repositories.id, repositoryId));
});

let delivery = 0;
const nextDelivery = () => `delivery-${++delivery}`;

function repoPayload(extra: Record<string, unknown> = {}) {
  return {
    repository: { full_name: FULL_NAME, default_branch: 'main' },
    installation: { id: 555 },
    ...extra,
  };
}

function pushPayload(extra: Record<string, unknown> = {}) {
  return repoPayload({ ref: 'refs/heads/main', after: 'a'.repeat(40), deleted: false, ...extra });
}

function prPayload(action: string, extra: Record<string, unknown> = {}) {
  return repoPayload({
    action,
    pull_request: {
      number: 7,
      draft: false,
      head: { sha: 'b'.repeat(40), ref: 'feature' },
      base: { sha: 'c'.repeat(40), ref: 'main' },
      ...extra,
    },
  });
}

async function jobCount() {
  return (await db.select().from(scanJobs)).length;
}

describe('handleWebhook — delivery ledger', () => {
  it('records every delivery it receives', async () => {
    const id = nextDelivery();
    await handleWebhook({ deliveryId: id, event: 'ping', payload: repoPayload() });

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.event).toBe('ping');
    expect(row?.status).toBe('processed');
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never stores the raw payload — it can contain private source code', async () => {
    const id = nextDelivery();
    await handleWebhook({
      deliveryId: id,
      event: 'push',
      payload: pushPayload({ head_commit: { message: 'SECRET_TOKEN=ghp_dontstoreme' } }),
    });

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(JSON.stringify(row)).not.toContain('ghp_dontstoreme');
  });

  it('records WHY an event was ignored, so silence is debuggable', async () => {
    const id = nextDelivery();
    const outcome = await handleWebhook({
      deliveryId: id,
      event: 'pull_request',
      payload: prPayload('labeled'),
    });

    expect(outcome.status).toBe('ignored');
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.status).toBe('ignored');
    expect(row?.message).toContain('labeled');
  });

  it('records the repository and installation for correlation', async () => {
    const id = nextDelivery();
    await handleWebhook({ deliveryId: id, event: 'push', payload: pushPayload() });
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.repositoryFullName).toBe(FULL_NAME);
    expect(row?.installationId).toBe(555);
  });
});

describe('handleWebhook — idempotency', () => {
  it('processes a redelivered event exactly once', async () => {
    // GitHub retries on timeout. A second scan would post a duplicate comment.
    const id = nextDelivery();
    const first = await handleWebhook({ deliveryId: id, event: 'push', payload: pushPayload() });
    const second = await handleWebhook({ deliveryId: id, event: 'push', payload: pushPayload() });

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
    expect(await jobCount()).toBe(1);
  });

  it('keeps distinct deliveries independent', async () => {
    await handleWebhook({ deliveryId: nextDelivery(), event: 'push', payload: pushPayload() });
    await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ after: 'd'.repeat(40) }),
    });
    expect(await jobCount()).toBe(2);
  });
});

describe('handleWebhook — push', () => {
  it('queues a scan for the default branch', async () => {
    const outcome = await handleWebhook({ deliveryId: nextDelivery(), event: 'push', payload: pushPayload() });
    expect(outcome.status).toBe('processed');
    expect(outcome.jobId).toBeTruthy();

    const [job] = await db.select().from(scanJobs);
    expect(job?.trigger).toBe('push');
    expect(job?.status).toBe('queued');
  });

  it('ignores pushes to feature branches — the pull request covers them', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ ref: 'refs/heads/feature-x' }),
    });
    expect(outcome.status).toBe('ignored');
    expect(await jobCount()).toBe(0);
  });

  it('ignores tag pushes', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ ref: 'refs/tags/v1.0.0' }),
    });
    expect(outcome.status).toBe('ignored');
  });

  it('ignores branch deletions', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ deleted: true }),
    });
    expect(outcome.status).toBe('ignored');
    expect(await jobCount()).toBe(0);
  });

  it('ignores the all-zero sha of a deleted ref', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ after: '0'.repeat(40) }),
    });
    expect(outcome.status).toBe('ignored');
  });

  it('ignores repositories that are not connected', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'push',
      payload: pushPayload({ repository: { full_name: 'someone/unknown', default_branch: 'main' } }),
    });
    expect(outcome.status).toBe('ignored');
    expect(outcome.message).toMatch(/not connected/i);
  });

  it('respects guardianEnabled = false', async () => {
    await db.update(repositories).set({ guardianEnabled: false }).where(eq(repositories.id, repositoryId));
    const outcome = await handleWebhook({ deliveryId: nextDelivery(), event: 'push', payload: pushPayload() });
    expect(outcome.status).toBe('ignored');
    expect(await jobCount()).toBe(0);
  });

  it('respects the scanOnPush policy', async () => {
    await db.insert(repositoryPolicies).values({ repositoryId, scanOnPush: false });
    const outcome = await handleWebhook({ deliveryId: nextDelivery(), event: 'push', payload: pushPayload() });
    expect(outcome.status).toBe('ignored');
    expect(outcome.message).toMatch(/scanOnPush/);
  });
});

describe('handleWebhook — pull_request', () => {
  it.each(['opened', 'reopened', 'synchronize', 'ready_for_review'])('scans on "%s"', async (action) => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'pull_request',
      payload: prPayload(action),
    });
    expect(outcome.status).toBe('processed');
  });

  it.each(['labeled', 'assigned', 'closed', 'edited', 'review_requested'])(
    'ignores "%s"',
    async (action) => {
      const outcome = await handleWebhook({
        deliveryId: nextDelivery(),
        event: 'pull_request',
        payload: prPayload(action),
      });
      expect(outcome.status).toBe('ignored');
      expect(await jobCount()).toBe(0);
    },
  );

  it('skips draft pull requests', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'pull_request',
      payload: prPayload('opened', { draft: true }),
    });
    expect(outcome.status).toBe('ignored');
    expect(outcome.message).toMatch(/draft/i);
  });

  it('scans a draft the moment it is marked ready for review', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'pull_request',
      payload: prPayload('ready_for_review', { draft: true }),
    });
    expect(outcome.status).toBe('processed');
  });

  it('records the pull request number on the job', async () => {
    await handleWebhook({ deliveryId: nextDelivery(), event: 'pull_request', payload: prPayload('opened') });
    const [job] = await db.select().from(scanJobs);
    expect(job?.pullRequestNumber).toBe(7);
    expect(job?.trigger).toBe('pull_request');
  });

  it('respects the scanOnPullRequest policy', async () => {
    await db.insert(repositoryPolicies).values({ repositoryId, scanOnPullRequest: false });
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'pull_request',
      payload: prPayload('opened'),
    });
    expect(outcome.status).toBe('ignored');
  });

  it('ignores an incomplete payload rather than throwing', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'pull_request',
      payload: repoPayload({ action: 'opened', pull_request: { number: 9 } }),
    });
    expect(outcome.status).toBe('ignored');
  });
});

describe('handleWebhook — check_run re-run', () => {
  it('queues a high-priority scan when a user clicks Re-run', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'check_run',
      payload: repoPayload({
        action: 'rerequested',
        check_run: { head_sha: 'e'.repeat(40), pull_requests: [{ number: 12 }] },
      }),
    });

    expect(outcome.status).toBe('processed');
    const [job] = await db.select().from(scanJobs);
    expect(job?.pullRequestNumber).toBe(12);
    expect(job?.priority).toBe(100);
  });

  it('ignores routine check_run lifecycle events', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'check_run',
      payload: repoPayload({ action: 'completed', check_run: { head_sha: 'f'.repeat(40) } }),
    });
    expect(outcome.status).toBe('ignored');
    expect(await jobCount()).toBe(0);
  });
});

describe('handleWebhook — unknown events', () => {
  it('acknowledges ping', async () => {
    const outcome = await handleWebhook({ deliveryId: nextDelivery(), event: 'ping', payload: repoPayload() });
    expect(outcome.status).toBe('processed');
    expect(outcome.message).toBe('pong');
  });

  it('ignores events it does not handle without erroring', async () => {
    const outcome = await handleWebhook({
      deliveryId: nextDelivery(),
      event: 'star',
      payload: repoPayload({ action: 'created' }),
    });
    expect(outcome.status).toBe('ignored');
    expect(outcome.message).toMatch(/not handled/);
  });
});

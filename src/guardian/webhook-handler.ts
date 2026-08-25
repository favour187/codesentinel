import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { installations, repositories, webhookDeliveries } from '@/db/schema';
import { enqueueScan } from './jobs';
import { getRepositoryPolicy } from '@/lib/repositories';
import { createLogger } from '@/lib/logger';

/**
 * Webhook event routing.
 *
 * Design rules:
 *  - **Idempotent.** GitHub retries deliveries; the delivery id is recorded
 *    with a unique index and a duplicate short-circuits. Without this, a retry
 *    storm would queue duplicate scans and post duplicate comments.
 *  - **Fast.** Handlers only write rows and enqueue jobs. GitHub times out
 *    around 10 seconds; scanning happens in the worker, never inline.
 *  - **Explicit about ignoring.** Every event we deliberately skip is recorded
 *    with a reason, so "why didn't the guardian run?" is answerable from the
 *    delivery log instead of guesswork.
 */

const log = createLogger('guardian:webhook');

/** Events we act on. Anything else is recorded and ignored. */
export const HANDLED_EVENTS = [
  'ping',
  'push',
  'pull_request',
  'installation',
  'installation_repositories',
  'check_run',
] as const;

/** Pull request actions worth scanning; ignore label/assignee noise. */
const SCANNABLE_PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

export interface WebhookEnvelope {
  deliveryId: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface WebhookOutcome {
  status: 'processed' | 'ignored' | 'duplicate' | 'failed';
  message: string;
  jobId?: string;
}

/**
 * Record the delivery and route it.
 *
 * The ledger insert happens FIRST and doubles as the idempotency lock: if the
 * unique index rejects the insert, this delivery was already handled.
 */
export async function handleWebhook(envelope: WebhookEnvelope): Promise<WebhookOutcome> {
  const started = Date.now();
  const db = await getDb();
  const { deliveryId, event, payload } = envelope;

  const action = typeof payload.action === 'string' ? payload.action : null;
  const repoFullName = extractRepositoryFullName(payload);
  const installationId = extractInstallationId(payload);

  const existing = await db
    .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, deliveryId))
    .limit(1);

  if (existing[0]) {
    log.info('Duplicate webhook delivery ignored', { deliveryId, event });
    return { status: 'duplicate', message: 'Delivery already processed' };
  }

  const [ledger] = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId,
      event,
      action,
      repositoryFullName: repoFullName,
      installationId,
      status: 'received',
    })
    .returning();

  const finish = async (outcome: WebhookOutcome): Promise<WebhookOutcome> => {
    if (ledger) {
      await db
        .update(webhookDeliveries)
        .set({
          status: outcome.status === 'duplicate' ? 'ignored' : outcome.status,
          message: outcome.message.slice(0, 1000),
          durationMs: Date.now() - started,
        })
        .where(eq(webhookDeliveries.id, ledger.id));
    }
    return outcome;
  };

  try {
    switch (event) {
      case 'ping':
        return finish({ status: 'processed', message: 'pong' });

      case 'installation':
      case 'installation_repositories':
        return finish(await handleInstallation(payload, action));

      case 'push':
        return finish(await handlePush(payload, deliveryId));

      case 'pull_request':
        return finish(await handlePullRequest(payload, action, deliveryId));

      case 'check_run':
        // Only react to a user clicking "Re-run" in the GitHub Checks UI.
        if (action === 'rerequested') return finish(await handleRerun(payload, deliveryId));
        return finish({ status: 'ignored', message: `check_run action "${action}" not actionable` });

      default:
        return finish({ status: 'ignored', message: `Event "${event}" is not handled` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Webhook handling failed', { deliveryId, event, error: message });
    return finish({ status: 'failed', message });
  }
}

/* -------------------------------------------------------------------------- */
/* Event handlers                                                             */
/* -------------------------------------------------------------------------- */

async function handleInstallation(
  payload: Record<string, unknown>,
  action: string | null,
): Promise<WebhookOutcome> {
  const db = await getDb();
  const installation = payload.installation as
    | {
        id: number;
        account?: { login?: string; type?: string; id?: number };
        repository_selection?: string;
        permissions?: Record<string, string>;
      }
    | undefined;

  if (!installation?.id) return { status: 'ignored', message: 'No installation in payload' };

  if (action === 'deleted') {
    // Keep the row but mark it suspended: deleting it would cascade away the
    // user's whole scan history for repositories they may reconnect later.
    await db
      .update(installations)
      .set({ suspendedAt: new Date(), updatedAt: new Date() })
      .where(eq(installations.installationId, installation.id));
    return { status: 'processed', message: `Installation ${installation.id} marked removed` };
  }

  const accountLogin = installation.account?.login ?? 'unknown';
  await upsertInstallationRow({
    installationId: installation.id,
    accountLogin,
    accountType: installation.account?.type ?? 'User',
    targetId: installation.account?.id ?? null,
    repositorySelection: installation.repository_selection ?? 'selected',
    permissions: installation.permissions ?? {},
    suspendedAt: action === 'suspend' ? new Date() : null,
  });

  const listed = payload.repositories as Array<{ full_name?: string; name?: string }> | undefined;
  const names = listed?.map((r) => r.full_name).filter((n): n is string => Boolean(n)) ?? [];

  if (names.length > 0) {
    await Promise.all(
      names.map((fullName) => {
        const [owner, name] = fullName.split('/');
        return activateGuardianForConnectedRepo(owner ?? accountLogin, name ?? fullName, fullName);
      }),
    );
  } else {
    const connected = await db
      .select({ owner: repositories.owner, name: repositories.name, fullName: repositories.fullName })
      .from(repositories)
      .where(eq(repositories.owner, accountLogin));
    await Promise.all(
      connected.map((r) => activateGuardianForConnectedRepo(r.owner, r.name, r.fullName)),
    );
  }

  return { status: 'processed', message: `Installation ${installation.id} recorded (${action ?? 'sync'})` };
}

async function handlePush(payload: Record<string, unknown>, deliveryId: string): Promise<WebhookOutcome> {
  const ref = typeof payload.ref === 'string' ? payload.ref : null;
  const after = typeof payload.after === 'string' ? payload.after : null;
  const deleted = payload.deleted === true;

  if (!ref || !after) return { status: 'ignored', message: 'Push payload missing ref or commit' };
  if (deleted) return { status: 'ignored', message: 'Branch deletion — nothing to scan' };
  // All-zero sha means the ref was deleted or is a tag creation with no commit.
  if (/^0+$/.test(after)) return { status: 'ignored', message: 'No head commit on push' };

  const repo = await resolveRepository(payload);
  if (!repo) return { status: 'ignored', message: 'Repository is not connected to CodeSentinel' };

  const policy = await getRepositoryPolicy(repo.id);
  if (!repo.guardianEnabled) return { status: 'ignored', message: 'Guardian is disabled for this repository' };
  if (!policy.scanOnPush) return { status: 'ignored', message: 'scanOnPush is disabled by policy' };

  // Only the default branch drives repository health. Feature branches are
  // covered by their pull request, and scanning every branch push would triple
  // the work for no extra signal.
  const branch = ref.replace(/^refs\/heads\//, '');
  if (ref.startsWith('refs/heads/') && branch !== repo.defaultBranch) {
    return { status: 'ignored', message: `Push to non-default branch "${branch}" — covered by its pull request` };
  }
  if (!ref.startsWith('refs/heads/')) {
    return { status: 'ignored', message: `Ref "${ref}" is not a branch` };
  }

  const job = await enqueueScan({
    repositoryId: repo.id,
    trigger: 'push',
    commitSha: after,
    ref,
    deliveryId,
  });

  return { status: 'processed', message: `Queued push scan for ${branch}@${after.slice(0, 7)}`, jobId: job.id };
}

async function handlePullRequest(
  payload: Record<string, unknown>,
  action: string | null,
  deliveryId: string,
): Promise<WebhookOutcome> {
  if (!action || !SCANNABLE_PR_ACTIONS.has(action)) {
    return { status: 'ignored', message: `Pull request action "${action}" does not require a scan` };
  }

  const pr = payload.pull_request as
    | { number: number; draft?: boolean; head?: { sha?: string; ref?: string }; base?: { sha?: string; ref?: string } }
    | undefined;

  if (!pr?.number || !pr.head?.sha) return { status: 'ignored', message: 'Pull request payload incomplete' };

  // Draft PRs are work in progress; scanning each push wastes budget and the
  // author gets the report when they mark it ready (ready_for_review re-fires).
  if (pr.draft && action !== 'ready_for_review') {
    return { status: 'ignored', message: 'Draft pull request — will scan when marked ready for review' };
  }

  const repo = await resolveRepository(payload);
  if (!repo) return { status: 'ignored', message: 'Repository is not connected to CodeSentinel' };

  const policy = await getRepositoryPolicy(repo.id);
  if (!repo.guardianEnabled) return { status: 'ignored', message: 'Guardian is disabled for this repository' };
  if (!policy.scanOnPullRequest) {
    return { status: 'ignored', message: 'scanOnPullRequest is disabled by policy' };
  }

  const job = await enqueueScan({
    repositoryId: repo.id,
    trigger: 'pull_request',
    commitSha: pr.head.sha,
    ref: pr.head.ref ? `refs/heads/${pr.head.ref}` : null,
    pullRequestNumber: pr.number,
    deliveryId,
  });

  return {
    status: 'processed',
    message: `Queued pull request scan for #${pr.number}`,
    jobId: job.id,
  };
}

async function handleRerun(payload: Record<string, unknown>, deliveryId: string): Promise<WebhookOutcome> {
  const checkRun = payload.check_run as
    | { head_sha?: string; pull_requests?: Array<{ number: number }> }
    | undefined;

  const repo = await resolveRepository(payload);
  if (!repo) return { status: 'ignored', message: 'Repository is not connected to CodeSentinel' };
  if (!checkRun?.head_sha) return { status: 'ignored', message: 'check_run payload missing head_sha' };

  const prNumber = checkRun.pull_requests?.[0]?.number ?? null;
  const job = await enqueueScan({
    repositoryId: repo.id,
    trigger: prNumber ? 'pull_request' : 'manual',
    commitSha: checkRun.head_sha,
    pullRequestNumber: prNumber,
    deliveryId,
    priority: 100,
  });

  return { status: 'processed', message: 'Queued re-requested scan', jobId: job.id };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface ResolvedRepo {
  id: string;
  fullName: string;
  defaultBranch: string;
  guardianEnabled: boolean;
}

/**
 * Map a webhook payload to a connected repository.
 *
 * Matches on `source = 'github'` so a demo fixture sharing a name can never be
 * driven by a real webhook — demo and real data stay strictly separate.
 */
async function resolveRepository(payload: Record<string, unknown>): Promise<ResolvedRepo | null> {
  const repository = payload.repository as { full_name?: string; default_branch?: string } | undefined;
  const fullName = repository?.full_name;
  if (!fullName) return null;

  const db = await getDb();
  const rows = await db
    .select({
      id: repositories.id,
      fullName: repositories.fullName,
      defaultBranch: repositories.defaultBranch,
      guardianEnabled: repositories.guardianEnabled,
    })
    .from(repositories)
    .where(and(eq(repositories.fullName, fullName), eq(repositories.source, 'github')))
    .limit(1);

  return rows[0] ?? null;
}

function extractRepositoryFullName(payload: Record<string, unknown>): string | null {
  const repository = payload.repository as { full_name?: string } | undefined;
  return repository?.full_name ?? null;
}

function extractInstallationId(payload: Record<string, unknown>): number | null {
  const installation = payload.installation as { id?: number } | undefined;
  return typeof installation?.id === 'number' ? installation.id : null;
}

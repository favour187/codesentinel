/**
 * END-TO-END GUARDIAN WORKFLOW
 *
 * The other guardian suites test each stage in isolation with the neighbouring
 * stage stubbed. This one wires the real pieces together and asserts the whole
 * path a real delivery takes:
 *
 *   signed webhook -> route -> delivery ledger -> scan_jobs -> worker
 *     -> tarball checkout -> deterministic scanners -> findings persisted
 *     -> risk assessed -> GitHub Check run -> sticky PR comment
 *
 * Nothing about the pipeline is mocked. The only substitution is `fetch`: a
 * fake GitHub that serves a real gzipped tarball built from the bundled
 * vulnerable fixture and records the Check/comment calls the guardian makes.
 * That is the one thing we genuinely cannot exercise without credentials.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../helpers/test-db';
import * as schema from '@/db/schema';
import { signWebhookBody } from '@/github/app-auth';
import { resetEnvCache } from '@/lib/env';
import { demoFixturePath } from '@/lib/demo/fixture';

const SECRET = 'e2e-webhook-secret';
const INSTALLATION_ID = 987654;
const OWNER = 'acme';
const REPO = 'guarded';
const FULL_NAME = `${OWNER}/${REPO}`;
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

let db: TestDb;
let repositoryId: string;
let tarballGz: Buffer;
let workDir: string;

/** Calls the fake GitHub recorded, so we can assert what the guardian sent. */
interface Recorded {
  checkRuns: Array<{ method: string; body: Record<string, unknown> }>;
  comments: Array<{ method: string; body: Record<string, unknown> }>;
  tarballRequests: number;
}
let recorded: Recorded;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return {
    ...actual,
    getDb: () => db,
    db: async () => db,
    ensureSchema: async () => undefined,
  };
});

/** Build a GitHub-shaped tarball: everything nested under one wrapper dir. */
function buildFixtureTarball(): Buffer {
  const staging = mkdtempSync(join(tmpdir(), 'cs-e2e-stage-'));
  const wrapper = join(staging, `${OWNER}-${REPO}-${HEAD_SHA.slice(0, 7)}`);
  mkdirSync(wrapper, { recursive: true });
  cpSync(demoFixturePath(), wrapper, { recursive: true });

  const out = join(staging, 'repo.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', staging, `${OWNER}-${REPO}-${HEAD_SHA.slice(0, 7)}`]);
  const buf = readFileSync(out);
  rmSync(staging, { recursive: true, force: true });
  return buf;
}

function fakeGitHub(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: Record<string, unknown> =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    const json = (payload: unknown, status = 200): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    // Installation token exchange.
    if (url.includes('/access_tokens')) {
      return json({ token: 'ghs_faketoken', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }

    // Tarball download.
    if (url.includes('/tarball/')) {
      recorded.tarballRequests++;
      return new Response(new Uint8Array(tarballGz), {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      });
    }

    // PR metadata — the worker re-reads this rather than trusting the payload.
    if (/\/pulls\/\d+$/.test(url) && method === 'GET') {
      return json({
        number: 42,
        title: 'Add admin tooling',
        user: { login: 'contributor' },
        head: { sha: HEAD_SHA, ref: 'feature/admin' },
        base: { sha: BASE_SHA, ref: 'main' },
      });
    }

    // Changed files.
    if (url.includes('/pulls/42/files')) {
      return json([
        { filename: 'admin.js', status: 'modified', additions: 30, deletions: 2, changes: 32 },
        { filename: 'auth.js', status: 'modified', additions: 12, deletions: 1, changes: 13 },
      ]);
    }

    if (url.includes('/check-runs')) {
      recorded.checkRuns.push({ method, body });
      return json({ id: 555, html_url: 'https://github.test/check/555' }, 201);
    }

    if (url.includes('/issues/42/comments') && method === 'GET') {
      return json([]);
    }
    if (url.includes('/issues/42/comments') && method === 'POST') {
      recorded.comments.push({ method, body });
      return json({ id: 777, html_url: 'https://github.test/comment/777' }, 201);
    }
    if (url.includes('/issues/comments/')) {
      recorded.comments.push({ method, body });
      return json({ id: 777 });
    }

    if (/\/commits\//.test(url)) {
      return json({
        sha: HEAD_SHA,
        commit: { message: 'Add admin tooling', author: { name: 'Contributor', date: new Date().toISOString() } },
        author: { login: 'contributor' },
      });
    }

    if (url.endsWith(`/repos/${OWNER}/${REPO}`)) {
      return json({ default_branch: 'main', private: false });
    }

    return json({ message: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
}

beforeEach(async () => {
  vi.resetModules();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  resetEnvCache();

  recorded = { checkRuns: [], comments: [], tarballRequests: 0 };
  db = await createTestDb();
  tarballGz = buildFixtureTarball();
  workDir = mkdtempSync(join(tmpdir(), 'cs-e2e-'));

  const [user] = await db
    .insert(schema.users)
    .values({ githubId: 4242, login: 'owner', name: 'Owner' })
    .returning();

  const [installation] = await db
    .insert(schema.installations)
    .values({
      installationId: INSTALLATION_ID,
      accountLogin: OWNER,
      accountType: 'Organization',
      installedByUserId: user!.id,
    })
    .returning();

  const [repo] = await db
    .insert(schema.repositories)
    .values({
      source: 'github',
      owner: OWNER,
      name: REPO,
      fullName: FULL_NAME,
      defaultBranch: 'main',
      ownerUserId: user!.id,
      installationId: installation!.id,
      guardianEnabled: true,
    })
    .returning();

  repositoryId = repo!.id;

  await db.insert(schema.repositoryPolicies).values({
    repositoryId,
    failOnSeverity: 'high',
    scanOnPush: true,
    scanOnPullRequest: true,
    postPrComments: true,
    createChecks: true,
  });
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  resetEnvCache();
  rmSync(workDir, { recursive: true, force: true });
});

async function postWebhook(event: string, payload: unknown, delivery: string) {
  const { POST } = await import('@/app/api/webhooks/github/route');
  const { NextRequest } = await import('next/server');
  const raw = JSON.stringify(payload);

  const request = new NextRequest('https://sentinel.test/api/webhooks/github', {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': signWebhookBody(raw, SECRET),
    }),
    body: raw,
  });

  return POST(request);
}

const prPayload = {
  action: 'opened',
  number: 42,
  pull_request: {
    number: 42,
    title: 'Add admin tooling',
    draft: false,
    state: 'open',
    user: { login: 'contributor' },
    head: { sha: HEAD_SHA, ref: 'feature/admin' },
    base: { sha: BASE_SHA, ref: 'main' },
  },
  repository: { full_name: FULL_NAME, default_branch: 'main' },
  installation: { id: INSTALLATION_ID },
};

describe('guardian end-to-end: pull request', () => {
  it('carries a signed delivery all the way to a Check run and a PR comment', async () => {
    /* 1. Delivery arrives. */
    const response = await postWebhook('pull_request', prPayload, 'delivery-e2e-1');
    expect(response.status).toBe(200);

    /* 2. It is recorded in the ledger — and the raw payload is NOT stored. */
    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.deliveryId).toBe('delivery-e2e-1');
    expect(deliveries[0]!.event).toBe('pull_request');
    expect(JSON.stringify(deliveries[0])).not.toContain('feature/admin');

    /* 3. A job is queued. */
    const queued = await db.select().from(schema.scanJobs);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.status).toBe('queued');
    expect(queued[0]!.pullRequestNumber).toBe(42);

    /* 4. The worker drains it against the fake GitHub. */
    const { runWorker } = await import('@/guardian/worker');
    const { GitHubClient } = await import('@/github/client');

    const result = await runWorker({
      maxJobs: 1,
      clientFactory: async () => new GitHubClient({ token: 'ghs_faketoken', fetchImpl: fakeGitHub() }),
    });

    expect(result.failed, JSON.stringify(result.jobs)).toBe(0);
    expect(result.succeeded).toBe(1);

    /* 5. Real scanners ran over the real tarball. */
    expect(recorded.tarballRequests).toBeGreaterThan(0);

    const scanRows = await db.select().from(schema.scans).where(eq(schema.scans.repositoryId, repositoryId));
    const prScan = scanRows.find((s) => s.trigger === 'pull_request');
    expect(prScan).toBeDefined();
    expect(prScan!.status).toBe('completed');

    const findings = await db.select().from(schema.findings).where(eq(schema.findings.scanId, prScan!.id));
    expect(findings.length).toBeGreaterThan(10);

    // Findings point at files that genuinely exist in the fixture.
    expect(findings.every((f) => typeof f.filePath === 'string' && f.filePath!.length > 0)).toBe(true);

    /*
     * A pull request scan must be fully attributable but must never speak for
     * the tracked branch: every row is `proposed`, and the repository-level
     * `open` set stays empty because no branch scan has run in this test.
     */
    expect(findings.every((f) => f.status === 'proposed')).toBe(true);
    const openForRepo = await db
      .select()
      .from(schema.findings)
      .where(and(eq(schema.findings.repositoryId, repositoryId), eq(schema.findings.status, 'open')));
    expect(openForRepo).toHaveLength(0);

    // ...and a PR scan must not move the repository's health score.
    const prSnapshots = await db
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.repositoryId, repositoryId));
    expect(prSnapshots).toHaveLength(0);

    /* 6. Risk was assessed and stored. */
    const prRows = await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.repositoryId, repositoryId));
    expect(prRows).toHaveLength(1);
    expect(prRows[0]!.number).toBe(42);
    expect(['low', 'medium', 'high', 'critical']).toContain(prRows[0]!.riskLevel);

    /* 7. A Check run was created and completed. */
    expect(recorded.checkRuns.length).toBeGreaterThanOrEqual(1);
    const completed = recorded.checkRuns.find((c) => c.body.conclusion !== undefined);
    expect(completed, 'expected a completed check run').toBeDefined();
    expect(['failure', 'neutral', 'success', 'action_required']).toContain(completed!.body.conclusion);

    /* 8. Exactly one PR comment, carrying the sticky marker. */
    expect(recorded.comments).toHaveLength(1);
    const commentBody = String(recorded.comments[0]!.body.body ?? '');
    expect(commentBody).toContain('<!-- codesentinel:guardian-report -->');

    /* 9. The fixture's hardcoded secrets must not leak into GitHub. */
    expect(commentBody).not.toMatch(/sk_live_[A-Za-z0-9]/);
    expect(commentBody).not.toMatch(/AKIA[0-9A-Z]{16}/);

    /* 10. The job is closed out. */
    const doneJobs = await db.select().from(schema.scanJobs);
    expect(doneJobs[0]!.status).toBe('completed');
    expect(doneJobs[0]!.scanId).toBe(prScan!.id);
  }, 120_000);

  it('treats a redelivered event as a no-op instead of scanning twice', async () => {
    const first = await postWebhook('pull_request', prPayload, 'delivery-dupe');
    expect(first.status).toBe(200);

    const second = await postWebhook('pull_request', prPayload, 'delivery-dupe');
    expect(second.status).toBe(200);

    const jobs = await db.select().from(schema.scanJobs);
    expect(jobs).toHaveLength(1);

    const deliveries = await db.select().from(schema.webhookDeliveries);
    expect(deliveries).toHaveLength(1);
  }, 30_000);
});

describe('guardian end-to-end: push', () => {
  it('scans the default branch and records a health snapshot', async () => {
    const pushPayload = {
      ref: 'refs/heads/main',
      after: HEAD_SHA,
      repository: { full_name: FULL_NAME, default_branch: 'main' },
      installation: { id: INSTALLATION_ID },
      commits: [{ id: HEAD_SHA, message: 'Add admin tooling' }],
    };

    const response = await postWebhook('push', pushPayload, 'delivery-push-1');
    expect(response.status).toBe(200);

    const { runWorker } = await import('@/guardian/worker');
    const { GitHubClient } = await import('@/github/client');

    const result = await runWorker({
      maxJobs: 1,
      clientFactory: async () => new GitHubClient({ token: 'ghs_faketoken', fetchImpl: fakeGitHub() }),
    });
    expect(result.failed, JSON.stringify(result.jobs)).toBe(0);

    const scanRows = await db.select().from(schema.scans).where(eq(schema.scans.repositoryId, repositoryId));
    const pushScan = scanRows.find((s) => s.trigger === 'push');
    expect(pushScan?.status).toBe('completed');

    const snapshots = await db
      .select()
      .from(schema.healthSnapshots)
      .where(eq(schema.healthSnapshots.repositoryId, repositoryId));
    expect(snapshots).toHaveLength(1);
    // The fixture is deliberately awful; a perfect score would mean the
    // scanners never actually read it.
    expect(Number(snapshots[0]!.health)).toBeLessThan(90);

    const findings = await db.select().from(schema.findings).where(eq(schema.findings.scanId, pushScan!.id));
    expect(findings.length).toBeGreaterThan(10);
    // A default-branch scan owns the repository's live state.
    expect(findings.every((f) => f.status === 'open')).toBe(true);
  }, 120_000);

  it('ignores a push to a non-default branch', async () => {
    const response = await postWebhook(
      'push',
      {
        ref: 'refs/heads/scratch',
        after: HEAD_SHA,
        repository: { full_name: FULL_NAME, default_branch: 'main' },
        installation: { id: INSTALLATION_ID },
      },
      'delivery-push-2',
    );
    expect(response.status).toBe(200);

    const jobs = await db.select().from(schema.scanJobs);
    expect(jobs).toHaveLength(0);
  }, 30_000);
});

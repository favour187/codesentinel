import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  requireUser,
  assertRepositoryAccess,
  getUserGitHubToken,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/current-user';
import { getRepositoryById } from '@/lib/repositories';
import { executeScan } from '@/scanner/persistence';
import { demoFixturePath } from '@/lib/demo/fixture';
import { GitHubClient } from '@/github/client';
import { checkoutRepository } from '@/guardian/checkout';
import { createLogger } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';

/**
 * Manually trigger a scan and wait for it.
 *
 * Demo uses the bundled fixture. GitHub uses the signed-in user's OAuth token
 * to download a tarball — no GitHub App and no background worker required.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const log = createLogger('api:scan');

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const limited = rateLimit(`scan:${user.id}`, 8, 60_000);
    if (!limited.ok) {
      return NextResponse.json({ ok: false, error: 'Too many scan requests. Try again shortly.' }, { status: 429 });
    }
    const { id } = await params;
    await assertRepositoryAccess(user.id, id);

    const repository = await getRepositoryById(id);
    if (!repository) {
      return NextResponse.json({ ok: false, error: 'Repository not found' }, { status: 404 });
    }

    if (repository.source === 'demo') {
      const executed = await executeScan({
        repositoryId: repository.id,
        rootDir: demoFixturePath(),
        trigger: 'manual',
        ref: 'refs/heads/main',
      });

      log.info('Demo scan complete', {
        repositoryId: repository.id,
        scanId: executed.scanId,
        findings: executed.result.findings.length,
      });

      return scanJson(executed);
    }

    const token = await getUserGitHubToken(user.id);
    if (!token) {
      return NextResponse.json(
        { ok: false, error: 'Sign in with GitHub again so we can read the repository.' },
        { status: 400 },
      );
    }

    const client = new GitHubClient({ token });
    const head = await client.getCommit(repository.owner, repository.name, repository.defaultBranch);
    const checkout = await checkoutRepository(client, repository.owner, repository.name, head.sha);
    try {
      const executed = await executeScan({
        repositoryId: repository.id,
        rootDir: checkout.dir,
        trigger: 'manual',
        commitSha: head.sha,
        ref: `refs/heads/${repository.defaultBranch}`,
      });

      log.info('GitHub scan complete', {
        repositoryId: repository.id,
        fullName: repository.fullName,
        scanId: executed.scanId,
        findings: executed.result.findings.length,
      });

      return scanJson(executed);
    } finally {
      await checkout.cleanup();
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Manual scan failed', { error: message });
    return NextResponse.json({ ok: false, error: humanScanError(message) }, { status: 500 });
  }
}

function scanJson(executed: {
  scanId: string;
  result: { findings: unknown[]; scores: { health: number } };
  healthDelta: number | null;
  introduced: number;
  resolved: number;
}): NextResponse {
  return NextResponse.json({
    ok: true,
    mode: 'synchronous',
    scanId: executed.scanId,
    findings: executed.result.findings.length,
    health: executed.result.scores.health,
    healthDelta: executed.healthDelta,
    introduced: executed.introduced,
    resolved: executed.resolved,
  });
}

function humanScanError(message: string): string {
  if (/401|403|Bad credentials|tarball/i.test(message)) {
    return 'GitHub refused the download. Reconnect GitHub or check the repository is visible to your account.';
  }
  if (/tar exited|Failed to run tar/i.test(message)) {
    return 'Could not unpack the repository archive on this host.';
  }
  if (/not readable|ENOENT|fixture/i.test(message)) {
    return 'Scan files were not found on this server. Redeploy so fixtures are included.';
  }
  return 'Scan failed. Check the server logs and retry.';
}

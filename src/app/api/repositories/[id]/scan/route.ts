import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireUser, assertRepositoryAccess, UnauthorizedError, ForbiddenError } from '@/lib/auth/current-user';
import { getRepositoryById } from '@/lib/repositories';
import { enqueueScan } from '@/guardian/jobs';
import { executeScan } from '@/scanner/persistence';
import { demoFixturePath } from '@/lib/demo/fixture';
import { createLogger } from '@/lib/logger';

/**
 * Manually trigger a scan.
 *
 * Two paths, deliberately different:
 *  - **Demo repositories** scan the bundled local fixture synchronously. There
 *    is no GitHub round-trip, it takes a second, and the caller gets the result
 *    immediately — which is what makes the demo flow feel live.
 *  - **GitHub repositories** enqueue a job. The scan needs a tarball download
 *    and a full analysis pass, which will not fit in a request timeout.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:scan');

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
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

    const job = await enqueueScan({
      repositoryId: repository.id,
      trigger: 'manual',
      ref: `refs/heads/${repository.defaultBranch}`,
    });

    return NextResponse.json({
      ok: true,
      mode: 'queued',
      jobId: job.id,
      message: 'Scan queued. It will run on the next worker pass.',
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error('Manual scan failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

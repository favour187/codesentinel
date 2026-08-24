import { NextResponse } from 'next/server';

import { ForbiddenError, UnauthorizedError, requireUser, assertRepositoryAccess } from '@/lib/auth/current-user';
import { getRepositoryById } from '@/lib/repositories';
import { resetDemoRepository } from '@/lib/demo/register';
import { rateLimit } from '@/lib/rate-limit';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:demo-reset');

export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const limited = rateLimit(`demo-reset:${user.id}`, 4, 60_000);
    if (!limited.ok) {
      return NextResponse.json({ ok: false, error: 'Please wait before resetting the demo again.' }, { status: 429 });
    }

    const { listRepositoriesForUser } = await import('@/lib/repositories');
    const repos = await listRepositoriesForUser(user.id);
    const demo = repos.find((r) => r.isDemo);
    if (!demo) {
      return NextResponse.json({ ok: false, error: 'No demo repository is connected.' }, { status: 404 });
    }

    await assertRepositoryAccess(user.id, demo.id);
    const check = await getRepositoryById(demo.id);
    if (!check || check.source !== 'demo') {
      return NextResponse.json({ ok: false, error: 'Demo reset is only available for the fixture.' }, { status: 403 });
    }

    const result = await resetDemoRepository(demo.id);
    log.info('Demo reset', { userId: user.id, repositoryId: demo.id, scanId: result.scanId });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Repository not found' }, { status: 404 });
    }
    log.error('Demo reset failed', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: 'Demo reset failed.' }, { status: 500 });
  }
}

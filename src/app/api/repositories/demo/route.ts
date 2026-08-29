import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth/current-user';
import { demoFixtureExists } from '@/lib/demo/fixture';
import { ensureDemoRepository } from '@/lib/demo/register';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:repositories:demo');








export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireUser();

    if (!(await demoFixtureExists())) {
      return NextResponse.json(
        { ok: false, error: 'Demo fixture not found on disk (expected ./fixtures/demo-repo).' },
        { status: 500 },
      );
    }

    const repositoryId = await ensureDemoRepository(user.id);
    if (!repositoryId) throw new Error('Failed to create demo repository');

    log.info('Demo repository registered', { userId: user.id, repositoryId });
    return NextResponse.json({ ok: true, repositoryId, created: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    log.error('Failed to register demo repository', { error: (err as Error).message });
    return NextResponse.json({ ok: false, error: 'Failed to register the demo repository' }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { getOrCreateDemoUser } from '@/lib/auth/demo-session';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { ensureDemoRepository } from '@/lib/demo/register';
import { createLogger } from '@/lib/logger';
import { redirectTo } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:auth:demo');

/**
 * Sign in to the local demo workspace.
 *
 * This grants access ONLY to `source: 'demo'` repositories — the bundled
 * intentionally-vulnerable fixture that CodeSentinel scans for real. It never
 * touches a third-party GitHub repository.
 */
/** GET is accepted so a bookmark or prefetch does not return 405. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const demoUser = await getOrCreateDemoUser();
    await ensureDemoRepository(demoUser.id);
    const token = await createSessionToken({ userId: demoUser.id, login: demoUser.login, demo: true });

    const response = redirectTo(request, '/');
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    log.info('Demo session started', { userId: demoUser.id });
    return response;
  } catch (err) {
    log.error('Failed to start demo session', { error: (err as Error).message });
    return redirectTo(request, '/login?error=demo_failed');
  }
}

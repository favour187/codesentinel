import { NextResponse, type NextRequest } from 'next/server';
import { getOrCreateDemoUser } from '@/lib/auth/demo-session';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
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
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const demoUser = await getOrCreateDemoUser();
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

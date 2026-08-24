import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthorizeUrl, isOAuthConfigured, OAUTH_STATE_COOKIE } from '@/lib/auth/oauth';
import { sessionCookieOptions } from '@/lib/auth/session';
import { createLogger } from '@/lib/logger';
import { redirectTo, resolveOrigin } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:auth:github');

/** Kick off the GitHub OAuth web flow. */
export function GET(request: NextRequest): NextResponse {
  if (!isOAuthConfigured()) {
    return redirectTo(request, '/login?error=oauth_not_configured');
  }

  const requestedRedirect = request.nextUrl.searchParams.get('redirect') ?? '/';
  const safeRedirect =
    requestedRedirect.startsWith('/') && !requestedRedirect.startsWith('//') ? requestedRedirect : '/';

  try {
    const { url, state } = buildAuthorizeUrl(safeRedirect, resolveOrigin(request));
    const response = NextResponse.redirect(url);
    // Short-lived, httpOnly state cookie -> CSRF protection on callback.
    response.cookies.set(OAUTH_STATE_COOKIE, state, { ...sessionCookieOptions(600), sameSite: 'lax' });
    return response;
  } catch (err) {
    log.error('Failed to start OAuth flow', { error: (err as Error).message });
    return redirectTo(request, '/login?error=oauth_start_failed');
  }
}

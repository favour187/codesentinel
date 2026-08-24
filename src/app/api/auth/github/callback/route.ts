import { NextResponse, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  exchangeCodeForToken,
  fetchGitHubUser,
  isOAuthConfigured,
  OAUTH_STATE_COOKIE,
  originFromState,
  redirectPathFromState,
  verifyState,
} from '@/lib/auth/oauth';
import { createSessionToken, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { db, users } from '@/db';
import { encryptSecret } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';
import { redirectTo } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:auth:callback');

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isOAuthConfigured()) {
    return redirectTo(request, '/login?error=oauth_not_configured');
  }

  const url = request.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    log.warn('OAuth denied by user or provider', { error: oauthError });
    return redirectTo(request, `/login?error=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return redirectTo(request, '/login?error=missing_code');
  }

  // --- CSRF check -----------------------------------------------------------
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!verifyState(state, expectedState)) {
    log.warn('OAuth state mismatch — possible CSRF attempt');
    return redirectTo(request, '/login?error=state_mismatch');
  }

  try {
    const token = await exchangeCodeForToken(code, originFromState(state));
    const ghUser = await fetchGitHubUser(token.accessToken);

    const database = await db();
    // Token is encrypted at rest (AES-256-GCM) — never stored in plaintext.
    const encrypted = encryptSecret(token.accessToken);

    const [existing] = await database.select().from(users).where(eq(users.githubId, ghUser.id)).limit(1);

    let userId: string;
    if (existing) {
      await database
        .update(users)
        .set({
          login: ghUser.login,
          name: ghUser.name,
          email: ghUser.email,
          avatarUrl: ghUser.avatarUrl,
          accessTokenEncrypted: encrypted,
          tokenScopes: token.scope,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      userId = existing.id;
    } else {
      const [created] = await database
        .insert(users)
        .values({
          githubId: ghUser.id,
          login: ghUser.login,
          name: ghUser.name,
          email: ghUser.email,
          avatarUrl: ghUser.avatarUrl,
          accessTokenEncrypted: encrypted,
          tokenScopes: token.scope,
          lastLoginAt: new Date(),
        })
        .returning();
      if (!created) throw new Error('Failed to create user record');
      userId = created.id;
    }

    log.info('User signed in via GitHub', { userId, login: ghUser.login });

    const redirectPath = redirectPathFromState(state);
    const response = redirectTo(request, redirectPath);
    const sessionToken = await createSessionToken({ userId, login: ghUser.login });
    response.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions());
    response.cookies.set(OAUTH_STATE_COOKIE, '', sessionCookieOptions(0));
    return response;
  } catch (err) {
    log.error('OAuth callback failed', { error: (err as Error).message });
    return redirectTo(request, '/login?error=oauth_failed');
  }
}

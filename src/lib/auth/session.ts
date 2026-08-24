import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

/**
 * Stateless, signed session cookies (JWS / HS256).
 *
 * The cookie holds only an opaque user id + login. GitHub tokens never leave
 * the database (and are encrypted there), so a stolen cookie cannot be replayed
 * against the GitHub API outside this app.
 */

const log = createLogger('auth:session');

export const SESSION_COOKIE = 'codesentinel_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const ISSUER = 'codesentinel';

export interface SessionPayload {
  userId: string;
  login: string;
  /** True for the local demo session (no GitHub account attached). */
  demo?: boolean;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(getEnv().SESSION_SECRET);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ login: payload.login, demo: payload.demo ?? false })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(payload.userId)
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: ISSUER });
    if (!payload.sub || typeof payload.login !== 'string') return null;
    return { userId: payload.sub, login: payload.login, demo: payload.demo === true };
  } catch (err) {
    log.debug('Session verification failed', { error: (err as Error).message });
    return null;
  }
}

export function sessionCookieOptions(maxAge: number = SESSION_TTL_SECONDS) {
  const env = getEnv();
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

/** Read + verify the session from the incoming request cookies. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function setSessionCookie(payload: SessionPayload): Promise<void> {
  const token = await createSessionToken(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', sessionCookieOptions(0));
}

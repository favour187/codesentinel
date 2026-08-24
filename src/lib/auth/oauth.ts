import { getEnv, getFeatures } from '@/lib/env';
import { randomToken, safeEqual, sha256 } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';

/**
 * GitHub OAuth (web application flow) with CSRF protection.
 *
 * Best practices implemented:
 *  - `state` parameter, stored in an httpOnly cookie and compared in constant
 *    time on callback (prevents login CSRF).
 *  - minimal scopes: `read:user` + `repo` (repo is required to read private
 *    repository contents; users may install the GitHub App instead for
 *    finer-grained, per-repository access).
 *  - the access token is exchanged server-side only and never sent to a client.
 */

const log = createLogger('auth:oauth');

export const OAUTH_STATE_COOKIE = 'codesentinel_oauth_state';
export const OAUTH_SCOPES = ['read:user', 'user:email', 'repo'] as const;

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';

export interface OAuthStart {
  url: string;
  state: string;
}

export function isOAuthConfigured(): boolean {
  return getFeatures().githubOAuth;
}

export function buildAuthorizeUrl(redirectPath = '/'): OAuthStart {
  const env = getEnv();
  if (!isOAuthConfigured()) {
    throw new Error('GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).');
  }
  // state = random nonce + where to return the user afterwards
  const nonce = randomToken(24);
  const state = `${nonce}.${Buffer.from(redirectPath).toString('base64url')}`;

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${env.APP_URL}/api/auth/github/callback`);
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');

  return { url: url.toString(), state };
}

export function verifyState(received: string | undefined, expected: string | undefined): boolean {
  if (!received || !expected) return false;
  return safeEqual(received, expected);
}

export function redirectPathFromState(state: string): string {
  const encoded = state.split('.')[1];
  if (!encoded) return '/';
  try {
    const path = Buffer.from(encoded, 'base64url').toString('utf8');
    // Only allow same-origin relative paths — blocks open-redirect abuse.
    return path.startsWith('/') && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
}

export interface TokenResponse {
  accessToken: string;
  scope: string;
  tokenType: string;
}

export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const env = getEnv();
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.APP_URL}/api/auth/github/callback`,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed with status ${res.status}`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (data.error || !data.access_token) {
    log.warn('Token exchange rejected', { error: data.error, description: data.error_description });
    throw new Error(data.error_description ?? data.error ?? 'No access token returned');
  }
  log.info('OAuth token exchanged', { tokenHash: sha256(data.access_token).slice(0, 12) });
  return {
    accessToken: data.access_token,
    scope: data.scope ?? '',
    tokenType: data.token_type ?? 'bearer',
  };
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CodeSentinel',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch GitHub user (${res.status})`);
  const u = (await res.json()) as {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
  return { id: u.id, login: u.login, name: u.name, email: u.email, avatarUrl: u.avatar_url };
}

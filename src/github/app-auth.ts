import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SignJWT, importPKCS8 } from 'jose';
import { getEnv, getFeatures } from '@/lib/env';
import { createLogger } from '@/lib/logger';
















const log = createLogger('github:auth');


const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export const GITHUB_API = 'https://api.github.com';

export class GitHubAppNotConfiguredError extends Error {
  readonly status = 503;
  constructor(message = 'GitHub App is not configured on this deployment') {
    super(message);
    this.name = 'GitHubAppNotConfiguredError';
  }
}


export function isGitHubAppConfigured(): boolean {
  return getFeatures().githubApp;
}







export async function loadPrivateKey(): Promise<string> {
  const env = getEnv();
  const inline = env.GITHUB_APP_PRIVATE_KEY.trim();
  if (inline) {

    return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  }
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH.trim();
  if (!path) throw new GitHubAppNotConfiguredError('No GitHub App private key configured');
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new GitHubAppNotConfiguredError(
      `Could not read GITHUB_APP_PRIVATE_KEY_PATH (${path}): ${(err as Error).message}`,
    );
  }
}



export async function getRepoInstallation(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; accountLogin: string } | null> {
  if (!isGitHubAppConfigured()) return null;
  try {
    const jwt = await createAppJwt();
    const response = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CodeSentinel',
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: number; account?: { login?: string } };
    if (typeof body.id !== 'number') return null;
    return { id: body.id, accountLogin: body.account?.login ?? owner };
  } catch {
    return null;
  }
}

export async function createAppJwt(now: number = Date.now()): Promise<string> {
  const env = getEnv();
  if (!env.GITHUB_APP_ID) throw new GitHubAppNotConfiguredError('GITHUB_APP_ID is not set');

  const pem = await loadPrivateKey();
  const key = await importPKCS8(pem, 'RS256');
  const issued = Math.floor(now / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })

    .setIssuedAt(issued - 60)
    .setExpirationTime(issued + 9 * 60)
    .setIssuer(env.GITHUB_APP_ID)
    .sign(key);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();


export function resetInstallationTokenCache(): void {
  tokenCache.clear();
}







export async function getInstallationToken(
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const jwt = await createAppJwt();
  const response = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to create installation token (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const payload = (await response.json()) as { token: string; expires_at: string };
  const expiresAt = Date.parse(payload.expires_at);

  tokenCache.set(installationId, {
    token: payload.token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 60 * 60 * 1000,
  });

  log.debug('Minted installation token', { installationId, expiresAt: payload.expires_at });
  return payload.token;
}





export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: 'missing-secret' | 'missing-signature' | 'bad-format' | 'mismatch' };












export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): SignatureResult {
  const secret = getEnv().GITHUB_WEBHOOK_SECRET;
  if (!secret) return { valid: false, reason: 'missing-secret' };
  if (!signatureHeader) return { valid: false, reason: 'missing-signature' };
  if (!signatureHeader.startsWith('sha256=')) return { valid: false, reason: 'bad-format' };

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
}


export function signWebhookBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

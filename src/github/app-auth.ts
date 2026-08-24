import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SignJWT, importPKCS8 } from 'jose';
import { getEnv, getFeatures } from '@/lib/env';
import { createLogger } from '@/lib/logger';

/**
 * GitHub App authentication.
 *
 * Two distinct credentials, deliberately separated:
 *  - The **app JWT** (RS256, signed with the private key) authenticates the App
 *    itself. It is only good for app-level endpoints and is capped at 10 minutes
 *    by GitHub; we use 9 to stay clear of clock skew.
 *  - An **installation token** authenticates as the App *on one installation*
 *    and is what every repository API call must use. GitHub expires these after
 *    an hour, so they are cached in-process with an early-expiry margin rather
 *    than minted per request (minting is rate-limited and adds latency).
 *
 * Tokens are never logged and never persisted — they live in memory only.
 */

const log = createLogger('github:auth');

/** Refresh installation tokens this long before GitHub expires them. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export const GITHUB_API = 'https://api.github.com';

export class GitHubAppNotConfiguredError extends Error {
  readonly status = 503;
  constructor(message = 'GitHub App is not configured on this deployment') {
    super(message);
    this.name = 'GitHubAppNotConfiguredError';
  }
}

/** True when an App id and a private key (inline or on disk) are present. */
export function isGitHubAppConfigured(): boolean {
  return getFeatures().githubApp;
}

/**
 * Loads the App private key.
 *
 * Accepts either the inline PEM (Vercel-friendly, `\n` escapes tolerated) or a
 * filesystem path (Docker/local-friendly). Inline wins when both are set.
 */
export async function loadPrivateKey(): Promise<string> {
  const env = getEnv();
  const inline = env.GITHUB_APP_PRIVATE_KEY.trim();
  if (inline) {
    // Env vars cannot hold real newlines in most dashboards; unescape them.
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

/** Mint a short-lived RS256 JWT authenticating as the App itself. */
export async function createAppJwt(now: number = Date.now()): Promise<string> {
  const env = getEnv();
  if (!env.GITHUB_APP_ID) throw new GitHubAppNotConfiguredError('GITHUB_APP_ID is not set');

  const pem = await loadPrivateKey();
  const key = await importPKCS8(pem, 'RS256');
  const issued = Math.floor(now / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    // 60s back-date absorbs clock drift between us and GitHub.
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

/** Test-only: drop cached installation tokens. */
export function resetInstallationTokenCache(): void {
  tokenCache.clear();
}

/**
 * Fetch (or reuse) an installation access token.
 *
 * `fetchImpl` is injectable so webhook/PR tests can run the whole guardian
 * pipeline against a fake GitHub without network access or real credentials.
 */
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

/* -------------------------------------------------------------------------- */
/* Webhook signature verification                                             */
/* -------------------------------------------------------------------------- */

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: 'missing-secret' | 'missing-signature' | 'bad-format' | 'mismatch' };

/**
 * Verify the `X-Hub-Signature-256` header against the RAW request body.
 *
 * Critical details:
 *  - The signature covers the exact bytes GitHub sent. Never re-serialize the
 *    JSON before verifying — key order changes and the HMAC fails.
 *  - Comparison is constant-time. A fast `===` leaks how many leading bytes
 *    matched, which is enough to forge a signature byte-by-byte.
 *  - An unset secret returns `missing-secret` rather than passing. Failing open
 *    would let anyone on the internet trigger scans and post PR comments.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): SignatureResult {
  const secret = getEnv().GITHUB_WEBHOOK_SECRET;
  if (!secret) return { valid: false, reason: 'missing-secret' };
  if (!signatureHeader) return { valid: false, reason: 'missing-signature' };
  if (!signatureHeader.startsWith('sha256=')) return { valid: false, reason: 'bad-format' };

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself be a leak.
  if (a.length !== b.length) return { valid: false, reason: 'mismatch' };
  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'mismatch' };
}

/** Helper used by tests and the local delivery replayer. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

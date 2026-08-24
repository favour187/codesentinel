import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSessionToken, verifySessionToken } from '@/lib/auth/session';
import { buildAuthorizeUrl, verifyState, redirectPathFromState, originFromState, isOAuthConfigured } from '@/lib/auth/oauth';
import { resetEnvCache } from '@/lib/env';

describe('session tokens', () => {
  it('signs and verifies a session', async () => {
    const token = await createSessionToken({ userId: 'user-42', login: 'octocat', demo: false });
    const payload = await verifySessionToken(token);

    expect(payload).not.toBeNull();
    expect(payload?.userId).toBe('user-42');
    expect(payload?.login).toBe('octocat');
    expect(payload?.demo).toBe(false);
  });

  it('preserves the demo flag', async () => {
    const token = await createSessionToken({ userId: 'user-1', login: 'demo-user', demo: true });
    expect((await verifySessionToken(token))?.demo).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const token = await createSessionToken({ userId: 'user-42', login: 'octocat', demo: false });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ sub: '999' })).toString('base64url')}.${signature}`;

    expect(await verifySessionToken(forged)).toBeNull();
  });

  it('rejects garbage input without throwing', async () => {
    expect(await verifySessionToken('not-a-jwt')).toBeNull();
    expect(await verifySessionToken('')).toBeNull();
  });

  it('does not embed the GitHub access token in the session', async () => {
    const token = await createSessionToken({ userId: 'user-42', login: 'octocat', demo: false });
    const decoded = Buffer.from(token.split('.')[1]!, 'base64url').toString();
    expect(decoded).not.toMatch(/ghp_|access_token|accessToken/);
  });
});

describe('oauth state', () => {
  it('reports OAuth as unconfigured when credentials are absent', () => {
    expect(isOAuthConfigured()).toBe(false);
  });
});

describe('oauth authorize flow', () => {
  beforeAll(() => {
    process.env.GITHUB_CLIENT_ID = 'Iv1.testclientid';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    resetEnvCache();
  });

  afterAll(() => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    resetEnvCache();
  });

  it('builds an authorize URL with the required parameters', () => {
    const { url } = buildAuthorizeUrl('/');
    const parsed = new URL(url);
    expect(parsed.host).toBe('github.com');
    expect(parsed.searchParams.get('client_id')).toBe('Iv1.testclientid');
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(parsed.searchParams.get('redirect_uri')).toContain('/api/auth/github/callback');
  });

  it('uses the request origin for the callback so preview hosts work', () => {
    const { url, state } = buildAuthorizeUrl('/', 'https://preview.example');
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://preview.example/api/auth/github/callback',
    );
    expect(originFromState(state)).toBe('https://preview.example');
  });

  it('round-trips a redirect path through the state parameter', () => {
    const { state } = buildAuthorizeUrl('/analysis');
    expect(verifyState(state, state)).toBe(true);
    expect(redirectPathFromState(state)).toBe('/analysis');
  });

  it('rejects a mismatched state (CSRF protection)', () => {
    const { state } = buildAuthorizeUrl('/');
    const { state: other } = buildAuthorizeUrl('/');
    expect(verifyState(state, other)).toBe(false);
    expect(verifyState(state, '')).toBe(false);
    expect(verifyState('', '')).toBe(false);
  });

  it('refuses open redirects to external hosts', () => {
    const { state } = buildAuthorizeUrl('https://evil.example.com/steal');
    expect(redirectPathFromState(state)).toBe('/');

    const { state: protocolRelative } = buildAuthorizeUrl('//evil.example.com');
    expect(redirectPathFromState(protocolRelative)).toBe('/');
  });
});

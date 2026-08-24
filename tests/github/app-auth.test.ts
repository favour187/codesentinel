import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { resetEnvCache } from '@/lib/env';
import {
  verifyWebhookSignature,
  signWebhookBody,
  isGitHubAppConfigured,
} from '@/github/app-auth';

const SECRET = 'test-webhook-secret-value';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
  });

  afterEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
  });

  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ action: 'opened', number: 7 });
    expect(verifyWebhookSignature(body, sign(body))).toEqual({ valid: true });
  });

  it('rejects a body that was modified after signing', () => {
    const body = JSON.stringify({ action: 'opened' });
    const signature = sign(body);
    const tampered = JSON.stringify({ action: 'closed' });
    const result = verifyWebhookSignature(tampered, signature);
    expect(result.valid).toBe(false);
    expect(result).toMatchObject({ reason: 'mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const body = '{"ok":true}';
    const result = verifyWebhookSignature(body, sign(body, 'attacker-secret'));
    expect(result.valid).toBe(false);
    expect(result).toMatchObject({ reason: 'mismatch' });
  });

  it('rejects a missing signature header', () => {
    expect(verifyWebhookSignature('{}', null)).toMatchObject({
      valid: false,
      reason: 'missing-signature',
    });
  });

  it('rejects a signature without the sha256= prefix', () => {
    const body = '{}';
    const raw = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyWebhookSignature(body, raw)).toMatchObject({ valid: false, reason: 'bad-format' });
  });

  it('rejects a sha1 signature — the legacy algorithm is not accepted', () => {
    const body = '{}';
    const sha1 = createHmac('sha1', SECRET).update(body).digest('hex');
    expect(verifyWebhookSignature(body, `sha1=${sha1}`)).toMatchObject({ valid: false });
  });

  it('FAILS CLOSED when no secret is configured', () => {
    // The dangerous failure mode: an unconfigured deployment must reject every
    // delivery, never accept unsigned ones.
    process.env.GITHUB_WEBHOOK_SECRET = '';
    resetEnvCache();
    const body = '{}';
    expect(verifyWebhookSignature(body, sign(body))).toMatchObject({
      valid: false,
      reason: 'missing-secret',
    });
  });

  it('is byte-exact: whitespace differences invalidate the signature', () => {
    // This is why the route must read raw text and never re-serialize JSON.
    const original = '{"a":1,"b":2}';
    const signature = sign(original);
    const reserialized = JSON.stringify(JSON.parse(original) as unknown) + ' ';
    expect(verifyWebhookSignature(reserialized, signature).valid).toBe(false);
  });

  it('verifies a payload containing unicode correctly', () => {
    const body = JSON.stringify({ title: 'fix: härdened auth ✅', emoji: '🛑' });
    expect(verifyWebhookSignature(body, sign(body))).toEqual({ valid: true });
  });

  it('signWebhookBody round-trips with verifyWebhookSignature', () => {
    const body = JSON.stringify({ zen: 'Non-blocking is better than blocking.' });
    expect(verifyWebhookSignature(body, signWebhookBody(body, SECRET))).toEqual({ valid: true });
  });
});

describe('isGitHubAppConfigured', () => {
  afterEach(() => {
    resetEnvCache();
  });

  it('is false when the app id is absent', () => {
    process.env.GITHUB_APP_ID = '';
    process.env.GITHUB_APP_PRIVATE_KEY = '';
    resetEnvCache();
    expect(isGitHubAppConfigured()).toBe(false);
  });

  it('is false when an app id exists but the private key does not', () => {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = '';
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = '';
    resetEnvCache();
    expect(isGitHubAppConfigured()).toBe(false);
  });
});

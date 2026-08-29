






import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetEnvCache } from '@/lib/env';
import { signWebhookBody } from '@/github/app-auth';

const handleWebhook = vi.hoisted(() => vi.fn());
vi.mock('@/guardian/webhook-handler', () => ({ handleWebhook }));

const SECRET = 'test-webhook-secret';

let POST: typeof import('@/app/api/webhooks/github/route').POST;
let GET: typeof import('@/app/api/webhooks/github/route').GET;

beforeEach(async () => {
  vi.resetModules();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  resetEnvCache();
  handleWebhook.mockReset();
  handleWebhook.mockResolvedValue({ status: 'processed', message: 'ok', jobId: 'job-1' });
  ({ POST, GET } = await import('@/app/api/webhooks/github/route'));
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  resetEnvCache();
});

function request(
  body: string,
  { signature, event = 'push', delivery = 'd-1' }: { signature?: string | null; event?: string | null; delivery?: string | null } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (event !== null) headers.set('x-github-event', event);
  if (delivery !== null) headers.set('x-github-delivery', delivery);
  const sig = signature === undefined ? signWebhookBody(body, SECRET) : signature;
  if (sig !== null) headers.set('x-hub-signature-256', sig);

  return new NextRequest('https://sentinel.test/api/webhooks/github', {
    method: 'POST',
    headers,
    body,
  });
}

const BODY = JSON.stringify({ ref: 'refs/heads/main', after: 'abc' });

describe('POST /api/webhooks/github — signature enforcement', () => {
  it('accepts a correctly signed delivery', async () => {
    const res = await POST(request(BODY));
    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledOnce();
  });

  it('rejects a forged signature with 401 and never invokes the handler', async () => {
    const res = await POST(request(BODY, { signature: `sha256=${'0'.repeat(64)}` }));
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a delivery with no signature at all', async () => {
    const res = await POST(request(BODY, { signature: null }));
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a signature computed over different bytes', async () => {

    const res = await POST(
      request(JSON.stringify({ ref: 'refs/heads/main', after: 'TAMPERED' }), {
        signature: signWebhookBody(BODY, SECRET),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a legacy sha1 signature', async () => {
    const res = await POST(request(BODY, { signature: 'sha1=abcdef' }));
    expect(res.status).toBe(401);
  });

  it('returns 503 — not 401 — when the deployment has no secret configured', async () => {


    vi.resetModules();
    delete process.env.GITHUB_WEBHOOK_SECRET;
    resetEnvCache();
    const mod = await import('@/app/api/webhooks/github/route');

    const res = await mod.POST(request(BODY, { signature: 'sha256=whatever' }));
    expect(res.status).toBe(503);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/github — request shape', () => {
  it('requires the event and delivery headers', async () => {
    expect((await POST(request(BODY, { event: null }))).status).toBe(400);
    expect((await POST(request(BODY, { delivery: null }))).status).toBe(400);
  });

  it('rejects a signed body that is not JSON', async () => {
    const res = await POST(request('not json at all'));
    expect(res.status).toBe(400);
  });

  it('passes the parsed payload and headers to the handler', async () => {
    await POST(request(BODY, { event: 'pull_request', delivery: 'abc-123' }));
    expect(handleWebhook).toHaveBeenCalledWith({
      deliveryId: 'abc-123',
      event: 'pull_request',
      payload: JSON.parse(BODY),
    });
  });
});

describe('POST /api/webhooks/github — response codes', () => {
  it('returns 200 for a deliberately ignored event so GitHub stops retrying', async () => {
    handleWebhook.mockResolvedValue({ status: 'ignored', message: 'draft pull request' });
    const res = await POST(request(BODY));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: 'ignored' });
  });

  it('returns 200 for a duplicate delivery', async () => {
    handleWebhook.mockResolvedValue({ status: 'duplicate', message: 'already processed' });
    expect((await POST(request(BODY))).status).toBe(200);
  });

  it('returns 200 when the handler records a failure', async () => {

    handleWebhook.mockResolvedValue({ status: 'failed', message: 'scanner unavailable' });
    expect((await POST(request(BODY))).status).toBe(200);
  });

  it('returns 500 when the handler throws, so GitHub retries', async () => {
    handleWebhook.mockRejectedValue(new Error('database unreachable'));
    const res = await POST(request(BODY));
    expect(res.status).toBe(500);
  });

  it('does not leak internal error details to the caller', async () => {
    handleWebhook.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const body = await (await POST(request(BODY))).text();
    expect(body).not.toContain('10.0.0.5');
  });

  it('returns the job id so a delivery can be traced to its scan', async () => {
    const res = await POST(request(BODY));
    await expect(res.json()).resolves.toMatchObject({ jobId: 'job-1' });
  });
});

describe('GET /api/webhooks/github', () => {
  it('explains the endpoint instead of 404ing', async () => {
    const res = GET();
    expect(res.status).toBe(405);
    await expect(res.json()).resolves.toMatchObject({ message: expect.stringContaining('webhook') });
  });
});

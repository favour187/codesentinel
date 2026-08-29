import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { verifyWebhookSignature } from '@/github/app-auth';
import { handleWebhook } from '@/guardian/webhook-handler';
import { createLogger } from '@/lib/logger';














export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:webhook');

export async function POST(request: NextRequest): Promise<NextResponse> {


  const rawBody = await request.text();

  const event = request.headers.get('x-github-event');
  const deliveryId = request.headers.get('x-github-delivery');
  const signature = request.headers.get('x-hub-signature-256');

  if (!event || !deliveryId) {
    return NextResponse.json(
      { error: 'Missing X-GitHub-Event or X-GitHub-Delivery header' },
      { status: 400 },
    );
  }

  const verification = verifyWebhookSignature(rawBody, signature);
  if (!verification.valid) {
    log.warn('Rejected webhook delivery', { deliveryId, event, reason: verification.reason });




    const status = verification.reason === 'missing-secret' ? 503 : 401;
    return NextResponse.json(
      {
        error:
          verification.reason === 'missing-secret'
            ? 'Webhook secret is not configured on this deployment'
            : 'Invalid signature',
      },
      { status },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON' }, { status: 400 });
  }

  try {
    const outcome = await handleWebhook({ deliveryId, event, payload });




    return NextResponse.json(
      { status: outcome.status, message: outcome.message, ...(outcome.jobId ? { jobId: outcome.jobId } : {}) },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Unhandled webhook error', { deliveryId, event, error: message });


    return NextResponse.json({ error: 'Internal error handling webhook' }, { status: 500 });
  }
}


export function GET(): NextResponse {
  return NextResponse.json(
    { message: 'CodeSentinel GitHub webhook endpoint. Send signed POST requests here.' },
    { status: 405 },
  );
}

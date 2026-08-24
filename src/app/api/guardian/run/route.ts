import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runWorker } from '@/guardian/worker';
import { requireUser, UnauthorizedError } from '@/lib/auth/current-user';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

/**
 * Drain the scan queue.
 *
 * Two callers, two auth modes:
 *  - A **cron/scheduler** presents `Authorization: Bearer <CRON_SECRET>`. This
 *    is how Vercel Cron and any external scheduler drive the queue.
 *  - A **signed-in user** hitting "Run queued scans" in the UI.
 *
 * Unauthenticated access is refused outright: this endpoint performs real work
 * against the GitHub API and would otherwise be a free denial-of-wallet vector.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Give the worker room on platforms that honour this hint. */
export const maxDuration = 300;

const log = createLogger('api:guardian:run');

function hasValidCronSecret(request: NextRequest): boolean {
  const configured = getEnv().CRON_SECRET;
  if (!configured) return false;

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(configured);
  // Length check first: timingSafeEqual throws on unequal lengths.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let actor: string;

  if (hasValidCronSecret(request)) {
    actor = 'cron';
  } else {
    try {
      const user = await requireUser();
      actor = `user:${user.id}`;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json(
          { ok: false, error: 'Authentication or a valid CRON_SECRET is required' },
          { status: 401 },
        );
      }
      throw err;
    }
  }

  try {
    const result = await runWorker({ maxJobs: 5 });
    log.info('Worker pass complete', { actor, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Worker pass failed', { actor, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

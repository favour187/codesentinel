import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, getDbKind } from '@/db';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:health');





export async function GET(): Promise<NextResponse> {
  const started = Date.now();
  try {
    const database = await db();
    await database.execute(sql`select 1`);

    return NextResponse.json({
      status: 'ok',
      database: { kind: getDbKind(), reachable: true },
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    log.error('Health check failed', { error: (err as Error).message });
    return NextResponse.json(
      { status: 'error', database: { kind: getDbKind(), reachable: false }, timestamp: new Date().toISOString() },
      { status: 503 },
    );
  }
}

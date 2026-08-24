import { NextResponse } from 'next/server';
import { requireUser, UnauthorizedError } from '@/lib/auth/current-user';
import { probeAIProviders } from '@/lib/ai-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    await requireUser();
    const probes = await probeAIProviders();
    return NextResponse.json({ ok: true, ...probes });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Could not probe AI providers' }, { status: 500 });
  }
}

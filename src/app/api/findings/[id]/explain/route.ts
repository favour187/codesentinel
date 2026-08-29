import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getFindingById } from '@/ai/context';
import { analyzeFalsePositive, explainFinding } from '@/ai/tasks/explain-finding';
import { aiErrorResponse, errorResponse, withRepositoryAccess } from '@/lib/api';







export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;



  const finding = await getFindingById(id).catch(() => null);
  if (!finding) {
    return NextResponse.json({ ok: false, error: 'Finding not found' }, { status: 404 });
  }

  return withRepositoryAccess(finding.repositoryId, async () => {
    try {
      const url = new URL(request.url);
      const regenerate = url.searchParams.get('regenerate') === 'true';
      const mode = url.searchParams.get('mode');

      if (mode === 'false-positive') {
        const result = await analyzeFalsePositive(id, regenerate ? { noCache: true } : {});
        if (!result.ok) return aiErrorResponse(result.reason, result.message);

        return NextResponse.json({
          ok: true,
          analysis: result.data,
          provider: result.provider,
          model: result.model,
          cached: result.cached,
        });
      }

      const result = await explainFinding(id, regenerate ? { noCache: true } : {});
      if (!result.ok) return aiErrorResponse(result.reason, result.message);

      return NextResponse.json({
        ok: true,
        explanation: result.data,
        provider: result.provider,
        model: result.model,
        cached: result.cached,
      });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

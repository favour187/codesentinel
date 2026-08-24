import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getFindingById } from '@/ai/context';
import { generateFix } from '@/ai/tasks/generate-fix';
import { generateTestsForFinding } from '@/ai/tasks/generate-tests';
import { aiErrorResponse, errorResponse, optionalString, readJsonBody, withRepositoryAccess } from '@/lib/api';

/**
 * Generate a fix, or regression tests, for a finding.
 *
 * Generating is not applying. This route only ever produces a proposal stored
 * with status `proposed`; creating a branch or a pull request is a separate,
 * explicitly-confirmed action.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

      if (mode === 'tests') {
        // The caller may pass the fixed code so the tests target the patched
        // behaviour rather than the current, broken one.
        const body = await readJsonBody(request).catch(() => ({}) as Record<string, unknown>);
        const fixedCode = optionalString(body, 'fixedCode', 20_000);

        const result = await generateTestsForFinding(id, {
          ...(regenerate ? { noCache: true } : {}),
          ...(fixedCode ? { fixedCode } : {}),
        });

        if (!result.ok) return aiErrorResponse(result.reason, result.message);

        return NextResponse.json({
          ok: true,
          tests: result.data,
          provider: result.provider,
          model: result.model,
          cached: result.cached,
          /* Stated explicitly: these have been generated, never executed. */
          executed: false,
        });
      }

      const result = await generateFix(id, regenerate ? { noCache: true } : {});
      if (!result.ok) return aiErrorResponse(result.reason, result.message);

      return NextResponse.json({ ok: true, fix: result.fix });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

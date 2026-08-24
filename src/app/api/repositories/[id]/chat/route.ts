import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { askCodebase } from '@/ai/tasks/codebase-chat';
import { countRecentRequests } from '@/lib/ai-queries';
import { aiErrorResponse, errorResponse, readJsonBody, requireString, withRepositoryAccess } from '@/lib/api';

/**
 * Codebase Intelligence: answer a question about this repository.
 *
 * Rate-limited per repository. Every question costs an inference call, and an
 * open text box is the easiest place in the product to run up a bill by
 * accident or on purpose.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_QUESTIONS_PER_HOUR = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return withRepositoryAccess(id, async () => {
    try {
      const body = await readJsonBody(request);
      const question = requireString(body, 'question', 1000);

      const recent = await countRecentRequests(id, 60);
      if (recent >= MAX_QUESTIONS_PER_HOUR) {
        return NextResponse.json(
          {
            ok: false,
            error: 'Hourly AI request limit reached for this repository. Try again later.',
            reason: 'rate_limited',
          },
          { status: 429 },
        );
      }

      const result = await askCodebase(id, question);
      if (!result.ok) return aiErrorResponse(result.reason, result.message);

      return NextResponse.json({
        ok: true,
        answer: result.data,
        files: result.sources?.files ?? [],
        findings:
          result.sources?.findings.map((f) => ({
            id: f.id,
            title: f.title,
            severity: f.severity,
            filePath: f.filePath,
            lineStart: f.lineStart,
          })) ?? [],
        provider: result.provider,
        model: result.model,
        cached: result.cached,
      });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

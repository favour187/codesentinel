import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { MEMORY_KINDS } from '@/db/schema';
import type { MemoryKind } from '@/db/schema';
import {
  createMemory,
  deleteMemory,
  listMemory,
  MemoryValidationError,
  updateMemory,
} from '@/lib/memory-queries';
import {
  BadRequestError,
  errorResponse,
  optionalString,
  optionalStringArray,
  readJsonBody,
  requireString,
  withRepositoryAccess,
} from '@/lib/api';









export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseKind(body: Record<string, unknown>): MemoryKind {
  const kind = requireString(body, 'kind', 50);
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestError(`"kind" must be one of: ${MEMORY_KINDS.join(', ')}.`);
  }
  return kind as MemoryKind;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return withRepositoryAccess(id, async () => {
    const entries = await listMemory(id);
    return NextResponse.json({ ok: true, entries });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return withRepositoryAccess(id, async ({ userId }) => {
    try {
      const body = await readJsonBody(request);
      const entry = await createMemory(id, userId, {
        kind: parseKind(body),
        title: requireString(body, 'title', 200),
        body: requireString(body, 'body', 4000),
        paths: optionalStringArray(body, 'paths', 25) ?? [],
      });

      return NextResponse.json({ ok: true, entry }, { status: 201 });
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
      }
      return errorResponse(err);
    }
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return withRepositoryAccess(id, async () => {
    try {
      const body = await readJsonBody(request);
      const entryId = requireString(body, 'id', 100);

      const entry = await updateMemory(id, entryId, {
        kind: parseKind(body),
        title: requireString(body, 'title', 200),
        body: requireString(body, 'body', 4000),
        paths: optionalStringArray(body, 'paths', 25) ?? [],
      });

      if (!entry) return NextResponse.json({ ok: false, error: 'Entry not found' }, { status: 404 });
      return NextResponse.json({ ok: true, entry });
    } catch (err) {
      if (err instanceof MemoryValidationError) {
        return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
      }
      return errorResponse(err);
    }
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  return withRepositoryAccess(id, async () => {
    try {
      const url = new URL(request.url);
      const entryId =
        url.searchParams.get('entryId') ?? optionalString(await readJsonBody(request).catch(() => ({})), 'id', 100);

      if (!entryId) throw new BadRequestError('An entry id is required.');

      const deleted = await deleteMemory(id, entryId);
      if (!deleted) return NextResponse.json({ ok: false, error: 'Entry not found' }, { status: 404 });

      return NextResponse.json({ ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  });
}

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  requireUser,
  assertRepositoryAccess,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/current-user';
import { activateGuardianForConnectedRepo, getRepositoryById } from '@/lib/repositories';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const { id } = await params;
    await assertRepositoryAccess(user.id, id);

    const repository = await getRepositoryById(id);
    if (!repository) {
      return NextResponse.json({ ok: false, error: 'Repository not found' }, { status: 404 });
    }
    if (repository.source !== 'github') {
      return NextResponse.json({ ok: false, error: 'Guardian applies to GitHub repositories.' }, { status: 400 });
    }

    const enabled = await activateGuardianForConnectedRepo(repository.owner, repository.name, repository.fullName);
    const fresh = await getRepositoryById(id);
    return NextResponse.json({
      ok: true,
      enabled: Boolean(enabled || fresh?.guardianEnabled),
      guardianEnabled: Boolean(fresh?.guardianEnabled),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  requireUser,
  assertRepositoryAccess,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/current-user';
import { activateGuardianForConnectedRepo, getRepositoryById, listRepositoriesForUser } from '@/lib/repositories';
import { handleWebhook } from '@/guardian/webhook-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Signed-in smoke test: turn Guardian on if the App is present, then record a
 * real `ping` delivery so the Guardian page shows activity. Nothing is faked.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    const repos = await listRepositoriesForUser(user.id);
    const repository = repos.find((r) => r.source === 'github') ?? repos[0];
    if (!repository) {
      return NextResponse.json({ ok: false, error: 'Connect a repository first.' }, { status: 400 });
    }
    await assertRepositoryAccess(user.id, repository.id);

    let enabled = repository.guardianEnabled;
    if (repository.source === 'github' && !enabled) {
      enabled = await activateGuardianForConnectedRepo(repository.owner, repository.name, repository.fullName);
    }

    const deliveryId = `ui-test-${randomUUID()}`;
    const outcome = await handleWebhook({
      deliveryId,
      event: 'ping',
      payload: {
        zen: 'CodeSentinel is listening.',
        hook_id: 0,
        repository: {
          full_name: repository.fullName,
          default_branch: repository.defaultBranch,
        },
      },
    });

    const fresh = await getRepositoryById(repository.id);
    return NextResponse.json({
      ok: true,
      repository: repository.fullName,
      guardianEnabled: Boolean(fresh?.guardianEnabled || enabled),
      delivery: {
        id: deliveryId,
        status: outcome.status,
        message: outcome.message,
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Sign in to test Guardian.' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db, repositories, repositoryPolicies } from '@/db';
import { requireUser, UnauthorizedError } from '@/lib/auth/current-user';
import { DEMO_REPO_FULL_NAME, demoFixtureExists } from '@/lib/demo/fixture';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:repositories:demo');

/**
 * Register the bundled demo fixture as a repository.
 *
 * The fixture is a REAL local repository of intentionally vulnerable code that
 * the real scanners analyse. It is stored with `source: 'demo'` so the UI can
 * always distinguish it from production GitHub analysis.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireUser();

    if (!(await demoFixtureExists())) {
      return NextResponse.json(
        { ok: false, error: 'Demo fixture not found on disk (expected ./fixtures/demo-repo).' },
        { status: 500 },
      );
    }

    const database = await db();
    const [existing] = await database
      .select()
      .from(repositories)
      .where(and(eq(repositories.fullName, DEMO_REPO_FULL_NAME), eq(repositories.source, 'demo')))
      .limit(1);

    if (existing) {
      // Make sure the current user owns it, then no-op.
      if (existing.ownerUserId !== user.id) {
        await database
          .update(repositories)
          .set({ ownerUserId: user.id, updatedAt: new Date() })
          .where(eq(repositories.id, existing.id));
      }
      return NextResponse.json({ ok: true, repositoryId: existing.id, created: false });
    }

    const [created] = await database
      .insert(repositories)
      .values({
        source: 'demo',
        owner: 'codesentinel',
        name: 'demo-repo',
        fullName: DEMO_REPO_FULL_NAME,
        defaultBranch: 'main',
        isPrivate: false,
        description: 'Bundled fixture containing intentionally vulnerable code for demonstrating real detection.',
        primaryLanguage: 'TypeScript',
        ownerUserId: user.id,
        guardianEnabled: false,
      })
      .returning();

    if (!created) throw new Error('Failed to create demo repository');

    await database.insert(repositoryPolicies).values({ repositoryId: created.id }).onConflictDoNothing();

    log.info('Demo repository registered', { userId: user.id, repositoryId: created.id });
    return NextResponse.json({ ok: true, repositoryId: created.id, created: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    log.error('Failed to register demo repository', { error: (err as Error).message });
    return NextResponse.json({ ok: false, error: 'Failed to register the demo repository' }, { status: 500 });
  }
}

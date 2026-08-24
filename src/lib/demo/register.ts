import { and, eq } from 'drizzle-orm';

import { db, repositories, repositoryPolicies } from '@/db';
import { DEMO_REPO_FULL_NAME, demoFixtureExists } from '@/lib/demo/fixture';

/** Idempotent: attach the bundled fixture to this user. */
export async function ensureDemoRepository(userId: string): Promise<string | null> {
  if (!(await demoFixtureExists())) return null;
  const database = await db();

  const [existing] = await database
    .select()
    .from(repositories)
    .where(and(eq(repositories.fullName, DEMO_REPO_FULL_NAME), eq(repositories.source, 'demo')))
    .limit(1);

  if (existing) {
    if (existing.ownerUserId !== userId) {
      await database.update(repositories).set({ ownerUserId: userId, updatedAt: new Date() }).where(eq(repositories.id, existing.id));
    }
    return existing.id;
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
      description: 'Bundled fixture with intentional issues. Scanned by the same production pipeline.',
      primaryLanguage: 'JavaScript',
      ownerUserId: userId,
      guardianEnabled: false,
    })
    .returning();

  if (!created) return null;
  await database.insert(repositoryPolicies).values({ repositoryId: created.id }).onConflictDoNothing();
  return created.id;
}

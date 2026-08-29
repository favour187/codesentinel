








import { and, eq } from 'drizzle-orm';
import { getDb } from '../src/db/index';
import { repositories, repositoryPolicies } from '../src/db/schema';
import { bootstrapSchema } from '../src/db/bootstrap';
import { getOrCreateDemoUser } from '../src/lib/auth/demo-session';
import { DEMO_REPO_FULL_NAME, demoFixtureExists, demoFixturePath } from '../src/lib/demo/fixture';

async function main(): Promise<void> {
  if (!(await demoFixtureExists())) {
    throw new Error(`Demo fixture not found at ${demoFixturePath()}`);
  }

  const db = await getDb();
  await bootstrapSchema(db);

  const user = await getOrCreateDemoUser();
  console.log(`[seed] demo user id=${user.id} login=${user.login}`);

  const [existing] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.fullName, DEMO_REPO_FULL_NAME), eq(repositories.source, 'demo')))
    .limit(1);

  if (existing) {
    console.log(`[seed] demo repository already present (id=${existing.id}).`);
    return;
  }

  const [repo] = await db
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

  await db.insert(repositoryPolicies).values({ repositoryId: repo!.id }).onConflictDoNothing();

  console.log(`[seed] demo repository created (id=${repo!.id}).`);
  console.log('[seed] run a scan from the UI to generate real findings from the fixture.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });

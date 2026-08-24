import { and, eq } from 'drizzle-orm';

import {
  db,
  repositories,
  repositoryPolicies,
  scans,
  findings,
  fixes,
  healthSnapshots,
  files,
  dependencies,
  tests,
  guardianEvents,
  symbols,
  codeEdges,
  components,
  indexState,
  scanJobs,
} from '@/db';
import { DEMO_REPO_FULL_NAME, demoFixtureExists, demoFixturePath } from '@/lib/demo/fixture';
import { executeScan } from '@/scanner/persistence';

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

/**
 * Wipe demo analysis only, then rescan the fixture.
 *
 * Refuses any repository that is not `source: 'demo'`. Real GitHub repos are
 * never touched.
 */
export async function resetDemoRepository(repositoryId: string): Promise<{ scanId: string; findings: number }> {
  const database = await db();
  const [repo] = await database.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1);
  if (!repo || repo.source !== 'demo') {
    throw new Error('Demo reset is only available for the bundled fixture.');
  }

  await database.delete(guardianEvents).where(eq(guardianEvents.repositoryId, repositoryId));
  await database.delete(scanJobs).where(eq(scanJobs.repositoryId, repositoryId));
  await database.delete(fixes).where(eq(fixes.repositoryId, repositoryId));
  await database.delete(findings).where(eq(findings.repositoryId, repositoryId));
  await database.delete(healthSnapshots).where(eq(healthSnapshots.repositoryId, repositoryId));
  await database.delete(files).where(eq(files.repositoryId, repositoryId));
  await database.delete(dependencies).where(eq(dependencies.repositoryId, repositoryId));
  await database.delete(tests).where(eq(tests.repositoryId, repositoryId));
  await database.delete(symbols).where(eq(symbols.repositoryId, repositoryId));
  await database.delete(codeEdges).where(eq(codeEdges.repositoryId, repositoryId));
  await database.delete(components).where(eq(components.repositoryId, repositoryId));
  await database.delete(indexState).where(eq(indexState.repositoryId, repositoryId));
  await database.delete(scans).where(eq(scans.repositoryId, repositoryId));

  const executed = await executeScan({
    repositoryId,
    rootDir: demoFixturePath(),
    trigger: 'manual',
    ref: 'refs/heads/main',
  });

  return { scanId: executed.scanId, findings: executed.result.findings.length };
}

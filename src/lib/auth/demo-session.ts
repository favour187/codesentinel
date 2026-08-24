import { eq } from 'drizzle-orm';
import { db, users } from '@/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:demo');

/**
 * The local demo identity.
 *
 * CodeSentinel is open-source and must be evaluable without registering a
 * GitHub OAuth app. The demo user owns ONLY demo-source repositories (the
 * bundled intentionally-vulnerable fixture), and every demo repository is
 * flagged `source: 'demo'` so its scan results can never be presented as real
 * production analysis.
 *
 * A negative githubId guarantees no collision with a real GitHub account id.
 */
export const DEMO_GITHUB_ID = -1;
export const DEMO_LOGIN = 'demo-user';

export async function getOrCreateDemoUser(): Promise<{ id: string; login: string }> {
  const database = await db();

  const [existing] = await database.select().from(users).where(eq(users.githubId, DEMO_GITHUB_ID)).limit(1);
  if (existing) return { id: existing.id, login: existing.login };

  const [created] = await database
    .insert(users)
    .values({
      githubId: DEMO_GITHUB_ID,
      login: DEMO_LOGIN,
      name: 'Demo User',
      email: null,
      avatarUrl: null,
      lastLoginAt: new Date(),
    })
    .returning();

  if (!created) throw new Error('Failed to create demo user');
  log.info('Created demo user', { userId: created.id });
  return { id: created.id, login: created.login };
}

import { eq, and } from 'drizzle-orm';
import { db, users, repositories, repositoryMembers } from '@/db';
import { getSession } from './session';
import { decryptSecret } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('auth:user');

export interface CurrentUser {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isDemo: boolean;
}

/** Resolve the signed-in user from the session cookie, or null. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getSession();
  if (!session) return null;

  const database = await db();
  const [row] = await database.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!row) return null;

  return {
    id: row.id,
    githubId: row.githubId,
    login: row.login,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    isDemo: session.demo === true || row.githubId < 0,
  };
}

/** Throwing variant for API routes / server actions. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'You do not have access to this resource') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Authorization check: a user may access a repository when they own it or are
 * an explicit member. Every repository-scoped route must go through this.
 */
export async function assertRepositoryAccess(userId: string, repositoryId: string): Promise<void> {
  const database = await db();

  const [repo] = await database
    .select({ id: repositories.id, ownerUserId: repositories.ownerUserId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  if (!repo) throw new ForbiddenError('Repository not found');
  if (repo.ownerUserId === userId) return;

  const [member] = await database
    .select({ userId: repositoryMembers.userId })
    .from(repositoryMembers)
    .where(and(eq(repositoryMembers.repositoryId, repositoryId), eq(repositoryMembers.userId, userId)))
    .limit(1);

  if (!member) {
    log.warn('Repository access denied', { userId, repositoryId });
    throw new ForbiddenError();
  }
}

/**
 * Decrypt a user's GitHub OAuth token for server-side API calls.
 * Returns null when the user has no token (e.g. the demo user).
 */
export async function getUserGitHubToken(userId: string): Promise<string | null> {
  const database = await db();
  const [row] = await database
    .select({ token: users.accessTokenEncrypted })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row?.token) return null;
  try {
    return decryptSecret(row.token);
  } catch (err) {
    log.error('Failed to decrypt stored GitHub token', { userId, error: (err as Error).message });
    return null;
  }
}

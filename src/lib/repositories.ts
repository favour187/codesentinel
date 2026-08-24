import { desc, eq, or, inArray } from 'drizzle-orm';
import { db, repositories, repositoryMembers, repositoryPolicies } from '@/db';
import type { RepoSource, Severity } from '@/db/schema';

export interface RepositorySummary {
  id: string;
  source: RepoSource;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  description: string | null;
  primaryLanguage: string | null;
  htmlUrl: string | null;
  guardianEnabled: boolean;
  lastScanAt: Date | null;
  isDemo: boolean;
}

/** Repositories the user owns or is an explicit member of. */
export async function listRepositoriesForUser(userId: string): Promise<RepositorySummary[]> {
  const database = await db();

  const memberships = await database
    .select({ repositoryId: repositoryMembers.repositoryId })
    .from(repositoryMembers)
    .where(eq(repositoryMembers.userId, userId));

  const memberIds = memberships.map((m) => m.repositoryId);

  const rows = await database
    .select()
    .from(repositories)
    .where(
      memberIds.length > 0
        ? or(eq(repositories.ownerUserId, userId), inArray(repositories.id, memberIds))
        : eq(repositories.ownerUserId, userId),
    )
    .orderBy(desc(repositories.lastScanAt), desc(repositories.createdAt));

  return rows.map(toSummary);
}

export async function getRepositoryById(id: string): Promise<RepositorySummary | null> {
  const database = await db();
  const [row] = await database.select().from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Resolve the repository a page should render: the explicitly requested one, or
 * the user's most recently scanned repository.
 */
export async function resolveActiveRepository(
  userId: string,
  requestedId?: string,
): Promise<RepositorySummary | null> {
  const repos = await listRepositoriesForUser(userId);
  if (repos.length === 0) return null;
  if (requestedId) {
    const match = repos.find((r) => r.id === requestedId);
    if (match) return match;
  }
  return repos[0] ?? null;
}

export interface RepositoryPolicy {
  failOnSeverity: Severity;
  enabledScanners: string[];
  scanOnPush: boolean;
  scanOnPullRequest: boolean;
  postPrComments: boolean;
  createChecks: boolean;
  scanSchedule: string;
  ignorePaths: string[];
}

export const DEFAULT_POLICY: RepositoryPolicy = {
  failOnSeverity: 'high',
  enabledScanners: [],
  scanOnPush: true,
  scanOnPullRequest: true,
  postPrComments: true,
  createChecks: true,
  scanSchedule: 'daily',
  ignorePaths: [],
};

export async function getRepositoryPolicy(repositoryId: string): Promise<RepositoryPolicy> {
  const database = await db();
  const [row] = await database
    .select()
    .from(repositoryPolicies)
    .where(eq(repositoryPolicies.repositoryId, repositoryId))
    .limit(1);

  if (!row) return { ...DEFAULT_POLICY };
  return {
    failOnSeverity: row.failOnSeverity,
    enabledScanners: row.enabledScanners,
    scanOnPush: row.scanOnPush,
    scanOnPullRequest: row.scanOnPullRequest,
    postPrComments: row.postPrComments,
    createChecks: row.createChecks,
    scanSchedule: row.scanSchedule,
    ignorePaths: row.ignorePaths,
  };
}

type RepositoryRow = typeof repositories.$inferSelect;

export async function connectGitHubRepository(
  userId: string,
  input: {
    githubId: number;
    owner: string;
    name: string;
    fullName: string;
    defaultBranch: string;
    isPrivate: boolean;
    description: string | null;
    primaryLanguage: string | null;
    htmlUrl: string | null;
  },
): Promise<RepositorySummary> {
  const database = await db();
  const [existing] = await database.select().from(repositories).where(eq(repositories.githubId, input.githubId)).limit(1);

  if (existing) {
    await database
      .update(repositories)
      .set({
        ownerUserId: userId,
        owner: input.owner,
        name: input.name,
        fullName: input.fullName,
        defaultBranch: input.defaultBranch,
        isPrivate: input.isPrivate,
        description: input.description,
        primaryLanguage: input.primaryLanguage,
        htmlUrl: input.htmlUrl,
        updatedAt: new Date(),
      })
      .where(eq(repositories.id, existing.id));
    return { ...toSummary(existing), ...input, id: existing.id, source: existing.source, guardianEnabled: existing.guardianEnabled, lastScanAt: existing.lastScanAt, isDemo: existing.source === 'demo' };
  }

  const [created] = await database
    .insert(repositories)
    .values({
      source: 'github',
      githubId: input.githubId,
      owner: input.owner,
      name: input.name,
      fullName: input.fullName,
      defaultBranch: input.defaultBranch,
      isPrivate: input.isPrivate,
      description: input.description,
      primaryLanguage: input.primaryLanguage,
      htmlUrl: input.htmlUrl,
      ownerUserId: userId,
    })
    .returning();

  if (!created) throw new Error('Failed to connect repository');
  await database.insert(repositoryPolicies).values({ repositoryId: created.id }).onConflictDoNothing();
  return toSummary(created);
}

function toSummary(row: RepositoryRow): RepositorySummary {
  return {
    id: row.id,
    source: row.source,
    owner: row.owner,
    name: row.name,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    description: row.description,
    primaryLanguage: row.primaryLanguage,
    htmlUrl: row.htmlUrl,
    guardianEnabled: row.guardianEnabled,
    lastScanAt: row.lastScanAt,
    isDemo: row.source === 'demo',
  };
}

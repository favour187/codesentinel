import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { installations, repositories } from '@/db/schema';
import { GitHubClient } from '@/github/client';
import { isGitHubAppConfigured } from '@/github/app-auth';
import { demoFixturePath } from '@/lib/demo/fixture';
import { createLogger } from '@/lib/logger';
import { redactSecrets } from '@/ai/redaction';

/**
 * Read the current content of a repository file.
 *
 * AI features need real source, not the excerpt frozen into a finding at scan
 * time. Two backends, one interface:
 *  - **demo** repositories read the bundled local fixture,
 *  - **github** repositories read through the installation-authenticated API.
 *
 * Content is redacted before it leaves this module. That makes it impossible
 * for a caller to obtain raw secret material by way of a "read this file"
 * helper, whatever it then does with the text.
 */

const log = createLogger('analysis:source');

/** Refuse to load anything a prompt could not use anyway. */
const MAX_FILE_BYTES = 512 * 1024;

export interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  /** Kinds of secret redacted before returning, for display. */
  readonly redacted: readonly string[];
}

export async function readRepositoryFile(repositoryId: string, path: string): Promise<SourceFile | null> {
  const safePath = sanitizeRepoPath(path);
  if (!safePath) {
    log.warn('Rejected unsafe repository path', { repositoryId, path });
    return null;
  }

  const db = await getDb();
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1);
  if (!repo) return null;

  const raw =
    repo.source === 'demo'
      ? await readLocalFile(demoFixturePath(), safePath)
      : await readGitHubFile(repo, safePath);

  if (raw === null) return null;

  const truncated = raw.length > MAX_FILE_BYTES;
  const body = truncated ? raw.slice(0, MAX_FILE_BYTES) : raw;
  const { text, redacted } = redactSecrets(body);

  return { path: safePath, content: text, truncated, redacted };
}

async function readLocalFile(rootDir: string, path: string): Promise<string | null> {
  /*
   * Resolve and re-check containment. sanitizeRepoPath already rejects `..`,
   * but a symlink inside the fixture could still point outside it, and this is
   * the boundary where that would matter.
   */
  const root = resolve(rootDir);
  const target = resolve(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) {
    log.warn('Path escaped repository root', { path });
    return null;
  }

  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function readGitHubFile(
  repo: typeof repositories.$inferSelect,
  path: string,
): Promise<string | null> {
  if (!isGitHubAppConfigured() || !repo.installationId) return null;

  try {
    const db = await getDb();
    const [installation] = await db
      .select({ installationId: installations.installationId })
      .from(installations)
      .where(eq(installations.id, repo.installationId))
      .limit(1);

    if (!installation) return null;

    const client = await GitHubClient.forInstallation(installation.installationId);
    return await client.getFileContent(repo.owner, repo.name, path, repo.defaultBranch);
  } catch (err) {
    log.warn('Could not read file from GitHub', {
      repository: repo.fullName,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Normalise a repository-relative path and reject traversal.
 *
 * Paths reaching here can originate from an AI response or a query parameter,
 * so neither is trusted. Returns null for anything not clearly inside the repo.
 */
export function sanitizeRepoPath(path: string): string | null {
  if (!path || path.length > 400) return null;
  if (path.includes('\0')) return null;
  if (isAbsolute(path)) return null;

  const normalized = normalize(path).replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '.') return null;
  if (normalized.startsWith('/')) return null;

  return normalized;
}

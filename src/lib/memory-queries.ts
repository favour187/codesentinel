import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { repositoryMemory } from '@/db/schema';
import type { MemoryKind } from '@/db/schema';

/**
 * Item 12: repository memory.
 *
 * Facts a team wants CodeSentinel to remember: architecture decisions,
 * intentional exceptions, accepted risks, policies, conventions.
 *
 * These rows are authoritative and are injected into AI prompts as trusted
 * context. That is exactly why **only a human can create one**. There is no
 * code path anywhere that lets a model write here — if an AI guess could
 * become a remembered rule, a single hallucination would silently poison every
 * later analysis.
 */

export interface MemoryEntry {
  readonly id: string;
  readonly repositoryId: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  readonly paths: readonly string[];
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  decision: 'Architecture decision',
  exception: 'Intentional exception',
  accepted_risk: 'Accepted risk',
  policy: 'Policy',
  convention: 'Convention',
};

export const MEMORY_KIND_DESCRIPTIONS: Record<MemoryKind, string> = {
  decision: 'A deliberate design choice and the reasoning behind it.',
  exception: 'Something that looks like a problem but is intentional here.',
  accepted_risk: 'A known risk the team has decided to live with, for now.',
  policy: 'A rule this repository must follow.',
  convention: 'A pattern contributors are expected to match.',
};

export async function listMemory(repositoryId: string): Promise<MemoryEntry[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(repositoryMemory)
    .where(eq(repositoryMemory.repositoryId, repositoryId))
    .orderBy(desc(repositoryMemory.updatedAt));

  return rows.map(toEntry);
}

export async function getMemoryEntry(repositoryId: string, id: string): Promise<MemoryEntry | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(repositoryMemory)
    .where(and(eq(repositoryMemory.repositoryId, repositoryId), eq(repositoryMemory.id, id)))
    .limit(1);

  return row ? toEntry(row) : null;
}

export interface MemoryInput {
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  /** Empty means the fact applies to the whole repository. */
  readonly paths?: readonly string[];
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

/** Bounds that keep one entry from consuming the entire prompt budget. */
const MAX_TITLE = 200;
const MAX_BODY = 4000;
const MAX_PATHS = 25;

export function validateMemoryInput(input: MemoryInput): MemoryInput {
  const title = input.title.trim();
  const body = input.body.trim();

  if (title.length === 0) throw new MemoryValidationError('A title is required.');
  if (title.length > MAX_TITLE) throw new MemoryValidationError(`Title must be ${MAX_TITLE} characters or fewer.`);
  if (body.length === 0) throw new MemoryValidationError('A description is required.');
  if (body.length > MAX_BODY) throw new MemoryValidationError(`Description must be ${MAX_BODY} characters or fewer.`);

  const paths = (input.paths ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, MAX_PATHS);

  return { kind: input.kind, title, body, paths };
}

export async function createMemory(
  repositoryId: string,
  userId: string,
  input: MemoryInput,
): Promise<MemoryEntry> {
  const clean = validateMemoryInput(input);
  const db = await getDb();

  const [row] = await db
    .insert(repositoryMemory)
    .values({
      repositoryId,
      kind: clean.kind,
      title: clean.title,
      body: clean.body,
      paths: [...(clean.paths ?? [])],
      createdByUserId: userId,
    })
    .returning();

  if (!row) throw new Error('Failed to create memory entry.');
  return toEntry(row);
}

export async function updateMemory(
  repositoryId: string,
  id: string,
  input: MemoryInput,
): Promise<MemoryEntry | null> {
  const clean = validateMemoryInput(input);
  const db = await getDb();

  const [row] = await db
    .update(repositoryMemory)
    .set({
      kind: clean.kind,
      title: clean.title,
      body: clean.body,
      paths: [...(clean.paths ?? [])],
      updatedAt: new Date(),
    })
    .where(and(eq(repositoryMemory.repositoryId, repositoryId), eq(repositoryMemory.id, id)))
    .returning();

  return row ? toEntry(row) : null;
}

export async function deleteMemory(repositoryId: string, id: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(repositoryMemory)
    .where(and(eq(repositoryMemory.repositoryId, repositoryId), eq(repositoryMemory.id, id)))
    .returning();

  return rows.length > 0;
}

function toEntry(row: typeof repositoryMemory.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    paths: row.paths,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

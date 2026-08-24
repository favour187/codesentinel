import { and, desc, eq, isNull, or } from 'drizzle-orm';

import { getDb } from '@/db';
import { guardianEvents } from '@/db/schema';
import type { GuardianEventType } from '@/db/schema';

/**
 * Guardian event log.
 *
 * Every notable observation becomes a row. Duplicate events with the same
 * dedupeKey within a repository are ignored (unique index). Nothing here
 * mutates repository code.
 */

export interface GuardianEventInput {
  readonly repositoryId: string;
  readonly type: GuardianEventType;
  readonly title: string;
  readonly detail?: string | null;
  readonly level?: 'info' | 'success' | 'warning' | 'critical';
  readonly dedupeKey?: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface GuardianEventRecord {
  readonly id: string;
  readonly type: GuardianEventType;
  readonly title: string;
  readonly detail: string | null;
  readonly level: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: Date;
}

export async function recordEvent(input: GuardianEventInput): Promise<GuardianEventRecord | null> {
  const db = await getDb();
  try {
    const [row] = await db
      .insert(guardianEvents)
      .values({
        repositoryId: input.repositoryId,
        type: input.type,
        title: input.title,
        detail: input.detail ?? null,
        level: input.level ?? 'info',
        dedupeKey: input.dedupeKey ?? null,
        payload: input.payload ?? {},
      })
      .onConflictDoNothing()
      .returning();
    return row ? toRecord(row) : null;
  } catch {
    return null;
  }
}

export async function listEvents(repositoryId: string, limit = 40): Promise<GuardianEventRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(guardianEvents)
    .where(eq(guardianEvents.repositoryId, repositoryId))
    .orderBy(desc(guardianEvents.createdAt))
    .limit(limit);
  return rows.map(toRecord);
}

/** Events that still apply — expired memory is handled elsewhere. */
export async function findEventByDedupe(
  repositoryId: string,
  dedupeKey: string,
): Promise<GuardianEventRecord | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(guardianEvents)
    .where(
      and(
        eq(guardianEvents.repositoryId, repositoryId),
        or(eq(guardianEvents.dedupeKey, dedupeKey), isNull(guardianEvents.dedupeKey)),
      ),
    )
    .limit(1);
  return row && row.dedupeKey === dedupeKey ? toRecord(row) : null;
}

function toRecord(row: typeof guardianEvents.$inferSelect): GuardianEventRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    detail: row.detail,
    level: row.level,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

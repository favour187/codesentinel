import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { aiRequests } from '@/db/schema';
import type { AIRequestStatus } from '@/db/schema';










export interface AIActivityEntry {
  readonly id: string;
  readonly task: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: AIRequestStatus;
  readonly durationMs: number | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly attempts: ReadonlyArray<{ provider: string; error: string }>;
  readonly evidenceSources: readonly string[];
  readonly redactedKinds: readonly string[];
  readonly findingId: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
}

export async function listAIActivity(repositoryId: string, limit = 50): Promise<AIActivityEntry[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiRequests.id,
      task: aiRequests.task,
      provider: aiRequests.provider,
      model: aiRequests.model,
      status: aiRequests.status,
      durationMs: aiRequests.durationMs,
      promptTokens: aiRequests.promptTokens,
      completionTokens: aiRequests.completionTokens,
      attempts: aiRequests.attempts,
      evidenceSources: aiRequests.evidenceSources,
      redactedKinds: aiRequests.redactedKinds,
      findingId: aiRequests.findingId,
      error: aiRequests.error,
      createdAt: aiRequests.createdAt,
    })
    .from(aiRequests)
    .where(eq(aiRequests.repositoryId, repositoryId))
    .orderBy(desc(aiRequests.createdAt))
    .limit(limit);

  return rows;
}

export interface AIUsageStats {
  readonly totalRequests: number;
  readonly successful: number;
  readonly failed: number;
  readonly medianDurationMs: number | null;
  readonly totalPromptTokens: number;
  readonly totalCompletionTokens: number;
  readonly byProvider: ReadonlyArray<{ provider: string; count: number; failures: number }>;
  readonly byTask: ReadonlyArray<{ task: string; count: number }>;

  readonly fallbackCount: number;
}


export async function getAIUsageStats(repositoryId: string, sinceDays = 30): Promise<AIUsageStats> {
  const db = await getDb();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      provider: aiRequests.provider,
      task: aiRequests.task,
      status: aiRequests.status,
      durationMs: aiRequests.durationMs,
      promptTokens: aiRequests.promptTokens,
      completionTokens: aiRequests.completionTokens,
      attempts: aiRequests.attempts,
    })
    .from(aiRequests)
    .where(and(eq(aiRequests.repositoryId, repositoryId), gte(aiRequests.createdAt, since)));

  const byProvider = new Map<string, { count: number; failures: number }>();
  const byTask = new Map<string, number>();
  const durations: number[] = [];

  let successful = 0;
  let failed = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let fallbackCount = 0;

  for (const row of rows) {
    if (row.status === 'ok') successful += 1;
    else if (row.status === 'failed') failed += 1;

    if (row.durationMs !== null) durations.push(row.durationMs);
    totalPromptTokens += row.promptTokens ?? 0;
    totalCompletionTokens += row.completionTokens ?? 0;

    byTask.set(row.task, (byTask.get(row.task) ?? 0) + 1);

    if (row.provider) {
      const entry = byProvider.get(row.provider) ?? { count: 0, failures: 0 };
      entry.count += 1;
      byProvider.set(row.provider, entry);
    }


    for (const attempt of row.attempts) {
      const entry = byProvider.get(attempt.provider) ?? { count: 0, failures: 0 };
      entry.failures += 1;
      byProvider.set(attempt.provider, entry);
    }

    if (row.status === 'ok' && row.attempts.length > 0) fallbackCount += 1;
  }

  return {
    totalRequests: rows.length,
    successful,
    failed,
    medianDurationMs: median(durations),
    totalPromptTokens,
    totalCompletionTokens,
    byProvider: [...byProvider.entries()]
      .map(([provider, v]) => ({ provider, ...v }))
      .sort((a, b) => b.count - a.count),
    byTask: [...byTask.entries()].map(([task, count]) => ({ task, count })).sort((a, b) => b.count - a.count),
    fallbackCount,
  };
}


export async function getCachedResponse(findingId: string, task: string): Promise<Record<string, unknown> | null> {
  const db = await getDb();
  const [row] = await db
    .select({ response: aiRequests.response })
    .from(aiRequests)
    .where(and(eq(aiRequests.findingId, findingId), eq(aiRequests.task, task), eq(aiRequests.status, 'ok')))
    .orderBy(desc(aiRequests.createdAt))
    .limit(1);

  return row?.response ?? null;
}


export async function countRecentRequests(repositoryId: string, withinMinutes = 60): Promise<number> {
  const db = await getDb();
  const since = new Date(Date.now() - withinMinutes * 60 * 1000);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiRequests)
    .where(and(eq(aiRequests.repositoryId, repositoryId), gte(aiRequests.createdAt, since)));

  return row?.n ?? 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? null);
}

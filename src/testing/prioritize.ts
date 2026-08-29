import { eq } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { tests } from '@/db/schema';
import { TwinGraph } from '@/twin/graph';














export interface PrioritizedTest {
  readonly testPath: string;
  readonly framework: string | null;
  readonly testCount: number;

  readonly score: number;

  readonly justification: string;

  readonly covers: ReadonlyArray<{ path: string; depth: number }>;
}

const MAX_DEPTH = 3;








export async function prioritizeTests(
  repositoryId: string,
  changedFiles: readonly string[],
  options: { limit?: number } = {},
): Promise<PrioritizedTest[]> {
  const limit = options.limit ?? 20;
  if (changedFiles.length === 0) return [];

  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return [];

  const [testRows, graph] = await Promise.all([
    db.select().from(tests).where(eq(tests.scanId, scanId)),
    TwinGraph.load(repositoryId),
  ]);
  if (testRows.length === 0) return [];






  const distance = new Map<string, number>();
  for (const path of changedFiles) distance.set(path, 0);
  for (const reached of graph.reachableDependents(changedFiles, { maxDepth: MAX_DEPTH, maxNodes: 300 })) {
    const existing = distance.get(reached.path);
    if (existing === undefined || reached.depth < existing) distance.set(reached.path, reached.depth);
  }


  const coverage = new Map<string, Set<string>>();
  for (const edge of graph.testsCovering([...distance.keys()])) {
    const set = coverage.get(edge.testPath) ?? new Set<string>();
    set.add(edge.covers);
    coverage.set(edge.testPath, set);
  }

  const results: PrioritizedTest[] = [];

  for (const row of testRows) {
    const covered = coverage.get(row.filePath);
    if (!covered || covered.size === 0) continue;

    const covers = [...covered]
      .map((path) => ({ path, depth: distance.get(path) ?? MAX_DEPTH }))
      .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

    const nearest = covers[0];
    if (!nearest) continue;

    results.push({
      testPath: row.filePath,
      framework: row.framework,
      testCount: row.testCount,
      score: scoreTestRelevance({
        nearestDepth: nearest.depth,
        directHits: covers.filter((c) => c.depth === 0).length,
        totalHits: covers.length,
        testCount: row.testCount,
        hasAssertions: row.hasAssertions,
      }),
      justification: justify(covers, row.hasAssertions),
      covers,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.testPath.localeCompare(b.testPath))
    .slice(0, limit);
}








export function scoreTestRelevance(input: {
  nearestDepth: number;
  directHits: number;
  totalHits: number;
  testCount: number;
  hasAssertions: boolean;
}): number {






  if (!Number.isFinite(input.nearestDepth) || input.nearestDepth < 0 || input.nearestDepth > MAX_DEPTH) return 0;

  let score = 0;


  const depthPoints = [55, 35, 20, 10];
  score += depthPoints[input.nearestDepth] ?? 10;



  score += Math.min(20, Math.log2(input.directHits + 1) * 10);
  score += Math.min(10, Math.log2(input.totalHits + 1) * 4);


  score += Math.min(10, Math.log2(input.testCount + 1) * 3);

  if (!input.hasAssertions) return Math.min(25, Math.round(score));

  return Math.round(Math.max(0, Math.min(100, score)));
}

function justify(covers: ReadonlyArray<{ path: string; depth: number }>, hasAssertions: boolean): string {
  const direct = covers.filter((c) => c.depth === 0);
  const indirect = covers.filter((c) => c.depth > 0);

  const parts: string[] = [];

  if (direct.length > 0) {
    parts.push(
      `Directly imports ${direct.length === 1 ? 'the changed file' : `${direct.length} changed files`}: ${direct
        .slice(0, 3)
        .map((c) => c.path)
        .join(', ')}${direct.length > 3 ? '…' : ''}`,
    );
  }

  if (indirect.length > 0) {
    const nearest = indirect[0];
    parts.push(
      `Covers ${nearest?.path} which is ${nearest?.depth} import hop${nearest?.depth === 1 ? '' : 's'} downstream of the change`,
    );
  }

  if (!hasAssertions) {
    parts.push('No assertions were detected in this file, so it may execute the code without verifying it');
  }

  return `${parts.join('. ')}.`;
}

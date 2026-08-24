import { eq } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { tests } from '@/db/schema';
import { TwinGraph } from '@/twin/graph';

/**
 * Test prioritisation.
 *
 * Given a set of changed files, order the existing test suite by how likely
 * each test is to catch a regression in that change. Every position carries a
 * justification naming the relationship that put it there — an ordering
 * nobody can audit is an ordering nobody will trust.
 *
 * The ranking is graph distance first, then breadth. A test that directly
 * imports a changed file beats a test that reaches it through two hops, and
 * among equals the one covering more of the change wins.
 */

export interface PrioritizedTest {
  readonly testPath: string;
  readonly framework: string | null;
  readonly testCount: number;
  /** 0-100. Relative ordering signal, not a probability. */
  readonly score: number;
  /** Why this test is at this position, in terms of the graph. */
  readonly justification: string;
  /** Changed files this test reaches, nearest first. */
  readonly covers: ReadonlyArray<{ path: string; depth: number }>;
}

const MAX_DEPTH = 3;

/**
 * Rank tests by relevance to a change.
 *
 * A test is relevant when it covers a changed file, or covers a file that
 * (transitively) depends on a changed file. Depth is the number of import
 * hops between the test's subject and the change.
 */
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

  /*
   * Distance from each changed file outward. A file at distance 0 is changed;
   * at distance 1 it imports something changed. A test covering either is
   * relevant, and the smaller distance is the stronger signal.
   */
  const distance = new Map<string, number>();
  for (const path of changedFiles) distance.set(path, 0);
  for (const reached of graph.reachableDependents(changedFiles, { maxDepth: MAX_DEPTH, maxNodes: 300 })) {
    const existing = distance.get(reached.path);
    if (existing === undefined || reached.depth < existing) distance.set(reached.path, reached.depth);
  }

  // testPath -> the files it covers, from stored TESTS edges.
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

/**
 * Relevance score, 0-100. Pure and exported so the ordering can be tested.
 *
 * Depth dominates: a direct test is worth far more than three indirect ones.
 * A test with no assertions is capped low — it executes code without checking
 * anything, so it will not catch the regression it appears to guard.
 */
export function scoreTestRelevance(input: {
  nearestDepth: number;
  directHits: number;
  totalHits: number;
  testCount: number;
  hasAssertions: boolean;
}): number {
  /*
   * Beyond the traversal horizon there is no evidence of a relationship, so
   * there is nothing to recommend. `prioritizeTests` never scores a test this
   * far out, but the function is exported and must not invent relevance for
   * a subject it cannot connect to the change.
   */
  if (!Number.isFinite(input.nearestDepth) || input.nearestDepth < 0 || input.nearestDepth > MAX_DEPTH) return 0;

  let score = 0;

  // Distance to the change: 0 hops = 55, 1 = 35, 2 = 20, 3 = 10.
  const depthPoints = [55, 35, 20, 10];
  score += depthPoints[input.nearestDepth] ?? 10;

  // Breadth of the overlap, saturating — covering 8 changed files instead of
  // 6 does not make a test meaningfully more urgent.
  score += Math.min(20, Math.log2(input.directHits + 1) * 10);
  score += Math.min(10, Math.log2(input.totalHits + 1) * 4);

  // A suite with more cases explores more of the subject.
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

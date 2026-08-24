import { and, eq, inArray } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { files, tests } from '@/db/schema';
import { SUPPORTED_LANGUAGES } from '@/twin/parsers';
import { TwinGraph } from '@/twin/graph';
import { loadSymbols } from '@/twin/graph';
import type { GraphSymbol } from '@/twin/graph';

/**
 * The test-gap engine.
 *
 * Answers "what is not tested, and what should the missing test check?" from
 * the Digital Twin alone. Deterministic first, always: the scenarios below
 * come from the parsed signature — parameter count, async-ness, branch count,
 * whether the symbol is reachable from an HTTP route or touches the database.
 * AI is only ever asked to phrase or expand these afterwards.
 *
 * COVERAGE HONESTY: nothing here measures coverage. A TESTS edge means a test
 * file imports a source file, which is evidence a module is exercised, not a
 * percentage of its lines. The word "coverage" is reserved for real coverage
 * reports, and `coverageAvailable` says plainly when there are none.
 */

export interface TestScenario {
  /** What the missing test should assert, in one line. */
  readonly description: string;
  /** The parsed fact that implies this scenario is worth testing. */
  readonly rationale: string;
  readonly priority: 'high' | 'medium' | 'low';
}

export interface TestGap {
  readonly filePath: string;
  readonly symbolName: string;
  readonly symbolKind: string;
  readonly signature: string | null;
  readonly lineStart: number;
  readonly complexity: number;
  /** high when the symbol is exported, branchy and reachable from a route. */
  readonly severity: 'high' | 'medium' | 'low';
  readonly reason: string;
  readonly scenarios: readonly TestScenario[];
  /**
   * Test files that reference this file without actually covering it — the
   * indexer records a TESTS edge only for a direct test-to-source import, so
   * a file can be touched by a suite (via a helper, a fixture or a barrel)
   * and still have no test asserting on it. These are the best places to add
   * the missing case, and their presence is why this gap is not simply
   * "nobody has looked at this file".
   */
  readonly existingTests: readonly string[];
}

export interface TestIntelligence {
  /** Frameworks actually detected in the repository's test files. */
  readonly frameworks: readonly string[];
  readonly testFileCount: number;
  readonly testCaseCount: number;
  /** Source files with at least one test importing them. */
  readonly testedFileCount: number;
  readonly sourceFileCount: number;
  /**
   * Share of source files with a test importing them. This is a *linkage*
   * ratio, not line coverage — see the note at the top of this module.
   */
  readonly linkageRatio: number;
  /** False whenever no real coverage report has been ingested. */
  readonly coverageAvailable: boolean;
  readonly untestedFiles: readonly string[];
  readonly testsWithoutAssertions: readonly string[];
}

/** Symbol kinds worth demanding a test for. Types and interfaces are not code. */
const TESTABLE_KINDS = new Set(['function', 'class', 'method']);

/**
 * Repository-level test intelligence.
 *
 * Frameworks, counts and linkage come from the scan's `tests` rows and the
 * twin's TESTS edges. Where a number would be a guess it is not reported.
 */
export async function getTestIntelligence(repositoryId: string): Promise<TestIntelligence> {
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);

  if (!scanId) {
    return {
      frameworks: [],
      testFileCount: 0,
      testCaseCount: 0,
      testedFileCount: 0,
      sourceFileCount: 0,
      linkageRatio: 0,
      coverageAvailable: false,
      untestedFiles: [],
      testsWithoutAssertions: [],
    };
  }

  const [testRows, fileRows, graph] = await Promise.all([
    db.select().from(tests).where(eq(tests.scanId, scanId)),
    db.select().from(files).where(eq(files.scanId, scanId)),
    TwinGraph.load(repositoryId),
  ]);

  const tested = graph.testedFiles();
  const sourceFiles = fileRows.filter((f) => isTestableFile(f.kind, f.language));

  const untestedFiles = sourceFiles
    .filter((f) => !tested.has(f.path))
    .map((f) => f.path)
    .sort();

  const frameworks = [...new Set(testRows.map((t) => t.framework).filter((f): f is string => Boolean(f)))].sort();

  return {
    frameworks,
    testFileCount: testRows.length,
    testCaseCount: testRows.reduce((sum, t) => sum + t.testCount, 0),
    testedFileCount: sourceFiles.filter((f) => tested.has(f.path)).length,
    sourceFileCount: sourceFiles.length,
    linkageRatio: sourceFiles.length === 0 ? 0 : (sourceFiles.length - untestedFiles.length) / sourceFiles.length,
    // No coverage-report ingestion exists yet, so this is always false today.
    // It is a field rather than a constant so the honest answer survives when
    // report parsing lands, instead of the UI quietly implying a number.
    coverageAvailable: false,
    untestedFiles,
    testsWithoutAssertions: testRows
      .filter((t) => !t.hasAssertions)
      .map((t) => t.filePath)
      .sort(),
  };
}

/**
 * Test gaps for a set of files — or the whole repository when none are given.
 *
 * A gap is an exported, testable symbol in a file no test imports. Symbols in
 * covered files are not reported: the test may or may not exercise that
 * specific function, and claiming otherwise would be the same overreach as
 * claiming a coverage percentage.
 */
export async function detectTestGaps(
  repositoryId: string,
  filePaths?: readonly string[],
  options: { limit?: number } = {},
): Promise<TestGap[]> {
  const limit = options.limit ?? 50;
  const db = await getDb();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) return [];

  const graph = await TwinGraph.load(repositoryId);
  const tested = graph.testedFiles();

  const scope = filePaths && filePaths.length > 0 ? filePaths : undefined;

  const fileRows = scope
    ? await db
        .select()
        .from(files)
        .where(and(eq(files.scanId, scanId), inArray(files.path, [...scope])))
    : await db.select().from(files).where(eq(files.scanId, scanId));

  const candidates = fileRows.filter((f) => isTestableFile(f.kind, f.language));
  if (candidates.length === 0) return [];

  const symbols = await loadSymbols(
    repositoryId,
    candidates.map((f) => f.path),
  );

  /*
   * Test files in this scan, so a gap can point at the suite that already
   * touches the file. Read from the scan's own rows rather than inferred from
   * the path, so it matches what the scanner actually classified.
   */
  const testPaths = new Set(
    (await db.select({ filePath: tests.filePath }).from(tests).where(eq(tests.scanId, scanId))).map(
      (t) => t.filePath,
    ),
  );

  // Files whose symbols are reachable from a route, for severity weighting.
  const routeFiles = new Set(graph.routesOf(graph.files()).map((r) => r.filePath));
  const dbFiles = new Set(graph.databasesOf(graph.files()).map((d) => d.filePath));

  const gaps: TestGap[] = [];

  for (const file of candidates) {
    if (tested.has(file.path)) continue;

    const fileSymbols = symbols.filter(
      (s) => s.filePath === file.path && s.isExported && TESTABLE_KINDS.has(s.kind),
    );
    if (fileSymbols.length === 0) continue;

    // Anything importing this file inherits the risk of it being wrong.
    const dependents = graph.dependentsOf(file.path);
    const existingTests = dependents.filter((d) => testPaths.has(d)).sort();
    const exposesRoute = routeFiles.has(file.path);
    const touchesDb = dbFiles.has(file.path);

    for (const symbol of fileSymbols) {
      const severity = gapSeverity({
        complexity: symbol.complexity,
        dependents: dependents.length,
        exposesRoute,
        touchesDb,
        sensitive: isSensitivePath(file.path),
      });

      gaps.push({
        filePath: file.path,
        symbolName: symbol.name,
        symbolKind: symbol.kind,
        signature: symbol.signature,
        lineStart: symbol.lineStart,
        complexity: symbol.complexity,
        severity,
        reason: gapReason(symbol, dependents.length, exposesRoute, touchesDb),
        scenarios: scenariosFor(symbol, { exposesRoute, touchesDb, sensitive: isSensitivePath(file.path) }),
        existingTests,
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  return gaps
    .sort(
      (a, b) =>
        order[a.severity] - order[b.severity] ||
        b.complexity - a.complexity ||
        a.filePath.localeCompare(b.filePath) ||
        a.symbolName.localeCompare(b.symbolName),
    )
    .slice(0, limit);
}

/**
 * Which scenarios a missing test should cover.
 *
 * Every scenario is tied to something the parser actually saw. A function with
 * no parameters gets no "invalid input" scenario, because there is no input to
 * make invalid — generic checklists are what make test suggestions ignorable.
 */
export function scenariosFor(
  symbol: Pick<GraphSymbol, 'name' | 'kind' | 'parameters' | 'complexity' | 'signature'> & { isAsync?: boolean },
  context: { exposesRoute?: boolean; touchesDb?: boolean; sensitive?: boolean } = {},
): TestScenario[] {
  const scenarios: TestScenario[] = [];
  const params = symbol.parameters;

  scenarios.push({
    description: `${symbol.name} returns the expected result for a typical input`,
    rationale: symbol.signature ? `Signature: ${symbol.signature}` : `${symbol.kind} ${symbol.name} is exported`,
    priority: 'high',
  });

  if (params.length > 0) {
    scenarios.push({
      description: `${symbol.name} handles missing or invalid ${params.length === 1 ? `\`${params[0]}\`` : 'arguments'}`,
      rationale: `Takes ${params.length} parameter${params.length === 1 ? '' : 's'}: ${params.join(', ')}`,
      priority: 'high',
    });
  }

  if (symbol.complexity >= 3) {
    scenarios.push({
      description: `Each branch of ${symbol.name} is exercised`,
      rationale: `${symbol.complexity} decision points were parsed in this ${symbol.kind}`,
      priority: symbol.complexity >= 6 ? 'high' : 'medium',
    });
  }

  if (symbol.isAsync) {
    scenarios.push({
      description: `${symbol.name} propagates or handles a rejected promise`,
      rationale: 'Declared async — failure paths are easy to leave untested',
      priority: 'medium',
    });
  }

  if (context.touchesDb) {
    scenarios.push({
      description: `${symbol.name} behaves correctly when the database returns no rows`,
      rationale: 'This file contains detected database access',
      priority: 'medium',
    });
  }

  if (context.exposesRoute) {
    scenarios.push({
      description: `The endpoint rejects unauthenticated or malformed requests`,
      rationale: 'This file exposes an HTTP route',
      priority: 'high',
    });
  }

  if (context.sensitive) {
    scenarios.push({
      description: `${symbol.name} denies access when the caller is not permitted`,
      rationale: 'File path indicates a security-sensitive area',
      priority: 'high',
    });
  }

  return scenarios;
}

/** Exported for direct testing — see docs/testing-intelligence.md. */
export function gapSeverity(input: {
  complexity: number;
  dependents: number;
  exposesRoute: boolean;
  touchesDb: boolean;
  sensitive: boolean;
}): TestGap['severity'] {
  let score = 0;
  if (input.complexity >= 6) score += 2;
  else if (input.complexity >= 3) score += 1;
  if (input.dependents >= 3) score += 2;
  else if (input.dependents >= 1) score += 1;
  if (input.exposesRoute) score += 2;
  if (input.touchesDb) score += 1;
  if (input.sensitive) score += 2;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function gapReason(symbol: GraphSymbol, dependents: number, exposesRoute: boolean, touchesDb: boolean): string {
  const parts: string[] = [`Exported ${symbol.kind} with no test file importing ${symbol.filePath}`];
  if (symbol.complexity >= 3) parts.push(`${symbol.complexity} decision points`);
  if (dependents > 0) parts.push(`${dependents} dependent file${dependents === 1 ? '' : 's'}`);
  if (exposesRoute) parts.push('reachable from an HTTP route');
  if (touchesDb) parts.push('touches the database');
  return `${parts.join(' · ')}.`;
}

/**
 * Files whose symbols are worth demanding a test for.
 *
 * `kind` is the classification `persistRepositoryIntelligence` stored, so a
 * test file is `kind === 'test'` — there is no `isTest` column on `files`.
 */
function isSourceKind(kind: string | null): boolean {
  return kind !== 'test' && kind !== 'config' && kind !== 'infra' && kind !== 'documentation' && kind !== 'asset';
}

/**
 * Files that could meaningfully carry a test.
 *
 * `kind` alone is not enough: a README classifies as `source` because it is
 * neither test, config nor infra, and counting it as an untested source file
 * both understates the linkage ratio and puts documentation in a list of
 * things to write tests for. Only files a parser can read count.
 */
function isTestableFile(kind: string | null, language: string | null): boolean {
  if (!isSourceKind(kind)) return false;
  return language !== null && SUPPORTED_LANGUAGES.includes(language);
}

function isSensitivePath(path: string): boolean {
  return /(^|\/)(auth|session|login|token|payment|billing|crypto|permission|admin)/i.test(path);
}

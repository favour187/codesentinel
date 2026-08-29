import { and, eq, inArray } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { getDb } from '@/db';
import { files, tests } from '@/db/schema';
import { SUPPORTED_LANGUAGES } from '@/twin/parsers';
import { TwinGraph } from '@/twin/graph';
import { loadSymbols } from '@/twin/graph';
import type { GraphSymbol } from '@/twin/graph';
















export interface TestScenario {

  readonly description: string;

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

  readonly severity: 'high' | 'medium' | 'low';
  readonly reason: string;
  readonly scenarios: readonly TestScenario[];








  readonly existingTests: readonly string[];
}

export interface TestIntelligence {

  readonly frameworks: readonly string[];
  readonly testFileCount: number;
  readonly testCaseCount: number;

  readonly testedFileCount: number;
  readonly sourceFileCount: number;




  readonly linkageRatio: number;

  readonly coverageAvailable: boolean;
  readonly untestedFiles: readonly string[];
  readonly testsWithoutAssertions: readonly string[];
}


const TESTABLE_KINDS = new Set(['function', 'class', 'method']);







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



    coverageAvailable: false,
    untestedFiles,
    testsWithoutAssertions: testRows
      .filter((t) => !t.hasAssertions)
      .map((t) => t.filePath)
      .sort(),
  };
}









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






  const testPaths = new Set(
    (await db.select({ filePath: tests.filePath }).from(tests).where(eq(tests.scanId, scanId))).map(
      (t) => t.filePath,
    ),
  );


  const routeFiles = new Set(graph.routesOf(graph.files()).map((r) => r.filePath));
  const dbFiles = new Set(graph.databasesOf(graph.files()).map((d) => d.filePath));

  const gaps: TestGap[] = [];

  for (const file of candidates) {
    if (tested.has(file.path)) continue;

    const fileSymbols = symbols.filter(
      (s) => s.filePath === file.path && s.isExported && TESTABLE_KINDS.has(s.kind),
    );
    if (fileSymbols.length === 0) continue;


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







function isSourceKind(kind: string | null): boolean {
  return kind !== 'test' && kind !== 'config' && kind !== 'infra' && kind !== 'documentation' && kind !== 'asset';
}









function isTestableFile(kind: string | null, language: string | null): boolean {
  if (!isSourceKind(kind)) return false;
  return language !== null && SUPPORTED_LANGUAGES.includes(language);
}

function isSensitivePath(path: string): boolean {
  return /(^|\/)(auth|session|login|token|payment|billing|crypto|permission|admin)/i.test(path);
}

import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { codeEdges, symbols as symbolsTable } from '@/db/schema';
import type { EdgeConfidence, EdgeType, SymbolKind } from '@/db/schema';

/**
 * Read side of the Digital Twin graph.
 *
 * `indexer.ts` writes edges; this module answers questions about them. It is
 * deliberately the only place that knows how endpoint keys are shaped, so
 * every consumer — blast radius, change impact, the architecture map, search —
 * traverses the same graph with the same rules rather than re-deriving
 * relationships from `files.imports` in six slightly different ways.
 *
 * Three rules hold throughout:
 *
 * 1. Nothing is invented. Every returned relationship corresponds to a stored
 *    edge with stored evidence. A file with no edges returns no edges.
 * 2. Endpoint keys are opaque strings, decoded only by the helpers here.
 * 3. Traversal is bounded. A hub file must not pull the whole repository into
 *    an "impact" list nobody can act on.
 */

/** An edge as consumers see it, with its stored justification attached. */
export interface GraphEdge {
  readonly type: EdgeType;
  readonly fromKey: string;
  readonly toKey: string;
  readonly confidence: EdgeConfidence;
  readonly evidence: string | null;
  readonly lineNumber: number | null;
}

export interface GraphSymbol {
  readonly id: string;
  readonly filePath: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly isExported: boolean;
  readonly signature: string | null;
  readonly complexity: number;
  readonly parentName: string | null;
  readonly parameters: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Endpoint keys                                                              */
/* -------------------------------------------------------------------------- */

/** True for `path#symbolName` endpoints. */
export function isSymbolKey(key: string): boolean {
  return key.includes('#');
}

export function isPackageKey(key: string): boolean {
  return key.startsWith('pkg:');
}

export function isRouteKey(key: string): boolean {
  return key.startsWith('api:');
}

export function isDatabaseKey(key: string): boolean {
  return key.startsWith('db:');
}

/** True when a key addresses a file in the repository (not a package/route/table). */
export function isFileKey(key: string): boolean {
  return !isPackageKey(key) && !isRouteKey(key) && !isDatabaseKey(key);
}

/**
 * The file an endpoint belongs to, or null for external endpoints.
 *
 * `src/a.ts#login` -> `src/a.ts`; `src/a.ts` -> `src/a.ts`; `pkg:express` -> null.
 */
export function fileOfKey(key: string): string | null {
  if (!isFileKey(key)) return null;
  const hash = key.indexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
}

/** The symbol name in a symbol key, else null. */
export function symbolNameOfKey(key: string): string | null {
  if (!isFileKey(key)) return null;
  const hash = key.indexOf('#');
  return hash === -1 ? null : key.slice(hash + 1);
}

/** `api:GET /users/:id` -> `{ method: 'GET', path: '/users/:id' }`. */
export function parseRouteKey(key: string): { method: string; path: string } | null {
  if (!isRouteKey(key)) return null;
  const rest = key.slice('api:'.length);
  const space = rest.indexOf(' ');
  if (space === -1) return { method: 'ANY', path: rest };
  return { method: rest.slice(0, space), path: rest.slice(space + 1) };
}

/** `pkg:express` -> `express`; `db:users` -> `users`. */
export function labelOfKey(key: string): string {
  if (isPackageKey(key)) return key.slice('pkg:'.length);
  if (isDatabaseKey(key)) return key.slice('db:'.length);
  if (isRouteKey(key)) {
    const route = parseRouteKey(key);
    return route ? `${route.method} ${route.path}` : key;
  }
  return key;
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every edge for a repository, optionally filtered by type.
 *
 * Loaded whole rather than queried per hop: a traversal does many small
 * lookups, and one round trip plus an in-memory index beats N queries against
 * a graph that comfortably fits in memory for any repository we can index.
 */
export async function loadEdges(repositoryId: string, types?: readonly EdgeType[]): Promise<GraphEdge[]> {
  const db = await getDb();
  const rows = await db
    .select({
      type: codeEdges.type,
      fromKey: codeEdges.fromKey,
      toKey: codeEdges.toKey,
      confidence: codeEdges.confidence,
      evidence: codeEdges.evidence,
      lineNumber: codeEdges.lineNumber,
    })
    .from(codeEdges)
    .where(
      types && types.length > 0
        ? and(eq(codeEdges.repositoryId, repositoryId), inArray(codeEdges.type, [...types]))
        : eq(codeEdges.repositoryId, repositoryId),
    );

  return rows;
}

/** How many edges the twin holds for a repository — the "is it indexed?" check. */
export async function edgeCount(repositoryId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(codeEdges)
    .where(eq(codeEdges.repositoryId, repositoryId));
  return row?.count ?? 0;
}

export async function loadSymbols(repositoryId: string, filePaths?: readonly string[]): Promise<GraphSymbol[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(symbolsTable)
    .where(
      filePaths && filePaths.length > 0
        ? and(eq(symbolsTable.repositoryId, repositoryId), inArray(symbolsTable.filePath, [...filePaths]))
        : eq(symbolsTable.repositoryId, repositoryId),
    );

  return rows.map((r) => ({
    id: r.id,
    filePath: r.filePath,
    name: r.name,
    kind: r.kind,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
    isExported: r.isExported,
    signature: r.signature,
    complexity: r.complexity,
    parentName: r.parentName,
    parameters: r.parameters,
  }));
}

/* -------------------------------------------------------------------------- */
/* Adjacency                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory index over a repository's edges.
 *
 * Built once per request and reused across every traversal in that request.
 * The forward and reverse maps are both file-level: symbol endpoints collapse
 * to their file, because "what breaks if this changes" is answered in files
 * even when the evidence is a specific call.
 */
export class TwinGraph {
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();
  /** File-level dependency edges, deduped: importer -> imported. */
  private readonly fileImports = new Map<string, Set<string>>();
  private readonly fileImporters = new Map<string, Set<string>>();

  constructor(readonly edges: readonly GraphEdge[]) {
    for (const edge of edges) {
      push(this.outgoing, edge.fromKey, edge);
      push(this.incoming, edge.toKey, edge);

      // `imports` and `calls` both mean "from depends on to" for traversal.
      if (edge.type !== 'imports' && edge.type !== 'calls') continue;
      const from = fileOfKey(edge.fromKey);
      const to = fileOfKey(edge.toKey);
      if (!from || !to || from === to) continue;
      add(this.fileImports, from, to);
      add(this.fileImporters, to, from);
    }
  }

  static async load(repositoryId: string): Promise<TwinGraph> {
    return new TwinGraph(await loadEdges(repositoryId));
  }

  get isEmpty(): boolean {
    return this.edges.length === 0;
  }

  /** Edges leaving a key exactly as stored (symbol keys stay symbol keys). */
  edgesFrom(key: string, type?: EdgeType): GraphEdge[] {
    const all = this.outgoing.get(key) ?? [];
    return type ? all.filter((e) => e.type === type) : all;
  }

  edgesTo(key: string, type?: EdgeType): GraphEdge[] {
    const all = this.incoming.get(key) ?? [];
    return type ? all.filter((e) => e.type === type) : all;
  }

  /** Every edge touching a file, including edges on symbols declared in it. */
  edgesForFile(filePath: string): GraphEdge[] {
    return this.edges.filter((e) => fileOfKey(e.fromKey) === filePath || fileOfKey(e.toKey) === filePath);
  }

  /** Files this file imports or calls into. */
  dependenciesOf(filePath: string): string[] {
    return [...(this.fileImports.get(filePath) ?? [])].sort();
  }

  /** Files that import or call into this file. */
  dependentsOf(filePath: string): string[] {
    return [...(this.fileImporters.get(filePath) ?? [])].sort();
  }

  /** Every file that appears as an endpoint of a file-level edge. */
  files(): string[] {
    const out = new Set<string>();
    for (const edge of this.edges) {
      const from = fileOfKey(edge.fromKey);
      const to = fileOfKey(edge.toKey);
      if (from) out.add(from);
      if (to) out.add(to);
    }
    return [...out].sort();
  }

  /**
   * Breadth-first walk over reverse dependencies.
   *
   * Returns the shortest depth at which each file is reached, which is what
   * makes "direct" (1) versus "indirect" (2+) meaningful. Bounded by both
   * depth and node count so a shared utility cannot return the repository.
   */
  reachableDependents(
    origins: readonly string[],
    options: { maxDepth?: number; maxNodes?: number } = {},
  ): Array<{ path: string; depth: number; via: string }> {
    const maxDepth = options.maxDepth ?? 3;
    const maxNodes = options.maxNodes ?? 200;

    const seen = new Set(origins);
    const out: Array<{ path: string; depth: number; via: string }> = [];
    let frontier = [...origins];

    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && out.length < maxNodes; depth += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const importer of this.dependentsOf(current)) {
          if (seen.has(importer)) continue;
          seen.add(importer);
          next.push(importer);
          out.push({ path: importer, depth, via: current });
          if (out.length >= maxNodes) break;
        }
        if (out.length >= maxNodes) break;
      }
      frontier = next;
    }

    return out;
  }

  /** Routes exposed by any of these files, with the evidence that proved it. */
  routesOf(filePaths: readonly string[]): Array<{ route: string; filePath: string; evidence: string | null }> {
    const set = new Set(filePaths);
    const out: Array<{ route: string; filePath: string; evidence: string | null }> = [];
    for (const edge of this.edges) {
      if (edge.type !== 'exposes_api') continue;
      const from = fileOfKey(edge.fromKey);
      if (!from || !set.has(from)) continue;
      out.push({ route: labelOfKey(edge.toKey), filePath: from, evidence: edge.evidence });
    }
    return out.sort((a, b) => a.route.localeCompare(b.route));
  }

  /** Database targets touched by any of these files. */
  databasesOf(filePaths: readonly string[]): Array<{ target: string; filePath: string; evidence: string | null }> {
    const set = new Set(filePaths);
    const out: Array<{ target: string; filePath: string; evidence: string | null }> = [];
    for (const edge of this.edges) {
      if (edge.type !== 'uses_database') continue;
      const from = fileOfKey(edge.fromKey);
      if (!from || !set.has(from)) continue;
      out.push({ target: labelOfKey(edge.toKey), filePath: from, evidence: edge.evidence });
    }
    return out.sort((a, b) => a.target.localeCompare(b.target));
  }

  /** External packages any of these files depend on. */
  packagesOf(filePaths: readonly string[]): string[] {
    const set = new Set(filePaths);
    const out = new Set<string>();
    for (const edge of this.edges) {
      if (edge.type !== 'depends_on') continue;
      const from = fileOfKey(edge.fromKey);
      if (from && set.has(from)) out.add(labelOfKey(edge.toKey));
    }
    return [...out].sort();
  }

  /**
   * Test files covering any of these files, via stored TESTS edges.
   *
   * A TESTS edge is written when a test file imports a non-test file, so this
   * is "a test exercises this module", not a coverage measurement.
   */
  testsCovering(filePaths: readonly string[]): Array<{ testPath: string; covers: string; evidence: string | null }> {
    const set = new Set(filePaths);
    const out: Array<{ testPath: string; covers: string; evidence: string | null }> = [];
    for (const edge of this.edges) {
      if (edge.type !== 'tests') continue;
      const to = fileOfKey(edge.toKey);
      const from = fileOfKey(edge.fromKey);
      if (!to || !from || !set.has(to)) continue;
      out.push({ testPath: from, covers: to, evidence: edge.evidence });
    }
    return out.sort((a, b) => a.testPath.localeCompare(b.testPath) || a.covers.localeCompare(b.covers));
  }

  /** Files with a TESTS edge pointing at them. */
  testedFiles(): Set<string> {
    const out = new Set<string>();
    for (const edge of this.edges) {
      if (edge.type !== 'tests') continue;
      const to = fileOfKey(edge.toKey);
      if (to) out.add(to);
    }
    return out;
  }

  /** Callers of a specific symbol, with the call site as evidence. */
  callersOfSymbol(symbolKeyValue: string): Array<{ fromKey: string; filePath: string | null; evidence: string | null; line: number | null }> {
    return this.edgesTo(symbolKeyValue, 'calls').map((e) => ({
      fromKey: e.fromKey,
      filePath: fileOfKey(e.fromKey),
      evidence: e.evidence,
      line: e.lineNumber,
    }));
  }
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

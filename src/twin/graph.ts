import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb } from '@/db';
import { codeEdges, symbols as symbolsTable } from '@/db/schema';
import type { EdgeConfidence, EdgeType, SymbolKind } from '@/db/schema';




















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


export function isFileKey(key: string): boolean {
  return !isPackageKey(key) && !isRouteKey(key) && !isDatabaseKey(key);
}






export function fileOfKey(key: string): string | null {
  if (!isFileKey(key)) return null;
  const hash = key.indexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
}


export function symbolNameOfKey(key: string): string | null {
  if (!isFileKey(key)) return null;
  const hash = key.indexOf('#');
  return hash === -1 ? null : key.slice(hash + 1);
}


export function parseRouteKey(key: string): { method: string; path: string } | null {
  if (!isRouteKey(key)) return null;
  const rest = key.slice('api:'.length);
  const space = rest.indexOf(' ');
  if (space === -1) return { method: 'ANY', path: rest };
  return { method: rest.slice(0, space), path: rest.slice(space + 1) };
}


export function labelOfKey(key: string): string {
  if (isPackageKey(key)) return key.slice('pkg:'.length);
  if (isDatabaseKey(key)) return key.slice('db:'.length);
  if (isRouteKey(key)) {
    const route = parseRouteKey(key);
    return route ? `${route.method} ${route.path}` : key;
  }
  return key;
}












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













export class TwinGraph {
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly incoming = new Map<string, GraphEdge[]>();

  private readonly fileImports = new Map<string, Set<string>>();
  private readonly fileImporters = new Map<string, Set<string>>();

  constructor(readonly edges: readonly GraphEdge[]) {
    for (const edge of edges) {
      push(this.outgoing, edge.fromKey, edge);
      push(this.incoming, edge.toKey, edge);


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


  edgesFrom(key: string, type?: EdgeType): GraphEdge[] {
    const all = this.outgoing.get(key) ?? [];
    return type ? all.filter((e) => e.type === type) : all;
  }

  edgesTo(key: string, type?: EdgeType): GraphEdge[] {
    const all = this.incoming.get(key) ?? [];
    return type ? all.filter((e) => e.type === type) : all;
  }


  edgesForFile(filePath: string): GraphEdge[] {
    return this.edges.filter((e) => fileOfKey(e.fromKey) === filePath || fileOfKey(e.toKey) === filePath);
  }


  dependenciesOf(filePath: string): string[] {
    return [...(this.fileImports.get(filePath) ?? [])].sort();
  }


  dependentsOf(filePath: string): string[] {
    return [...(this.fileImporters.get(filePath) ?? [])].sort();
  }


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


  testedFiles(): Set<string> {
    const out = new Set<string>();
    for (const edge of this.edges) {
      if (edge.type !== 'tests') continue;
      const to = fileOfKey(edge.toKey);
      if (to) out.add(to);
    }
    return out;
  }


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

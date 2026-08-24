import { desc, eq } from 'drizzle-orm';

import { latestScanId } from '@/ai/context';
import { db, commits, dependencies, files, symbols } from '@/db';
import type { Severity } from '@/db/schema';
import { TwinGraph, loadSymbols } from '@/twin/graph';
import { componentGraph, LAYERS, type ComponentSummary, type Layer } from '@/twin/components';
import type { SearchDocument } from '@/lib/codebase-search';

export type { SearchDocument, SearchHit } from '@/lib/codebase-search';
export { searchDocuments } from '@/lib/codebase-search';

/**
 * Read models for the Codebase page: architecture, package inventory, API map,
 * and in-repo search. Every number comes from the latest completed scan or the
 * digital twin. Nothing is invented for the UI.
 */

export interface PackageDependency {
  readonly name: string;
  readonly ecosystem: string;
  readonly version: string | null;
  readonly versionSpec: string | null;
  readonly isDev: boolean;
  readonly isDirect: boolean;
  readonly manifestPath: string | null;
  readonly latestVersion: string | null;
  readonly vulnerabilities: ReadonlyArray<{
    id: string;
    severity: Severity;
    summary: string;
    fixedIn?: string;
    url?: string;
  }>;
}

export interface DependencyInventory {
  readonly total: number;
  readonly direct: number;
  readonly dev: number;
  readonly vulnerable: number;
  readonly ecosystems: readonly string[];
  readonly packages: readonly PackageDependency[];
}

export async function getDependencyInventory(repositoryId: string): Promise<DependencyInventory> {
  const database = await db();
  const scanId = await latestScanId(repositoryId);
  if (!scanId) {
    return { total: 0, direct: 0, dev: 0, vulnerable: 0, ecosystems: [], packages: [] };
  }

  const rows = await database.select().from(dependencies).where(eq(dependencies.scanId, scanId));

  const packages: PackageDependency[] = rows
    .map((r) => ({
      name: r.name,
      ecosystem: r.ecosystem,
      version: r.version,
      versionSpec: r.versionSpec,
      isDev: r.isDev,
      isDirect: r.isDirect,
      manifestPath: r.manifestPath,
      latestVersion: r.latestVersion,
      vulnerabilities: r.vulnerabilities,
    }))
    .sort((a, b) => {
      const av = a.vulnerabilities.length;
      const bv = b.vulnerabilities.length;
      if (bv !== av) return bv - av;
      return a.name.localeCompare(b.name);
    });

  return {
    total: packages.length,
    direct: packages.filter((p) => p.isDirect).length,
    dev: packages.filter((p) => p.isDev).length,
    vulnerable: packages.filter((p) => p.vulnerabilities.length > 0).length,
    ecosystems: [...new Set(packages.map((p) => p.ecosystem))].sort(),
    packages,
  };
}

export interface ArchitectureOverview {
  readonly indexed: boolean;
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly layers: ReadonlyArray<{ layer: Layer; components: ComponentSummary[] }>;
  readonly edges: ReadonlyArray<{ from: string; to: string; fileCount: number }>;
  readonly routes: ReadonlyArray<{ route: string; filePath: string; evidence: string | null }>;
  readonly databases: ReadonlyArray<{ target: string; filePath: string; evidence: string | null }>;
}

export async function getArchitectureOverview(repositoryId: string): Promise<ArchitectureOverview> {
  const database = await db();
  const scanId = await latestScanId(repositoryId);
  const graph = await TwinGraph.load(repositoryId);
  const { nodes, edges } = await componentGraph(repositoryId);

  const fileCount = scanId
    ? (await database.select().from(files).where(eq(files.scanId, scanId))).length
    : 0;

  const allSymbols = scanId ? await loadSymbols(repositoryId) : [];
  const filesForRoutes = graph.files();

  const byLayer = new Map<Layer, ComponentSummary[]>();
  for (const layer of LAYERS) byLayer.set(layer, []);
  for (const node of nodes) {
    const list = byLayer.get(node.layer) ?? byLayer.get('Other');
    list?.push(node);
  }

  return {
    indexed: !graph.isEmpty || nodes.length > 0,
    fileCount,
    symbolCount: allSymbols.length,
    layers: LAYERS.map((layer) => ({
      layer,
      components: (byLayer.get(layer) ?? []).sort((a, b) => b.riskScore - a.riskScore || a.name.localeCompare(b.name)),
    })).filter((row) => row.components.length > 0),
    edges,
    routes: graph.routesOf(filesForRoutes),
    databases: graph.databasesOf(filesForRoutes),
  };
}

export async function getSearchIndex(repositoryId: string): Promise<SearchDocument[]> {
  const database = await db();
  const scanId = await latestScanId(repositoryId);
  const docs: SearchDocument[] = [];

  if (scanId) {
    const fileRows = await database.select().from(files).where(eq(files.scanId, scanId));
    for (const file of fileRows) {
      docs.push({
        kind: 'file',
        id: `file:${file.path}`,
        title: file.path,
        subtitle: [file.language, file.kind, file.loc ? `${file.loc} loc` : null].filter(Boolean).join(' · '),
        path: file.path,
        haystack: `${file.path} ${(file.exports ?? []).join(' ')} ${(file.imports ?? []).join(' ')}`,
      });
    }

    const symbolRows = await database.select().from(symbols).where(eq(symbols.repositoryId, repositoryId));
    for (const symbol of symbolRows) {
      docs.push({
        kind: 'symbol',
        id: `symbol:${symbol.id}`,
        title: symbol.name,
        subtitle: `${symbol.kind} · ${symbol.filePath}${symbol.lineStart ? `:${symbol.lineStart}` : ''}`,
        path: symbol.filePath,
        haystack: `${symbol.name} ${symbol.signature ?? ''} ${symbol.filePath}`,
      });
    }

    const depRows = await database.select().from(dependencies).where(eq(dependencies.scanId, scanId));
    for (const dep of depRows) {
      docs.push({
        kind: 'package',
        id: `pkg:${dep.ecosystem}:${dep.name}`,
        title: dep.name,
        subtitle: `${dep.ecosystem} ${dep.version ?? dep.versionSpec ?? ''}`.trim(),
        path: dep.manifestPath,
        haystack: `${dep.name} ${dep.ecosystem}`,
      });
    }
  }

  const graph = await TwinGraph.load(repositoryId);
  for (const route of graph.routesOf(graph.files())) {
    docs.push({
      kind: 'route',
      id: `route:${route.route}:${route.filePath}`,
      title: route.route,
      subtitle: route.filePath,
      path: route.filePath,
      haystack: `${route.route} ${route.filePath} ${route.evidence ?? ''}`,
    });
  }

  return docs;
}

export async function getLatestChangedPaths(repositoryId: string): Promise<string[]> {
  const database = await db();
  const [row] = await database
    .select({ changedPaths: commits.changedPaths })
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .orderBy(desc(commits.authoredAt), desc(commits.createdAt))
    .limit(1);
  return row?.changedPaths ?? [];
}

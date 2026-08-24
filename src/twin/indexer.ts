import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db';
import { codeEdges, indexState, symbols as symbolsTable } from '@/db/schema';
import { isTestPath } from '@/scanner/discovery';
import type { SourceFile } from '@/scanner/types';

import { parseFile, type ParsedFile } from './parsers';
import { isExternalSpecifier, packageNameOf, resolveSpecifier } from './resolve';

/**
 * The Digital Twin indexer.
 *
 * Turns a set of source files into rows in `symbols` and `code_edges`. Two
 * properties matter more than anything else here:
 *
 * 1. INCREMENTAL. Files are keyed by content hash in `index_state`. A re-index
 *    reparses only what changed, deletes the rows belonging to changed and
 *    removed files, and leaves everything else untouched. Re-indexing an
 *    unchanged repository is a hash comparison per file and zero writes.
 *
 * 2. GROUNDED. Every edge carries evidence — the specifier, the route literal,
 *    the call line. An edge that cannot be justified is not written. Calls that
 *    cannot be resolved to a definite target are dropped rather than guessed,
 *    which is why CALLS edges are fewer than call sites.
 */

/** How a symbol is addressed in an edge endpoint: `path#name`. */
export function symbolKey(filePath: string, symbolName: string): string {
  return `${filePath}#${symbolName}`;
}

/** Dependency endpoints are namespaced so they cannot collide with file paths. */
export function packageKey(name: string): string {
  return `pkg:${name}`;
}

/** Route endpoints, e.g. `api:GET /users/:id`. */
export function routeKey(method: string, path: string): string {
  return `api:${method} ${path}`;
}

/** Database endpoints, e.g. `db:users` or `db:(unknown)`. */
export function databaseKey(target: string | null): string {
  return `db:${target ?? '(unknown)'}`;
}

interface EdgeDraft {
  type: (typeof codeEdges.$inferInsert)['type'];
  fromKey: string;
  toKey: string;
  confidence: 'certain' | 'probable';
  evidence: string | null;
  lineNumber: number | null;
}

export interface IndexOptions {
  /** Force a full reparse, ignoring stored hashes. */
  readonly force?: boolean;
  readonly logger?: { info: (msg: string, meta?: unknown) => void };
}

export interface IndexResult {
  readonly filesTotal: number;
  readonly filesParsed: number;
  readonly filesUnchanged: number;
  readonly filesRemoved: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly edgesByType: Record<string, number>;
  readonly durationMs: number;
  readonly parseErrors: ReadonlyArray<{ path: string; error: string }>;
}

/**
 * Index a repository into the Digital Twin.
 *
 * `files` is the same `SourceFile[]` the scanner already produced, so indexing
 * costs no additional filesystem work when it runs alongside a scan.
 */
export async function indexRepository(
  repositoryId: string,
  files: readonly SourceFile[],
  options: IndexOptions = {},
): Promise<IndexResult> {
  const startedAt = Date.now();
  const db = await getDb();

  const existing = await db
    .select({ filePath: indexState.filePath, contentHash: indexState.contentHash })
    .from(indexState)
    .where(eq(indexState.repositoryId, repositoryId));

  const previousHashes = new Map(existing.map((row) => [row.filePath, row.contentHash]));
  const currentPaths = new Set(files.map((f) => f.path));

  /* Files that disappeared since the last index. */
  const removedPaths = [...previousHashes.keys()].filter((p) => !currentPaths.has(p));

  /* Files whose content changed (or everything, when forced). */
  const changed = files.filter((f) => options.force || previousHashes.get(f.path) !== f.contentHash);
  const unchangedCount = files.length - changed.length;

  /*
   * Edges are resolved against the full path set, not just changed files: a
   * changed file can import an unchanged one. The parse itself is what we
   * avoid repeating, which is where essentially all the cost is.
   */
  const knownPaths = new Set(files.map((f) => f.path));

  const parsed = new Map<string, ParsedFile>();
  const parseTimes = new Map<string, number>();
  const parseErrors: Array<{ path: string; error: string }> = [];

  for (const file of changed) {
    const t0 = Date.now();
    const result = parseFile(file.path, file.content, file.language);
    parseTimes.set(file.path, Date.now() - t0);
    parsed.set(file.path, result);
    if (result.error) parseErrors.push({ path: file.path, error: result.error });
  }

  /* ---------------- build edges for the changed files ---------------- */

  const fileByPath = new Map(files.map((f) => [f.path, f]));
  const edgesByFile = new Map<string, EdgeDraft[]>();

  for (const file of changed) {
    const result = parsed.get(file.path);
    if (!result) continue;
    edgesByFile.set(file.path, buildFileEdges(file, result, knownPaths, fileByPath));
  }

  /* ---------------- persist ---------------- */

  const stalePaths = [...changed.map((f) => f.path), ...removedPaths];

  await db.transaction(async (tx) => {
    /*
     * Delete-then-insert per changed file. Scoped by fromKey prefix so an edge
     * owned by an untouched file is never collateral damage, which is what
     * makes a single-file re-index actually incremental rather than a
     * disguised full rebuild.
     */
    for (const batch of chunk(stalePaths, 200)) {
      if (batch.length === 0) continue;
      await tx
        .delete(symbolsTable)
        .where(and(eq(symbolsTable.repositoryId, repositoryId), inArray(symbolsTable.filePath, batch)));
      await tx
        .delete(codeEdges)
        .where(and(eq(codeEdges.repositoryId, repositoryId), inArray(codeEdges.fromKey, batch)));
    }

    /* Symbol-scoped edges (CALLS from `path#symbol`) need a separate sweep. */
    for (const path of stalePaths) {
      await tx.delete(codeEdges).where(
        and(
          eq(codeEdges.repositoryId, repositoryId),
          inArray(
            codeEdges.fromKey,
            (parsed.get(path)?.symbols ?? []).map((s) => symbolKey(path, s.name)),
          ),
        ),
      );
    }

    if (removedPaths.length > 0) {
      for (const batch of chunk(removedPaths, 200)) {
        await tx
          .delete(indexState)
          .where(and(eq(indexState.repositoryId, repositoryId), inArray(indexState.filePath, batch)));
      }
    }

    /* Insert symbols. */
    const symbolRows = changed.flatMap((file) => {
      const result = parsed.get(file.path);
      if (!result) return [];
      return result.symbols.map((s) => ({
        repositoryId,
        filePath: file.path,
        name: s.name,
        kind: s.kind,
        lineStart: s.lineStart,
        lineEnd: s.lineEnd,
        isExported: s.isExported,
        isAsync: s.isAsync,
        parameters: [...s.parameters],
        parentName: s.parentName,
        complexity: s.complexity,
        signature: s.signature,
      }));
    });
    for (const batch of chunk(symbolRows, 500)) {
      if (batch.length > 0) await tx.insert(symbolsTable).values(batch);
    }

    /* Insert edges, de-duplicated on the unique key. */
    const seen = new Set<string>();
    const edgeRows: Array<typeof codeEdges.$inferInsert> = [];
    for (const drafts of edgesByFile.values()) {
      for (const edge of drafts) {
        const key = `${edge.type}|${edge.fromKey}|${edge.toKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edgeRows.push({ repositoryId, ...edge });
      }
    }
    for (const batch of chunk(edgeRows, 500)) {
      if (batch.length > 0) await tx.insert(codeEdges).values(batch).onConflictDoNothing();
    }

    /* Update the index ledger. */
    for (const file of changed) {
      const result = parsed.get(file.path);
      const edgeCount = edgesByFile.get(file.path)?.length ?? 0;
      await tx
        .insert(indexState)
        .values({
          repositoryId,
          filePath: file.path,
          contentHash: file.contentHash,
          language: file.language,
          symbolCount: result?.symbols.length ?? 0,
          edgeCount,
          parseMs: parseTimes.get(file.path) ?? 0,
          indexedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [indexState.repositoryId, indexState.filePath],
          set: {
            contentHash: file.contentHash,
            language: file.language,
            symbolCount: result?.symbols.length ?? 0,
            edgeCount,
            parseMs: parseTimes.get(file.path) ?? 0,
            indexedAt: new Date(),
          },
        });
    }
  });

  /* ---------------- report ---------------- */

  const totals = await db
    .select({ type: codeEdges.type })
    .from(codeEdges)
    .where(eq(codeEdges.repositoryId, repositoryId));

  const edgesByType: Record<string, number> = {};
  for (const row of totals) edgesByType[row.type] = (edgesByType[row.type] ?? 0) + 1;

  const symbolTotal = await db
    .select({ id: symbolsTable.id })
    .from(symbolsTable)
    .where(eq(symbolsTable.repositoryId, repositoryId));

  const result: IndexResult = {
    filesTotal: files.length,
    filesParsed: changed.length,
    filesUnchanged: unchangedCount,
    filesRemoved: removedPaths.length,
    symbolCount: symbolTotal.length,
    edgeCount: totals.length,
    edgesByType,
    durationMs: Date.now() - startedAt,
    parseErrors,
  };

  options.logger?.info('digital twin indexed', {
    repositoryId,
    parsed: result.filesParsed,
    unchanged: result.filesUnchanged,
    removed: result.filesRemoved,
    symbols: result.symbolCount,
    edges: result.edgeCount,
    durationMs: result.durationMs,
  });

  return result;
}

/**
 * Every edge a single file contributes.
 *
 * Split out so it can be unit tested without a database.
 */
export function buildFileEdges(
  file: SourceFile,
  result: ParsedFile,
  knownPaths: ReadonlySet<string>,
  fileByPath: ReadonlyMap<string, SourceFile>,
): EdgeDraft[] {
  const edges: EdgeDraft[] = [];
  const language = file.language;

  /* ---------------- IMPORTS / DEPENDS_ON ---------------- */
  const importedPaths = new Map<string, string[]>();

  for (const imp of result.imports) {
    if (isExternalSpecifier(imp.specifier, language)) {
      edges.push({
        type: 'depends_on',
        fromKey: file.path,
        toKey: packageKey(packageNameOf(imp.specifier, language)),
        confidence: 'certain',
        evidence: `imports '${imp.specifier}'`,
        lineNumber: imp.line,
      });
      continue;
    }

    const target = resolveSpecifier(file.path, imp.specifier, knownPaths, language);
    if (!target) continue; // Unresolvable: no edge, rather than a guessed one.

    edges.push({
      type: 'imports',
      fromKey: file.path,
      toKey: target,
      confidence: 'certain',
      evidence: `imports '${imp.specifier}'`,
      lineNumber: imp.line,
    });

    const names = importedPaths.get(target) ?? [];
    names.push(...imp.imported);
    importedPaths.set(target, names);
  }

  /* ---------------- TESTS ---------------- */
  if (file.isTest || isTestPath(file.path)) {
    for (const target of importedPaths.keys()) {
      const targetFile = fileByPath.get(target);
      if (targetFile?.isTest) continue; // A helper import is not coverage.
      edges.push({
        type: 'tests',
        fromKey: file.path,
        toKey: target,
        confidence: 'certain',
        evidence: `test file imports '${target}'`,
        lineNumber: null,
      });
    }
  }

  /* ---------------- EXPOSES_API ---------------- */
  for (const route of result.routes) {
    edges.push({
      type: 'exposes_api',
      fromKey: file.path,
      toKey: routeKey(route.method, route.path),
      confidence: 'certain',
      evidence: route.evidence,
      lineNumber: route.line,
    });
  }

  /* ---------------- USES_DATABASE ---------------- */
  for (const use of result.databaseUses) {
    edges.push({
      type: 'uses_database',
      fromKey: file.path,
      toKey: databaseKey(use.target),
      // A named table from SQL is certain; a client import only proves intent.
      confidence: use.via === 'client' ? 'probable' : 'certain',
      evidence: use.evidence,
      lineNumber: use.line,
    });
  }

  /* ---------------- CALLS ---------------- */
  /*
   * Only calls that resolve to a definite declaration are recorded. Two cases
   * qualify: a call to a name imported from a known file, and a call to a
   * symbol declared in this same file. Everything else — methods on runtime
   * objects, dynamic dispatch, same-named helpers in unrelated modules —
   * is dropped. The spec says "CALLS where reliably detectable", and a call
   * graph padded with name collisions would poison every impact calculation
   * built on top of it.
   */
  const importedNameToPath = new Map<string, string>();
  for (const [target, names] of importedPaths) {
    for (const name of names) if (!importedNameToPath.has(name)) importedNameToPath.set(name, target);
  }
  const localSymbols = new Set(result.symbols.map((s) => s.name));

  const seenCalls = new Set<string>();
  for (const call of result.calls) {
    // `obj.method()` where obj is an imported namespace still resolves.
    const lookupName = call.receiver && importedNameToPath.has(call.receiver) ? call.receiver : call.callee;
    const targetPath = importedNameToPath.get(lookupName);

    let toKey: string | null = null;
    let confidence: 'certain' | 'probable' = 'certain';

    if (targetPath) {
      toKey = symbolKey(targetPath, call.receiver === lookupName ? call.callee : lookupName);
      // Namespace member calls are a name match inside a known file.
      confidence = call.receiver === lookupName ? 'probable' : 'certain';
    } else if (!call.receiver && localSymbols.has(call.callee)) {
      toKey = symbolKey(file.path, call.callee);
    }

    if (!toKey) continue;

    const fromKey = call.enclosingSymbol ? symbolKey(file.path, call.enclosingSymbol) : file.path;
    const dedupe = `${fromKey}|${toKey}`;
    if (seenCalls.has(dedupe)) continue;
    seenCalls.add(dedupe);

    edges.push({
      type: 'calls',
      fromKey,
      toKey,
      confidence,
      evidence: `${call.receiver ? `${call.receiver}.` : ''}${call.callee}() at line ${call.line}`,
      lineNumber: call.line,
    });
  }

  return edges;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

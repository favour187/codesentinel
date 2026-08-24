import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import { db as getDb } from '@/db';
import {
  dependencies as dependenciesTable,
  files as filesTable,
  findings as findingsTable,
  healthSnapshots,
  repositories,
  scans,
  tests as testsTable,
  type ScanStatus,
} from '@/db/schema';
import { createLogger } from '@/lib/logger';
import { rebuildComponents } from '@/twin/components';
import { indexRepository } from '@/twin/indexer';
import { recordEvent } from '@/guardian/events';
import { selectScanners } from '@/guardian/scan-strategy';
import { getScanner } from './registry';
import { runScan, type RunScanOptions, type ScanResult } from './orchestrator';
import { parseManifests } from './scanners/dependencies';
import {
  countTestCases,
  detectFramework,
  extractRelativeImports,
  hasAssertions,
  resolveImport,
} from './scanners/testing';
import { diffFindings } from './scoring';
import type { Finding, SourceFile } from './types';

/**
 * Persists a scan and everything derived from it.
 *
 * The scan row is created first with status `running`, so an in-flight or
 * crashed scan is visible in the UI rather than invisible until it completes.
 * Writes are chunked so a large repository never builds one oversized
 * statement.
 */

const log = createLogger('scanner:persist');

/** Batch size for multi-row inserts. */
const CHUNK = 200;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ExecuteScanOptions extends RunScanOptions {
  trigger?: string;
  commitSha?: string | null;
  ref?: string | null;
  pullRequestId?: string | null;
  changedPaths?: readonly string[];
}

export interface ExecutedScan {
  scanId: string;
  result: ScanResult;
  introduced: number;
  resolved: number;
  previousHealth: number | null;
  healthDelta: number | null;
}

/** Fingerprints currently open for a repository — the baseline for diffing. */
export async function openFingerprints(repositoryId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ fingerprint: findingsTable.fingerprint })
    .from(findingsTable)
    .where(and(eq(findingsTable.repositoryId, repositoryId), eq(findingsTable.status, 'open')));
  return rows.map((row) => row.fingerprint);
}

export async function executeScan(options: ExecuteScanOptions): Promise<ExecutedScan> {
  const db = await getDb();

  const [scanRow] = await db
    .insert(scans)
    .values({
      repositoryId: options.repositoryId,
      status: 'running' satisfies ScanStatus,
      trigger: options.trigger ?? 'manual',
      commitSha: options.commitSha ?? null,
      ref: options.ref ?? null,
      pullRequestId: options.pullRequestId ?? null,
      startedAt: new Date(),
    })
    .returning();

  if (!scanRow) throw new Error('Failed to create scan record');
  const scanId = scanRow.id;

  try {
    const previousFingerprints = await openFingerprints(options.repositoryId);
    const previousSnapshotRows = await db
      .select({ health: healthSnapshots.health })
      .from(healthSnapshots)
      .where(eq(healthSnapshots.repositoryId, options.repositoryId))
      .orderBy(desc(healthSnapshots.createdAt))
      .limit(1);
    const previousHealth = previousSnapshotRows[0]?.health ?? null;

    const strategy =
      options.scanners || !options.changedPaths
        ? null
        : selectScanners(options.changedPaths);
    const targeted = strategy
      ? strategy.scanners.map((id) => getScanner(id)).filter((s): s is NonNullable<typeof s> => Boolean(s))
      : undefined;
    const result = await runScan({
      ...options,
      scanners: options.scanners ?? targeted,
    });
    const delta = diffFindings(previousFingerprints, result.findings);

    await persistFindings(scanId, options.repositoryId, result, delta);
    await persistRepositoryIntelligence(scanId, options.repositoryId, result);

    /*
     * The Digital Twin indexes the same file set the scanners just read, so
     * indexing costs no extra disk I/O and stays consistent with the findings
     * from this scan. It is incremental: unchanged files are skipped on the
     * hash comparison alone.
     *
     * A twin failure must never fail the scan — findings are the product,
     * the graph is an enrichment. We log and carry on.
     */
    try {
      const indexed = await indexRepository(options.repositoryId, result.files);
      log.info('Digital twin indexed', {
        scanId,
        parsed: indexed.filesParsed,
        unchanged: indexed.filesUnchanged,
        removed: indexed.filesRemoved,
        symbols: indexed.symbolCount,
        edges: indexed.edgeCount,
        durationMs: indexed.durationMs,
      });
      // Components are derived from the graph plus this scan's findings, so
      // they are rebuilt after both exist.
      await rebuildComponents(options.repositoryId, scanId);
    } catch (error: unknown) {
      log.error('Digital twin indexing failed; scan results are unaffected', {
        scanId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await db
      .update(scans)
      .set({
        status: 'completed' satisfies ScanStatus,
        scannerRuns: result.runs,
        filesScanned: result.stats.fileCount,
        linesScanned: result.stats.totalLoc,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(scans.id, scanId));

    await db
      .update(repositories)
      .set({ lastScanAt: new Date(), updatedAt: new Date() })
      .where(eq(repositories.id, options.repositoryId));

    await recordEvent({
      repositoryId: options.repositoryId,
      type: 'SCAN_COMPLETED',
      title: `Scan completed (${strategy?.mode ?? 'full'})`,
      detail: `${result.findings.length} findings · health ${Math.round(result.scores.health)} · ${result.durationMs}ms`,
      level: result.findings.some((f) => f.severity === 'critical') ? 'warning' : 'success',
      dedupeKey: `scan:${scanId}`,
      payload: { scanId, mode: strategy?.mode ?? 'full', durationMs: result.durationMs },
    });
    if (delta.introduced.some((f) => f.category === 'secrets')) {
      await recordEvent({
        repositoryId: options.repositoryId,
        type: 'SECRET_DETECTED',
        title: 'Secret detected',
        detail: 'A credential-shaped value was found. The value is never shown.',
        level: 'critical',
        dedupeKey: `secret:${scanId}`,
      });
    }

    log.info('Scan persisted', {
      scanId,
      findings: result.findings.length,
      introduced: delta.introduced.length,
      resolved: delta.resolved.length,
      health: result.scores.health,
    });

    return {
      scanId,
      result,
      introduced: delta.introduced.length,
      resolved: delta.resolved.length,
      previousHealth,
      healthDelta:
        previousHealth === null ? null : Math.round((result.scores.health - previousHealth) * 10) / 10,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Scan failed', { scanId, message });
    await db
      .update(scans)
      .set({ status: 'failed' satisfies ScanStatus, error: message, finishedAt: new Date() })
      .where(eq(scans.id, scanId));
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Findings + health snapshot                                                 */
/* -------------------------------------------------------------------------- */

interface Delta {
  introduced: Finding[];
  resolved: string[];
  unchanged: string[];
}

async function persistFindings(
  scanId: string,
  repositoryId: string,
  result: ScanResult,
  delta: Delta,
): Promise<void> {
  const db = await getDb();
  const now = new Date();

  /*
   * Each scan writes a complete, self-contained set of findings, so the rows
   * from the previous scan have to be retired. The distinction that matters:
   *
   *   - genuinely fixed  -> status 'resolved' + resolvedAt (Insights counts it)
   *   - still reproduces -> status 'superseded', no resolvedAt (it was never
   *                         fixed; the newest scan simply owns the live row)
   *
   * Conflating the two would make every re-scan look like a wave of fixes
   * immediately undone by a wave of regressions.
   *
   * Ordering matters: retire the old rows before inserting the new ones, or the
   * update would close the rows just written.
   */
  const previouslyOpen = new Map<string, Date>();
  const existing = await db
    .select({
      fingerprint: findingsTable.fingerprint,
      createdAt: findingsTable.createdAt,
      metadata: findingsTable.metadata,
    })
    .from(findingsTable)
    .where(and(eq(findingsTable.repositoryId, repositoryId), eq(findingsTable.status, 'open')));

  for (const row of existing) {
    const recorded = row.metadata['firstSeenAt'];
    const firstSeen = typeof recorded === 'string' ? new Date(recorded) : row.createdAt;
    previouslyOpen.set(row.fingerprint, firstSeen);
  }

  if (delta.resolved.length > 0) {
    for (const chunk of chunked(delta.resolved)) {
      await db
        .update(findingsTable)
        .set({ status: 'resolved', resolvedAt: now, updatedAt: now })
        .where(
          and(
            eq(findingsTable.repositoryId, repositoryId),
            eq(findingsTable.status, 'open'),
            inArray(findingsTable.fingerprint, chunk),
          ),
        );
    }
  }

  if (delta.unchanged.length > 0) {
    for (const chunk of chunked(delta.unchanged)) {
      await db
        .update(findingsTable)
        .set({ status: 'superseded', updatedAt: now })
        .where(
          and(
            eq(findingsTable.repositoryId, repositoryId),
            eq(findingsTable.status, 'open'),
            inArray(findingsTable.fingerprint, chunk),
          ),
        );
    }
  }

  for (const chunk of chunked(result.findings)) {
    await db.insert(findingsTable).values(
      chunk.map((finding) => ({
        scanId,
        repositoryId,
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        scannerId: finding.scannerId,
        severity: finding.severity,
        category: finding.category,
        status: 'open' as const,
        title: finding.title,
        description: finding.description,
        filePath: finding.filePath,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        evidence: finding.evidence,
        confidence: finding.confidence,
        whyItMatters: finding.whyItMatters,
        remediation: finding.remediation,
        references: finding.references,
        relatedTests: finding.relatedTests,
        metadata: {
          ...finding.metadata,
          firstSeenAt: (previouslyOpen.get(finding.fingerprint) ?? now).toISOString(),
          isNew: !previouslyOpen.has(finding.fingerprint),
        },
      })),
    );
  }

  await db.insert(healthSnapshots).values({
    repositoryId,
    scanId,
    health: result.scores.health,
    security: result.scores.security,
    reliability: result.scores.reliability,
    quality: result.scores.quality,
    testing: result.scores.testing,
    performance: result.scores.performance,
    counts: result.severityCounts,
    issuesResolved: delta.resolved.length,
    issuesIntroduced: delta.introduced.length,
    debtHours: result.scores.debtHours,
  });
}

/* -------------------------------------------------------------------------- */
/* Repository intelligence: files, dependencies, tests                        */
/* -------------------------------------------------------------------------- */

/** Classifies a file's role, used by the Codebase map. */
export function classifyFile(file: SourceFile): string {
  if (file.isTest) return 'test';
  if (file.language === 'dockerfile' || /^(?:docker-compose|\.github\/|k8s\/|terraform\/)/.test(file.path)) return 'infra';
  if (/\.(?:json|ya?ml|toml|ini|env)$/i.test(file.path)) return 'config';
  if (/(?:^|\/)(?:routes?|api|controllers?|handlers?|pages)\//i.test(file.path)) return 'route';
  if (/(?:^|\/)components?\//i.test(file.path) || /\.(?:tsx|jsx)$/.test(file.path)) return 'component';
  if (/(?:^|\/)(?:services?|lib|utils?|helpers?|models?)\//i.test(file.path)) return 'service';
  return 'source';
}

/** Extracts exported symbol names — powers the API/component map. */
export function extractExports(file: SourceFile): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:const|let|var|class|interface|type|enum)\s+(\w+)/g,
    /module\.exports\.(\w+)\s*=/g,
    /exports\.(\w+)\s*=/g,
    /^def\s+(\w+)\s*\(/gm,
    /^class\s+(\w+)/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      if (match[1] && !match[1].startsWith('_')) names.add(match[1]);
    }
  }
  // `module.exports = { a, b }`
  const bulk = /module\.exports\s*=\s*\{([^}]*)\}/.exec(file.content);
  if (bulk?.[1]) {
    for (const part of bulk[1].split(',')) {
      const name = part.split(':')[0]?.trim();
      if (name && /^\w+$/.test(name)) names.add(name);
    }
  }
  return [...names].slice(0, 100);
}

/** Cheap cyclomatic-complexity proxy: count of branching constructs. */
export function complexityOf(file: SourceFile): number {
  const matches = file.content.match(
    /\b(?:if|else\s+if|for|while|case|catch|elif|and|or|&&|\|\||\?\.|\?)\b|\?\?/g,
  );
  return 1 + (matches?.length ?? 0);
}

/**
 * Risk score per file (0..1): complexity relative to size, weighted by whether
 * the module is untested and how many findings landed on it.
 */
export function fileRisk(file: SourceFile, findingCount: number, isCovered: boolean): number {
  const density = Math.min(1, complexityOf(file) / Math.max(file.loc, 20));
  const findingPressure = Math.min(1, findingCount / 5);
  const untestedPenalty = file.isTest || isCovered ? 0 : 0.25;
  return Math.round(Math.min(1, density * 0.35 + findingPressure * 0.4 + untestedPenalty) * 100) / 100;
}

export async function persistRepositoryIntelligence(
  scanId: string,
  repositoryId: string,
  result: ScanResult,
): Promise<void> {
  const db = await getDb();

  /*
   * files/dependencies/tests describe the repository as of one scan, and only
   * the newest scan's rows are ever queried. Without this the tables grow by a
   * full repository snapshot on every scan — thousands of dead rows a day on an
   * active repo. Findings are deliberately NOT pruned here: their history is
   * the audit trail that drives the Insights trends.
   */
  await db
    .delete(filesTable)
    .where(and(eq(filesTable.repositoryId, repositoryId), ne(filesTable.scanId, scanId)));
  await db
    .delete(dependenciesTable)
    .where(and(eq(dependenciesTable.repositoryId, repositoryId), ne(dependenciesTable.scanId, scanId)));
  await db
    .delete(testsTable)
    .where(and(eq(testsTable.repositoryId, repositoryId), ne(testsTable.scanId, scanId)));

  const knownPaths = new Set(result.files.map((f) => f.path));

  // Resolve the import graph once; used for both files.imports and test coverage.
  const importsByFile = new Map<string, string[]>();
  const covered = new Set<string>();

  for (const file of result.files) {
    const resolved: string[] = [];
    for (const specifier of extractRelativeImports(file)) {
      const target = resolveImport(file.path, specifier, knownPaths);
      if (target) resolved.push(target);
    }
    importsByFile.set(file.path, resolved);
    if (file.isTest) for (const target of resolved) covered.add(target);
  }

  const findingsByFile = new Map<string, number>();
  for (const finding of result.findings) {
    if (!finding.filePath) continue;
    findingsByFile.set(finding.filePath, (findingsByFile.get(finding.filePath) ?? 0) + 1);
  }

  /* --------------------------------- files --------------------------------- */
  for (const chunk of chunked(result.files)) {
    await db.insert(filesTable).values(
      chunk.map((file) => ({
        repositoryId,
        scanId,
        path: file.path,
        language: file.language,
        loc: file.loc,
        bytes: file.bytes,
        imports: importsByFile.get(file.path) ?? [],
        exports: extractExports(file),
        kind: classifyFile(file),
        complexity: complexityOf(file),
        churn: 0,
        riskScore: fileRisk(file, findingsByFile.get(file.path) ?? 0, covered.has(file.path)),
        contentHash: file.contentHash,
      })),
    );
  }

  /* ----------------------------- dependencies ------------------------------ */
  const parsed = parseManifests(result.files);
  if (parsed.length > 0) {
    const vulnerabilities = result.vulnerabilities;

    // The unique index is (scanId, ecosystem, name, manifestPath); a manifest
    // listing a package in both deps and devDeps would otherwise conflict.
    const seen = new Set<string>();
    const rows = parsed
      .filter((dep) => {
        const key = `${dep.ecosystem}|${dep.name}|${dep.manifestPath}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((dep) => ({
        repositoryId,
        scanId,
        ecosystem: dep.ecosystem,
        name: dep.name,
        version: dep.version,
        versionSpec: dep.versionSpec,
        isDev: dep.isDev,
        isDirect: dep.isDirect,
        manifestPath: dep.manifestPath,
        vulnerabilities: vulnerabilities.get(`${dep.ecosystem}:${dep.name}`) ?? [],
      }));

    for (const chunk of chunked(rows)) {
      await db.insert(dependenciesTable).values(chunk);
    }
  }

  /* --------------------------------- tests --------------------------------- */
  const testRows = result.files
    .filter((file) => file.isTest)
    .map((file) => ({
      repositoryId,
      scanId,
      filePath: file.path,
      framework: detectFramework(file.content),
      testCount: countTestCases(file.content),
      coversPaths: importsByFile.get(file.path) ?? [],
      hasAssertions: hasAssertions(file.content),
    }));

  for (const chunk of chunked(testRows)) {
    await db.insert(testsTable).values(chunk);
  }
}

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { commits, findings, pullRequests, scans } from '@/db/schema';
import { executeScan } from '@/scanner/persistence';
import { runScan } from '@/scanner/orchestrator';
import { getScanner } from '@/scanner/registry';
import { selectScanners } from '@/guardian/scan-strategy';
import { recordEvent } from '@/guardian/events';
import type { ScanResult } from '@/scanner/orchestrator';
import type { Finding } from '@/scanner/types';
import { GitHubClient } from '@/github/client';
import type { PullRequestFile } from '@/github/client';
import { checkoutRepository } from './checkout';
import { assessPullRequestRisk } from './risk';
import type { PullRequestRisk } from './risk';
import { buildCheckRun, renderPullRequestComment } from './report';
import type { ReportContext } from './report';
import { reviewPullRequest, renderReviewMarkdown } from '@/ai/tasks/review-pull-request';
import type { PullRequestReviewInput } from '@/ai/tasks/review-pull-request';
import { getRepositoryPolicy } from '@/lib/repositories';
import { getEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

















const log = createLogger('guardian:pipeline');

export interface RepositoryRef {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  installationId: number | null;
  defaultBranch: string;
}





export interface BranchScanOptions {
  repository: RepositoryRef;
  ref: string;
  commitSha: string;
  trigger: string;
  client: GitHubClient;
}

export interface BranchScanOutcome {
  scanId: string;
  findings: number;
  health: number;
  healthDelta: number | null;
  introduced: number;
  resolved: number;
}

export async function scanBranch(options: BranchScanOptions): Promise<BranchScanOutcome> {
  const { repository, ref, commitSha, trigger, client } = options;

  const checkout = await checkoutRepository(client, repository.owner, repository.name, commitSha);
  try {
    const executed = await executeScan({
      repositoryId: repository.id,
      rootDir: checkout.dir,
      trigger,
      commitSha,
      ref,
    });

    await recordCommit(repository, commitSha, client);

    log.info('Branch scan complete', {
      repository: repository.fullName,
      ref,
      findings: executed.result.findings.length,
      health: executed.result.scores.health,
    });

    return {
      scanId: executed.scanId,
      findings: executed.result.findings.length,
      health: executed.result.scores.health,
      healthDelta: executed.healthDelta,
      introduced: executed.introduced,
      resolved: executed.resolved,
    };
  } finally {
    await checkout.cleanup();
  }
}





export interface PullRequestScanOptions {
  repository: RepositoryRef;
  number: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  title?: string | null;
  authorLogin?: string | null;
  client: GitHubClient;

  dryRun?: boolean;
}

export interface PullRequestScanOutcome {
  scanId: string;
  pullRequestId: string;
  risk: PullRequestRisk;
  checkRunId: string | null;
  commentId: string | null;
  conclusion: string;
}

export async function scanPullRequest(options: PullRequestScanOptions): Promise<PullRequestScanOutcome> {
  const { repository, number, headSha, baseSha, client } = options;
  const db = await getDb();
  const policy = await getRepositoryPolicy(repository.id);


  const { files, truncated } = await client.listPullRequestFiles(repository.owner, repository.name, number);



  const headCheckout = await checkoutRepository(client, repository.owner, repository.name, headSha);

  let headResult: ScanResult;
  let scanId: string;
  let pullRequestId: string;

  try {
    const prRow = await upsertPullRequest(options, files);
    pullRequestId = prRow.id;

    const [scanRow] = await db
      .insert(scans)
      .values({
        repositoryId: repository.id,
        status: 'running',
        trigger: 'pull_request',
        commitSha: headSha,
        ref: options.headRef,
        pullRequestId,
        startedAt: new Date(),
      })
      .returning();

    if (!scanRow) throw new Error('Failed to create pull request scan record');
    scanId = scanRow.id;

    try {
      const strategy = selectScanners(files.map((f) => f.filename));
      const targeted = strategy.scanners
        .map((id) => getScanner(id))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));
      headResult = await runScan({
        repositoryId: repository.id,
        rootDir: headCheckout.dir,
        scanners: targeted.length > 0 ? targeted : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(scans)
        .set({ status: 'failed', error: message, finishedAt: new Date() })
        .where(eq(scans.id, scanId));
      throw err;
    }
  } finally {
    await headCheckout.cleanup();
  }



  const baseFindings = await resolveBaseFindings(repository, baseSha, client);

  const basePrints = new Set(baseFindings.map((f) => f.fingerprint));
  const headPrints = new Set(headResult.findings.map((f) => f.fingerprint));
  const newFindings = headResult.findings.filter((f) => !basePrints.has(f.fingerprint));
  const resolvedFingerprints = [...basePrints].filter((p) => !headPrints.has(p));


  const importGraph = new Map<string, string[]>();
  const testFiles: string[] = [];
  for (const file of headResult.files) {
    if (file.isTest) testFiles.push(file.path);
  }
  for (const file of headResult.files) {
    importGraph.set(file.path, resolveImports(file.path, file.content, headResult.files.map((f) => f.path)));
  }

  const risk = assessPullRequestRisk({
    files,
    newFindings,
    resolvedFingerprints,
    importGraph,
    testFiles,
    failOnSeverity: policy.failOnSeverity,
    truncatedDiff: truncated,
  });


  await persistPullRequestFindings(scanId, repository.id, headResult, basePrints);

  await db
    .update(scans)
    .set({
      status: 'completed',
      scannerRuns: headResult.runs,
      filesScanned: headResult.stats.fileCount,
      linesScanned: headResult.stats.totalLoc,
      durationMs: headResult.durationMs,
      finishedAt: new Date(),
    })
    .where(eq(scans.id, scanId));

  await db
    .update(pullRequests)
    .set({
      riskLevel: risk.level,
      riskScore: risk.score,
      riskFactors: risk.factors,
      updatedAt: new Date(),
    })
    .where(eq(pullRequests.id, pullRequestId));


  const ctx: ReportContext = {
    repositoryFullName: repository.fullName,
    pullRequestNumber: number,
    headSha,
    detailsUrl: `${getEnv().APP_URL.replace(/\/$/, '')}/guardian?repo=${repository.id}&pr=${number}`,
    failOnSeverity: policy.failOnSeverity,
    degraded: headResult.runs
      .filter((r) => r.status !== 'ok')
      .map((r) => ({ id: r.id, status: r.status as 'error' | 'skipped', message: r.message })),
  };

  const check = buildCheckRun(risk, ctx);
  let checkRunId: string | null = null;
  let commentId: string | null = null;

  if (!options.dryRun && policy.createChecks) {
    checkRunId = await postCheckRun(client, repository, scanId, check);
  }
  if (!options.dryRun && policy.postPrComments) {






    const aiSection = await buildAIReviewSection({
      repositoryId: repository.id,
      repositoryFullName: repository.fullName,
      pullRequestNumber: number,
      title: options.title ?? null,
      author: options.authorLogin ?? null,
      risk,
      changedFiles: files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
      })),
    });

    const body = renderPullRequestComment(risk, ctx) + (aiSection ? `\n\n${aiSection}` : '');
    commentId = await postComment(client, repository, number, pullRequestId, body);
  }

  await db
    .update(scans)
    .set({ checkRunId, checkConclusion: check.conclusion ?? null })
    .where(eq(scans.id, scanId));

  await recordEvent({
    repositoryId: repository.id,
    type: 'PR_ANALYZED',
    title: `PR #${number} analyzed`,
    detail: `${risk.level} risk (${risk.score}) · ${newFindings.length} new · ${resolvedFingerprints.length} resolved`,
    level: risk.shouldBlock ? 'critical' : risk.level === 'high' || risk.level === 'critical' ? 'warning' : 'success',
    dedupeKey: `pr:${number}:${headSha}`,
    payload: { number, risk: risk.score, level: risk.level, blocked: risk.shouldBlock },
  });

  log.info('Pull request scan complete', {
    repository: repository.fullName,
    number,
    risk: risk.score,
    level: risk.level,
    newFindings: newFindings.length,
    blocked: risk.shouldBlock,
  });

  return {
    scanId,
    pullRequestId,
    risk,
    checkRunId,
    commentId,
    conclusion: check.conclusion ?? 'neutral',
  };
}






















async function persistPullRequestFindings(
  scanId: string,
  repositoryId: string,
  result: ScanResult,
  basePrints: ReadonlySet<string>,
): Promise<void> {
  if (result.findings.length === 0) return;
  const db = await getDb();

  const CHUNK = 200;
  for (let i = 0; i < result.findings.length; i += CHUNK) {
    const chunk = result.findings.slice(i, i + CHUNK);
    await db.insert(findings).values(
      chunk.map((finding) => ({
        scanId,
        repositoryId,
        fingerprint: finding.fingerprint,
        ruleId: finding.ruleId,
        scannerId: finding.scannerId,
        severity: finding.severity,
        category: finding.category,
        status: 'proposed' as const,
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
          firstSeenOnBase: basePrints.has(finding.fingerprint),
        },
      })),
    );
  }

  log.debug('Persisted pull request findings', {
    scanId,
    findings: result.findings.length,
    introduced: result.findings.filter((f) => !basePrints.has(f.fingerprint)).length,
  });
}








async function resolveBaseFindings(
  repository: RepositoryRef,
  baseSha: string,
  client: GitHubClient,
): Promise<Finding[]> {
  const db = await getDb();

  const cached = await db
    .select({ id: scans.id })
    .from(scans)
    .where(and(eq(scans.repositoryId, repository.id), eq(scans.commitSha, baseSha), eq(scans.status, 'completed')))
    .orderBy(desc(scans.createdAt))
    .limit(1);

  const cachedScan = cached[0];
  if (cachedScan) {
    const rows = await db
      .select({ fingerprint: findings.fingerprint })
      .from(findings)
      .where(eq(findings.scanId, cachedScan.id));
    log.debug('Reused cached base scan', { baseSha, scanId: cachedScan.id, findings: rows.length });
    return rows.map((row) => ({ fingerprint: row.fingerprint }) as Finding);
  }

  const checkout = await checkoutRepository(client, repository.owner, repository.name, baseSha);
  try {
    const result = await runScan({ repositoryId: repository.id, rootDir: checkout.dir });
    return result.findings;
  } finally {
    await checkout.cleanup();
  }
}

async function upsertPullRequest(
  options: PullRequestScanOptions,
  files: PullRequestFile[],
): Promise<{ id: string }> {
  const db = await getDb();
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const existing = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, options.repository.id), eq(pullRequests.number, options.number)))
    .limit(1);

  const values = {
    repositoryId: options.repository.id,
    number: options.number,
    title: options.title ?? null,
    state: 'open',
    authorLogin: options.authorLogin ?? null,
    headSha: options.headSha,
    baseSha: options.baseSha,
    headRef: options.headRef,
    baseRef: options.baseRef,
    filesChanged: files.length,
    additions,
    deletions,
  };

  const found = existing[0];
  if (found) {
    await db.update(pullRequests).set({ ...values, updatedAt: new Date() }).where(eq(pullRequests.id, found.id));
    return { id: found.id };
  }

  const [row] = await db.insert(pullRequests).values(values).returning();
  if (!row) throw new Error('Failed to record pull request');
  return { id: row.id };
}


async function postCheckRun(
  client: GitHubClient,
  repository: RepositoryRef,
  scanId: string,
  check: ReturnType<typeof buildCheckRun>,
): Promise<string | null> {
  try {
    const created = await client.createCheckRun(repository.owner, repository.name, check);
    log.info('Posted check run', { repository: repository.fullName, checkRunId: created.id, scanId });
    return String(created.id);
  } catch (err) {


    log.error('Failed to post check run', {
      repository: repository.fullName,
      error: (err as Error).message,
    });
    return null;
  }
}















async function buildAIReviewSection(input: PullRequestReviewInput): Promise<string | null> {
  try {
    const result = await reviewPullRequest(input);
    if (!result.ok) {
      log.info('Skipping AI review section', { reason: result.reason, pr: input.pullRequestNumber });
      return null;
    }
    return renderReviewMarkdown(result.data, result.model);
  } catch (err) {
    log.warn('AI review failed; posting deterministic comment only', {
      pr: input.pullRequestNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function postComment(
  client: GitHubClient,
  repository: RepositoryRef,
  number: number,
  pullRequestId: string,
  body: string,
): Promise<string | null> {
  const db = await getDb();
  try {
    const rows = await db
      .select({ commentExternalId: pullRequests.commentExternalId })
      .from(pullRequests)
      .where(eq(pullRequests.id, pullRequestId))
      .limit(1);

    const existingId = rows[0]?.commentExternalId;
    if (existingId) {
      const still = await client.getIssueComment(repository.owner, repository.name, existingId);
      if (still) {
        await client.updateIssueComment(repository.owner, repository.name, existingId, body);
        return existingId;
      }

    }

    const created = await client.createIssueComment(repository.owner, repository.name, number, body);
    await db
      .update(pullRequests)
      .set({ commentExternalId: String(created.id), updatedAt: new Date() })
      .where(eq(pullRequests.id, pullRequestId));
    return String(created.id);
  } catch (err) {
    log.error('Failed to post pull request comment', {
      repository: repository.fullName,
      number,
      error: (err as Error).message,
    });
    return null;
  }
}









async function recordCommit(
  repository: RepositoryRef,
  commitSha: string,
  client: GitHubClient,
): Promise<void> {
  try {
    const db = await getDb();
    const commit = await client.getCommit(repository.owner, repository.name, commitSha);
    const authoredAt = commit.commit.author?.date ? new Date(commit.commit.author.date) : null;

    await db
      .insert(commits)
      .values({
        repositoryId: repository.id,
        sha: commit.sha,


        message: commit.commit.message.split('\n')[0]?.slice(0, 500) ?? null,
        authorName: commit.commit.author?.name ?? null,
        authorEmail: commit.commit.author?.email ?? null,
        authoredAt: authoredAt && !Number.isNaN(authoredAt.getTime()) ? authoredAt : null,
        additions: commit.stats?.additions ?? 0,
        deletions: commit.stats?.deletions ?? 0,
        changedFiles: commit.files?.length ?? 0,


        changedPaths: (commit.files ?? []).slice(0, 100).map((f) => f.filename),
      })
      .onConflictDoNothing({ target: [commits.repositoryId, commits.sha] });
  } catch (err) {
    log.warn('Could not record commit metadata', {
      repository: repository.fullName,
      commitSha,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}








export function resolveImports(fromPath: string, content: string, allPaths: readonly string[]): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const spec = match[1];
      if (spec && spec.startsWith('.')) specifiers.add(spec);
    }
  }

  const known = new Set(allPaths);
  const dir = fromPath.split('/').slice(0, -1).join('/');
  const resolved: string[] = [];

  for (const spec of specifiers) {
    const joined = normalizePath(dir ? `${dir}/${spec}` : spec);
    const candidates = [
      joined,
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}.js`,
      `${joined}.jsx`,
      `${joined}.mjs`,
      `${joined}.cjs`,
      `${joined}/index.ts`,
      `${joined}/index.js`,
    ];
    const hit = candidates.find((c) => known.has(c));
    if (hit) resolved.push(hit);
  }

  return [...new Set(resolved)].sort();
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

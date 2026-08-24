import type { Severity } from '@/db/schema';
import type { Finding } from '@/scanner/types';
import type { PullRequestRisk } from './risk';
import type { CheckAnnotation, CheckRunOptions } from '@/github/client';

/**
 * Renders guardian results into GitHub surfaces: the Check Run and the PR
 * comment.
 *
 * Rules that shape everything here:
 *  - Evidence is already redacted by the scanner, but this layer never prints
 *    an evidence string for a secret finding at all. A PR comment is public on
 *    open-source repositories; even a masked credential is a needless leak.
 *  - Output is bounded. A 200-finding PR must not produce a 200-entry comment
 *    that nobody reads and that GitHub truncates at 65536 characters anyway.
 *  - Everything states *why* something is risky and what to do, because the
 *    comment is often the only thing a reviewer reads.
 */

/** GitHub hard-limits comment bodies; stay well clear. */
const MAX_COMMENT_CHARS = 60_000;
/** GitHub accepts at most 50 annotations per Check Run request. */
export const MAX_ANNOTATIONS = 50;
/** Findings listed in full in the comment before collapsing to a count. */
const MAX_LISTED_FINDINGS = 15;

/** Marker that lets the guardian find and update its own comment. */
export const COMMENT_MARKER = '<!-- codesentinel:guardian-report -->';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🛑',
  high: '🔴',
  medium: '🟠',
  low: '🟡',
  info: '🔵',
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Secret findings never get their evidence echoed into a public surface. */
function isSecretFinding(finding: Finding): boolean {
  return finding.category === 'secrets' || finding.ruleId.startsWith('secret/');
}

export interface ReportContext {
  repositoryFullName: string;
  pullRequestNumber: number;
  headSha: string;
  /** Absolute URL of the guardian page for this repository. */
  detailsUrl: string;
  failOnSeverity: Severity;
  /** Scanner runs that were skipped or errored — surfaced honestly. */
  degraded?: Array<{ id: string; status: 'error' | 'skipped'; message?: string }>;
}

/* -------------------------------------------------------------------------- */
/* Pull request comment                                                       */
/* -------------------------------------------------------------------------- */

export function renderPullRequestComment(risk: PullRequestRisk, ctx: ReportContext): string {
  const lines: string[] = [COMMENT_MARKER];

  const verdictEmoji = risk.shouldBlock ? '🛑' : risk.level === 'high' ? '🔴' : risk.level === 'medium' ? '🟠' : '✅';
  lines.push(`## ${verdictEmoji} CodeSentinel — ${risk.shouldBlock ? 'Changes requested' : 'Review summary'}`);
  lines.push('');
  lines.push(risk.summary);
  lines.push('');

  /* Headline table — the "is this safe to merge?" answer. */
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| **Risk** | ${risk.score}/100 (${risk.level}) |`);
  lines.push(`| **New findings** | ${risk.newFindings.length} |`);
  lines.push(`| **Resolved** | ${risk.resolvedFingerprints.length} |`);
  lines.push(`| **Files changed** | ${risk.blastRadius.changedFiles.length} |`);
  lines.push(`| **Blast radius** | ${risk.blastRadius.impactedFiles.length} dependent file(s) |`);
  lines.push('');

  if (risk.shouldBlock) {
    lines.push(
      `> [!CAUTION]`,
      `> This pull request introduces findings at or above the \`${ctx.failOnSeverity}\` threshold configured for this repository, so the check is failing. Resolve them or adjust the policy in CodeSentinel → Settings.`,
      '',
    );
  }

  /* New findings, worst first. */
  if (risk.newFindings.length > 0) {
    lines.push('### New findings introduced by this pull request');
    lines.push('');
    const sorted = [...risk.newFindings].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.filePath?.localeCompare(b.filePath ?? '') || 0,
    );

    for (const finding of sorted.slice(0, MAX_LISTED_FINDINGS)) {
      const location = finding.filePath
        ? `\`${finding.filePath}${finding.lineStart ? `:${finding.lineStart}` : ''}\``
        : '_repository-wide_';
      lines.push(`<details><summary>${SEVERITY_EMOJI[finding.severity]} <strong>${escapeHtml(finding.title)}</strong> — ${location}</summary>`);
      lines.push('');
      lines.push(finding.description);
      if (finding.whyItMatters) {
        lines.push('');
        lines.push(`**Why it matters:** ${finding.whyItMatters}`);
      }
      if (finding.remediation) {
        lines.push('');
        lines.push(`**How to fix:** ${finding.remediation}`);
      }
      // Evidence is shown for code-quality/security patterns but NEVER for
      // credential material, even though it is already masked upstream.
      if (finding.evidence && !isSecretFinding(finding)) {
        lines.push('');
        lines.push('```');
        lines.push(finding.evidence.slice(0, 300));
        lines.push('```');
      }
      lines.push('');
      lines.push(`<sub>Rule \`${finding.ruleId}\` · confidence ${Math.round(finding.confidence * 100)}%</sub>`);
      lines.push('');
      lines.push('</details>');
    }

    if (sorted.length > MAX_LISTED_FINDINGS) {
      lines.push('');
      lines.push(`_…and ${sorted.length - MAX_LISTED_FINDINGS} more. [View all in CodeSentinel](${ctx.detailsUrl})._`);
    }
    lines.push('');
  }

  /* Why the risk score is what it is. */
  if (risk.factors.length > 0) {
    lines.push('### Why this risk score');
    lines.push('');
    for (const factor of risk.factors.slice(0, 8)) {
      const sign = factor.points >= 0 ? '+' : '';
      lines.push(`- **${factor.label}** (${sign}${factor.points}) — ${factor.detail}`);
    }
    lines.push('');
  }

  /* Blast radius. */
  const { impactedFiles, affectedComponents, uncoveredChanges } = risk.blastRadius;
  if (impactedFiles.length > 0 || affectedComponents.length > 0 || uncoveredChanges.length > 0) {
    lines.push('### Blast radius');
    lines.push('');
    if (affectedComponents.length > 0) {
      lines.push(`- **Areas touched:** ${affectedComponents.join(', ')}`);
    }
    if (impactedFiles.length > 0) {
      lines.push(
        `- **Could break:** ${impactedFiles.slice(0, 8).map((f) => `\`${f}\``).join(', ')}` +
          (impactedFiles.length > 8 ? ` _(+${impactedFiles.length - 8} more)_` : ''),
      );
    }
    if (uncoveredChanges.length > 0) {
      lines.push(
        `- **Changed without tests:** ${uncoveredChanges.slice(0, 8).map((f) => `\`${f}\``).join(', ')}` +
          (uncoveredChanges.length > 8 ? ` _(+${uncoveredChanges.length - 8} more)_` : ''),
      );
    }
    lines.push('');
  }

  /* Recommended tests. */
  if (risk.recommendedTests.length > 0) {
    lines.push('### Recommended tests');
    lines.push('');
    for (const test of risk.recommendedTests.slice(0, 6)) lines.push(`- ${test}`);
    lines.push('');
  }

  /* Honest degradation notice. */
  if (ctx.degraded && ctx.degraded.length > 0) {
    lines.push('### ⚠️ Incomplete analysis');
    lines.push('');
    lines.push('Some analyzers did not run, so this report may be incomplete:');
    for (const run of ctx.degraded) {
      lines.push(`- \`${run.id}\` — ${run.status}${run.message ? `: ${run.message}` : ''}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `<sub>[CodeSentinel](${ctx.detailsUrl}) analysed \`${ctx.headSha.slice(0, 7)}\` · ` +
      `Findings are detected by deterministic analyzers, not generated by an LLM. ` +
      `No code was modified.</sub>`,
  );

  const body = lines.join('\n');
  return body.length > MAX_COMMENT_CHARS
    ? `${body.slice(0, MAX_COMMENT_CHARS - 200)}\n\n_…report truncated. [View the full analysis](${ctx.detailsUrl})._`
    : body;
}

/* -------------------------------------------------------------------------- */
/* Check run                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the Check Run payload.
 *
 * Conclusion mapping is deliberate:
 *  - `failure` only when policy says block — a check that fails on every
 *    informational finding gets muted by the team within a week.
 *  - `neutral` when findings exist below the threshold: visible, not blocking.
 *  - `action_required` when analysis itself was degraded, because "we could not
 *    check" must never look like "we checked and it is fine".
 */
export function buildCheckRun(risk: PullRequestRisk, ctx: ReportContext): CheckRunOptions {
  const degraded = (ctx.degraded ?? []).filter((r) => r.status === 'error');

  const conclusion: NonNullable<CheckRunOptions['conclusion']> = risk.shouldBlock
    ? 'failure'
    : degraded.length > 0
      ? 'action_required'
      : risk.newFindings.length > 0
        ? 'neutral'
        : 'success';

  const title = risk.shouldBlock
    ? `Blocked — ${risk.newFindings.length} new finding(s) at or above ${ctx.failOnSeverity}`
    : degraded.length > 0
      ? 'Analysis incomplete'
      : risk.newFindings.length > 0
        ? `${risk.newFindings.length} new finding(s), none blocking`
        : 'No new findings';

  const summaryLines = [
    risk.summary,
    '',
    `- Risk score: **${risk.score}/100** (${risk.level})`,
    `- New findings: **${risk.newFindings.length}**`,
    `- Resolved: **${risk.resolvedFingerprints.length}**`,
    `- Files changed: **${risk.blastRadius.changedFiles.length}**, dependent files: **${risk.blastRadius.impactedFiles.length}**`,
  ];

  if (degraded.length > 0) {
    summaryLines.push('', '**Incomplete analysis:**');
    for (const run of degraded) summaryLines.push(`- \`${run.id}\`: ${run.message ?? 'failed'}`);
  }

  return {
    name: 'CodeSentinel',
    headSha: ctx.headSha,
    status: 'completed',
    conclusion,
    detailsUrl: ctx.detailsUrl,
    output: {
      title,
      summary: summaryLines.join('\n'),
      text: buildCheckText(risk),
      annotations: buildAnnotations(risk.newFindings),
    },
  };
}

function buildCheckText(risk: PullRequestRisk): string {
  const lines: string[] = ['## Risk factors', ''];
  for (const factor of risk.factors.slice(0, 10)) {
    const sign = factor.points >= 0 ? '+' : '';
    lines.push(`- **${factor.label}** (${sign}${factor.points}): ${factor.detail}`);
  }
  if (risk.recommendedTests.length > 0) {
    lines.push('', '## Recommended tests', '');
    for (const test of risk.recommendedTests.slice(0, 8)) lines.push(`- ${test}`);
  }
  return lines.join('\n');
}

/**
 * Inline annotations, worst-first, capped at GitHub's 50-per-request limit.
 *
 * Only findings with a real file and line can be annotated; repository-wide
 * findings (e.g. "no tests exist") have nowhere to point and stay in the summary.
 */
export function buildAnnotations(findings: readonly Finding[]): CheckAnnotation[] {
  return [...findings]
    .filter((f): f is Finding & { filePath: string; lineStart: number } =>
      Boolean(f.filePath) && typeof f.lineStart === 'number' && f.lineStart > 0,
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, MAX_ANNOTATIONS)
    .map((finding) => ({
      path: finding.filePath,
      start_line: finding.lineStart,
      end_line: Math.max(finding.lineEnd ?? finding.lineStart, finding.lineStart),
      annotation_level: annotationLevel(finding.severity),
      title: `${finding.severity.toUpperCase()}: ${finding.title}`.slice(0, 255),
      message: buildAnnotationMessage(finding),
      // raw_details would echo evidence; omitted for secrets for the same
      // reason as in the comment.
      ...(finding.evidence && !isSecretFinding(finding)
        ? { raw_details: finding.evidence.slice(0, 500) }
        : {}),
    }));
}

function buildAnnotationMessage(finding: Finding): string {
  const parts = [finding.description];
  if (finding.whyItMatters) parts.push(`Why it matters: ${finding.whyItMatters}`);
  if (finding.remediation) parts.push(`Fix: ${finding.remediation}`);
  parts.push(`Rule: ${finding.ruleId}`);
  return parts.join('\n\n').slice(0, 64_000);
}

function annotationLevel(severity: Severity): CheckAnnotation['annotation_level'] {
  if (severity === 'critical' || severity === 'high') return 'failure';
  if (severity === 'medium' || severity === 'low') return 'warning';
  return 'notice';
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

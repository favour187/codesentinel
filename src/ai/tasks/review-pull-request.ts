import type { PullRequestRisk } from '@/guardian/risk';
import type { Finding } from '@/scanner/types';
import { runAITask } from '../router';
import type { AIResult, RouterOptions } from '../router';
import { CONFIDENCE_HINT, promptSchemaHint, PullRequestReview } from '../schemas';
import { buildUserMessage, systemPrompt } from '../prompt';
import { getMemory } from '../context';

/**
 * Item 5: AI review of a pull request.
 *
 * Runs *after* deterministic scanning and receives a compact structured
 * summary rather than the diff. Two reasons: a large diff would blow the
 * context budget on code the scanners have already analysed, and grounding the
 * review in the findings keeps the AI commenting on measured facts instead of
 * offering style opinions nobody asked for.
 *
 * The recommendation is advisory. The Check Run conclusion is decided by
 * policy and deterministic severity, never by this.
 */

export interface PullRequestReviewInput {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly pullRequestNumber: number;
  readonly title: string | null;
  readonly author: string | null;
  readonly risk: PullRequestRisk;
  readonly changedFiles: ReadonlyArray<{ path: string; additions: number; deletions: number; status: string }>;
  /** Dependency additions/removals detected in this PR. */
  readonly dependencyChanges?: readonly string[];
}

const REVIEW_HINT = promptSchemaHint({
  summary: 'string — 2-4 sentences: what this pull request changes, in plain language',
  riskAssessment: 'string — why the risk level is what it is, referring to the specific factors given',
  importantFindings: 'array of at most 5 short strings — the findings a reviewer must not miss',
  recommendedTests: 'array of at most 5 short strings — what to test before merging',
  recommendation: '"APPROVE" | "REVIEW" | "REQUEST_CHANGES"',
  confidence: CONFIDENCE_HINT,
});

const MAX_LISTED_FINDINGS = 25;
const MAX_LISTED_FILES = 40;

export async function reviewPullRequest(
  input: PullRequestReviewInput,
  options: RouterOptions & { noCache?: boolean } = {},
): Promise<AIResult<PullRequestReview>> {
  const { risk } = input;

  const memory = await getMemory(
    input.repositoryId,
    input.changedFiles.map((f) => f.path),
  );

  const sections: Array<{ label: string; content: string }> = [
    {
      label: 'PULL REQUEST',
      content: [
        `Repository: ${input.repositoryFullName}`,
        `PR #${input.pullRequestNumber}: ${input.title ?? '(no title)'}`,
        `Author: ${input.author ?? 'unknown'}`,
        `Files changed: ${input.changedFiles.length}`,
        `Lines: +${sum(input.changedFiles.map((f) => f.additions))} / -${sum(
          input.changedFiles.map((f) => f.deletions),
        )}`,
      ].join('\n'),
    },
    {
      label: 'CHANGED FILES',
      content:
        input.changedFiles
          .slice(0, MAX_LISTED_FILES)
          .map((f) => `- ${f.status} ${f.path} (+${f.additions}/-${f.deletions})`)
          .join('\n') +
        (input.changedFiles.length > MAX_LISTED_FILES
          ? `\n... and ${input.changedFiles.length - MAX_LISTED_FILES} more file(s)`
          : ''),
    },
    {
      label: 'DETERMINISTIC RISK ASSESSMENT (computed by CodeSentinel, authoritative)',
      content: [
        `Risk score: ${risk.score}/100 (${risk.level})`,
        `Blocks merge under current policy: ${risk.shouldBlock ? 'yes' : 'no'}`,
        '',
        'Contributing factors:',
        risk.factors.length > 0
          ? risk.factors.map((f) => `- ${f.label}: +${f.points} (${f.detail})`).join('\n')
          : '- none',
      ].join('\n'),
    },
    {
      label: 'NEW FINDINGS INTRODUCED BY THIS PULL REQUEST',
      content: renderFindings(risk.newFindings),
    },
    {
      label: 'BLAST RADIUS',
      content: [
        `Directly changed: ${risk.blastRadius.changedFiles.length} file(s)`,
        `Dependent files affected: ${risk.blastRadius.impactedFiles.slice(0, 20).join(', ') || 'none detected'}`,
        `Components touched: ${risk.blastRadius.affectedComponents.join(', ') || 'none detected'}`,
        `Covering tests: ${risk.blastRadius.coveringTests.slice(0, 15).join(', ') || 'none detected'}`,
        `Changed files with NO covering test: ${
          risk.blastRadius.uncoveredChanges.slice(0, 20).join(', ') || 'none'
        }`,
      ].join('\n'),
    },
  ];

  if (risk.resolvedFingerprints.length > 0) {
    sections.push({
      label: 'IMPROVEMENTS',
      content: `This pull request resolves ${risk.resolvedFingerprints.length} previously open finding(s).`,
    });
  }

  if (input.dependencyChanges && input.dependencyChanges.length > 0) {
    sections.push({ label: 'DEPENDENCY CHANGES', content: input.dependencyChanges.map((d) => `- ${d}`).join('\n') });
  }

  if (memory.length > 0) {
    sections.push({
      label: 'RECORDED TEAM DECISIONS (authoritative, written by maintainers)',
      content: memory.map((m) => `- [${m.kind}] ${m.title}: ${m.body}`).join('\n'),
    });
  }

  return runAITask(
    {
      task: 'review-pull-request',
      schema: PullRequestReview,
      system: systemPrompt({
        role: 'You write a concise review summary for a pull request, for a reviewer who has not read the diff yet.',
        rules: [
          'The deterministic risk score and findings are authoritative. Explain them; do not dispute or recalculate them.',
          'Do not comment on code you were not shown. You have a structured summary, not the diff.',
          'Be concise. This becomes a GitHub comment that must be readable in fifteen seconds.',
          'Recommend REQUEST_CHANGES only when a critical or high-severity finding was introduced, or the change is unsafe for a stated, specific reason.',
          'Recommend APPROVE only when no new findings were introduced and the risk score is low.',
          'Otherwise recommend REVIEW.',
          'Your recommendation is advisory and will be labelled as such. Never state that the pull request is blocked or approved as a matter of fact.',
          'Recommended tests must relate to what actually changed.',
        ],
        schemaHint: REVIEW_HINT,
      }),
      user: buildUserMessage(sections),
      repositoryId: input.repositoryId,
      evidenceSources: [
        `pull_request:${input.pullRequestNumber}`,
        ...input.changedFiles.slice(0, 20).map((f) => `file:${f.path}`),
      ],
      maxTokens: 1200,
      ...(options.noCache ? { noCache: true } : {}),
    },
    options,
  );
}

function renderFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No new findings were introduced.';

  const listed = findings.slice(0, MAX_LISTED_FINDINGS).map((f) => {
    // Secret findings never have their evidence forwarded, even redacted:
    // this text can end up in a public pull request comment.
    const isSecret = f.category === 'secrets' || f.ruleId.startsWith('secret/');
    const location = f.filePath ? `${f.filePath}${f.lineStart ? `:${f.lineStart}` : ''}` : 'repository-wide';
    return [
      `- [${f.severity.toUpperCase()}] ${f.title}`,
      `  rule: ${f.ruleId} | location: ${location}`,
      `  ${f.description}`,
      !isSecret && f.evidence ? `  evidence: ${f.evidence.slice(0, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  const more =
    findings.length > MAX_LISTED_FINDINGS ? `\n... and ${findings.length - MAX_LISTED_FINDINGS} more finding(s)` : '';

  return listed.join('\n') + more;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Render the AI review as a compact Markdown section for the PR comment.
 *
 * Explicitly labelled as AI-generated and advisory, and placed after the
 * deterministic results so the measured facts are what a reviewer reads first.
 */
export function renderReviewMarkdown(review: PullRequestReview, model: string): string {
  const recommendationLabel: Record<PullRequestReview['recommendation'], string> = {
    APPROVE: '✅ Approve',
    REVIEW: '👀 Review recommended',
    REQUEST_CHANGES: '🔴 Request changes',
  };

  const lines = [
    '<details>',
    `<summary><b>🤖 AI review summary</b> — ${recommendationLabel[review.recommendation]} (advisory)</summary>`,
    '',
    review.summary,
    '',
    `**Risk:** ${review.riskAssessment}`,
  ];

  if (review.importantFindings.length > 0) {
    lines.push('', '**Do not miss:**', ...review.importantFindings.map((f) => `- ${f}`));
  }

  if (review.recommendedTests.length > 0) {
    lines.push('', '**Suggested tests:**', ...review.recommendedTests.map((t) => `- ${t}`));
  }

  lines.push(
    '',
    `<sub>Generated by ${model} · confidence: ${review.confidence} · advisory only — the check result above is decided by deterministic analysis and repository policy.</sub>`,
    '',
    '</details>',
  );

  return lines.join('\n');
}

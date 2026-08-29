import { runAITask } from '../router';
import type { AIResult, RouterOptions } from '../router';
import {
  CLAIMS_HINT,
  CONFIDENCE_HINT,
  FalsePositiveAnalysis,
  FindingExplanation,
  promptSchemaHint,
} from '../schemas';
import { buildUserMessage, systemPrompt } from '../prompt';
import {
  getFileNeighbourhood,
  getFindingById,
  getFindingsForFile,
  getMemory,
  getTestsCovering,
  renderExcerpt,
  renderFileList,
  renderFindingList,
  renderMemory,
} from '../context';
import { readRepositoryFile } from '@/analysis/source';










export interface FindingEvidence {
  readonly finding: NonNullable<Awaited<ReturnType<typeof getFindingById>>>;
  readonly userMessage: string;
  readonly sources: readonly string[];
}








export async function collectFindingEvidence(findingId: string): Promise<FindingEvidence | null> {
  const finding = await getFindingById(findingId);
  if (!finding) return null;

  const sources: string[] = [`finding:${finding.id}`];
  const sections: Array<{ label: string; content: string }> = [];

  sections.push({
    label: 'FINDING (produced by CodeSentinel deterministic scanner)',
    content: [
      `Rule: ${finding.ruleId}`,
      `Scanner: ${finding.scannerId}`,
      `Severity: ${finding.severity}`,
      `Category: ${finding.category}`,
      `Scanner confidence: ${finding.confidence}`,
      `Title: ${finding.title}`,
      `Location: ${finding.filePath ?? 'not file-specific'}${
        finding.lineStart ? `:${finding.lineStart}${finding.lineEnd ? `-${finding.lineEnd}` : ''}` : ''
      }`,
      '',
      `Scanner description: ${finding.description}`,
      finding.whyItMatters ? `Scanner rationale: ${finding.whyItMatters}` : '',
      finding.remediation ? `Scanner remediation hint: ${finding.remediation}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  if (finding.filePath) {
    const file = await readRepositoryFile(finding.repositoryId, finding.filePath);
    if (file) {
      const excerpt = renderExcerpt(file.content, finding.lineStart, 30);
      sources.push(`file:${finding.filePath}`);
      sections.push({
        label: `SOURCE CODE ${finding.filePath} (lines ${excerpt.firstLine}-${excerpt.lastLine}${
          file.redacted.length > 0 ? ', secrets masked' : ''
        })`,
        content: excerpt.text,
      });
    } else if (finding.evidence) {


      sections.push({ label: 'CODE EXCERPT (captured at scan time)', content: finding.evidence });
    }

    const neighbourhood = await getFileNeighbourhood(finding.repositoryId, finding.filePath, 12);
    if (neighbourhood.file) {
      sections.push({
        label: 'FILE CONTEXT',
        content: [
          `Language: ${neighbourhood.file.language ?? 'unknown'}`,
          `Lines of code: ${neighbourhood.file.loc}`,
          `Role: ${neighbourhood.file.kind ?? 'unclassified'}`,
          `Estimated complexity: ${neighbourhood.file.complexity}`,
          '',
          'This file imports:',
          renderFileList(neighbourhood.imports),
          '',
          'Files that import this file (blast radius):',
          renderFileList(neighbourhood.dependents),
        ].join('\n'),
      });
      sources.push(...neighbourhood.dependents.slice(0, 5).map((d) => `dependent:${d.path}`));
    }

    const others = (await getFindingsForFile(finding.repositoryId, finding.filePath, 10)).filter(
      (f) => f.id !== finding.id,
    );
    if (others.length > 0) {
      sections.push({ label: 'OTHER FINDINGS IN THIS FILE', content: renderFindingList(others) });
    }

    const covering = await getTestsCovering(finding.repositoryId, finding.filePath);
    sections.push({
      label: 'TEST COVERAGE FOR THIS FILE',
      content:
        covering.length > 0
          ? covering.map((t) => `- ${t}`).join('\n')
          : 'No test file was detected that covers this file.',
    });
    if (covering.length > 0) sources.push(...covering.map((t) => `test:${t}`));
  }

  const memory = await getMemory(finding.repositoryId, finding.filePath ? [finding.filePath] : undefined);
  if (memory.length > 0) {
    sections.push({
      label: 'RECORDED TEAM DECISIONS (authoritative, written by maintainers)',
      content: renderMemory(memory),
    });
    sources.push(...memory.map((m) => `memory:${m.id}`));
  }

  return { finding, userMessage: buildUserMessage(sections), sources };
}

const EXPLANATION_HINT = promptSchemaHint({
  whatHappened: 'string — what the scanner detected, in plain language, referencing the real code',
  whyItMatters: 'string — the concrete consequence for this specific application',
  impact: 'string — what an attacker or a failure could actually achieve here',
  remediation: 'string — specific, actionable steps for this code (not generic advice)',
  confidence: CONFIDENCE_HINT,
  claims: CLAIMS_HINT,
});

export async function explainFinding(
  findingId: string,
  options: RouterOptions & { noCache?: boolean } = {},
): Promise<AIResult<FindingExplanation>> {
  const evidence = await collectFindingEvidence(findingId);
  if (!evidence) {
    return { ok: false, reason: 'failed', message: 'Finding not found.' };
  }

  return runAITask(
    {
      task: 'explain-finding',
      schema: FindingExplanation,
      system: systemPrompt({
        role: 'You explain a single code finding to the developer who owns this repository.',
        rules: [
          'Explain THIS finding in THIS code. Do not give a generic description of the vulnerability class.',
          'Reference only file paths, line numbers, functions and tests that appear in the evidence.',
          'If a recorded team decision covers this finding, take it into account and say so.',
          'Remediation must be specific enough to act on without further research, and must fit the language and framework shown.',
          'Set confidence to "low" when the evidence is thin, truncated, or the surrounding context is missing.',
          'Label each claim: FACT for what the scanner and code directly show, INFERENCE for reasoning, RECOMMENDATION for suggested actions.',
        ],
        schemaHint: EXPLANATION_HINT,
      }),
      user: evidence.userMessage,
      repositoryId: evidence.finding.repositoryId,
      findingId: evidence.finding.id,
      evidenceSources: evidence.sources,
      maxTokens: 1400,
      ...(options.noCache ? { noCache: true } : {}),
    },
    options,
  );
}

const FALSE_POSITIVE_HINT = promptSchemaHint({
  verdict: '"LIKELY_TRUE" | "POSSIBLE" | "LIKELY_FALSE_POSITIVE"',
  reasoning: 'string — why, referring to specific evidence',
  evidence: 'array of at most 6 short strings, each a concrete observation from the code',
  confidence: CONFIDENCE_HINT,
});








export async function analyzeFalsePositive(
  findingId: string,
  options: RouterOptions & { noCache?: boolean } = {},
): Promise<AIResult<FalsePositiveAnalysis>> {
  const evidence = await collectFindingEvidence(findingId);
  if (!evidence) {
    return { ok: false, reason: 'failed', message: 'Finding not found.' };
  }

  return runAITask(
    {
      task: 'false-positive-analysis',
      schema: FalsePositiveAnalysis,
      system: systemPrompt({
        role: 'You assess whether a static-analysis finding is a true positive or a false positive.',
        rules: [
          'Base the verdict only on the evidence shown. Absence of context is not evidence that the finding is wrong.',
          'Consider: is the flagged value actually reachable, is input actually untrusted, is there mitigation nearby, is this test or fixture code, is it a documented intentional exception.',
          'Use LIKELY_FALSE_POSITIVE only when the evidence positively shows the finding does not apply — not merely because you are unsure.',
          'Use POSSIBLE when it depends on context you cannot see.',
          'Every entry in evidence must be an observation about the supplied code, not a general statement.',
          'This assessment is advisory. A human decides. Never state that the finding has been dismissed or resolved.',
        ],
        schemaHint: FALSE_POSITIVE_HINT,
      }),
      user: evidence.userMessage,
      repositoryId: evidence.finding.repositoryId,
      findingId: evidence.finding.id,
      evidenceSources: evidence.sources,
      maxTokens: 900,
      ...(options.noCache ? { noCache: true } : {}),
    },
    options,
  );
}

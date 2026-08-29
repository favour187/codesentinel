import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { fixes } from '@/db/schema';
import { createUnifiedDiff, DiffError, validatePatch } from '@/analysis/diff';
import type { UnifiedDiff } from '@/analysis/diff';
import { readRepositoryFile } from '@/analysis/source';
import { createLogger } from '@/lib/logger';
import { runAITask } from '../router';
import type { RouterOptions } from '../router';
import { CONFIDENCE_HINT, GeneratedFix, promptSchemaHint } from '../schemas';
import { systemPrompt } from '../prompt';
import { collectFindingEvidence } from './explain-finding';
import { detectTestFramework, getTestsCovering } from '../context';
















const log = createLogger('ai:fix');

export interface FixProposal {
  readonly fixId: string;
  readonly findingId: string;
  readonly title: string;
  readonly explanation: string;
  readonly filePath: string;
  readonly originalCode: string;
  readonly fixedCode: string;
  readonly diff: UnifiedDiff;
  readonly patchedContent: string;
  readonly risks: readonly string[];
  readonly testsToRun: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';

  readonly warnings: readonly string[];
  readonly provider: string;
  readonly model: string;
}

export type FixResult =
  | { readonly ok: true; readonly fix: FixProposal }
  | { readonly ok: false; readonly reason: 'unavailable' | 'failed' | 'invalid' | 'ungrounded'; readonly message: string };

const FIX_HINT = promptSchemaHint({
  title: 'string — short imperative summary, e.g. "Use a parameterised query in getUserById"',
  explanation: 'string — what the change does and why it resolves the finding',
  filePath: 'string — the exact path from the evidence, unchanged',
  originalCode:
    'string — the EXACT lines from the supplied source that must be replaced, copied character for character including indentation. Keep it as small as possible while still being unique in the file.',
  fixedCode: 'string — the replacement lines, complete and syntactically valid',
  risks: 'array of at most 5 short strings describing what could break',
  testsToRun: 'array of at most 5 test file paths or commands from the evidence',
  confidence: CONFIDENCE_HINT,
});

export async function generateFix(
  findingId: string,
  options: RouterOptions & { noCache?: boolean } = {},
): Promise<FixResult> {
  const evidence = await collectFindingEvidence(findingId);
  if (!evidence) return { ok: false, reason: 'failed', message: 'Finding not found.' };

  const { finding } = evidence;
  if (!finding.filePath) {
    return {
      ok: false,
      reason: 'failed',
      message: 'This finding is not tied to a specific file, so no code fix can be generated.',
    };
  }


  const file = await readRepositoryFile(finding.repositoryId, finding.filePath);
  if (!file) {
    return {
      ok: false,
      reason: 'failed',
      message:
        'The current contents of this file could not be read, so a fix cannot be verified against real code.',
    };
  }

  const framework = await detectTestFramework(finding.repositoryId);
  const covering = await getTestsCovering(finding.repositoryId, finding.filePath);

  const userMessage = [
    evidence.userMessage,
    '',
    `--- BEGIN FULL CURRENT FILE ${finding.filePath} ---`,
    file.content,
    `--- END FULL CURRENT FILE ${finding.filePath} ---`,
    '',
    `--- BEGIN PROJECT CONVENTIONS ---`,
    `Test framework in use: ${framework ?? 'none detected'}`,
    `Tests covering this file: ${covering.length > 0 ? covering.join(', ') : 'none detected'}`,
    `--- END PROJECT CONVENTIONS ---`,
  ].join('\n');

  const result = await runAITask(
    {
      task: 'generate-fix',
      schema: GeneratedFix,
      system: systemPrompt({
        role: 'You propose a minimal, correct code change that resolves a specific security or quality finding.',
        rules: [
          'originalCode MUST be copied verbatim from the supplied file content. If you cannot copy it exactly, you cannot propose a fix.',
          'Keep the change minimal. Do not reformat, rename, reorder imports, or "improve" unrelated code.',
          'Match the existing language, framework, style and error-handling conventions visible in the file.',
          'The fixedCode must be complete and syntactically valid on its own — never abbreviate with comments like "... rest unchanged".',
          'Never introduce a hardcoded credential, and never leave a placeholder the developer must fill in.',
          'If the correct fix requires changes in more than one file, fix the primary file and note the rest under risks.',
          'If the evidence is insufficient to write a safe fix, set confidence to "low" and explain the gap in the explanation.',
        ],
        schemaHint: FIX_HINT,
      }),
      user: userMessage,
      repositoryId: finding.repositoryId,
      findingId: finding.id,
      evidenceSources: [...evidence.sources, `source:${finding.filePath}`],
      maxTokens: 2000,
      ...(options.noCache ? { noCache: true } : {}),
    },
    options,
  );

  if (!result.ok) return { ok: false, reason: result.reason, message: result.message };

  const proposed = result.data;





  if (proposed.filePath !== finding.filePath) {
    log.warn('Rejected fix targeting a different file', {
      findingId,
      expected: finding.filePath,
      received: proposed.filePath,
    });
    return {
      ok: false,
      reason: 'ungrounded',
      message: `The generated fix targeted ${proposed.filePath}, but the finding is in ${finding.filePath}. It was rejected.`,
    };
  }

  let diff: UnifiedDiff;
  let patched: string;
  try {
    const built = createUnifiedDiff({
      path: finding.filePath,
      content: file.content,
      originalCode: proposed.originalCode,
      fixedCode: proposed.fixedCode,
    });
    diff = built.diff;
    patched = built.patched;
  } catch (err) {
    if (err instanceof DiffError) {
      log.warn('Generated fix did not apply to the real file', { findingId, error: err.message });
      return { ok: false, reason: 'ungrounded', message: err.message };
    }
    throw err;
  }

  const validation = validatePatch({
    originalContent: file.content,
    patchedContent: patched,
    path: finding.filePath,
  });






  const db = await getDb();
  const [row] = await db
    .insert(fixes)
    .values({
      findingId: finding.id,
      repositoryId: finding.repositoryId,
      origin: 'ai',
      status: 'proposed',
      title: proposed.title,
      explanation: proposed.explanation,
      patch: diff.text,
      originalCode: proposed.originalCode,
      fixedCode: proposed.fixedCode,
    })
    .returning();

  if (!row) {
    return { ok: false, reason: 'failed', message: 'The fix could not be saved.' };
  }

  log.info('Fix proposed', {
    findingId,
    fixId: row.id,
    provider: result.provider,
    warnings: validation.problems.length,
  });

  return {
    ok: true,
    fix: {
      fixId: row.id,
      findingId: finding.id,
      title: proposed.title,
      explanation: proposed.explanation,
      filePath: finding.filePath,
      originalCode: proposed.originalCode,
      fixedCode: proposed.fixedCode,
      diff,
      patchedContent: patched,
      risks: proposed.risks,
      testsToRun: proposed.testsToRun.length > 0 ? proposed.testsToRun : covering,
      confidence: proposed.confidence,
      warnings: validation.problems,
      provider: result.provider,
      model: result.model,
    },
  };
}


export async function listFixesForFinding(findingId: string) {
  const db = await getDb();
  return db.select().from(fixes).where(eq(fixes.findingId, findingId));
}

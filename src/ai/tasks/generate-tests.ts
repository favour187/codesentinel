import { readRepositoryFile } from '@/analysis/source';
import { runAITask } from '../router';
import type { AIResult, RouterOptions } from '../router';
import { GeneratedTests, promptSchemaHint } from '../schemas';
import { buildUserMessage, systemPrompt } from '../prompt';
import { collectFindingEvidence } from './explain-finding';
import { detectTestFramework, getTestsCovering } from '../context';

/**
 * Item 4: regression test generation.
 *
 * Generated tests are *proposals*. CodeSentinel never claims they pass — it
 * has not run them. The UI says "generated, not yet run", and the demo flow
 * only reports a pass after the developer actually executes them.
 */

const TESTS_HINT = promptSchemaHint({
  framework: 'string — the test framework, exactly as given in the evidence',
  filePath: 'string — where this test file should live, following the conventions visible in the evidence',
  code: 'string — the complete test file, ready to run, including imports',
  cases:
    'array of at most 8 objects {"name": string, "kind": "unit" | "edge" | "negative" | "regression"} describing each test',
  notes: 'string — anything the developer must set up for these tests to run, or "" if nothing',
});

export interface TestGenerationOptions extends RouterOptions {
  readonly noCache?: boolean;
  /** Include the proposed fix so the test targets the fixed behaviour. */
  readonly fixedCode?: string;
}

export async function generateTestsForFinding(
  findingId: string,
  options: TestGenerationOptions = {},
): Promise<AIResult<GeneratedTests>> {
  const evidence = await collectFindingEvidence(findingId);
  if (!evidence) return { ok: false, reason: 'failed', message: 'Finding not found.' };

  const { finding } = evidence;
  const framework = await detectTestFramework(finding.repositoryId);

  /*
   * Without a detected framework we would be guessing between Jest, Vitest,
   * Mocha and Pytest — and a test file in the wrong framework is worse than
   * none, because it fails for reasons unrelated to the code.
   */
  if (!framework) {
    return {
      ok: false,
      reason: 'failed',
      message:
        'No test framework was detected in this repository, so tests cannot be generated in a matching style. Add a test setup first.',
    };
  }

  const sections: Array<{ label: string; content: string }> = [
    { label: 'FINDING AND CODE CONTEXT', content: evidence.userMessage },
  ];

  const existingTests = finding.filePath ? await getTestsCovering(finding.repositoryId, finding.filePath) : [];

  /*
   * An existing test file is the single most useful piece of context: it shows
   * the import style, the helpers, the assertion library and the naming the
   * project actually uses, so the generated file fits in instead of merely
   * being valid.
   */
  if (existingTests[0]) {
    const example = await readRepositoryFile(finding.repositoryId, existingTests[0]);
    if (example) {
      sections.push({
        label: `EXISTING TEST FILE ${existingTests[0]} (follow these conventions)`,
        content: example.content.slice(0, 6000),
      });
    }
  }

  if (options.fixedCode) {
    sections.push({
      label: 'PROPOSED FIXED CODE (the tests must pass against this)',
      content: options.fixedCode,
    });
  }

  sections.push({
    label: 'TEST REQUIREMENTS',
    content: [
      `Framework: ${framework}`,
      `Existing tests covering this file: ${existingTests.length > 0 ? existingTests.join(', ') : 'none'}`,
      '',
      'Required coverage:',
      '- a regression test that fails on the vulnerable/incorrect behaviour and passes once fixed',
      '- at least one negative test (invalid or malicious input)',
      '- at least one edge case (empty, null, boundary values)',
      '- unit tests for the normal expected behaviour',
    ].join('\n'),
  });

  return runAITask(
    {
      task: 'generate-tests',
      schema: GeneratedTests,
      system: systemPrompt({
        role: 'You write regression tests that prove a specific finding is fixed and stays fixed.',
        rules: [
          `Use ${framework} and only ${framework}. Do not mix in another framework's API.`,
          'Import only from paths shown in the evidence. Never invent a module, helper or fixture.',
          'The regression test must specifically exercise the behaviour described in the finding — not a generic smoke test.',
          'Tests must be deterministic: no real network calls, no real filesystem writes outside a temp dir, no dependence on wall-clock time.',
          'Write the complete file. It must run as-is.',
          'If setup is required that you cannot see (a database, an env var, a fixture), state it in notes rather than inventing it.',
          'Never assert that these tests have already been run or that they pass.',
        ],
        schemaHint: TESTS_HINT,
      }),
      user: buildUserMessage(sections),
      repositoryId: finding.repositoryId,
      findingId: finding.id,
      evidenceSources: [...evidence.sources, ...existingTests.map((t) => `test:${t}`)],
      maxTokens: 2500,
      ...(options.noCache ? { noCache: true } : {}),
    },
    options,
  );
}

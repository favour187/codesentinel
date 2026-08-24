import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixes } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { AICompletion, AICompletionRequest, AIProvider } from '@/ai/provider';
import { analyzeFalsePositive, collectFindingEvidence, explainFinding } from '@/ai/tasks/explain-finding';
import { generateFix } from '@/ai/tasks/generate-fix';
import { generateTestsForFinding } from '@/ai/tasks/generate-tests';
import { reviewPullRequest, renderReviewMarkdown } from '@/ai/tasks/review-pull-request';
import { askCodebase, extractKeywords, retrieveRelevantFiles } from '@/ai/tasks/codebase-chat';
import { createTestDb, seedRepository, seedScan } from '../helpers/test-db';
import type { TestDb } from '../helpers/test-db';

/**
 * End-to-end tests for the AI task layer with stubbed providers.
 *
 * The point of these is not that the model says something sensible — it is
 * that the surrounding machinery refuses to pass off ungrounded output as
 * real: fixes that do not apply are rejected, cited files that were not
 * supplied are dropped, and every response is schema-validated.
 */

let db: TestDb;
let repositoryId: string;

vi.mock('@/db', async () => {
  const actual = await vi.importActual<typeof import('@/db')>('@/db');
  return { ...actual, getDb: async () => db };
});

/** The real file that the demo fixture and these tests analyse. */
const VULNERABLE_SOURCE = [
  'const express = require("express");',
  'const db = require("./db");',
  '',
  'app.get("/users/:id", async (req, res) => {',
  '  const query = "SELECT * FROM users WHERE id = " + req.params.id;',
  '  const rows = await db.raw(query);',
  '  res.json(rows);',
  '});',
].join('\n');

vi.mock('@/analysis/source', async () => {
  const actual = await vi.importActual<typeof import('@/analysis/source')>('@/analysis/source');
  return {
    ...actual,
    readRepositoryFile: async (_repositoryId: string, path: string) =>
      path === 'src/routes/users.js'
        ? { path, content: VULNERABLE_SOURCE, truncated: false, redacted: [] }
        : null,
  };
});

class ScriptedProvider implements AIProvider {
  readonly id = 'featherless';
  readonly model = 'test-model';
  readonly prompts: AICompletionRequest[] = [];

  constructor(private readonly payload: string) {}

  isAvailable(): boolean {
    return true;
  }

  async complete(request: AICompletionRequest): Promise<AICompletion> {
    this.prompts.push(request);
    return {
      text: this.payload,
      model: this.model,
      provider: this.id,
      promptTokens: 200,
      completionTokens: 50,
      latencyMs: 3,
    };
  }
}

class DeadProvider implements AIProvider {
  readonly id = 'featherless';
  readonly model = 'test-model';

  isAvailable(): boolean {
    return false;
  }

  async complete(): Promise<AICompletion> {
    throw new Error('should never be called');
  }
}

async function seedVulnerableRepo() {
  const seeded = await seedScan(db, repositoryId, {
    files: [
      { path: 'src/routes/users.js', language: 'javascript', loc: 8, imports: ['src/db.js'], kind: 'route' },
      { path: 'src/db.js', language: 'javascript', loc: 30, imports: [] },
    ],
    findings: [
      {
        ruleId: 'security/sql-injection',
        severity: 'critical',
        title: 'SQL injection via string concatenation',
        filePath: 'src/routes/users.js',
        lineStart: 5,
        lineEnd: 5,
        evidence: 'const query = "SELECT * FROM users WHERE id = " + req.params.id;',
      },
    ],
    tests: [{ filePath: 'tests/users.test.js', framework: 'jest', coversPaths: ['src/routes/users.js'] }],
  });

  return seeded;
}

beforeEach(async () => {
  db = await createTestDb();
  ({ repositoryId } = await seedRepository(db, { fullName: 'acme/shop' }));
});

describe('collectFindingEvidence', () => {
  it('assembles finding, source, neighbourhood and coverage', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const evidence = await collectFindingEvidence(findingIds[0]!);

    expect(evidence).not.toBeNull();
    expect(evidence?.userMessage).toContain('security/sql-injection');
    expect(evidence?.userMessage).toContain('SELECT * FROM users');
    expect(evidence?.userMessage).toContain('tests/users.test.js');
    expect(evidence?.sources).toContain('file:src/routes/users.js');
  });

  it('returns null for an unknown finding', async () => {
    expect(await collectFindingEvidence('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('explainFinding', () => {
  const validResponse = JSON.stringify({
    whatHappened: 'Request input is concatenated into a SQL string.',
    whyItMatters: 'An attacker can read or modify any row.',
    impact: 'Full database disclosure through /users/:id.',
    remediation: 'Use a parameterised query with a bound parameter.',
    confidence: 'high',
    claims: [{ kind: 'FACT', text: 'req.params.id is concatenated into the query' }],
  });

  it('returns a structured explanation', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(validResponse);

    const result = await explainFinding(findingIds[0]!, { providers: [provider] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.whatHappened).toContain('concatenated');
    expect(result.data.confidence).toBe('high');
    expect(result.data.claims[0]?.kind).toBe('FACT');
  });

  it('grounds the prompt in the real file content', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(validResponse);

    await explainFinding(findingIds[0]!, { providers: [provider] });

    const userMessage = provider.prompts[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('req.params.id');
    expect(userMessage).toContain('src/routes/users.js');
  });

  it('instructs the model to treat repository content as data', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(validResponse);

    await explainFinding(findingIds[0]!, { providers: [provider] });

    const system = provider.prompts[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toMatch(/UNTRUSTED DATA/i);
    expect(system).toMatch(/never invent/i);
  });

  it('rejects a response missing required fields', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(JSON.stringify({ whatHappened: 'partial' }));

    const result = await explainFinding(findingIds[0]!, { providers: [provider] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('invalid');
  });

  it('degrades to unavailable with no provider configured', async () => {
    const { findingIds } = await seedVulnerableRepo();

    const result = await explainFinding(findingIds[0]!, { providers: [new DeadProvider()] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('unavailable');
  });

  it('fails cleanly for a finding that does not exist', async () => {
    const result = await explainFinding('00000000-0000-0000-0000-000000000000', {
      providers: [new ScriptedProvider(validResponse)],
    });

    expect(result.ok).toBe(false);
  });
});

describe('analyzeFalsePositive', () => {
  it('returns a verdict with evidence', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({
        verdict: 'LIKELY_TRUE',
        reasoning: 'req.params.id is attacker-controlled and reaches db.raw unescaped.',
        evidence: ['req.params.id flows directly into the query string'],
        confidence: 'high',
      }),
    );

    const result = await analyzeFalsePositive(findingIds[0]!, { providers: [provider] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.verdict).toBe('LIKELY_TRUE');
    expect(result.data.evidence).toHaveLength(1);
  });

  it('rejects a verdict outside the allowed set', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({ verdict: 'DEFINITELY_FAKE', reasoning: 'x', evidence: [], confidence: 'high' }),
    );

    const result = await analyzeFalsePositive(findingIds[0]!, { providers: [provider] });
    expect(result.ok).toBe(false);
  });

  it('never changes the finding status by itself', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({
        verdict: 'LIKELY_FALSE_POSITIVE',
        reasoning: 'looks like test code',
        evidence: [],
        confidence: 'low',
      }),
    );

    await analyzeFalsePositive(findingIds[0]!, { providers: [provider] });

    const finding = await db.query.findings.findFirst();
    expect(finding?.status).toBe('open');
  });
});

describe('generateFix', () => {
  const goodFix = JSON.stringify({
    title: 'Use a parameterised query',
    explanation: 'Binds the id instead of concatenating it.',
    filePath: 'src/routes/users.js',
    originalCode: '  const query = "SELECT * FROM users WHERE id = " + req.params.id;\n  const rows = await db.raw(query);',
    fixedCode: '  const query = "SELECT * FROM users WHERE id = ?";\n  const rows = await db.raw(query, [req.params.id]);',
    risks: ['db.raw must support bound parameters'],
    testsToRun: ['tests/users.test.js'],
    confidence: 'high',
  });

  it('produces a verified diff and stores the fix as proposed', async () => {
    const { findingIds } = await seedVulnerableRepo();

    const result = await generateFix(findingIds[0]!, { providers: [new ScriptedProvider(goodFix)] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');

    expect(result.fix.diff.text).toContain('--- a/src/routes/users.js');
    expect(result.fix.diff.text).toContain('+  const query = "SELECT * FROM users WHERE id = ?";');
    expect(result.fix.patchedContent).toContain('[req.params.id]');
    expect(result.fix.warnings).toEqual([]);

    const [row] = await db.select().from(fixes).where(eq(fixes.findingId, findingIds[0]!));
    expect(row?.status).toBe('proposed');
    expect(row?.origin).toBe('ai');
  });

  it('REJECTS a fix whose original code is not in the real file', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const hallucinated = JSON.stringify({
      title: 'Fix the ORM call',
      explanation: 'x',
      filePath: 'src/routes/users.js',
      originalCode: 'const user = await User.findOne({ where: { id: req.params.id } });',
      fixedCode: 'const user = await User.findByPk(req.params.id);',
      risks: [],
      testsToRun: [],
      confidence: 'high',
    });

    const result = await generateFix(findingIds[0]!, { providers: [new ScriptedProvider(hallucinated)] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('ungrounded');

    // Nothing ungrounded may be persisted for a reviewer to act on.
    const rows = await db.select().from(fixes);
    expect(rows).toHaveLength(0);
  });

  it('rejects a fix that targets a different file than the finding', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const wrongFile = JSON.stringify({
      title: 'Fix elsewhere',
      explanation: 'x',
      filePath: 'src/db.js',
      originalCode: 'const query = "SELECT"',
      fixedCode: 'const query = "SELECT ?"',
      risks: [],
      testsToRun: [],
      confidence: 'high',
    });

    const result = await generateFix(findingIds[0]!, { providers: [new ScriptedProvider(wrongFile)] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('ungrounded');
    expect(result.message).toContain('src/db.js');
  });

  it('never marks a fix as applied', async () => {
    const { findingIds } = await seedVulnerableRepo();
    await generateFix(findingIds[0]!, { providers: [new ScriptedProvider(goodFix)] });

    const [row] = await db.select().from(fixes);
    expect(row?.appliedAt).toBeNull();
    expect(row?.approvedAt).toBeNull();
    expect(row?.approvedByUserId).toBeNull();
  });

  it('degrades when AI is unavailable', async () => {
    const { findingIds } = await seedVulnerableRepo();

    const result = await generateFix(findingIds[0]!, { providers: [new DeadProvider()] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('unavailable');
  });

  it('refuses when the finding has no file', async () => {
    const { findingIds } = await seedScan(db, repositoryId, {
      findings: [{ filePath: null, title: 'Repository-wide issue' }],
    });

    const result = await generateFix(findingIds[0]!, { providers: [new ScriptedProvider(goodFix)] });
    expect(result.ok).toBe(false);
  });
});

describe('generateTestsForFinding', () => {
  it('generates tests in the detected framework', async () => {
    const { findingIds } = await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({
        framework: 'jest',
        filePath: 'tests/users.regression.test.js',
        code: "test('rejects injection', () => { expect(1).toBe(1); });",
        cases: [{ name: 'rejects injection', kind: 'regression' }],
        notes: '',
      }),
    );

    const result = await generateTestsForFinding(findingIds[0]!, { providers: [provider] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.framework).toBe('jest');
    expect(result.data.cases[0]?.kind).toBe('regression');

    // The detected framework must be stated in the prompt, not guessed.
    const user = provider.prompts[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('jest');
  });

  it('refuses when no test framework was detected, rather than guessing one', async () => {
    const { findingIds } = await seedScan(db, repositoryId, {
      files: [{ path: 'src/a.ts' }],
      findings: [{ filePath: 'src/a.ts' }],
    });

    const result = await generateTestsForFinding(findingIds[0]!, {
      providers: [new ScriptedProvider('{}')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toMatch(/no test framework/i);
  });
});

describe('reviewPullRequest', () => {
  const risk = {
    score: 62,
    level: 'high' as const,
    factors: [{ id: 'new-findings', label: 'New findings', points: 30, detail: '1 critical' }],
    blastRadius: {
      changedFiles: ['src/routes/users.js'],
      impactedFiles: ['src/api/index.js'],
      affectedComponents: ['routes'],
      coveringTests: [],
      uncoveredChanges: ['src/routes/users.js'],
    },
    newFindings: [
      {
        fingerprint: 'fp1',
        ruleId: 'security/sql-injection',
        scannerId: 'security',
        severity: 'critical' as const,
        category: 'security' as const,
        title: 'SQL injection',
        description: 'Concatenated query',
        filePath: 'src/routes/users.js',
        lineStart: 5,
        lineEnd: 5,
        evidence: 'const query = "SELECT ..." + req.params.id',
        confidence: 0.9,
        whyItMatters: 'db compromise',
        remediation: 'parameterise',
        references: [],
        relatedTests: [],
        metadata: {},
      },
    ],
    resolvedFingerprints: [],
    shouldBlock: true,
    recommendedTests: [],
    summary: 'High risk',
  };

  const reviewResponse = JSON.stringify({
    summary: 'Adds a user lookup endpoint that builds SQL by concatenation.',
    riskAssessment: 'A critical injection was introduced in a route with no tests.',
    importantFindings: ['SQL injection in src/routes/users.js'],
    recommendedTests: ['Injection regression test for /users/:id'],
    recommendation: 'REQUEST_CHANGES',
    confidence: 'high',
  });

  it('summarises a pull request from the deterministic risk assessment', async () => {
    const provider = new ScriptedProvider(reviewResponse);

    const result = await reviewPullRequest(
      {
        repositoryId,
        repositoryFullName: 'acme/shop',
        pullRequestNumber: 7,
        title: 'Add user endpoint',
        author: 'dev',
        risk,
        changedFiles: [{ path: 'src/routes/users.js', additions: 8, deletions: 0, status: 'added' }],
      },
      { providers: [provider] },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.recommendation).toBe('REQUEST_CHANGES');

    const user = provider.prompts[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('62/100');
    expect(user).toContain('SQL injection');
  });

  it('never forwards secret-finding evidence into a public comment', async () => {
    const provider = new ScriptedProvider(reviewResponse);
    const secretRisk = {
      ...risk,
      newFindings: [
        {
          ...risk.newFindings[0]!,
          ruleId: 'secret/aws-key',
          category: 'secrets' as const,
          title: 'Hardcoded AWS key',
          evidence: 'AKIAIOSFODNN7EXAMPLE',
        },
      ],
    };

    await reviewPullRequest(
      {
        repositoryId,
        repositoryFullName: 'acme/shop',
        pullRequestNumber: 8,
        title: 'oops',
        author: 'dev',
        risk: secretRisk,
        changedFiles: [{ path: '.env', additions: 1, deletions: 0, status: 'added' }],
      },
      { providers: [provider] },
    );

    const user = provider.prompts[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Hardcoded AWS key');
    expect(user).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('renders an advisory, clearly-labelled Markdown block', () => {
    const markdown = renderReviewMarkdown(
      {
        summary: 'Adds an endpoint.',
        riskAssessment: 'Critical injection.',
        importantFindings: ['SQL injection'],
        recommendedTests: ['Injection test'],
        recommendation: 'REQUEST_CHANGES',
        confidence: 'high',
      },
      'test-model',
    );

    expect(markdown).toContain('AI review summary');
    expect(markdown).toMatch(/advisory/i);
    expect(markdown).toContain('test-model');
    expect(markdown).toContain('SQL injection');
  });
});

describe('codebase chat', () => {
  it('extracts meaningful keywords and drops stopwords', () => {
    const keywords = extractKeywords('How does authentication work in this codebase?');

    expect(keywords).toContain('authentication');
    expect(keywords).toContain('work');
    expect(keywords).not.toContain('how');
    expect(keywords).not.toContain('this');
    expect(keywords).not.toContain('codebase');
  });

  it('retrieves files matching the question', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/auth/session.ts', exports: ['createSession'] },
        { path: 'src/utils/format.ts', exports: ['formatDate'] },
        { path: 'src/auth/oauth.ts', exports: ['startOAuth'] },
      ],
    });

    const files = await retrieveRelevantFiles(repositoryId, 'how does auth work');

    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.path).toMatch(/auth/);
  });

  it('falls back to structurally important files when nothing matches', async () => {
    await seedScan(db, repositoryId, {
      files: [
        { path: 'src/lib/core.ts', imports: [] },
        { path: 'src/a.ts', imports: ['src/lib/core.ts'] },
        { path: 'src/b.ts', imports: ['src/lib/core.ts'] },
      ],
    });

    const files = await retrieveRelevantFiles(repositoryId, 'quantum entanglement widgets');

    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.path).toBe('src/lib/core.ts');
  });

  it('answers from retrieved evidence and reports its sources', async () => {
    await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({
        answer: 'The users route in src/routes/users.js queries the database directly.',
        relevantFiles: ['src/routes/users.js'],
        confidence: 'medium',
        claims: [{ kind: 'FACT', text: 'src/routes/users.js calls db.raw' }],
      }),
    );

    const result = await askCodebase(repositoryId, 'How are users looked up?', { providers: [provider] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.relevantFiles).toContain('src/routes/users.js');
    expect(result.sources?.files).toContain('src/routes/users.js');
  });

  it('drops cited files that were never supplied as evidence', async () => {
    await seedVulnerableRepo();
    const provider = new ScriptedProvider(
      JSON.stringify({
        answer: 'Authentication is handled in src/auth/magic.ts.',
        relevantFiles: ['src/auth/magic.ts', 'src/routes/users.js'],
        confidence: 'high',
        claims: [],
      }),
    );

    const result = await askCodebase(repositoryId, 'How are users looked up?', { providers: [provider] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    // The invented path must not be presented to the user as a citation.
    expect(result.data.relevantFiles).not.toContain('src/auth/magic.ts');
  });

  it('refuses to answer before a scan exists', async () => {
    const result = await askCodebase(repositoryId, 'What does this do?', {
      providers: [new ScriptedProvider('{}')],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toMatch(/not been scanned/i);
  });

  it('rejects a trivially short question', async () => {
    await seedVulnerableRepo();
    const result = await askCodebase(repositoryId, 'hi', { providers: [new ScriptedProvider('{}')] });
    expect(result.ok).toBe(false);
  });
});

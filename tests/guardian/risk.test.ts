import { describe, it, expect } from 'vitest';
import { assessPullRequestRisk } from '@/guardian/risk';
import type { AssessRiskInput } from '@/guardian/risk';
import type { Finding } from '@/scanner/types';
import type { PullRequestFile } from '@/github/client';
import type { Severity } from '@/db/schema';

function file(filename: string, changes = 10, status: PullRequestFile['status'] = 'modified'): PullRequestFile {
  return { filename, status, additions: changes, deletions: 0, changes };
}

function finding(severity: Severity, filePath = 'src/app.ts', ruleId = 'test/rule'): Finding {
  return {
    fingerprint: `${ruleId}:${filePath}:${severity}:${Math.random()}`,
    ruleId,
    scannerId: 'test',
    severity,
    category: 'security',
    title: `${severity} issue`,
    description: 'description',
    filePath,
    lineStart: 12,
    lineEnd: 12,
    evidence: 'evidence',
    confidence: 0.9,
    whyItMatters: 'matters',
    remediation: 'fix it',
    references: [],
    relatedTests: [],
    metadata: {},
  };
}

function assess(overrides: Partial<AssessRiskInput> = {}) {
  return assessPullRequestRisk({
    files: [file('src/app.ts')],
    newFindings: [],
    resolvedFingerprints: [],
    ...overrides,
  });
}

describe('assessPullRequestRisk — baseline behaviour', () => {
  it('gives a trivial clean change a low score', () => {
    const risk = assess({ files: [file('README.md', 3)] });
    expect(risk.score).toBeLessThan(10);
    expect(risk.level).toBe('info');
    expect(risk.shouldBlock).toBe(false);
  });

  it('never returns a score outside 0..100', () => {
    const risk = assess({
      files: Array.from({ length: 60 }, (_, i) => file(`src/auth/module-${i}.ts`, 900)),
      newFindings: Array.from({ length: 40 }, () => finding('critical')),
    });
    expect(risk.score).toBeGreaterThanOrEqual(0);
    expect(risk.score).toBeLessThanOrEqual(100);
  });

  it('is deterministic — the same input always produces the same score', () => {
    const input: AssessRiskInput = {
      files: [file('src/auth/session.ts', 40), file('src/api/routes.ts', 20)],
      newFindings: [finding('high'), finding('medium')],
      resolvedFingerprints: ['abc'],
    };
    const first = assessPullRequestRisk(input);
    const second = assessPullRequestRisk(input);
    expect(second.score).toBe(first.score);
    expect(second.level).toBe(first.level);
  });
});

describe('assessPullRequestRisk — findings drive risk', () => {
  it('scores a critical finding far above a low one', () => {
    const critical = assess({ newFindings: [finding('critical')] });
    const low = assess({ newFindings: [finding('low')] });
    expect(critical.score).toBeGreaterThan(low.score * 3);
  });

  it('escalates the level as severity increases', () => {
    const levels = (['info', 'low', 'medium', 'high', 'critical'] as Severity[]).map(
      (s) => assess({ newFindings: [finding(s)] }).score,
    );

    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    }
  });

  it('damps repeated findings of the same severity rather than scaling linearly', () => {
    const one = assess({ newFindings: [finding('medium')] });
    const nine = assess({ newFindings: Array.from({ length: 9 }, () => finding('medium')) });

    expect(nine.score).toBeGreaterThan(one.score);
    expect(nine.score).toBeLessThan(one.score * 9);
  });

  it('credits resolved findings by lowering the score', () => {
    const withoutFixes = assess({ newFindings: [finding('medium')] });
    const withFixes = assess({
      newFindings: [finding('medium')],
      resolvedFingerprints: ['a', 'b', 'c', 'd'],
    });
    expect(withFixes.score).toBeLessThan(withoutFixes.score);
  });
});

describe('assessPullRequestRisk — blocking policy', () => {
  it('blocks when a new finding meets the configured threshold', () => {
    const risk = assess({ newFindings: [finding('high')], failOnSeverity: 'high' });
    expect(risk.shouldBlock).toBe(true);
  });

  it('does not block when findings sit below the threshold', () => {
    const risk = assess({ newFindings: [finding('medium'), finding('low')], failOnSeverity: 'high' });
    expect(risk.shouldBlock).toBe(false);
  });

  it('blocks a single critical even inside an otherwise tiny clean diff', () => {

    const risk = assess({
      files: [file('src/config.ts', 2)],
      newFindings: [finding('critical')],
      failOnSeverity: 'critical',
    });
    expect(risk.shouldBlock).toBe(true);
  });

  it('respects a stricter policy of failing on medium', () => {
    const risk = assess({ newFindings: [finding('medium')], failOnSeverity: 'medium' });
    expect(risk.shouldBlock).toBe(true);
  });

  it('never blocks a PR with zero new findings, however large', () => {
    const risk = assess({
      files: Array.from({ length: 40 }, (_, i) => file(`src/auth/f${i}.ts`, 500)),
      newFindings: [],
      failOnSeverity: 'low',
    });
    expect(risk.shouldBlock).toBe(false);
  });
});

describe('assessPullRequestRisk — sensitive areas', () => {
  it('flags authentication changes as an affected component', () => {
    const risk = assess({ files: [file('src/auth/session.ts')] });
    expect(risk.blastRadius.affectedComponents).toContain('authentication/authorization');
    expect(risk.factors.some((f) => f.id.startsWith('sensitive:'))).toBe(true);
  });

  it('scores an auth change above an equally sized docs change', () => {
    const auth = assess({ files: [file('src/auth/login.ts', 30)] });
    const docs = assess({ files: [file('docs/guide.md', 30)] });
    expect(auth.score).toBeGreaterThan(docs.score);
  });

  it('flags CI workflow changes', () => {
    const risk = assess({ files: [file('.github/workflows/deploy.yml')] });
    expect(risk.blastRadius.affectedComponents).toContain('infrastructure/CI');
  });

  it('flags dependency manifest changes', () => {
    const risk = assess({ files: [file('package.json')] });
    expect(risk.blastRadius.affectedComponents).toContain('dependency manifest');
  });
});

describe('assessPullRequestRisk — blast radius', () => {
  it('identifies files that import the changed file', () => {
    const importGraph = new Map<string, string[]>([
      ['src/api/users.ts', ['src/lib/db.ts']],
      ['src/api/orders.ts', ['src/lib/db.ts']],
      ['src/lib/db.ts', []],
    ]);
    const risk = assess({ files: [file('src/lib/db.ts')], importGraph });
    expect(risk.blastRadius.impactedFiles).toEqual(['src/api/orders.ts', 'src/api/users.ts']);
  });

  it('excludes files that are themselves part of the diff', () => {
    const importGraph = new Map<string, string[]>([['src/api/users.ts', ['src/lib/db.ts']]]);
    const risk = assess({
      files: [file('src/lib/db.ts'), file('src/api/users.ts')],
      importGraph,
    });
    expect(risk.blastRadius.impactedFiles).toEqual([]);
  });

  it('raises the score when many files depend on the change', () => {
    const wide = new Map<string, string[]>();
    for (let i = 0; i < 20; i++) wide.set(`src/c${i}.ts`, ['src/core.ts']);
    const narrow = new Map<string, string[]>([['src/c0.ts', ['src/core.ts']]]);

    const wideRisk = assess({ files: [file('src/core.ts')], importGraph: wide });
    const narrowRisk = assess({ files: [file('src/core.ts')], importGraph: narrow });
    expect(wideRisk.score).toBeGreaterThan(narrowRisk.score);
  });
});

describe('assessPullRequestRisk — test coverage', () => {
  it('flags a changed source file with no covering test', () => {
    const risk = assess({ files: [file('src/payments.ts')], testFiles: [] });
    expect(risk.blastRadius.uncoveredChanges).toContain('src/payments.ts');
    expect(risk.factors.some((f) => f.id === 'untested-changes')).toBe(true);
  });

  it('treats a test importing the file as coverage', () => {
    const importGraph = new Map<string, string[]>([['tests/payments.test.ts', ['src/payments.ts']]]);
    const risk = assess({
      files: [file('src/payments.ts')],
      testFiles: ['tests/payments.test.ts'],
      importGraph,
    });
    expect(risk.blastRadius.uncoveredChanges).not.toContain('src/payments.ts');
    expect(risk.blastRadius.coveringTests).toContain('tests/payments.test.ts');
  });

  it('treats a name-matched test as coverage', () => {
    const risk = assess({
      files: [file('src/payments.ts')],
      testFiles: ['tests/payments.test.ts'],
    });
    expect(risk.blastRadius.uncoveredChanges).not.toContain('src/payments.ts');
  });

  it('does not demand tests for non-source files', () => {
    const risk = assess({ files: [file('README.md'), file('assets/logo.svg')], testFiles: [] });
    expect(risk.blastRadius.uncoveredChanges).toEqual([]);
  });

  it('does not demand a test for a changed test file', () => {
    const risk = assess({
      files: [file('tests/app.test.ts')],
      testFiles: ['tests/app.test.ts'],
    });
    expect(risk.blastRadius.uncoveredChanges).toEqual([]);
  });
});

describe('assessPullRequestRisk — truncated diffs', () => {
  it('adds a risk factor and says the result is a lower bound', () => {
    const risk = assess({ truncatedDiff: true });
    const factor = risk.factors.find((f) => f.id === 'truncated-diff');
    expect(factor).toBeDefined();
    expect(factor?.detail).toMatch(/lower bound/i);
  });

  it('scores a truncated diff above the same diff fully analysed', () => {
    const full = assess({ files: [file('src/a.ts')] });
    const partial = assess({ files: [file('src/a.ts')], truncatedDiff: true });
    expect(partial.score).toBeGreaterThan(full.score);
  });
});

describe('assessPullRequestRisk — explainability', () => {
  it('attributes every point to a named factor', () => {
    const risk = assess({
      files: [file('src/auth/session.ts', 200)],
      newFindings: [finding('high')],
      resolvedFingerprints: ['x'],
    });
    const sum = risk.factors.reduce((total, f) => total + f.points, 0);
    expect(Math.round(sum * 10) / 10).toBeCloseTo(risk.score, 1);
  });

  it('orders factors by magnitude so the biggest driver is first', () => {
    const risk = assess({
      files: [file('src/auth/session.ts', 300)],
      newFindings: [finding('critical')],
    });
    const magnitudes = risk.factors.map((f) => Math.abs(f.points));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
  });

  it('recommends a regression test naming the specific rule and file', () => {
    const risk = assess({ newFindings: [finding('high', 'src/exec.ts', 'security/command-injection')] });
    expect(risk.recommendedTests.some((t) => t.includes('security/command-injection'))).toBe(true);
    expect(risk.recommendedTests.some((t) => t.includes('src/exec.ts'))).toBe(true);
  });

  it('never labels a blocked pull request as low risk', () => {

    const risk = assess({ newFindings: [finding('critical')], failOnSeverity: 'high' });
    expect(risk.shouldBlock).toBe(true);
    expect(risk.level).toBe('critical');
  });

  it('floors the level at the worst introduced severity', () => {
    const risk = assess({ files: [file('src/a.ts', 2)], newFindings: [finding('high')] });
    expect(['high', 'critical']).toContain(risk.level);
  });

  it('produces a summary that states the verdict and the counts', () => {
    const risk = assess({ newFindings: [finding('high')], resolvedFingerprints: ['a'] });
    expect(risk.summary).toMatch(/risk [\d.]+\/100/);
    expect(risk.summary).toMatch(/1 new finding/);
    expect(risk.summary).toMatch(/1 finding resolved/);
  });

  it('says so explicitly when nothing changed', () => {
    const risk = assess({ files: [file('README.md', 1)] });
    expect(risk.summary).toMatch(/No change in findings/i);
  });
});

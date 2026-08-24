import { describe, expect, it } from 'vitest';

import { findAttackPaths } from '@/guardian/attack-path';
import { diffDependencies } from '@/guardian/dependency-diff';
import { classifyLifecycle, isRecurring } from '@/guardian/lifecycle';
import { DEFAULT_POLICY_RULES, evaluatePolicies } from '@/guardian/policies';
import { assessRepositoryRisk } from '@/guardian/repo-risk';
import { selectScanners } from '@/guardian/scan-strategy';
import { groupFindings } from '@/guardian/triage';
import { verifyFix } from '@/guardian/verify-fix';
import { analyseWorkflow } from '@/scanner/scanners/cicd';
import { analyseConfig } from '@/scanner/scanners/config';
import { trajectoryOf } from '@/lib/insights';
import type { SourceFile } from '@/scanner/types';

function file(path: string, content: string): SourceFile {
  const lines = content.split('\n');
  return {
    path,
    language: 'yaml',
    content,
    lines,
    loc: lines.filter((l) => l.trim()).length,
    bytes: content.length,
    isTest: false,
    contentHash: 'x',
  };
}

describe('repo risk engine', () => {
  it('is deterministic and stays low on a clean repo', () => {
    const a = assessRepositoryRisk({
      health: 94,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      secretCount: 0,
      sourceFileCount: 10,
      untestedFileCount: 1,
      vulnerablePackages: 0,
      highRiskComponents: 0,
      sensitiveComponents: 0,
      recentRegressions: 0,
    });
    const b = assessRepositoryRisk({
      health: 94,
      counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      secretCount: 0,
      sourceFileCount: 10,
      untestedFileCount: 1,
      vulnerablePackages: 0,
      highRiskComponents: 0,
      sensitiveComponents: 0,
      recentRegressions: 0,
    });
    expect(a).toEqual(b);
    expect(a.level === 'info' || a.level === 'low').toBe(true);
  });

  it('raises to critical when secrets and critical findings combine', () => {
    const result = assessRepositoryRisk({
      health: 40,
      counts: { critical: 2, high: 3, medium: 0, low: 0, info: 0 },
      secretCount: 2,
      sourceFileCount: 8,
      untestedFileCount: 6,
      vulnerablePackages: 2,
      highRiskComponents: 2,
      sensitiveComponents: 2,
      recentRegressions: 1,
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.level).toBe('critical');
    expect(result.factors.length).toBeGreaterThan(0);
  });
});

describe('scan strategy', () => {
  it('targets auth changes without running cicd', () => {
    const strategy = selectScanners(['src/auth/login.ts']);
    expect(strategy.mode).toBe('targeted');
    expect(strategy.scanners).toContain('security');
    expect(strategy.scanners).not.toContain('cicd');
  });

  it('falls back to a full scan for unknown files', () => {
    expect(selectScanners(['weird.dat']).mode).toBe('full');
  });
});

describe('lifecycle', () => {
  it('marks a previously resolved open finding as a regression', () => {
    expect(
      classifyLifecycle({
        fingerprint: 'a',
        currentlyOpen: true,
        firstSeenAt: new Date('2026-08-01'),
        lastResolvedAt: new Date('2026-08-23'),
        previouslyOpen: false,
      }),
    ).toBe('regressed');
    expect(
      isRecurring({
        fingerprint: 'a',
        currentlyOpen: true,
        firstSeenAt: new Date(),
        lastResolvedAt: new Date(),
        previouslyOpen: false,
      }),
    ).toBe(true);
  });
});

describe('triage', () => {
  it('groups auth findings and keeps singles accessible', () => {
    const groups = groupFindings([
      { id: '1', title: 'Missing authz', severity: 'high', category: 'security', filePath: 'src/auth/a.ts', ruleId: 'security/auth' },
      { id: '2', title: 'Session', severity: 'medium', category: 'security', filePath: 'src/auth/b.ts', ruleId: 'security/session' },
      { id: '3', title: 'Odd quality', severity: 'low', category: 'quality', filePath: 'src/x.ts', ruleId: 'quality/long' },
    ]);
    expect(groups[0]?.findings.length).toBe(2);
    expect(groups.some((g) => g.findings.some((f) => f.id === '3'))).toBe(true);
  });
});

describe('policies', () => {
  it('requests changes for a critical finding', () => {
    const decisions = evaluatePolicies(DEFAULT_POLICY_RULES, {
      trigger: 'new_finding',
      severity: 'critical',
    });
    expect(decisions.some((d) => d.blocksCheck)).toBe(true);
  });

  it('does not fire a secret rule on a quality finding', () => {
    const decisions = evaluatePolicies(DEFAULT_POLICY_RULES, {
      trigger: 'new_finding',
      severity: 'low',
      category: 'quality',
    });
    expect(decisions).toEqual([]);
  });
});

describe('dependency diff', () => {
  it('flags a new vulnerable package as high risk', () => {
    const changes = diffDependencies(
      [{ name: 'react', ecosystem: 'npm', version: '18.0.0', vulnerabilities: [] }],
      [
        { name: 'react', ecosystem: 'npm', version: '18.2.0', vulnerabilities: [] },
        { name: 'lodash', ecosystem: 'npm', version: '4.17.20', vulnerabilities: [{ id: 'GHSA-1', severity: 'high' }] },
      ],
    );
    expect(changes.find((c) => c.name === 'lodash')?.risk).toBe('high');
    expect(changes.find((c) => c.name === 'react')?.kind).toBe('updated');
  });
});

describe('attack paths', () => {
  it('does not invent a path without edges', () => {
    expect(findAttackPaths([], [{ id: '1', filePath: 'src/a.ts' }])).toEqual([]);
  });

  it('labels a path with a finding as confirmed, not exploitable', () => {
    const paths = findAttackPaths(
      [
        { type: 'exposes_api', fromKey: 'src/api.ts', toKey: 'api:GET /login', confidence: 'certain', evidence: 'app.get', lineNumber: 1 },
        { type: 'imports', fromKey: 'src/api.ts', toKey: 'src/auth.ts', confidence: 'certain', evidence: './auth', lineNumber: 2 },
        { type: 'uses_database', fromKey: 'src/auth.ts', toKey: 'db:users', confidence: 'certain', evidence: 'query', lineNumber: 3 },
      ],
      [{ id: 'f1', filePath: 'src/auth.ts' }],
    );
    expect(paths[0]?.confidence).toBe('confirmed');
    expect(paths[0]?.evidence.toLowerCase()).not.toContain('exploit');
  });
});

describe('fix verification', () => {
  it('only reports resolved when the fingerprint is gone', () => {
    expect(
      verifyFix({
        originalFingerprint: 'fp-1',
        beforeFingerprints: ['fp-1'],
        afterFingerprints: ['fp-1'],
        testsPassed: 10,
        testsFailed: 0,
      }).status,
    ).toBe('still_present');
    expect(
      verifyFix({
        originalFingerprint: 'fp-1',
        beforeFingerprints: ['fp-1'],
        afterFingerprints: [],
        testsPassed: 10,
        testsFailed: 0,
      }).status,
    ).toBe('resolved');
  });
});

describe('ci/cd and config scanners', () => {
  it('flags pull_request_target and missing permissions', () => {
    const findings = analyseWorkflow(
      file(
        '.github/workflows/ci.yml',
        ['on:', '  pull_request_target:', 'jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n'),
      ),
    );
    expect(findings.some((f) => f.ruleId === 'cicd/pull-request-target')).toBe(true);
  });

  it('redacts dotenv secrets', () => {
    const sample = file('.env.production', 'API_TOKEN=supersecretvalue99\n');
    sample.language = 'dotenv';
    const findings = analyseConfig(sample);
    const hit = findings.find((f) => f.ruleId === 'config/dotenv-secret');
    expect(hit).toBeTruthy();
    expect(hit?.evidence ?? '').not.toContain('supersecretvalue99');
  });
});

describe('insights trajectory', () => {
  it('classifies improving, stable and degrading', () => {
    expect(trajectoryOf([70, 80])).toBe('improving');
    expect(trajectoryOf([70, 71])).toBe('stable');
    expect(trajectoryOf([80, 70])).toBe('degrading');
    expect(trajectoryOf([50])).toBe('unknown');
  });
});

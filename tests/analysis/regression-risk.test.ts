import { describe, expect, it } from 'vitest';
import { assessRegressionRisk, riskBand } from '@/analysis/regression-risk';
import type { RegressionRiskInput } from '@/analysis/regression-risk';

/**
 * The regression risk model is deterministic and documented, so it is tested
 * as arithmetic: the same input must always give the same score, and every
 * factor must move the score in the direction its documentation claims.
 */

function input(overrides: Partial<RegressionRiskInput> = {}): RegressionRiskInput {
  return {
    changedPaths: ['src/utils/format.ts'],
    linesAdded: 10,
    linesRemoved: 2,
    newFindingSeverities: [],
    historicalFindingCount: 0,
    maxBlastRadius: 0,
    testedPathCount: 1,
    coverageRatio: 0.8,
    priorFailureCount: 0,
    ...overrides,
  };
}

describe('assessRegressionRisk', () => {
  it('is deterministic — the same input always scores the same', () => {
    const a = assessRegressionRisk(input());
    const b = assessRegressionRisk(input());

    expect(a.score).toBe(b.score);
    expect(a.level).toBe(b.level);
  });

  it('scores a small, tested, isolated change as low risk', () => {
    const result = assessRegressionRisk(input());

    expect(result.level).toBe('low');
    expect(result.score).toBeLessThan(18);
  });

  it('escalates sharply when a critical finding is introduced', () => {
    const baseline = assessRegressionRisk(input());
    const withCritical = assessRegressionRisk(input({ newFindingSeverities: ['critical'] }));

    expect(withCritical.score).toBeGreaterThan(baseline.score + 20);
    expect(withCritical.factors.some((f) => f.label === 'New findings introduced')).toBe(true);
  });

  it('ranks severities in the documented order', () => {
    const score = (severity: RegressionRiskInput['newFindingSeverities'][number]) =>
      assessRegressionRisk(input({ newFindingSeverities: [severity] })).score;

    expect(score('critical')).toBeGreaterThan(score('high'));
    expect(score('high')).toBeGreaterThan(score('medium'));
    expect(score('medium')).toBeGreaterThan(score('low'));
    expect(score('low')).toBeGreaterThan(score('info'));
  });

  it('caps the severity contribution so findings alone cannot exceed the weight', () => {
    const many = assessRegressionRisk(
      input({ newFindingSeverities: Array.from({ length: 20 }, () => 'critical' as const) }),
    );
    const severityFactor = many.factors.find((f) => f.label === 'New findings introduced');

    expect(severityFactor?.points).toBeLessThanOrEqual(40);
  });

  it('treats auth and payment paths as riskier than ordinary ones', () => {
    const ordinary = assessRegressionRisk(input({ changedPaths: ['src/utils/format.ts'] }));
    const auth = assessRegressionRisk(input({ changedPaths: ['src/auth/session.ts'] }));
    const payment = assessRegressionRisk(input({ changedPaths: ['src/payment/checkout.ts'] }));

    expect(auth.score).toBeGreaterThan(ordinary.score);
    expect(payment.score).toBeGreaterThan(ordinary.score);
    expect(auth.factors.some((f) => f.detail.includes('authentication'))).toBe(true);
  });

  it('recognises migrations and infrastructure as sensitive', () => {
    const migration = assessRegressionRisk(input({ changedPaths: ['db/migrations/003_add_users.sql'] }));
    const ci = assessRegressionRisk(input({ changedPaths: ['.github/workflows/deploy.yml'] }));

    expect(migration.factors.some((f) => f.label === 'Sensitive areas touched')).toBe(true);
    expect(ci.factors.some((f) => f.label === 'Sensitive areas touched')).toBe(true);
  });

  it('grows with change size, but sub-linearly', () => {
    const small = assessRegressionRisk(input({ linesAdded: 10, linesRemoved: 0 }));
    const medium = assessRegressionRisk(input({ linesAdded: 100, linesRemoved: 0 }));
    const huge = assessRegressionRisk(input({ linesAdded: 10_000, linesRemoved: 0 }));

    expect(medium.score).toBeGreaterThan(small.score);
    expect(huge.score).toBeGreaterThan(medium.score);

    const churnFactor = huge.factors.find((f) => f.label === 'Change size');
    expect(churnFactor?.points).toBeLessThanOrEqual(15);
  });

  it('penalises changes with no covering tests', () => {
    const tested = assessRegressionRisk(
      input({ changedPaths: ['src/a.ts', 'src/b.ts'], testedPathCount: 2 }),
    );
    const untested = assessRegressionRisk(
      input({ changedPaths: ['src/a.ts', 'src/b.ts'], testedPathCount: 0 }),
    );

    expect(untested.score).toBeGreaterThan(tested.score);
    expect(untested.factors.some((f) => f.label === 'Changes without covering tests')).toBe(true);
  });

  it('adds a penalty for low repository coverage', () => {
    const good = assessRegressionRisk(input({ coverageRatio: 0.9 }));
    const poor = assessRegressionRisk(input({ coverageRatio: 0.05 }));

    expect(poor.score).toBeGreaterThan(good.score);
  });

  it('ignores coverage entirely when it is unknown', () => {
    const unknown = assessRegressionRisk(input({ coverageRatio: null }));
    expect(unknown.factors.some((f) => f.label === 'Low repository test coverage')).toBe(false);
  });

  it('accounts for blast radius', () => {
    const isolated = assessRegressionRisk(input({ maxBlastRadius: 0 }));
    const central = assessRegressionRisk(input({ maxBlastRadius: 100 }));

    expect(central.score).toBeGreaterThan(isolated.score);
  });

  it('accounts for history and prior failures', () => {
    const clean = assessRegressionRisk(input());
    const troubled = assessRegressionRisk(input({ historicalFindingCount: 30, priorFailureCount: 4 }));

    expect(troubled.score).toBeGreaterThan(clean.score);
  });

  it('never exceeds 100 even for a worst-case change', () => {
    const worst = assessRegressionRisk({
      changedPaths: ['src/auth/login.ts', 'src/payment/charge.ts', 'db/migrations/001.sql', '.github/workflows/ci.yml'],
      linesAdded: 50_000,
      linesRemoved: 20_000,
      newFindingSeverities: Array.from({ length: 50 }, () => 'critical' as const),
      historicalFindingCount: 500,
      maxBlastRadius: 100,
      testedPathCount: 0,
      coverageRatio: 0,
      priorFailureCount: 100,
    });

    expect(worst.score).toBeLessThanOrEqual(100);
    expect(worst.level).toBe('critical');
  });

  it('returns factors sorted by contribution, so the summary leads with the real driver', () => {
    const result = assessRegressionRisk(
      input({ newFindingSeverities: ['critical'], changedPaths: ['src/auth/session.ts'], testedPathCount: 0 }),
    );

    const points = result.factors.map((f) => f.points);
    expect(points).toEqual([...points].sort((a, b) => b - a));
  });

  it('explains itself: every factor carries a human-readable detail', () => {
    const result = assessRegressionRisk(
      input({ newFindingSeverities: ['high', 'high'], changedPaths: ['src/auth/x.ts'] }),
    );

    for (const factor of result.factors) {
      expect(factor.label.length).toBeGreaterThan(0);
      expect(factor.detail.length).toBeGreaterThan(0);
      expect(factor.points).toBeGreaterThan(0);
    }
    expect(result.summary).toMatch(/regression risk/i);
  });

  it('reports no signals for an empty change', () => {
    const result = assessRegressionRisk({
      changedPaths: [],
      linesAdded: 0,
      linesRemoved: 0,
      newFindingSeverities: [],
      historicalFindingCount: 0,
      maxBlastRadius: 0,
      testedPathCount: 0,
      coverageRatio: null,
      priorFailureCount: 0,
    });

    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.summary).toMatch(/no regression risk signals/i);
  });
});

describe('riskBand', () => {
  it('maps scores to the documented bands', () => {
    expect(riskBand(0)).toBe('low');
    expect(riskBand(17)).toBe('low');
    expect(riskBand(18)).toBe('medium');
    expect(riskBand(39)).toBe('medium');
    expect(riskBand(40)).toBe('high');
    expect(riskBand(64)).toBe('high');
    expect(riskBand(65)).toBe('critical');
    expect(riskBand(100)).toBe('critical');
  });
});

import { describe, expect, it } from 'vitest';

import {
  calculateScores,
  deductionToScore,
  scoreGrade,
  sizeAllowance,
} from '@/scanner/scoring';
import { createFinding } from '@/scanner/finding';
import type { Severity } from '@/db/schema';
import type { RepositoryStats } from '@/scanner/discovery';
import type { Finding } from '@/scanner/types';

function finding(severity: Severity, index: number, overrides: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding({
    ruleId: `rule/${index}`,
    scannerId: 'test',
    severity,
    category: 'security',
    title: `finding ${index}`,
    description: 'description',
    filePath: `src/file-${index}.ts`,
    lineStart: index + 1,
    confidence: 1,
    ...overrides,
  });
}

function stats(totalLoc: number, fileCount = 20): RepositoryStats {
  return {
    fileCount,
    totalLoc,
    totalBytes: totalLoc * 40,
    testFileCount: 2,
    languages: [],
  };
}

const NO_FINDINGS: Severity[] = [];

describe('deductionToScore', () => {
  it('returns a perfect score when nothing was deducted', () => {
    expect(deductionToScore(0)).toBe(100);
    expect(deductionToScore(-5)).toBe(100);
  });

  it('never reaches or crosses zero, however large the deduction', () => {
    for (const deduction of [100, 1_000, 100_000]) {
      const score = deductionToScore(deduction);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    }
  });

  it('never increases as more problems are found', () => {


    let previous = deductionToScore(0);
    for (let deduction = 5; deduction <= 400; deduction += 5) {
      const score = deductionToScore(deduction);
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });

  it('stays responsive across the range where repositories actually sit', () => {


    let previous = deductionToScore(0);
    for (let deduction = 5; deduction <= 150; deduction += 5) {
      const score = deductionToScore(deduction);
      expect(score).toBeLessThan(previous);
      previous = score;
    }
  });
});

describe('sizeAllowance', () => {
  it('does not reward tiny repositories with a discount', () => {
    expect(sizeAllowance(0)).toBe(1);
    expect(sizeAllowance(100)).toBe(1);
  });

  it('scales with repository size but stays bounded', () => {
    expect(sizeAllowance(50_000)).toBeGreaterThan(sizeAllowance(5_000));
    expect(sizeAllowance(10_000_000)).toBeLessThanOrEqual(3);
  });
});

describe('calculateScores', () => {
  it('gives a clean repository a perfect scorecard', () => {
    const result = calculateScores([], stats(5_000));
    expect(result.health).toBe(100);
    expect(result.security).toBe(100);
    expect(result.debtHours).toBe(0);
    expect(result.summary).toMatch(/no issues/i);
    expect(result.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  });

  it('weights a critical finding far more heavily than a low one', () => {
    const critical = calculateScores([finding('critical', 0)], stats(5_000));
    const low = calculateScores([finding('low', 0)], stats(5_000));
    expect(critical.security).toBeLessThan(low.security);
  });

  it('scales a finding by its confidence', () => {
    const certain = calculateScores(
      [finding('high', 0, { confidence: 1 })],
      stats(5_000),
    );
    const unsure = calculateScores(
      [finding('high', 0, { confidence: 0.3 })],
      stats(5_000),
    );
    expect(unsure.security).toBeGreaterThan(certain.security);
  });

  it('routes each category to the dimension it belongs to', () => {
    const testingOnly = calculateScores(
      [finding('high', 0, { category: 'testing' })],
      stats(5_000),
    );
    expect(testingOnly.testing).toBeLessThan(100);

    expect(testingOnly.security).toBe(100);
  });

  it('penalises the same finding less in a large repository', () => {
    const small = calculateScores([finding('high', 0)], stats(500));
    const large = calculateScores([finding('high', 0)], stats(200_000));
    expect(large.security).toBeGreaterThan(small.security);
  });

  it('reports debt hours that grow with severity', () => {
    const one = calculateScores([finding('critical', 0)], stats(5_000));
    const two = calculateScores([finding('critical', 0), finding('critical', 1)], stats(5_000));
    expect(two.debtHours).toBeGreaterThan(one.debtHours);
  });

  it('names the worst dimension in the summary', () => {
    const result = calculateScores(
      [finding('critical', 0), finding('critical', 1)],
      stats(5_000),
    );
    expect(result.summary).toMatch(/critical/i);
  });

  it('counts findings by severity', () => {
    const result = calculateScores(
      [finding('critical', 0), finding('high', 1), finding('high', 2)],
      stats(5_000),
    );
    expect(result.counts.critical).toBe(1);
    expect(result.counts.high).toBe(2);
  });
});

describe('scoreGrade', () => {
  it('grades on the number alone when severity counts are absent', () => {
    expect(scoreGrade(95).label).toBe('Excellent');
    expect(scoreGrade(80).label).toBe('Good');
    expect(scoreGrade(60).label).toBe('Needs attention');
    expect(scoreGrade(20).label).toBe('At risk');
  });

  it('never calls a repository with an open critical finding healthy', () => {



    const counts = { critical: 1, high: 0, medium: 0, low: 0, info: 0 };
    const grade = scoreGrade(92, counts);
    expect(grade.label).toBe('At risk');
    expect(grade.tone).toBe('critical');
  });

  it('caps a repository with open high findings below "Good"', () => {
    const counts = { critical: 0, high: 2, medium: 0, low: 0, info: 0 };
    expect(scoreGrade(95, counts).label).toBe('Needs attention');
    expect(scoreGrade(30, counts).label).toBe('At risk');
  });

  it('leaves medium and low findings to the numeric thresholds', () => {
    const counts = { critical: 0, high: 0, medium: 8, low: 3, info: 1 };
    expect(scoreGrade(91, counts).label).toBe('Excellent');
  });

  it('keeps the numeric score responsive even when the grade is pinned', () => {


    const many = calculateScores(
      Array.from({ length: 10 }, (_, i) => finding('critical', i)),
      stats(5_000),
    );
    const fewer = calculateScores(
      Array.from({ length: 3 }, (_, i) => finding('critical', i)),
      stats(5_000),
    );
    expect(fewer.health).toBeGreaterThan(many.health);
    expect(scoreGrade(fewer.health, fewer.counts).label).toBe('At risk');
  });

  it('treats an empty severity map as clean', () => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    expect(scoreGrade(100, counts).label).toBe('Excellent');
    expect(NO_FINDINGS).toHaveLength(0);
  });
});

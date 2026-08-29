import { describe, expect, it } from 'vitest';

import { createFinding, dedupeFindings, roundConfidence } from '@/scanner/finding';
import type { Finding } from '@/scanner/types';

function make(overrides: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding({
    ruleId: 'security/sql-injection',
    scannerId: 'security',
    severity: 'high',
    category: 'security',
    title: 'SQL injection',
    description: 'description',
    filePath: 'src/users.js',
    lineStart: 10,
    confidence: 0.8,
    ...overrides,
  });
}

describe('roundConfidence', () => {
  it('removes floating-point drift', () => {
    expect(roundConfidence(0.1 + 0.2)).toBe(0.3);
    expect(roundConfidence(0.55 + 0.1)).toBe(0.65);
  });

  it('keeps confidence within 0..1', () => {
    expect(roundConfidence(1.4)).toBeLessThanOrEqual(1);
    expect(roundConfidence(-0.5)).toBeGreaterThanOrEqual(0);
  });
});

describe('createFinding', () => {
  it('produces a stable fingerprint for the same issue', () => {
    expect(make().fingerprint).toBe(make().fingerprint);
  });

  it('ignores line numbers in the fingerprint', () => {


    expect(make({ lineStart: 10 }).fingerprint).toBe(make({ lineStart: 250 }).fingerprint);
  });

  it('distinguishes different rules in the same file', () => {
    expect(make({ ruleId: 'a/one' }).fingerprint).not.toBe(make({ ruleId: 'a/two' }).fingerprint);
  });

  it('distinguishes the same rule in different files', () => {
    expect(make({ filePath: 'src/a.js' }).fingerprint).not.toBe(
      make({ filePath: 'src/b.js' }).fingerprint,
    );
  });

  it('caps evidence so a minified line cannot bloat the record', () => {
    const finding = make({ evidence: 'x'.repeat(5_000) });
    expect((finding.evidence ?? '').length).toBeLessThanOrEqual(260);
  });

  it('rounds confidence on the way in', () => {
    expect(make({ confidence: 0.1 + 0.2 }).confidence).toBe(0.3);
  });
});

describe('dedupeFindings', () => {
  it('collapses the same issue reported by two scanners', () => {
    const a = make({ scannerId: 'security', confidence: 0.8 });
    const b = make({ scannerId: 'semgrep', confidence: 0.7 });
    expect(dedupeFindings([a, b])).toHaveLength(1);
  });

  it('keeps the highest severity when scanners disagree', () => {
    const low = make({ severity: 'low', scannerId: 'a' });
    const critical = make({ severity: 'critical', scannerId: 'b' });
    const [merged] = dedupeFindings([low, critical]);
    expect(merged?.severity).toBe('critical');
  });

  it('raises confidence when two scanners corroborate, without exceeding 1', () => {
    const a = make({ scannerId: 'a', confidence: 0.8 });
    const b = make({ scannerId: 'b', confidence: 0.75 });
    const [merged] = dedupeFindings([a, b]);
    expect(merged?.confidence).toBeGreaterThan(0.8);
    expect(merged?.confidence).toBeLessThanOrEqual(1);

    const high = dedupeFindings([
      make({ scannerId: 'a', confidence: 0.99 }),
      make({ scannerId: 'b', confidence: 0.98 }),
    ]);
    expect(high[0]?.confidence).toBeLessThanOrEqual(1);
  });

  it('records which scanners corroborated the finding', () => {
    const [merged] = dedupeFindings([make({ scannerId: 'a' }), make({ scannerId: 'b' })]);
    expect(merged?.metadata?.corroboratedBy).toBeDefined();
  });

  it('leaves genuinely distinct findings alone', () => {
    const findings = [
      make({ ruleId: 'a/one', filePath: 'src/a.js' }),
      make({ ruleId: 'a/two', filePath: 'src/a.js' }),
      make({ ruleId: 'a/one', filePath: 'src/b.js' }),
    ];
    expect(dedupeFindings(findings)).toHaveLength(3);
  });

  it('handles an empty list', () => {
    expect(dedupeFindings([])).toEqual([]);
  });

  it('never emits duplicate fingerprints', () => {
    const findings = [
      make({ scannerId: 'a' }),
      make({ scannerId: 'b' }),
      make({ scannerId: 'c', filePath: 'src/other.js' }),
    ];
    const result = dedupeFindings(findings);
    expect(new Set(result.map((f) => f.fingerprint)).size).toBe(result.length);
  });
});

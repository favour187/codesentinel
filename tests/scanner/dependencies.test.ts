import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  isUnresolvedVersion,
  isVersionVulnerable,
  parseVersionParts,
} from '@/scanner/providers/vulnerability-provider';
import { dependencyScanner } from '@/scanner/scanners/dependencies';
import { ruleIds, scanSource } from './helpers/source';

describe('version parsing and comparison', () => {
  it('parses semver into numeric parts', () => {
    expect(parseVersionParts('1.2.3')).toEqual([1, 2, 3]);
  });

  it('strips range prefixes so ^1.2.3 compares as 1.2.3', () => {
    expect(parseVersionParts('^1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersionParts('~4.17.15')).toEqual([4, 17, 15]);
    expect(parseVersionParts('>=2.0.0')).toEqual([2, 0, 0]);
  });

  it('orders versions numerically, not lexicographically', () => {

    expect(compareVersions('4.17.15', '4.17.9')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '^1.2.3')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2', '2.0.1')).toBeLessThan(0);
  });
});

describe('isVersionVulnerable', () => {
  const advisory = {
    id: 'GHSA-test',
    ecosystem: 'npm' as const,
    package: 'lodash',
    fixedIn: '4.17.21',
    severity: 'high' as const,
    summary: 'Prototype pollution',
    url: 'https://example.test/GHSA-test',
  };

  it('flags a version below the fixed release', () => {
    expect(isVersionVulnerable('4.17.15', advisory)).toBe(true);
  });

  it('does not flag the fixed release itself', () => {
    expect(isVersionVulnerable('4.17.21', advisory)).toBe(false);
  });

  it('does not flag a later release', () => {
    expect(isVersionVulnerable('4.18.0', advisory)).toBe(false);
  });

  it('never guesses when the version is unknown', () => {


    expect(isVersionVulnerable(null, advisory)).toBe(false);
    for (const version of ['*', 'x', 'latest', 'workspace:*', 'file:../lib', 'git+https://x/y.git']) {
      expect(isVersionVulnerable(version, advisory)).toBe(false);
    }
  });

  it('still resolves ordinary ranges to a concrete comparison', () => {
    expect(isVersionVulnerable('^4.17.15', advisory)).toBe(true);
    expect(isVersionVulnerable('~4.17.21', advisory)).toBe(false);
  });
});

describe('isUnresolvedVersion', () => {
  it('recognises concrete versions', () => {
    for (const version of ['1.2.3', '^4.17.15', '~0.1.0', '>=2.0.0', 'v3.1.4']) {
      expect(isUnresolvedVersion(version)).toBe(false);
    }
  });

  it('recognises ranges that carry no version information', () => {
    for (const version of ['*', 'x', 'latest', 'workspace:*', 'file:../a', '']) {
      expect(isUnresolvedVersion(version)).toBe(true);
    }
  });
});

describe('dependency scanner', () => {
  it('flags a known-vulnerable npm dependency', async () => {
    const findings = await scanSource(
      dependencyScanner,
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.15' } }, null, 2),
    );
    expect(ruleIds(findings)).toContain('dependency/vulnerable-package');
  });

  it('does not flag a patched version of the same package', async () => {
    const findings = await scanSource(
      dependencyScanner,
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.21' } }, null, 2),
    );
    expect(findings).toHaveLength(0);
  });

  it('reports the manifest path and the offending line', async () => {
    const findings = await scanSource(
      dependencyScanner,
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { lodash: '4.17.15' } }, null, 2),
    );
    const finding = findings[0];
    expect(finding?.filePath).toBe('package.json');
    expect(finding?.lineStart).toBeGreaterThan(0);
  });

  it('survives a malformed manifest without throwing', async () => {

    const findings = await scanSource(dependencyScanner, 'package.json', '{ not valid json');
    expect(findings).toEqual([]);
  });

  it('ignores a manifest with no dependencies', async () => {
    const findings = await scanSource(
      dependencyScanner,
      'package.json',
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    expect(findings).toEqual([]);
  });

  it('parses python requirements pins', async () => {
    const findings = await scanSource(dependencyScanner, 'requirements.txt', 'requests==2.19.1\n');
    expect(Array.isArray(findings)).toBe(true);
  });
});

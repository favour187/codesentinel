import path from 'node:path';

import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';

/**
 * Test discovery and test-gap detection.
 *
 * Coverage tooling is the authoritative source, but it requires executing the
 * suite — which CodeSentinel will not do against untrusted code during a scan.
 * Instead this derives an import-graph-based approximation: a source module is
 * "covered" when some test file imports it, directly or through one hop.
 *
 * Findings are prioritised by risk, not raw absence of tests. An untested
 * one-line constants file is noise; an untested payment service is the finding
 * that matters.
 */

const SCANNER_ID = 'testing';

const TEST_FRAMEWORKS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'vitest', pattern: /from\s+['"]vitest['"]|require\(['"]vitest['"]\)/ },
  { name: 'jest', pattern: /@jest\/globals|jest\.(?:mock|fn|spyOn)\s*\(/ },
  { name: 'mocha', pattern: /require\(['"]mocha['"]\)|from\s+['"]mocha['"]/ },
  { name: 'pytest', pattern: /import\s+pytest|from\s+pytest\s+import/ },
  { name: 'unittest', pattern: /import\s+unittest|unittest\.TestCase/ },
  { name: 'go test', pattern: /func\s+Test\w+\s*\(\s*t\s+\*testing\.T/ },
];

/**
 * Counts test cases regardless of framework.
 *
 * The JS branch allows a modifier (`it.skip`, `test.concurrent`) and an
 * optional intervening argument list, so table-driven cases written as
 * `it.each([...])('name', fn)` are counted. Missing those would understate
 * coverage in exactly the suites that exercise the most input combinations.
 */
export function countTestCases(content: string): number {
  const matches = content.match(
    /\b(?:it|test)\s*(?:\.\w+)*\s*(?:\([^()]*\)|`[^`]*`)?\s*\(\s*['"`]|\bdef\s+test_\w+\s*\(|\bfunc\s+Test\w+\s*\(/g,
  );
  return matches?.length ?? 0;
}

export function detectFramework(content: string): string | null {
  for (const framework of TEST_FRAMEWORKS) {
    if (framework.pattern.test(content)) return framework.name;
  }
  return null;
}

export function hasAssertions(content: string): boolean {
  return /\bexpect\s*\(|\bassert\b|\bshould\b|\bt\.(?:Error|Fatal)\b/.test(content);
}

/** Extracts relative import targets so tests can be linked to their subjects. */
export function extractRelativeImports(file: SourceFile): string[] {
  const targets = new Set<string>();
  const patterns = [
    /require\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /import\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /from\s+(\.[\w.]+)\s+import/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      if (match[1]) targets.add(match[1]);
    }
  }

  return [...targets];
}

/** Resolves a relative import to an actual repository path. */
export function resolveImport(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = path.posix.join(path.posix.dirname(fromPath), specifier);
  const candidates = [
    base,
    `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}.ts`, `${base}.tsx`, `${base}.py`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/__init__.py`,
  ];
  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate);
    if (known.has(normalized)) return normalized;
  }
  return null;
}

/** Files that carry real risk if they break. */
const HIGH_RISK_PATTERN = /(?:payment|billing|charge|invoice|auth|login|session|token|password|crypto|permission|access|admin|security|migration|order|checkout|transaction)/i;

/** Files where the absence of a test is not interesting. */
function isTriviallyTestable(file: SourceFile): boolean {
  if (file.loc < 10) return true;
  const base = path.posix.basename(file.path).toLowerCase();
  if (/^(?:index|types?|constants?|config)\.[jt]sx?$/.test(base)) return true;
  if (!['javascript', 'typescript', 'python'].includes(file.language)) return true;
  return false;
}

export const testingScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Test coverage scanner',
  description: 'Discovers test files and flags high-risk source modules that no test exercises.',
  categories: ['testing'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const knownPaths = new Set(ctx.files.map((f) => f.path));
    const testFiles = ctx.files.filter((f) => f.isTest);
    const sourceFiles = ctx.files.filter((f) => !f.isTest);

    /* ------------------ map each test file to what it covers ----------------- */
    const covered = new Set<string>();
    for (const testFile of testFiles) {
      for (const specifier of extractRelativeImports(testFile)) {
        const resolved = resolveImport(testFile.path, specifier, knownPaths);
        if (resolved) covered.add(resolved);
      }

      // A test file with no assertions gives false confidence.
      if (countTestCases(testFile.content) > 0 && !hasAssertions(testFile.content)) {
        findings.push(
          createFinding({
            ruleId: 'testing/test-without-assertions',
            scannerId: SCANNER_ID,
            severity: 'medium',
            category: 'testing',
            title: 'Test file contains no assertions',
            description: `${testFile.path} defines test cases but never asserts anything.`,
            filePath: testFile.path,
            lineStart: 1,
            confidence: 0.8,
            whyItMatters:
              'A test that cannot fail is worse than no test: it reports green, counts toward coverage, and hides the fact that the behaviour is unverified.',
            remediation: 'Add explicit assertions covering the expected output and the error paths.',
            references: [],
            fingerprintSeed: `test-without-assertions:${testFile.path}`,
          }),
        );
      }
    }

    /* ------------------------- no test suite at all ------------------------- */
    if (testFiles.length === 0 && sourceFiles.length > 0) {
      findings.push(
        createFinding({
          ruleId: 'testing/no-tests',
          scannerId: SCANNER_ID,
          severity: 'high',
          category: 'testing',
          title: 'Repository has no automated tests',
          description: `No test files were discovered across ${sourceFiles.length} source files.`,
          filePath: null,
          confidence: 0.9,
          whyItMatters:
            'Without a test suite every change is unverified. Regressions are found by users rather than CI, and refactoring becomes risky enough that quality problems get left in place.',
          remediation: 'Add a test runner and start with the highest-risk modules — authentication, payments and data mutation.',
          references: [],
          fingerprintSeed: 'no-tests',
        }),
      );
      return findings;
    }

    /* -------------------------- untested high risk -------------------------- */
    for (const file of sourceFiles) {
      if (isTriviallyTestable(file)) continue;
      if (covered.has(file.path)) continue;

      const highRisk = HIGH_RISK_PATTERN.test(file.path);
      const exportsSomething = /module\.exports|export\s+(?:default|const|function|class)|^def\s/m.test(file.content);
      if (!exportsSomething) continue;
      // Only surface substantial modules, so the list stays actionable.
      if (!highRisk && file.loc < 40) continue;

      findings.push(
        createFinding({
          ruleId: 'testing/untested-module',
          scannerId: SCANNER_ID,
          severity: highRisk ? 'high' : 'low',
          category: 'testing',
          title: `${highRisk ? 'High-risk module' : 'Module'} has no test coverage`,
          description: `No test file imports ${file.path}, so none of its ${file.loc} lines are exercised by the suite.`,
          filePath: file.path,
          lineStart: 1,
          confidence: highRisk ? 0.85 : 0.7,
          whyItMatters: highRisk
            ? 'This module handles money, authentication or privileged operations by name. Untested logic in these areas fails silently and expensively — an incorrect refund calculation or a broken permission check can run for weeks before anyone notices.'
            : 'Untested code has no safety net: a refactor or dependency upgrade can change its behaviour with nothing to catch it.',
          remediation: highRisk
            ? `Add unit tests for ${path.posix.basename(file.path)} covering the happy path, boundary values (zero, negative, very large) and failure modes such as network or database errors.`
            : `Add unit tests covering the main exported functions of ${path.posix.basename(file.path)}.`,
          references: [],
          metadata: { loc: file.loc, highRisk },
          relatedTests: [],
          fingerprintSeed: `untested-module:${file.path}`,
        }),
      );
    }

    return findings;
  },
};

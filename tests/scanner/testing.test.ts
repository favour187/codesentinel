import { describe, expect, it } from 'vitest';
import {
  countTestCases,
  detectFramework,
  extractRelativeImports,
  hasAssertions,
  resolveImport,
  testingScanner,
} from '@/scanner/scanners/testing';
import { ruleIds, scanContext, sourceFile } from './helpers/source';

/**
 * The testing scanner never executes the suite — it infers coverage from the
 * import graph. These tests pin both halves: the pure helpers, and the
 * gap-detection policy that decides which absences are worth reporting.
 */

describe('countTestCases', () => {
  it('counts JS test cases across it/test and modifiers', () => {
    const content = `
      describe('suite', () => {
        it('does a thing', () => {});
        test('does another', () => {});
        it.each([1, 2])('parameterised %i', () => {});
        it.skip('skipped but still declared', () => {});
      });
    `;
    expect(countTestCases(content)).toBe(4);
  });

  it('counts pytest and go test functions', () => {
    expect(countTestCases('def test_login():\n    pass\ndef test_logout():\n    pass\n')).toBe(2);
    expect(countTestCases('func TestAdd(t *testing.T) {}\nfunc TestSub(t *testing.T) {}')).toBe(2);
  });

  it('returns zero for a file with no test cases', () => {
    expect(countTestCases('const x = 1;\nfunction helper() { return x; }')).toBe(0);
  });

  it('does not count a describe block as a test case', () => {
    expect(countTestCases("describe('group', () => {});")).toBe(0);
  });
});

describe('detectFramework', () => {
  it('identifies the framework from its import', () => {
    expect(detectFramework("import { it } from 'vitest';")).toBe('vitest');
    expect(detectFramework("import { jest } from '@jest/globals';")).toBe('jest');
    expect(detectFramework("const mocha = require('mocha');")).toBe('mocha');
    expect(detectFramework('import pytest')).toBe('pytest');
    expect(detectFramework('import unittest')).toBe('unittest');
    expect(detectFramework('func TestThing(t *testing.T) {}')).toBe('go test');
  });

  it('returns null when nothing identifies a framework', () => {
    expect(detectFramework('const x = 1;')).toBeNull();
  });
});

describe('hasAssertions', () => {
  it('recognises common assertion styles', () => {
    expect(hasAssertions('expect(a).toBe(1)')).toBe(true);
    expect(hasAssertions('assert x == 1')).toBe(true);
    expect(hasAssertions('result.should.equal(2)')).toBe(true);
    expect(hasAssertions('t.Error("boom")')).toBe(true);
  });

  it('returns false for a test body that only calls code', () => {
    expect(hasAssertions('const result = doThing();\nconsole.log(result);')).toBe(false);
  });
});

describe('extractRelativeImports', () => {
  it('extracts relative specifiers from every supported syntax', () => {
    const file = sourceFile(
      'tests/a.test.js',
      [
        "const a = require('../src/a');",
        "import b from '../src/b.js';",
        "const c = await import('./c');",
        'from .utils import helper',
      ].join('\n'),
    );

    expect(extractRelativeImports(file).sort()).toEqual(
      ['../src/a', '../src/b.js', './c', '.utils'].sort(),
    );
  });

  it('ignores bare package specifiers', () => {
    const file = sourceFile(
      'tests/a.test.js',
      "import { describe } from 'vitest';\nconst lodash = require('lodash');",
    );
    expect(extractRelativeImports(file)).toEqual([]);
  });

  it('deduplicates a specifier imported twice', () => {
    const file = sourceFile(
      'tests/a.test.js',
      "import a from '../src/a';\nconst again = require('../src/a');",
    );
    expect(extractRelativeImports(file)).toEqual(['../src/a']);
  });
});

describe('resolveImport', () => {
  const known = new Set([
    'src/a.js',
    'src/nested/index.ts',
    'src/mod/__init__.py',
    'src/exact.ts',
  ]);

  it('resolves an extensionless specifier by trying known extensions', () => {
    expect(resolveImport('tests/a.test.js', '../src/a', known)).toBe('src/a.js');
    expect(resolveImport('tests/a.test.js', '../src/exact', known)).toBe('src/exact.ts');
  });

  it('resolves directory imports through index and __init__ files', () => {
    expect(resolveImport('tests/a.test.js', '../src/nested', known)).toBe('src/nested/index.ts');
    expect(resolveImport('tests/a.test.py', '../src/mod', known)).toBe('src/mod/__init__.py');
  });

  it('returns null when the target is not part of the repository', () => {
    expect(resolveImport('tests/a.test.js', '../src/missing', known)).toBeNull();
  });
});

describe('testing scanner — no test suite', () => {
  it('reports a single repository-level finding when no tests exist', async () => {
    const files = [
      sourceFile('src/auth.js', `${'const a = 1;\n'.repeat(50)}module.exports = { a };`),
      sourceFile('src/payment.js', `${'const b = 2;\n'.repeat(50)}module.exports = { b };`),
    ];

    const findings = await testingScanner.scan(scanContext(files));

    // One aggregate finding, not one per file — a repository with no tests has
    // a single problem, and per-file noise would bury it.
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('testing/no-tests');
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.filePath).toBeNull();
  });

  it('does not report no-tests for an empty repository', async () => {
    const findings = await testingScanner.scan(scanContext([]));
    expect(findings).toEqual([]);
  });
});

describe('testing scanner — coverage inference', () => {
  const paymentService = sourceFile(
    'src/services/payment-service.js',
    `${'// logic\nconst x = 1;\n'.repeat(20)}module.exports = { charge };`,
  );

  it('flags a high-risk module that no test imports', async () => {
    const files = [
      paymentService,
      sourceFile('tests/other.test.js', "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });"),
    ];

    const findings = await testingScanner.scan(scanContext(files));
    const untested = findings.filter((f) => f.ruleId === 'testing/untested-module');

    expect(untested).toHaveLength(1);
    expect(untested[0]?.filePath).toBe('src/services/payment-service.js');
    expect(untested[0]?.severity).toBe('high');
    expect(untested[0]?.metadata?.highRisk).toBe(true);
  });

  it('does not flag a module a test file imports', async () => {
    const files = [
      paymentService,
      sourceFile(
        'tests/payment.test.js',
        [
          "import { it, expect } from 'vitest';",
          "const { charge } = require('../src/services/payment-service');",
          "it('charges', () => { expect(charge).toBeDefined(); });",
        ].join('\n'),
      ),
    ];

    const findings = await testingScanner.scan(scanContext(files));

    expect(ruleIds(findings)).not.toContain('testing/untested-module');
  });

  it('rates a non-risky module lower than a high-risk one', async () => {
    const files = [
      sourceFile('src/reporting.js', `${'const x = 1;\n'.repeat(60)}module.exports = { x };`),
      sourceFile('tests/keep.test.js', "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });"),
    ];

    const findings = await testingScanner.scan(scanContext(files));
    const untested = findings.filter((f) => f.ruleId === 'testing/untested-module');

    expect(untested).toHaveLength(1);
    expect(untested[0]?.severity).toBe('low');
    expect(untested[0]?.metadata?.highRisk).toBe(false);
  });
});

describe('testing scanner — false positive suppression', () => {
  const keepSuite = sourceFile(
    'tests/keep.test.js',
    "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });",
  );

  async function untestedFor(file: ReturnType<typeof sourceFile>) {
    const findings = await testingScanner.scan(scanContext([file, keepSuite]));
    return findings.filter((f) => f.ruleId === 'testing/untested-module');
  }

  it('ignores tiny files', async () => {
    expect(await untestedFor(sourceFile('src/tiny.js', 'module.exports = { a: 1 };'))).toEqual([]);
  });

  it('ignores index, types, constants and config modules', async () => {
    for (const name of ['index.js', 'types.ts', 'constants.js', 'config.js']) {
      const file = sourceFile(`src/${name}`, `${'const x = 1;\n'.repeat(60)}module.exports = { x };`);
      expect(await untestedFor(file), name).toEqual([]);
    }
  });

  it('ignores a module that exports nothing', async () => {
    const file = sourceFile('src/script.js', `${'console.log(1);\n'.repeat(60)}`);
    expect(await untestedFor(file)).toEqual([]);
  });

  it('ignores a small non-risky module below the size threshold', async () => {
    const file = sourceFile('src/small.js', `${'const x = 1;\n'.repeat(20)}module.exports = { x };`);
    expect(await untestedFor(file)).toEqual([]);
  });

  it('ignores non-JS/TS/Python languages', async () => {
    const file = sourceFile('src/style.css', `${'.a { color: red; }\n'.repeat(60)}`);
    expect(await untestedFor(file)).toEqual([]);
  });

  it('never reports a test file as untested', async () => {
    const findings = await testingScanner.scan(scanContext([keepSuite]));
    expect(findings.filter((f) => f.filePath === keepSuite.path && f.ruleId === 'testing/untested-module')).toEqual([]);
  });
});

describe('testing scanner — assertion-free tests', () => {
  it('flags a test file that declares cases but asserts nothing', async () => {
    const file = sourceFile(
      'tests/hollow.test.js',
      [
        "import { it } from 'vitest';",
        "it('runs the thing', () => {",
        '  doThing();',
        '});',
      ].join('\n'),
    );

    const findings = await testingScanner.scan(scanContext([file]));
    const hollow = findings.filter((f) => f.ruleId === 'testing/test-without-assertions');

    expect(hollow).toHaveLength(1);
    expect(hollow[0]?.severity).toBe('medium');
    expect(hollow[0]?.filePath).toBe('tests/hollow.test.js');
  });

  it('does not flag a test file that asserts', async () => {
    const file = sourceFile(
      'tests/real.test.js',
      "import { it, expect } from 'vitest';\nit('works', () => { expect(add(1, 2)).toBe(3); });",
    );

    const findings = await testingScanner.scan(scanContext([file]));
    expect(ruleIds(findings)).not.toContain('testing/test-without-assertions');
  });

  it('does not flag a helper file in the test directory that declares no cases', async () => {
    const file = sourceFile(
      'tests/helpers/build.js',
      'function buildUser(overrides) {\n  return { id: 1, ...overrides };\n}\nmodule.exports = { buildUser };',
    );

    const findings = await testingScanner.scan(scanContext([file]));
    expect(ruleIds(findings)).not.toContain('testing/test-without-assertions');
  });
});

describe('testing scanner — contract', () => {
  it('is always available', async () => {
    await expect(testingScanner.isAvailable(scanContext([]))).resolves.toBe(true);
  });

  it('emits only testing-category findings with remediation guidance', async () => {
    const files = [
      sourceFile('src/services/auth-service.js', `${'const x = 1;\n'.repeat(30)}module.exports = { x };`),
      sourceFile('tests/keep.test.js', "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });"),
    ];

    const findings = await testingScanner.scan(scanContext(files));

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.category).toBe('testing');
      expect(finding.scannerId).toBe('testing');
      expect(finding.whyItMatters).toBeTruthy();
      expect(finding.remediation).toBeTruthy();
    }
  });

  it('produces stable, distinct fingerprints per module', async () => {
    const files = [
      sourceFile('src/services/auth-service.js', `${'const x = 1;\n'.repeat(30)}module.exports = { x };`),
      sourceFile('src/services/payment-service.js', `${'const y = 2;\n'.repeat(30)}module.exports = { y };`),
      sourceFile('tests/keep.test.js', "import { it, expect } from 'vitest';\nit('x', () => { expect(1).toBe(1); });"),
    ];
    const ctx = scanContext(files);

    const first = await testingScanner.scan(ctx);
    const second = await testingScanner.scan(ctx);

    expect(first.map((f) => f.fingerprint)).toEqual(second.map((f) => f.fingerprint));
    expect(new Set(first.map((f) => f.fingerprint)).size).toBe(first.length);
  });
});

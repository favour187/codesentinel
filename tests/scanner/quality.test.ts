import { describe, expect, it } from 'vitest';

import { maxIndentDepth, maxNestingDepth, qualityScanner } from '@/scanner/scanners/quality';
import { ruleIds, scanSource } from './helpers/source';

describe('maxNestingDepth', () => {
  it('counts control-flow blocks only, not function or object braces', () => {


    expect(maxNestingDepth('function a() {\n  if (x) {\n    y();\n  }\n}'.split('\n')).depth).toBe(1);
    expect(maxNestingDepth('const o = { a: { b: { c: 1 } } };'.split('\n')).depth).toBe(0);
    expect(maxNestingDepth('class A {\n  m() {\n    return 1;\n  }\n}'.split('\n')).depth).toBe(0);
  });

  it('accumulates genuinely nested control flow', () => {
    const src = 'if (a) {\n  for (;;) {\n    while (b) {\n      c();\n    }\n  }\n}';
    expect(maxNestingDepth(src.split('\n')).depth).toBe(3);
  });

  it('does not count an else-if chain as nesting', () => {
    const src = 'if (a) {\n  x();\n} else if (b) {\n  y();\n} else if (c) {\n  z();\n}';
    expect(maxNestingDepth(src.split('\n')).depth).toBe(1);
  });

  it('ignores braces inside strings and comments', () => {
    expect(maxNestingDepth('if (a) {\n  const s = "{{{{{";\n}'.split('\n')).depth).toBe(1);
    expect(maxNestingDepth('// if (a) { if (b) { if (c) {\nconst x = 1;'.split('\n')).depth).toBe(0);
    expect(maxNestingDepth('/* if (a) {\n if (b) {\n*/\nconst x = 1;'.split('\n')).depth).toBe(0);
  });

  it('reports the line where the deepest nesting occurs', () => {
    const result = maxNestingDepth('if (a) {\n  if (b) {\n    c();\n  }\n}'.split('\n'));
    expect(result.depth).toBe(2);
    expect(result.line).toBe(2);
  });

  it('returns zero for flat code', () => {
    expect(maxNestingDepth('const a = 1;\nconst b = 2;'.split('\n'))).toEqual({ depth: 0, line: 0 });
  });
});

describe('maxIndentDepth', () => {
  it('derives Python nesting from indentation', () => {
    const src = 'def f():\n    if a:\n        for x in y:\n            print(x)';
    expect(maxIndentDepth(src.split('\n')).depth).toBe(3);
  });

  it('ignores comments and blank lines', () => {
    const src = 'def f():\n\n    # deeply indented comment below\n            # noise\n    return 1';
    expect(maxIndentDepth(src.split('\n')).depth).toBe(1);
  });
});

describe('quality scanner — detection', () => {
  it('flags an empty catch block that swallows the error', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/a.js',
      'async function go() {\n  try {\n    await run();\n  } catch (e) {\n  }\n}',
    );
    expect(ruleIds(findings)).toContain('reliability/swallowed-error');
  });

  it('flags an unused local variable', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/a.js',
      'function go() {\n  var unusedHelper = function () { return 1; };\n  return 2;\n}',
    );
    expect(ruleIds(findings)).toContain('quality/unused-variable');
  });

  it('flags excessive control-flow nesting', async () => {
    const src = [
      'function f(a, b, c, d, e) {',
      '  if (a) {',
      '    if (b) {',
      '      if (c) {',
      '        if (d) {',
      '          if (e) {',
      '            work();',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const findings = await scanSource(qualityScanner, 'src/a.js', src);
    expect(ruleIds(findings)).toContain('quality/deep-nesting');
  });
});

describe('quality scanner — false positives', () => {
  it('does not flag a catch block that handles the error', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/a.js',
      'try {\n  run();\n} catch (e) {\n  logger.error("run failed", e);\n  throw e;\n}',
    );
    expect(ruleIds(findings)).not.toContain('reliability/swallowed-error');
  });

  it('does not flag a variable that is used later', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/a.js',
      'function go() {\n  const total = compute();\n  return total + 1;\n}',
    );
    expect(ruleIds(findings)).not.toContain('quality/unused-variable');
  });

  it('does not flag shallow, readable nesting', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/a.js',
      'function f(a) {\n  if (a) {\n    for (const x of a) {\n      use(x);\n    }\n  }\n}',
    );
    expect(ruleIds(findings)).not.toContain('quality/deep-nesting');
  });

  it('leaves clean idiomatic code untouched', async () => {
    const findings = await scanSource(
      qualityScanner,
      'src/math.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}',
    );
    expect(findings).toHaveLength(0);
  });

  it('skips test files', async () => {
    const findings = await scanSource(
      qualityScanner,
      'tests/a.test.js',
      'try {\n  run();\n} catch (e) {\n}',
    );
    expect(findings).toHaveLength(0);
  });
});

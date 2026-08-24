import { describe, expect, it } from 'vitest';
import { createUnifiedDiff, DiffError, locateSnippet, validatePatch } from '@/analysis/diff';

/**
 * The diff layer is what stops an ungrounded AI fix from reaching a reviewer
 * as though it were real. Its central guarantee: a patch is only produced when
 * the code it claims to replace actually exists in the file.
 */

const SOURCE = [
  'import { db } from "./db";',
  '',
  'export async function getUser(id) {',
  '  const query = "SELECT * FROM users WHERE id = " + id;',
  '  return db.raw(query);',
  '}',
  '',
  'export function health() {',
  '  return { ok: true };',
  '}',
].join('\n');

describe('locateSnippet', () => {
  it('finds an exact match and returns its 0-based line', () => {
    expect(locateSnippet(SOURCE, '  return db.raw(query);')).toBe(4);
  });

  it('finds a multi-line snippet', () => {
    const snippet = '  const query = "SELECT * FROM users WHERE id = " + id;\n  return db.raw(query);';
    expect(locateSnippet(SOURCE, snippet)).toBe(3);
  });

  it('tolerates indentation drift, which models introduce constantly', () => {
    const reindented = 'const query = "SELECT * FROM users WHERE id = " + id;\nreturn db.raw(query);';
    expect(locateSnippet(SOURCE, reindented)).toBe(3);
  });

  it('returns -1 for code that is not in the file', () => {
    expect(locateSnippet(SOURCE, 'const totallyDifferent = 42;')).toBe(-1);
  });

  it('returns -1 for an empty snippet rather than matching everything', () => {
    expect(locateSnippet(SOURCE, '')).toBe(-1);
    expect(locateSnippet(SOURCE, '   \n  ')).toBe(-1);
  });
});

describe('createUnifiedDiff', () => {
  const fix = {
    path: 'src/users.js',
    content: SOURCE,
    originalCode: '  const query = "SELECT * FROM users WHERE id = " + id;\n  return db.raw(query);',
    fixedCode: '  const query = "SELECT * FROM users WHERE id = ?";\n  return db.raw(query, [id]);',
  };

  it('produces a unified diff with correct headers', () => {
    const { diff } = createUnifiedDiff(fix);

    expect(diff.text).toContain('--- a/src/users.js');
    expect(diff.text).toContain('+++ b/src/users.js');
    expect(diff.text).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it('marks removed lines with - and added lines with +', () => {
    const { diff } = createUnifiedDiff(fix);

    expect(diff.text).toContain('-  const query = "SELECT * FROM users WHERE id = " + id;');
    expect(diff.text).toContain('+  const query = "SELECT * FROM users WHERE id = ?";');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(2);
  });

  it('includes surrounding context lines', () => {
    const { diff } = createUnifiedDiff(fix);
    expect(diff.text).toContain(' export async function getUser(id) {');
  });

  it('applies the change to produce the patched file', () => {
    const { patched } = createUnifiedDiff(fix);

    expect(patched).toContain('db.raw(query, [id])');
    expect(patched).not.toContain('WHERE id = " + id');
    // Everything else must survive untouched.
    expect(patched).toContain('export function health() {');
    expect(patched).toContain('import { db } from "./db";');
  });

  it('REJECTS a fix whose original code is not in the file', () => {
    expect(() =>
      createUnifiedDiff({
        path: 'src/users.js',
        content: SOURCE,
        originalCode: 'const stmt = prepare("SELECT * FROM accounts");',
        fixedCode: 'const stmt = prepare("SELECT * FROM accounts WHERE id = ?");',
      }),
    ).toThrow(DiffError);
  });

  it('rejects a no-op change', () => {
    expect(() =>
      createUnifiedDiff({
        path: 'src/users.js',
        content: SOURCE,
        originalCode: '  return db.raw(query);',
        fixedCode: '  return db.raw(query);',
      }),
    ).toThrow(DiffError);
  });

  it('re-indents a fix the model returned flush-left', () => {
    const { patched } = createUnifiedDiff({
      path: 'src/users.js',
      content: SOURCE,
      originalCode: 'const query = "SELECT * FROM users WHERE id = " + id;',
      fixedCode: 'const query = "SELECT * FROM users WHERE id = ?";',
    });

    expect(patched).toContain('  const query = "SELECT * FROM users WHERE id = ?";');
    expect(patched).not.toContain('\nconst query');
  });

  it('handles a fix at the very first line', () => {
    const { patched, diff } = createUnifiedDiff({
      path: 'src/users.js',
      content: SOURCE,
      originalCode: 'import { db } from "./db";',
      fixedCode: 'import { db } from "./db.js";',
    });

    expect(patched.startsWith('import { db } from "./db.js";')).toBe(true);
    expect(diff.hunks[0]?.oldStart).toBe(1);
  });

  it('handles a fix at the very last line', () => {
    const { patched } = createUnifiedDiff({
      path: 'src/users.js',
      content: SOURCE,
      originalCode: '  return { ok: true };',
      fixedCode: '  return { ok: true, version: 2 };',
    });

    expect(patched).toContain('version: 2');
    expect(patched.split('\n')).toHaveLength(SOURCE.split('\n').length);
  });

  it('supports a fix that adds more lines than it removes', () => {
    const { patched, diff } = createUnifiedDiff({
      path: 'src/users.js',
      content: SOURCE,
      originalCode: '  return db.raw(query);',
      fixedCode: '  if (!id) throw new Error("id required");\n  return db.raw(query);',
    });

    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(patched).toContain('id required');
  });
});

describe('validatePatch', () => {
  const path = 'src/users.js';

  it('accepts a sound patch', () => {
    const result = validatePatch({
      originalContent: SOURCE,
      patchedContent: SOURCE.replace('db.raw(query)', 'db.raw(query, [id])'),
      path,
    });

    expect(result.valid).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('rejects an empty result', () => {
    const result = validatePatch({ originalContent: SOURCE, patchedContent: '   ', path });

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('empty');
  });

  it('flags a patch that deletes most of the file', () => {
    const long = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const result = validatePatch({ originalContent: long, patchedContent: 'const v0 = 0;', path });

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/half the file/);
  });

  it('detects unclosed brackets from a truncated completion', () => {
    const result = validatePatch({
      originalContent: SOURCE,
      patchedContent: 'export function getUser(id) {\n  return db.query(id);',
      path,
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/unclosed|truncated/i);
  });

  it('does not mistake brackets inside strings or comments for imbalance', () => {
    const tricky = [
      'const pattern = "function foo() {";',
      "const other = '}';",
      '// a stray } in a comment',
      '/* and { another */',
      'const tpl = `a ${"}"} b`;',
      'export const ok = true;',
    ].join('\n');

    const result = validatePatch({ originalContent: tricky, patchedContent: tricky, path });
    expect(result.problems.join(' ')).not.toMatch(/bracket/i);
  });

  it('refuses a patch that introduces a hardcoded credential', () => {
    const result = validatePatch({
      originalContent: SOURCE,
      patchedContent: `${SOURCE}\nconst key = "sk_live_abcdefghijklmnop";`,
      path,
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/credential/i);
  });

  it('flags a patch that leaves a placeholder to fill in', () => {
    const result = validatePatch({
      originalContent: SOURCE,
      patchedContent: SOURCE.replace('db.raw(query)', 'db.raw(query) // TODO: implement properly'),
      path,
    });

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/placeholder/i);
  });

  it('does not flag a placeholder that was already in the original', () => {
    const withTodo = `${SOURCE}\n// TODO: implement caching`;
    const result = validatePatch({
      originalContent: withTodo,
      patchedContent: withTodo.replace('db.raw(query)', 'db.raw(query, [id])'),
      path,
    });

    expect(result.problems.join(' ')).not.toMatch(/placeholder/i);
  });

  it('skips the bracket check for non-code files', () => {
    const result = validatePatch({
      originalContent: '# Readme\n\nSome text {',
      patchedContent: '# Readme\n\nSome updated text {',
      path: 'README.md',
    });

    expect(result.valid).toBe(true);
  });
});

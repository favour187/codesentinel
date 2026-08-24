/**
 * Unified diff generation and validation.
 *
 * A generated fix is only trustworthy if the "before" text it claims to
 * replace is actually in the file. Everything here exists to enforce that: the
 * diff is computed by us from verified content, never taken from the model's
 * own diff output, which is frequently misnumbered even when the code change
 * is correct.
 */

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

export interface UnifiedDiff {
  readonly path: string;
  readonly text: string;
  readonly hunks: readonly DiffHunk[];
  readonly additions: number;
  readonly deletions: number;
}

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffError';
  }
}

/**
 * Locate `snippet` inside `content`, tolerating indentation drift.
 *
 * Models reproduce code with the leading whitespace subtly altered often
 * enough that exact matching alone would reject many correct fixes. Exact
 * matching is tried first; the indentation-insensitive pass is a fallback and
 * still requires every line to match after trimming, so it cannot silently
 * patch the wrong region.
 *
 * Returns the 0-based line index, or -1.
 */
export function locateSnippet(content: string, snippet: string): number {
  const contentLines = content.split('\n');
  const snippetLines = snippet.replace(/\s+$/, '').split('\n');
  if (snippetLines.length === 0 || snippet.trim() === '') return -1;

  const exact = content.indexOf(snippet);
  if (exact !== -1) return content.slice(0, exact).split('\n').length - 1;

  const trimmed = snippetLines.map((l) => l.trim()).filter((l) => l !== '');
  if (trimmed.length === 0) return -1;

  for (let i = 0; i <= contentLines.length - snippetLines.length; i += 1) {
    const window = contentLines.slice(i, i + snippetLines.length).map((l) => l.trim());
    const windowNonEmpty = window.filter((l) => l !== '');
    if (windowNonEmpty.length !== trimmed.length) continue;
    if (windowNonEmpty.every((line, j) => line === trimmed[j])) return i;
  }

  return -1;
}

/**
 * Apply a snippet replacement and produce a verified unified diff.
 *
 * Throws when the original snippet is not present: that means the model
 * invented the code it claims to be fixing, and the only safe response is to
 * refuse rather than to guess a location.
 */
export function createUnifiedDiff(options: {
  path: string;
  content: string;
  originalCode: string;
  fixedCode: string;
  contextLines?: number;
}): { diff: UnifiedDiff; patched: string } {
  const { path, content, originalCode, fixedCode, contextLines = 3 } = options;

  if (originalCode === fixedCode) {
    throw new DiffError('The proposed fix is identical to the current code.');
  }

  const startLine = locateSnippet(content, originalCode);
  if (startLine === -1) {
    throw new DiffError(
      'The code the fix claims to replace was not found in the current file. The fix was rejected as ungrounded.',
    );
  }

  const contentLines = content.split('\n');
  const originalLines = originalCode.replace(/\s+$/, '').split('\n');
  const fixedLines = fixedCode.replace(/\s+$/, '').split('\n');

  /*
   * Re-apply the original indentation. When the snippet matched only after
   * trimming, the replacement would otherwise be flush-left and mangle the
   * file even though the change itself is right.
   */
  const originalIndent = leadingWhitespace(contentLines[startLine] ?? '');
  const fixedIndent = leadingWhitespace(fixedLines[0] ?? '');
  const reindented =
    originalIndent === fixedIndent
      ? fixedLines
      : fixedLines.map((line) => applyIndent(line, originalIndent, fixedIndent));

  const patchedLines = [
    ...contentLines.slice(0, startLine),
    ...reindented,
    ...contentLines.slice(startLine + originalLines.length),
  ];

  const contextBefore = Math.max(0, startLine - contextLines);
  const contextAfterEnd = Math.min(contentLines.length, startLine + originalLines.length + contextLines);

  const hunkLines: string[] = [];
  for (let i = contextBefore; i < startLine; i += 1) hunkLines.push(` ${contentLines[i]}`);
  for (const line of originalLines) hunkLines.push(`-${line}`);
  for (const line of reindented) hunkLines.push(`+${line}`);
  for (let i = startLine + originalLines.length; i < contextAfterEnd; i += 1) {
    hunkLines.push(` ${contentLines[i]}`);
  }

  const leadingContext = startLine - contextBefore;
  const trailingContext = contextAfterEnd - (startLine + originalLines.length);

  const hunk: DiffHunk = {
    oldStart: contextBefore + 1,
    oldLines: leadingContext + originalLines.length + trailingContext,
    newStart: contextBefore + 1,
    newLines: leadingContext + reindented.length + trailingContext,
    lines: hunkLines,
  };

  const text = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunkLines,
  ].join('\n');

  return {
    diff: {
      path,
      text,
      hunks: [hunk],
      additions: reindented.length,
      deletions: originalLines.length,
    },
    patched: patchedLines.join('\n'),
  };
}

/**
 * Sanity-check a patch before it is ever shown as applicable.
 *
 * These are cheap structural checks, not a substitute for human review — which
 * is required regardless. They catch the failure modes that would otherwise
 * waste a reviewer's time or, worse, look plausible.
 */
export function validatePatch(options: {
  originalContent: string;
  patchedContent: string;
  path: string;
}): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const { originalContent, patchedContent, path } = options;

  if (patchedContent.trim() === '') {
    problems.push('The patched file would be empty.');
  }

  const originalLineCount = originalContent.split('\n').length;
  const patchedLineCount = patchedContent.split('\n').length;
  if (patchedLineCount < originalLineCount * 0.5 && originalLineCount > 20) {
    problems.push(
      `The patch removes more than half the file (${originalLineCount} lines to ${patchedLineCount}).`,
    );
  }

  if (/\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(path)) {
    const balance = checkBalance(patchedContent);
    if (balance) problems.push(balance);
  }

  // A fix that introduces a literal secret is worse than the finding it closes.
  if (/(sk_live_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(patchedContent)) {
    problems.push('The patched content appears to contain a hardcoded credential.');
  }

  if (/\[REDACTED|\bTODO\b.*(implement|fill in)|<your[- ]/i.test(patchedContent.slice(0, 100000))) {
    const introduced = !/\[REDACTED|\bTODO\b.*(implement|fill in)|<your[- ]/i.test(originalContent);
    if (introduced) problems.push('The patch contains a placeholder that must be filled in manually.');
  }

  return { valid: problems.length === 0, problems };
}

/**
 * Bracket balance check.
 *
 * Deliberately not a parser: it must work for several languages and only needs
 * to catch the common truncated-output failure. Strings and comments are
 * skipped so their contents cannot produce a false alarm.
 */
function checkBalance(source: string): string | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const closers = new Set([')', ']', '}']);
  const stack: string[] = [];

  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === inString) inString = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    if (pairs[char]) stack.push(pairs[char]);
    else if (closers.has(char)) {
      if (stack.pop() !== char) return `Unbalanced brackets in the patched file (unexpected "${char}").`;
    }
  }

  if (stack.length > 0) return 'The patched file has unclosed brackets — the fix looks truncated.';
  return null;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function applyIndent(line: string, targetIndent: string, sourceIndent: string): string {
  if (line.trim() === '') return '';
  if (sourceIndent && line.startsWith(sourceIndent)) {
    return targetIndent + line.slice(sourceIndent.length);
  }
  return targetIndent + line.replace(/^[ \t]*/, '');
}

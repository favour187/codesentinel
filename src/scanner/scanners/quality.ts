import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';











const SCANNER_ID = 'quality';












export function maxNestingDepth(lines: readonly string[]): { depth: number; line: number } {

  const stack: boolean[] = [];
  let depth = 0;
  let maxDepth = 0;
  let maxLine = 0;
  let inBlockComment = false;

  const CONTROL = /\b(?:if|else|for|while|do|switch|try|catch|finally)\b\s*[({]?[^{]*$/;

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] ?? '';

    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1) {
      inBlockComment = line.indexOf('*/', blockStart) === -1;
      line = line.slice(0, blockStart);
    }

    line = line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');

    for (let c = 0; c < line.length; c += 1) {
      const char = line[c];
      if (char === '{') {


        const isControl = CONTROL.test(line.slice(0, c));
        stack.push(isControl);
        if (isControl) {
          depth += 1;
          if (depth > maxDepth) {
            maxDepth = depth;
            maxLine = i + 1;
          }
        }
      } else if (char === '}') {
        if (stack.pop() === true) depth = Math.max(0, depth - 1);
      }
    }
  }

  return { depth: maxDepth, line: maxLine };
}


export function maxIndentDepth(lines: readonly string[]): { depth: number; line: number } {
  let maxDepth = 0;
  let maxLine = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const leading = line.length - line.trimStart().length;
    const depth = Math.floor(leading / 4);
    if (depth > maxDepth) {
      maxDepth = depth;
      maxLine = i + 1;
    }
  }
  return { depth: maxDepth, line: maxLine };
}






export function estimateComplexity(content: string): number {
  const branches = content.match(
    /\b(?:if|else\s+if|elif|for|while|case|catch|except)\b|&&|\|\||\?\?|\?[^.:]/g,
  );
  return 1 + (branches?.length ?? 0);
}

const NESTING_THRESHOLD = 5;

function scanErrorHandling(file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  for (let i = 0; i < file.lines.length; i += 1) {
    const line = file.lines[i] ?? '';
    const trimmed = line.trim();


    const catchMatch = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(trimmed) || /^\s*except[^:]*:\s*$/.test(line);
    if (catchMatch) {

      const body: string[] = [];
      for (let j = i + 1; j < Math.min(file.lines.length, i + 6); j += 1) {
        const next = (file.lines[j] ?? '').trim();
        if (next === '}' || (file.language === 'python' && next && !next.startsWith('#') && body.length > 0)) break;
        body.push(next);
        if (file.language === 'python' && next && !next.startsWith('#')) break;
      }

      const meaningful = body.filter(
        (l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*'),
      );
      const onlyPass = meaningful.length === 0 || meaningful.every((l) => /^(?:pass|;)$/.test(l));

      if (onlyPass) {
        findings.push(
          createFinding({
            ruleId: 'reliability/swallowed-error',
            scannerId: SCANNER_ID,
            severity: 'medium',
            category: 'reliability',
            title: 'Error silently swallowed by empty catch block',
            description: 'An exception is caught and then discarded without logging, rethrowing or handling.',
            filePath: file.path,
            lineStart: i + 1,
            lineEnd: Math.min(file.lines.length, i + 1 + body.length),
            evidence: trimmed,
            confidence: 0.85,
            whyItMatters:
              'The operation fails but the program continues as if it succeeded. Data loss and corrupted state surface much later, far from the cause, and nothing is recorded to debug it — this is one of the most common sources of unexplained production behaviour.',
            remediation:
              'Log the error with context and rethrow, or handle it explicitly and document why it is safe to ignore: catch (err) { logger.error("delete user failed", { id, err }); throw err; }',
            references: [
              { label: 'CWE-390: Detection of Error Condition Without Action', url: 'https://cwe.mitre.org/data/definitions/390.html' },
            ],
            fingerprintSeed: `swallowed-error:${trimmed}:${i}`,
          }),
        );
      }
    }


    const chain = /\breturn\s+(\w+)\.(\w+)\.(\w+)/.exec(trimmed);
    if (chain && !trimmed.includes('?.') && !/\bthis\b|\bwindow\b|\bprocess\b|\bJSON\b|\bMath\b/.test(trimmed)) {
      findings.push(
        createFinding({
          ruleId: 'bugs/unchecked-property-access',
          scannerId: SCANNER_ID,
          severity: 'medium',
          category: 'bugs',
          title: 'Unchecked nested property access',
          description: `A nested property chain (${chain[1]}.${chain[2]}.${chain[3]}) is dereferenced without a null check.`,
          filePath: file.path,
          lineStart: i + 1,
          evidence: trimmed,
          confidence: 0.6,
          whyItMatters:
            'If any link in the chain is null or undefined this throws a TypeError at runtime. In a request handler that becomes a 500 for the user; in a background job it can abort the whole batch.',
          remediation:
            'Use optional chaining with a sensible default (user?.profile?.displayName ?? "Unknown"), or validate the shape at the boundary before use.',
          references: [
            { label: 'CWE-476: NULL Pointer Dereference', url: 'https://cwe.mitre.org/data/definitions/476.html' },
          ],
        }),
      );
    }


    if (/(?:amount|price|total|cost|balance|refund|fee|salary)\w*\s*[*/]\s*\d|\*\s*100\b/i.test(trimmed) &&
        /amount|price|total|cost|balance|refund|fee|cents|usd/i.test(trimmed) &&
        !/toFixed|Math\.round|Decimal|BigInt|Number\.isInteger/.test(trimmed)) {
      findings.push(
        createFinding({
          ruleId: 'bugs/float-currency-arithmetic',
          scannerId: SCANNER_ID,
          severity: 'medium',
          category: 'bugs',
          title: 'Floating-point arithmetic on currency values',
          description: 'A monetary value is computed with binary floating-point arithmetic.',
          filePath: file.path,
          lineStart: i + 1,
          evidence: trimmed,
          confidence: 0.55,
          whyItMatters:
            'IEEE-754 cannot represent most decimal fractions exactly (19.99 * 100 = 1998.9999999999998). Rounding drift produces off-by-one-cent charges, failed reconciliation and, in payment code, real financial discrepancies.',
          remediation:
            'Represent money as integer minor units (cents) throughout, or use a decimal library such as decimal.js. Round explicitly at the boundary: Math.round(amountUsd * 100).',
          references: [
            { label: 'CWE-681: Incorrect Conversion between Numeric Types', url: 'https://cwe.mitre.org/data/definitions/681.html' },
          ],
        }),
      );
    }


    if (/function\s+\w*(?:discount|percent|rate|ratio)/i.test(trimmed) ||
        /(?:discount|percent)\w*\s*\/\s*100/i.test(trimmed)) {
      const hasGuard = file.content.includes('Math.min') || file.content.includes('Math.max') ||
        /if\s*\([^)]*(?:percent|discount)[^)]*[<>]/i.test(file.content);
      if (!hasGuard && /\/\s*100/.test(trimmed)) {
        findings.push(
          createFinding({
            ruleId: 'bugs/missing-bounds-check',
            scannerId: SCANNER_ID,
            severity: 'low',
            category: 'bugs',
            title: 'Percentage value used without bounds checking',
            description: 'A percentage is applied without validating that it falls within an expected range.',
            filePath: file.path,
            lineStart: i + 1,
            evidence: trimmed,
            confidence: 0.5,
            whyItMatters:
              'A value above 100 or below 0 silently produces a nonsensical result — a negative total, or a refund larger than the original charge. Because nothing throws, the bad value propagates into stored records.',
            remediation: 'Clamp and validate the input at the entry point: if (percent < 0 || percent > 100) throw new RangeError("percent must be 0-100").',
            references: [
              { label: 'CWE-20: Improper Input Validation', url: 'https://cwe.mitre.org/data/definitions/20.html' },
            ],
          }),
        );
      }
    }
  }

  return findings;
}

function scanStructure(file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  const nesting =
    file.language === 'python' ? maxIndentDepth(file.lines) : maxNestingDepth(file.lines);

  if (nesting.depth >= NESTING_THRESHOLD) {
    findings.push(
      createFinding({
        ruleId: 'quality/deep-nesting',
        scannerId: SCANNER_ID,
        severity: nesting.depth >= 7 ? 'medium' : 'low',
        category: 'quality',
        title: `Excessive nesting depth (${nesting.depth} levels)`,
        description: `Control flow in this file nests ${nesting.depth} levels deep, well past the point where it can be read comfortably.`,
        filePath: file.path,
        lineStart: nesting.line,
        evidence: (file.lines[nesting.line - 1] ?? '').trim(),
        confidence: 0.9,
        whyItMatters:
          'Every level of nesting multiplies the paths a reader must hold in their head, and deeply nested conditionals are where edge cases go unhandled. Such code is also disproportionately hard to unit test, so it tends to stay untested.',
        remediation:
          'Invert conditions and return early to flatten the happy path, then extract the inner block into a named function that can be tested in isolation.',
        references: [{ label: 'Cyclomatic complexity', url: 'https://en.wikipedia.org/wiki/Cyclomatic_complexity' }],
        metadata: { depth: nesting.depth },
        fingerprintSeed: `deep-nesting:${file.path}`,
      }),
    );
  }

  const complexity = estimateComplexity(file.content);
  if (complexity > 25) {
    findings.push(
      createFinding({
        ruleId: 'quality/high-complexity',
        scannerId: SCANNER_ID,
        severity: 'low',
        category: 'quality',
        title: `High cyclomatic complexity (~${complexity})`,
        description: `This file contains roughly ${complexity} independent branch points.`,
        filePath: file.path,
        lineStart: 1,
        confidence: 0.7,
        whyItMatters:
          'Branch count is a direct lower bound on the number of test cases needed for full coverage. High-complexity files correlate strongly with defect density and are the usual home of regressions.',
        remediation: 'Break the file into smaller modules with single responsibilities and cover each branch with a focused test.',
        references: [],
        metadata: { complexity },
        fingerprintSeed: `high-complexity:${file.path}`,
      }),
    );
  }


  if (file.language === 'javascript' || file.language === 'typescript') {
    const declarations = [...file.content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)];
    for (const declaration of declarations) {
      const name = declaration[1];
      if (!name || name.startsWith('_')) continue;
      const uses = file.content.split(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)).length - 1;
      if (uses <= 1) {
        const line = file.content.slice(0, declaration.index).split('\n').length;
        findings.push(
          createFinding({
            ruleId: 'quality/unused-variable',
            scannerId: SCANNER_ID,
            severity: 'info',
            category: 'quality',
            title: `Unused variable "${name}"`,
            description: `"${name}" is declared but never referenced anywhere in the file.`,
            filePath: file.path,
            lineStart: line,
            evidence: (file.lines[line - 1] ?? '').trim(),
            confidence: 0.75,
            whyItMatters:
              'Dead code misleads readers into thinking it is load-bearing, and an unused variable is sometimes the residue of a refactor that left a real bug — the value was computed but the intended use was dropped.',
            remediation: 'Remove the declaration, or prefix it with an underscore if it is deliberately unused.',
            references: [],
            fingerprintSeed: `unused-variable:${file.path}:${name}`,
          }),
        );
      }
    }
  }

  return findings;
}

export const qualityScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Code quality & reliability scanner',
  description: 'Finds error-handling defects, likely runtime bugs, excessive complexity and dead code.',
  categories: ['quality', 'reliability', 'bugs'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const analysable = ['javascript', 'typescript', 'python', 'go', 'java', 'ruby', 'php'];
    for (const file of ctx.files) {
      if (!analysable.includes(file.language)) continue;
      if (file.isTest) continue;
      findings.push(...scanErrorHandling(file), ...scanStructure(file));
    }
    return findings;
  },
};

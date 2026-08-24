import ts from 'typescript';
import {
  emptyParsedFile,
  type LanguageParser,
  type ParsedCall,
  type ParsedDatabaseUse,
  type ParsedFile,
  type ParsedImport,
  type ParsedRoute,
  type ParsedSymbol,
} from './types';

/**
 * TypeScript / JavaScript parser.
 *
 * Uses the TypeScript compiler's own parser, which is already a dependency of
 * the project and is the only realistic way to get correct results for modern
 * syntax (decorators, generics, JSX, optional chaining). Crucially it is a
 * *parser*, not an evaluator: `createSourceFile` builds an AST from text and
 * executes nothing, which is exactly what analysing untrusted repository code
 * requires.
 *
 * Type checking is deliberately NOT used. A full type-checked program needs
 * every dependency installed and resolvable, which is false for most cloned
 * repositories and would make indexing cost minutes instead of milliseconds.
 * Everything below is derived from syntax alone.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']);

/** Router-ish receivers: app.get(...), router.post(...), api.use(...). */
const ROUTER_RECEIVERS = /^(app|router|server|api|r)$/i;

const SQL_STATEMENT =
  /\b(select\s+[\s\S]{0,200}?\bfrom\b|insert\s+into\b|update\s+[a-z_][\w".]*\s+set\b|delete\s+from\b|create\s+table\b|drop\s+table\b)/i;

/** ORM/query-builder surfaces worth recording as a database touch. */
/*
 * Members distinctive enough to imply a database on their own — no other
 * common API uses these names.
 */
const ORM_MEMBERS_DISTINCTIVE = new Set([
  'findone',
  'findmany',
  'findunique',
  'findall',
  'findbypk',
  'upsert',
  'createquerybuilder',
]);

/*
 * Members that are only a database touch when the receiver is itself a
 * database handle. `update` in particular is shared with plenty of unrelated
 * APIs — `crypto.createHash('md5').update(x)` is a hash, not a write, and
 * recording it as one would be an invented relationship.
 */
const ORM_MEMBERS_AMBIGUOUS = new Set([
  'query',
  'execute',
  'insert',
  'update',
  'delete',
  'aggregate',
  'transaction',
]);

/**
 * Identifier names that conventionally hold a database handle. Used only to
 * qualify the ambiguous members above, never to create an edge by itself.
 */
const DB_RECEIVER_NAME =
  /^(db|database|prisma|knex|sequelize|mongoose|conn|connection|pool|client|datasource|orm|em|entitymanager|queryrunner|repo|repository|trx|tx|session|store|collection|model|table|sql)$/i;

const DB_CLIENT_MODULES =
  /^(pg|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|knex|redis|ioredis)(\/|$)/;

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Branch-like nodes, matching the complexity proxy used elsewhere. */
function complexityOf(node: ts.Node): number {
  let score = 0;
  const visit = (n: ts.Node): void => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        score += 1;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          score += 1;
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return score;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === kind) ?? false;
}

function parameterNames(params: ts.NodeArray<ts.ParameterDeclaration>): string[] {
  return params.map((p, i) => {
    if (ts.isIdentifier(p.name)) return p.name.text;
    // Destructured parameters have no single name; record their shape position.
    return `arg${i}`;
  });
}

/** Declaration text with the body stripped — enough to write a call against. */
function signatureOf(sf: ts.SourceFile, node: ts.Node, body?: ts.Node): string {
  const full = node.getText(sf);
  if (!body) return full.slice(0, 300).trim();
  const bodyStart = body.getStart(sf) - node.getStart(sf);
  return full.slice(0, Math.max(0, bodyStart)).trim().slice(0, 300);
}

function stringLiteralOf(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

class TypeScriptParser implements LanguageParser {
  readonly id = 'typescript';
  /** Language ids as produced by scanner/discovery's detectLanguage. */
  readonly languages = ['typescript', 'javascript'] as const;

  parse(path: string, content: string): ParsedFile {
    try {
      return this.parseUnsafe(path, content);
    } catch (err) {
      /*
       * A parser crash must degrade to "no detail for this file", never take
       * down an index run. Malformed or hostile source is expected input.
       */
      return emptyParsedFile(path, 'typescript', err instanceof Error ? err.message : String(err));
    }
  }

  private parseUnsafe(path: string, content: string): ParsedFile {
    const jsx = /\.(tsx|jsx)$/.test(path);
    const sf = ts.createSourceFile(
      path,
      content,
      { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
      /* setParentNodes */ true,
      jsx ? ts.ScriptKind.TSX : /\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );

    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];
    const routes: ParsedRoute[] = [];
    const databaseUses: ParsedDatabaseUse[] = [];
    const calls: ParsedCall[] = [];

    /** Innermost named declaration, so a call can be attributed to a symbol. */
    const symbolStack: string[] = [];

    const pushSymbol = (s: ParsedSymbol): void => {
      symbols.push(s);
    };

    const visit = (node: ts.Node): void => {
      /* ---------------- imports ---------------- */
      if (ts.isImportDeclaration(node)) {
        const spec = stringLiteralOf(node.moduleSpecifier);
        if (spec) {
          const named: string[] = [];
          const clause = node.importClause;
          if (clause?.name) named.push(clause.name.text);
          if (clause?.namedBindings) {
            if (ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) named.push(el.name.text);
            } else if (ts.isNamespaceImport(clause.namedBindings)) {
              named.push(clause.namedBindings.name.text);
            }
          }
          imports.push({
            specifier: spec,
            imported: named,
            line: lineOf(sf, node.getStart(sf)),
            isRelative: spec.startsWith('.'),
          });
          if (DB_CLIENT_MODULES.test(spec)) {
            databaseUses.push({
              target: null,
              via: 'client',
              line: lineOf(sf, node.getStart(sf)),
              evidence: `imports '${spec}'`,
            });
          }
        }
      }

      // export ... from './x' also creates an import relationship.
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = stringLiteralOf(node.moduleSpecifier);
        if (spec) {
          imports.push({
            specifier: spec,
            imported: [],
            line: lineOf(sf, node.getStart(sf)),
            isRelative: spec.startsWith('.'),
          });
        }
      }

      /* ---------------- require() and dynamic import() ---------------- */
      if (ts.isCallExpression(node)) {
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) {
          const spec = stringLiteralOf(node.arguments[0]);
          if (spec) {
            imports.push({
              specifier: spec,
              imported: this.requireBindings(node),
              line: lineOf(sf, node.getStart(sf)),
              isRelative: spec.startsWith('.'),
            });
            if (DB_CLIENT_MODULES.test(spec)) {
              databaseUses.push({
                target: null,
                via: 'client',
                line: lineOf(sf, node.getStart(sf)),
                evidence: `requires '${spec}'`,
              });
            }
          }
        }

        this.collectCall(sf, node, symbolStack, calls);
        this.collectRoute(sf, node, routes);
        this.collectOrmUse(sf, node, databaseUses);
      }

      /* ---------------- raw SQL in string/template literals ---------------- */
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const text = ts.isTemplateExpression(node) ? node.getText(sf) : node.text;
        const match = SQL_STATEMENT.exec(text);
        if (match) {
          databaseUses.push({
            target: this.tableFrom(text),
            via: 'sql',
            line: lineOf(sf, node.getStart(sf)),
            evidence: text.trim().replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      }

      /* ---------------- declarations ---------------- */
      let pushedScope = false;

      if (ts.isFunctionDeclaration(node) && node.name) {
        pushSymbol({
          name: node.name.text,
          kind: 'function',
          lineStart: lineOf(sf, node.getStart(sf)),
          lineEnd: lineOf(sf, node.getEnd()),
          isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
          isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
          parameters: parameterNames(node.parameters),
          parentName: null,
          complexity: complexityOf(node),
          signature: signatureOf(sf, node, node.body),
        });
        if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) exports.push(node.name.text);
        symbolStack.push(node.name.text);
        pushedScope = true;
      } else if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        pushSymbol({
          name: className,
          kind: 'class',
          lineStart: lineOf(sf, node.getStart(sf)),
          lineEnd: lineOf(sf, node.getEnd()),
          isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
          isAsync: false,
          parameters: [],
          parentName: null,
          complexity: complexityOf(node),
          signature: `class ${className}`,
        });
        if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) exports.push(className);

        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
            const name = ts.isConstructorDeclaration(member)
              ? 'constructor'
              : ts.isIdentifier(member.name)
                ? member.name.text
                : member.name.getText(sf);
            pushSymbol({
              name,
              kind: 'method',
              lineStart: lineOf(sf, member.getStart(sf)),
              lineEnd: lineOf(sf, member.getEnd()),
              isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
              isAsync: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
              parameters: parameterNames(member.parameters),
              parentName: className,
              complexity: complexityOf(member),
              signature: signatureOf(sf, member, member.body),
            });
          }
        }
        symbolStack.push(className);
        pushedScope = true;
      } else if (ts.isInterfaceDeclaration(node)) {
        pushSymbol({
          name: node.name.text,
          kind: 'interface',
          lineStart: lineOf(sf, node.getStart(sf)),
          lineEnd: lineOf(sf, node.getEnd()),
          isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
          isAsync: false,
          parameters: [],
          parentName: null,
          complexity: 0,
          signature: `interface ${node.name.text}`,
        });
        if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) exports.push(node.name.text);
      } else if (ts.isTypeAliasDeclaration(node)) {
        pushSymbol({
          name: node.name.text,
          kind: 'type',
          lineStart: lineOf(sf, node.getStart(sf)),
          lineEnd: lineOf(sf, node.getEnd()),
          isExported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
          isAsync: false,
          parameters: [],
          parentName: null,
          complexity: 0,
          signature: `type ${node.name.text}`,
        });
        if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) exports.push(node.name.text);
      } else if (ts.isVariableStatement(node)) {
        const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        /*
         * Only module-scope declarations are symbols. Locals inside a function
         * body are implementation detail: nothing can import them, nothing can
         * call them from another file, and recording them would bury the real
         * declarations under noise in the graph and the UI.
         */
        const moduleScope = node.parent === sf;
        for (const decl of node.declarationList.declarations) {
          if (!moduleScope) continue;
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer;
          // `const x = require('y')` is an import binding, not a declaration.
          if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require') {
            continue;
          }
          const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          pushSymbol({
            name: decl.name.text,
            kind: isFn ? 'function' : 'variable',
            lineStart: lineOf(sf, decl.getStart(sf)),
            lineEnd: lineOf(sf, decl.getEnd()),
            isExported: exported,
            isAsync: isFn ? hasModifier(init, ts.SyntaxKind.AsyncKeyword) : false,
            parameters: isFn ? parameterNames(init.parameters) : [],
            parentName: null,
            complexity: isFn ? complexityOf(init) : 0,
            signature: isFn ? signatureOf(sf, decl, init.body) : `${decl.name.text}`,
          });
          if (exported) exports.push(decl.name.text);
        }
      }

      /* ---------------- CommonJS exports ---------------- */
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left.getText(sf);
        const cjs = /^(?:module\.exports|exports)\.(\w+)$/.exec(left);
        if (cjs?.[1]) {
          exports.push(cjs[1]);
        } else if (left === 'module.exports' && ts.isObjectLiteralExpression(node.right)) {
          for (const prop of node.right.properties) {
            if (prop.name && ts.isIdentifier(prop.name)) exports.push(prop.name.text);
          }
        }
      }

      /* ---------------- export { a, b } ---------------- */
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) exports.push(el.name.text);
      }

      ts.forEachChild(node, visit);
      if (pushedScope) symbolStack.pop();
    };

    ts.forEachChild(sf, visit);

    /*
     * Back-fill `isExported` from the export list.
     *
     * ESM marks the declaration itself (`export function foo`), so the flag is
     * set as the symbol is created. CommonJS does not: `function foo() {}` is
     * an ordinary declaration and `module.exports = { foo }` at the bottom of
     * the file is what exports it. Without this pass every symbol in a CJS
     * codebase reads as private, which silently empties the test-gap engine
     * and the public-API surface for any repository not yet on ESM.
     */
    const exportedNames = new Set(exports);
    const resolvedSymbols =
      exportedNames.size === 0
        ? symbols
        : symbols.map((s) =>
            !s.isExported && s.parentName === null && exportedNames.has(s.name) ? { ...s, isExported: true } : s,
          );

    return {
      path,
      language: jsx ? 'tsx' : 'typescript',
      symbols: resolvedSymbols,
      imports: dedupeImports(imports),
      exports: [...new Set(exports)],
      routes,
      databaseUses: dedupeDbUses(databaseUses),
      calls,
    };
  }

  /** Bindings from `const { a, b } = require('x')` / `const x = require('x')`. */
  private requireBindings(call: ts.CallExpression): string[] {
    const decl = call.parent;
    if (!decl || !ts.isVariableDeclaration(decl)) return [];
    if (ts.isIdentifier(decl.name)) return [decl.name.text];
    if (ts.isObjectBindingPattern(decl.name)) {
      return decl.name.elements
        .map((el) => (ts.isIdentifier(el.name) ? el.name.text : null))
        .filter((n): n is string => n !== null);
    }
    return [];
  }

  private collectCall(
    sf: ts.SourceFile,
    node: ts.CallExpression,
    stack: readonly string[],
    out: ParsedCall[],
  ): void {
    const enclosing = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
    if (ts.isIdentifier(node.expression)) {
      // Module loading is an import edge, already recorded as one.
      if (node.expression.text === 'require') return;
      out.push({
        callee: node.expression.text,
        receiver: null,
        line: lineOf(sf, node.getStart(sf)),
        enclosingSymbol: enclosing,
      });
    } else if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : null;
      out.push({
        callee: node.expression.name.text,
        receiver,
        line: lineOf(sf, node.getStart(sf)),
        enclosingSymbol: enclosing,
      });
    }
  }

  /** app.get('/path', handler) and friends. */
  private collectRoute(sf: ts.SourceFile, node: ts.CallExpression, out: ParsedRoute[]): void {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text.toLowerCase();
    if (!HTTP_METHODS.has(method)) return;

    const receiverNode = node.expression.expression;
    const receiver = ts.isIdentifier(receiverNode) ? receiverNode.text : null;
    if (!receiver || !ROUTER_RECEIVERS.test(receiver)) return;

    const first = stringLiteralOf(node.arguments[0]);
    if (first === null || !first.startsWith('/')) return;
    // `use` without a handler is middleware mounting, still a real API surface.
    out.push({
      method: method === 'all' || method === 'use' ? 'ANY' : method.toUpperCase(),
      path: first,
      line: lineOf(sf, node.getStart(sf)),
      evidence: `${receiver}.${method}('${first}', …)`,
    });
  }

  private collectOrmUse(sf: ts.SourceFile, node: ts.CallExpression, out: ParsedDatabaseUse[]): void {
    if (!ts.isPropertyAccessExpression(node.expression)) return;
    const member = node.expression.name.text.toLowerCase();
    const receiverText = node.expression.expression.getText(sf).slice(0, 60);

    if (!ORM_MEMBERS_DISTINCTIVE.has(member)) {
      if (!ORM_MEMBERS_AMBIGUOUS.has(member)) return;
      /*
       * Ambiguous member: only a database touch if the receiver looks like a
       * database handle. The receiver is the last identifier in the chain, so
       * `db.users.update()` qualifies on `users`… which is too loose, hence we
       * test the root of the chain as well and accept either.
       */
      const parts = receiverText.split(/[.[\]()]/).filter(Boolean);
      const root = parts[0] ?? '';
      const last = parts[parts.length - 1] ?? '';
      if (!DB_RECEIVER_NAME.test(root) && !DB_RECEIVER_NAME.test(last)) return;
    }

    // `db.query(...)`, `prisma.user.findMany()`, `repo.findOne()`.
    out.push({
      target: this.receiverTarget(receiverText),
      via: 'orm',
      line: lineOf(sf, node.getStart(sf)),
      evidence: `${receiverText}.${node.expression.name.text}(…)`,
    });
  }

  /** `prisma.user` → "user"; `db` → null (no identifiable table). */
  private receiverTarget(receiver: string): string | null {
    const parts = receiver.split('.');
    if (parts.length < 2) return null;
    return parts[parts.length - 1] ?? null;
  }

  private tableFrom(sql: string): string | null {
    const m =
      /\bfrom\s+["'`]?([a-z_][\w.]*)/i.exec(sql) ??
      /\binto\s+["'`]?([a-z_][\w.]*)/i.exec(sql) ??
      /\bupdate\s+["'`]?([a-z_][\w.]*)/i.exec(sql) ??
      /\btable\s+["'`]?([a-z_][\w.]*)/i.exec(sql);
    return m?.[1] ?? null;
  }
}

function dedupeImports(list: readonly ParsedImport[]): ParsedImport[] {
  const seen = new Map<string, ParsedImport>();
  for (const imp of list) {
    const existing = seen.get(imp.specifier);
    if (!existing) {
      seen.set(imp.specifier, imp);
      continue;
    }
    seen.set(imp.specifier, {
      ...existing,
      imported: [...new Set([...existing.imported, ...imp.imported])],
    });
  }
  return [...seen.values()];
}

function dedupeDbUses(list: readonly ParsedDatabaseUse[]): ParsedDatabaseUse[] {
  const seen = new Set<string>();
  const out: ParsedDatabaseUse[] = [];
  for (const use of list) {
    const key = `${use.via}:${use.target ?? ''}:${use.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(use);
  }
  return out;
}

export const typescriptParser: LanguageParser = new TypeScriptParser();

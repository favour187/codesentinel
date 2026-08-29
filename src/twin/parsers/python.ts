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
















const DEF_RE = /^(?<indent>\s*)(?<async>async\s+)?def\s+(?<name>[A-Za-z_]\w*)\s*\((?<params>[^)]*)/;
const CLASS_RE = /^(?<indent>\s*)class\s+(?<name>[A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
const IMPORT_RE = /^\s*import\s+(?<mods>[\w.,\s]+)$/;
const FROM_IMPORT_RE = /^\s*from\s+(?<mod>[.\w]+)\s+import\s+(?<names>\*|[\w,\s()]+)/;
const ASSIGN_RE = /^(?<indent>[ \t]*)(?<name>[A-Z_][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*\S/;


const DECORATOR_ROUTE_RE =
  /^\s*@(?<recv>\w+)\.(?<method>get|post|put|patch|delete|head|options|route)\s*\(\s*(?<quote>['"])(?<path>[^'"]+)\k<quote>(?<rest>[^)]*)/;


const DJANGO_PATH_RE = /^\s*(?:re_)?path\s*\(\s*(?<quote>['"])(?<path>[^'"]*)\k<quote>/;

const SQL_STATEMENT =
  /\b(select\s+[\s\S]{0,200}?\bfrom\b|insert\s+into\b|update\s+[a-z_][\w".]*\s+set\b|delete\s+from\b|create\s+table\b|drop\s+table\b)/i;

const DB_MODULES =
  /^(psycopg2?|sqlite3|pymysql|mysql|asyncpg|sqlalchemy|django\.db|pymongo|motor|redis|peewee|tortoise)(\.|$)/;





const DJANGO_ORM_RE = /\b([A-Z]\w*)\.objects\.(?:get|filter|all|create|update|delete|exclude|count)\s*\(/;






const GENERIC_DB_CALL_RE =
  /\b\w+\.(query|execute|executemany|fetchall|fetchone|find_one|insert_one|update_one|delete_one|bulk_write)\s*\(/;

const BRANCH_RE = /^\s*(if|elif|for|while|except|with)\b|(\band\b|\bor\b)/;

function paramNames(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== 'self' && p !== 'cls')
    .map((p) => {
      const name = p.split(/[:=]/)[0]?.trim() ?? p;
      return name.replace(/^\*+/, '');
    })
    .filter((p) => p.length > 0);
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width += ch === '\t' ? 4 : 1;
  return width;
}


function stripLiterals(line: string): string {
  return line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
}

interface OpenBlock {
  name: string;
  kind: 'function' | 'class' | 'method';
  indent: number;
  startLine: number;
  parentName: string | null;
  parameters: string[];
  isAsync: boolean;
  signature: string;
  complexity: number;
}

class PythonParser implements LanguageParser {
  readonly id = 'python';
  readonly languages = ['python'] as const;

  parse(path: string, content: string): ParsedFile {
    try {
      return this.parseUnsafe(path, content);
    } catch (err) {
      return emptyParsedFile(path, 'python', err instanceof Error ? err.message : String(err));
    }
  }

  private parseUnsafe(path: string, content: string): ParsedFile {
    const lines = content.split(/\r?\n/);
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];
    const routes: ParsedRoute[] = [];
    const databaseUses: ParsedDatabaseUse[] = [];
    const calls: ParsedCall[] = [];

    const open: OpenBlock[] = [];
    let inTripleQuote: false | string = false;


    const trimEnd = (endLine: number, startLine: number): number => {
      let end = endLine;
      while (end > startLine) {
        const text = (lines[end - 1] ?? '').trim();
        if (text.length === 0 || text.startsWith('#') || text.startsWith('@')) end -= 1;
        else break;
      }
      return end;
    };

    const closeTo = (indent: number, endLine: number): void => {
      while (open.length > 0) {
        const top = open[open.length - 1];
        if (!top || top.indent < indent) break;
        open.pop();
        symbols.push({
          name: top.name,
          kind: top.kind,
          lineStart: top.startLine,
          lineEnd: trimEnd(endLine, top.startLine),

          isExported: top.parentName === null && !top.name.startsWith('_'),
          isAsync: top.isAsync,
          parameters: top.parameters,
          parentName: top.parentName,
          complexity: top.complexity,
          signature: top.signature,
        });
        if (top.parentName === null && !top.name.startsWith('_')) exports.push(top.name);
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? '';
      const lineNo = i + 1;


      if (inTripleQuote) {
        if (raw.includes(inTripleQuote)) inTripleQuote = false;
        const sqlMatch = SQL_STATEMENT.exec(raw);
        if (sqlMatch) {
          databaseUses.push({
            target: this.tableFrom(raw),
            via: 'sql',
            line: lineNo,
            evidence: raw.trim().replace(/\s+/g, ' ').slice(0, 120),
          });
        }
        continue;
      }
      const tripleOpen = /("""|''')/.exec(raw);
      if (tripleOpen?.[1] && raw.split(tripleOpen[1]).length === 2) {
        inTripleQuote = tripleOpen[1];
      }

      const code = stripLiterals(raw);
      if (code.trim().length === 0 && !raw.includes('@')) continue;


      const fromImport = FROM_IMPORT_RE.exec(raw);
      if (fromImport?.groups) {
        const mod = fromImport.groups['mod'] ?? '';
        const names = (fromImport.groups['names'] ?? '')
          .replace(/[()]/g, '')
          .split(',')
          .map((n) => n.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
          .filter((n) => n.length > 0 && n !== '*');
        imports.push({
          specifier: mod,
          imported: names,
          line: lineNo,
          isRelative: mod.startsWith('.'),
        });
        if (DB_MODULES.test(mod)) {
          databaseUses.push({ target: null, via: 'client', line: lineNo, evidence: `from ${mod} import …` });
        }
      } else {
        const plainImport = IMPORT_RE.exec(raw);
        if (plainImport?.groups) {
          for (const mod of (plainImport.groups['mods'] ?? '').split(',')) {
            const name = mod.trim().split(/\s+as\s+/)[0]?.trim();
            if (!name) continue;
            imports.push({ specifier: name, imported: [], line: lineNo, isRelative: name.startsWith('.') });
            if (DB_MODULES.test(name)) {
              databaseUses.push({ target: null, via: 'client', line: lineNo, evidence: `import ${name}` });
            }
          }
        }
      }


      const decorated = DECORATOR_ROUTE_RE.exec(raw);
      if (decorated?.groups) {
        const method = (decorated.groups['method'] ?? '').toLowerCase();
        const rest = decorated.groups['rest'] ?? '';
        const methodsAttr = /methods\s*=\s*\[([^\]]*)\]/.exec(rest);
        const verb =
          method === 'route'
            ? methodsAttr
              ? (methodsAttr[1] ?? '').replace(/['"\s]/g, '').split(',')[0]?.toUpperCase() || 'ANY'
              : 'ANY'
            : method.toUpperCase();
        routes.push({
          method: verb,
          path: decorated.groups['path'] ?? '/',
          line: lineNo,
          evidence: raw.trim().slice(0, 120),
        });
      }
      const django = DJANGO_PATH_RE.exec(raw);
      if (django?.groups) {
        routes.push({
          method: 'ANY',
          path: `/${(django.groups['path'] ?? '').replace(/^\^?\/?/, '')}`,
          line: lineNo,
          evidence: raw.trim().slice(0, 120),
        });
      }


      const sqlMatch = SQL_STATEMENT.exec(raw);
      if (sqlMatch) {
        databaseUses.push({
          target: this.tableFrom(raw),
          via: 'sql',
          line: lineNo,
          evidence: raw.trim().replace(/\s+/g, ' ').slice(0, 120),
        });
      }
      const djangoOrm = DJANGO_ORM_RE.exec(code);
      if (djangoOrm) {
        databaseUses.push({
          target: djangoOrm[1] ?? null,
          via: 'orm',
          line: lineNo,
          evidence: raw.trim().replace(/\s+/g, ' ').slice(0, 120),
        });
      } else if (GENERIC_DB_CALL_RE.test(code) && !sqlMatch) {


        databaseUses.push({
          target: null,
          via: 'orm',
          line: lineNo,
          evidence: raw.trim().replace(/\s+/g, ' ').slice(0, 120),
        });
      }


      const classMatch = CLASS_RE.exec(raw);
      const defMatch = DEF_RE.exec(raw);

      if (classMatch?.groups) {
        const indent = indentWidth(classMatch.groups['indent'] ?? '');
        closeTo(indent, lineNo - 1);
        open.push({
          name: classMatch.groups['name'] ?? '',
          kind: 'class',
          indent,
          startLine: lineNo,
          parentName: null,
          parameters: [],
          isAsync: false,
          signature: raw.trim().slice(0, 200),
          complexity: 0,
        });
        continue;
      }

      if (defMatch?.groups) {
        const indent = indentWidth(defMatch.groups['indent'] ?? '');
        closeTo(indent, lineNo - 1);
        const enclosingClass = [...open].reverse().find((b) => b.kind === 'class' && b.indent < indent);
        open.push({
          name: defMatch.groups['name'] ?? '',
          kind: enclosingClass ? 'method' : 'function',
          indent,
          startLine: lineNo,
          parentName: enclosingClass?.name ?? null,
          parameters: paramNames(defMatch.groups['params'] ?? ''),
          isAsync: Boolean(defMatch.groups['async']),
          signature: raw.trim().replace(/:\s*$/, '').slice(0, 200),
          complexity: 0,
        });
        continue;
      }


      const assign = ASSIGN_RE.exec(raw);
      if (assign?.groups && indentWidth(assign.groups['indent'] ?? '') === 0 && open.length === 0) {
        const name = assign.groups['name'] ?? '';
        symbols.push({
          name,
          kind: 'variable',
          lineStart: lineNo,
          lineEnd: lineNo,
          isExported: !name.startsWith('_'),
          isAsync: false,
          parameters: [],
          parentName: null,
          complexity: 0,
          signature: raw.trim().slice(0, 120),
        });
        if (!name.startsWith('_')) exports.push(name);
      }


      const top = open[open.length - 1];
      if (top && indentWidth(/^\s*/.exec(raw)?.[0] ?? '') > top.indent) {
        if (BRANCH_RE.test(code)) top.complexity += 1;
      }
      for (const call of this.callsIn(code, lineNo, top?.name ?? null)) calls.push(call);
    }

    closeTo(0, lines.length);

    while (open.length > 0) {
      const top = open.pop();
      if (!top) break;
      symbols.push({
        name: top.name,
        kind: top.kind,
        lineStart: top.startLine,
        lineEnd: lines.length,
        isExported: top.parentName === null && !top.name.startsWith('_'),
        isAsync: top.isAsync,
        parameters: top.parameters,
        parentName: top.parentName,
        complexity: top.complexity,
        signature: top.signature,
      });
      if (top.parentName === null && !top.name.startsWith('_')) exports.push(top.name);
    }

    symbols.sort((a, b) => a.lineStart - b.lineStart);

    return {
      path,
      language: 'python',
      symbols,
      imports,
      exports: [...new Set(exports)],
      routes,
      databaseUses,
      calls,
    };
  }

  private *callsIn(code: string, line: number, enclosing: string | null): Generator<ParsedCall> {
    const re = /(?:(\w+)\.)?(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      const callee = match[2];
      if (!callee) continue;

      if (/^(if|for|while|return|print|def|class|with|except|and|or|not|in|elif)$/.test(callee)) continue;
      yield { callee, receiver: match[1] ?? null, line, enclosingSymbol: enclosing };
    }
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

export const pythonParser: LanguageParser = new PythonParser();

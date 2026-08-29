import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFile, parserFor, SUPPORTED_LANGUAGES } from '@/twin/parsers';









const FIXTURE_ROOT = path.join(process.cwd(), 'fixtures', 'demo-repo');

function fixture(relative: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, relative), 'utf8');
}

describe('parser registry', () => {
  it('supports the three prioritised languages', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['javascript', 'python', 'typescript']);
  });

  it('returns null for a language with no parser', () => {
    expect(parserFor('rust')).toBeNull();
    expect(parserFor(null)).toBeNull();
  });

  it('returns an empty result rather than throwing for unsupported files', () => {
    const parsed = parseFile('main.go', 'package main\nfunc main() {}', 'go');
    expect(parsed.symbols).toEqual([]);
    expect(parsed.language).toBe('go');
    expect(parsed.error).toBeUndefined();
  });
});

describe('typescript/javascript parser', () => {
  it('extracts functions with parameters and line ranges from the demo fixture', () => {
    const parsed = parseFile('src/routes/auth.js', fixture('src/routes/auth.js'), 'javascript');

    const names = parsed.symbols.map((s) => s.name);
    expect(names).toEqual(['hashPassword', 'verifyToken', 'login', 'findUser']);

    const login = parsed.symbols.find((s) => s.name === 'login');
    expect(login?.kind).toBe('function');
    expect(login?.parameters).toEqual(['req', 'res']);
    expect(login?.lineStart).toBeLessThan(login?.lineEnd ?? 0);

    expect(login?.complexity).toBe(2);
  });

  it('does not record function-local variables as symbols', () => {
    const parsed = parseFile('src/routes/auth.js', fixture('src/routes/auth.js'), 'javascript');
    const names = parsed.symbols.map((s) => s.name);
    expect(names).not.toContain('hashed');
    expect(names).not.toContain('token');
    expect(names).not.toContain('user');
  });

  it('treats require bindings as imports, not as symbols or calls', () => {
    const parsed = parseFile('src/routes/auth.js', fixture('src/routes/auth.js'), 'javascript');

    expect(parsed.imports.map((i) => i.specifier)).toEqual([
      'crypto',
      'jsonwebtoken',
      '../lib/config',
      '../auth/session',
    ]);
    const config = parsed.imports.find((i) => i.specifier === '../lib/config');
    expect(config?.isRelative).toBe(true);
    expect(config?.imported).toContain('JWT_SECRET');

    expect(parsed.symbols.map((s) => s.name)).not.toContain('crypto');
    expect(parsed.calls.map((c) => c.callee)).not.toContain('require');
  });

  it('reads CommonJS exports', () => {
    const parsed = parseFile('src/routes/auth.js', fixture('src/routes/auth.js'), 'javascript');
    expect(parsed.exports).toEqual(['hashPassword', 'verifyToken', 'login']);
  });

  it('attributes calls to the enclosing symbol', () => {
    const parsed = parseFile('src/routes/auth.js', fixture('src/routes/auth.js'), 'javascript');
    const inLogin = parsed.calls.filter((c) => c.enclosingSymbol === 'login').map((c) => c.callee);
    expect(inLogin).toContain('hashPassword');
    expect(inLogin).toContain('findUser');

    const createHash = parsed.calls.find((c) => c.callee === 'createHash');
    expect(createHash?.receiver).toBe('crypto');
    expect(createHash?.enclosingSymbol).toBe('hashPassword');
  });

  it('extracts ES module syntax, classes and methods', () => {
    const source = `
import { z } from 'zod';
import type { Thing } from './thing';
export interface Options { retries: number }
export type Mode = 'fast' | 'slow';

export class Service {
  constructor(private readonly db: Db) {}
  async fetch(id: string): Promise<Thing | null> {
    if (!id) return null;
    return this.db.findOne({ id });
  }
}

export const helper = async (a: number, b: number) => a + b;
function internal() {}
`;
    const parsed = parseFile('src/service.ts', source, 'typescript');
    const byName = new Map(parsed.symbols.map((s) => [s.name, s]));

    expect(byName.get('Options')?.kind).toBe('interface');
    expect(byName.get('Mode')?.kind).toBe('type');
    expect(byName.get('Service')?.kind).toBe('class');
    expect(byName.get('fetch')?.kind).toBe('method');
    expect(byName.get('fetch')?.parentName).toBe('Service');
    expect(byName.get('fetch')?.isAsync).toBe(true);
    expect(byName.get('helper')?.kind).toBe('function');
    expect(byName.get('helper')?.parameters).toEqual(['a', 'b']);

    expect(parsed.exports).toEqual(expect.arrayContaining(['Options', 'Mode', 'Service', 'helper']));
    expect(parsed.exports).not.toContain('internal');
    expect(byName.get('internal')?.isExported).toBe(false);
  });

  it('never captures symbol bodies', () => {
    const source = 'export function secret() { const apiKey = "sk-live-abcdef"; return apiKey; }';
    const parsed = parseFile('src/secret.ts', source, 'typescript');
    const signature = parsed.symbols[0]?.signature ?? '';
    expect(signature).not.toContain('sk-live-abcdef');
    expect(signature).toContain('function secret');
  });

  it('detects express-style routes', () => {
    const source = `
const app = express();
app.get('/health', (req, res) => res.send('ok'));
router.post('/users/:id', handler);
notARouter.get('/nope', handler);
`;
    const parsed = parseFile('src/server.js', source, 'javascript');
    expect(parsed.routes).toHaveLength(2);
    expect(parsed.routes[0]).toMatchObject({ method: 'GET', path: '/health' });
    expect(parsed.routes[1]).toMatchObject({ method: 'POST', path: '/users/:id' });
    expect(parsed.routes[0]?.evidence).toContain('app.get');
  });

  it('detects database use from raw SQL and ORM calls', () => {
    const source = `
import { Pool } from 'pg';
const rows = await pool.query('SELECT id, email FROM accounts WHERE id = $1', [id]);
const user = await prisma.user.findMany();
`;
    const parsed = parseFile('src/data.ts', source, 'typescript');
    const vias = parsed.databaseUses.map((u) => u.via);
    expect(vias).toContain('client');
    expect(vias).toContain('sql');

    const sql = parsed.databaseUses.find((u) => u.via === 'sql');
    expect(sql?.target).toBe('accounts');
    expect(sql?.evidence).toContain('SELECT');
  });

  it('does not mistake non-database methods that share ORM member names', () => {





    const source = `
const crypto = require('crypto');
function sign(payload) {
  return crypto.createHash('md5').update(payload).digest('hex');
}
function bump(el) {
  el.classList.update();
  chart.update();
  return state.query();
}
`;
    const parsed = parseFile('src/hash.js', source, 'javascript');
    expect(parsed.databaseUses).toEqual([]);
  });

  it('still records ambiguous ORM members when the receiver is a database handle', () => {
    const source = `
const db = require('./db');
async function save(row) {
  await db.update(row);
  await connection.query('ping');
  await prisma.user.findUnique({ where: { id: 1 } });
}
`;
    const parsed = parseFile('src/save.js', source, 'javascript');
    const evidence = parsed.databaseUses.map((u) => u.evidence).join(' | ');
    expect(evidence).toContain('db.update');
    expect(evidence).toContain('connection.query');
    expect(evidence).toContain('findUnique');
  });

  it('degrades gracefully on malformed source', () => {
    const parsed = parseFile('src/broken.ts', 'function ( { { { unterminated', 'typescript');
    expect(parsed.path).toBe('src/broken.ts');
    expect(Array.isArray(parsed.symbols)).toBe(true);
  });







  describe('CommonJS exports', () => {
    const cjs = [
      'function createSession(userId) { return { userId }; }',
      'function destroySession(id) { return id; }',
      'function internalHash(v) { return v; }',
      'class SessionStore {}',
      '',
      'module.exports = { createSession, destroySession, SessionStore };',
    ].join('\n');

    const parsed = parseFile('src/auth/session.js', cjs, 'javascript');
    const byName = new Map(parsed.symbols.map((s) => [s.name, s]));

    it('marks functions listed in module.exports as exported', () => {
      expect(byName.get('createSession')?.isExported).toBe(true);
      expect(byName.get('destroySession')?.isExported).toBe(true);
    });

    it('marks an exported class', () => {
      expect(byName.get('SessionStore')?.isExported).toBe(true);
    });

    it('leaves a symbol absent from module.exports private', () => {
      expect(byName.get('internalHash')?.isExported).toBe(false);
    });

    it('still records the file-level export list', () => {
      expect([...parsed.exports].sort()).toEqual(['SessionStore', 'createSession', 'destroySession']);
    });

    it('handles module.exports.name = fn assignment', () => {
      const single = parseFile('src/x.js', 'function go() {}\nmodule.exports.go = go;\n', 'javascript');
      expect(single.symbols.find((s) => s.name === 'go')?.isExported).toBe(true);
    });

    it('does not mark a nested member sharing an exported name', () => {
      const nested = parseFile(
        'src/y.js',
        ['class A { createSession() {} }', 'function createSession() {}', 'module.exports = { createSession };'].join(
          '\n',
        ),
        'javascript',
      );
      const method = nested.symbols.find((s) => s.kind === 'method' && s.name === 'createSession');
      const fn = nested.symbols.find((s) => s.kind === 'function' && s.name === 'createSession');

      expect(method?.isExported).toBe(false);
      expect(fn?.isExported).toBe(true);
    });

    it('leaves ESM behaviour unchanged', () => {
      const esm = parseFile('src/z.ts', 'export function a() {}\nfunction b() {}\n', 'typescript');
      expect(esm.symbols.find((s) => s.name === 'a')?.isExported).toBe(true);
      expect(esm.symbols.find((s) => s.name === 'b')?.isExported).toBe(false);
    });
  });
});

describe('python parser', () => {
  const source = `
import os
from psycopg2 import connect
from .models import User

MAX_RETRIES = 3

class UserRepo:
    def __init__(self, conn):
        self.conn = conn

    async def find_by_email(self, email, verified=True):
        if not email:
            return None
        cur = self.conn.execute("SELECT id, name FROM users WHERE email = %s", (email,))
        return cur.fetchone()

@app.post('/users/<id>')
def create_user(id):
    for i in range(3):
        if i > 1 and id:
            User.objects.filter(pk=id).delete()
    return {}

def _private_helper():
    pass
`;

  it('extracts classes, methods and functions with correct nesting', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    const byName = new Map(parsed.symbols.map((s) => [s.name, s]));

    expect(byName.get('UserRepo')?.kind).toBe('class');
    expect(byName.get('__init__')?.kind).toBe('method');
    expect(byName.get('__init__')?.parentName).toBe('UserRepo');
    expect(byName.get('find_by_email')?.parentName).toBe('UserRepo');
    expect(byName.get('create_user')?.kind).toBe('function');
    expect(byName.get('create_user')?.parentName).toBeNull();
  });

  it('drops self/cls from parameters and detects async', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    const find = parsed.symbols.find((s) => s.name === 'find_by_email');
    expect(find?.parameters).toEqual(['email', 'verified']);
    expect(find?.isAsync).toBe(true);
  });

  it('treats underscore-prefixed and nested names as non-public', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    expect(parsed.exports).toEqual(['MAX_RETRIES', 'UserRepo', 'create_user']);
    expect(parsed.symbols.find((s) => s.name === '_private_helper')?.isExported).toBe(false);
  });

  it('computes symbol line ranges that exclude trailing decorators', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    const repo = parsed.symbols.find((s) => s.name === 'UserRepo');

    expect(repo?.lineEnd).toBeLessThan(18);
    const create = parsed.symbols.find((s) => s.name === 'create_user');
    expect(create?.lineStart).toBe(19);
  });

  it('counts branches as complexity', () => {
    const parsed = parseFile('app/repo.py', source, 'python');

    expect(parsed.symbols.find((s) => s.name === 'create_user')?.complexity).toBeGreaterThanOrEqual(2);
  });

  it('reads both import forms and marks relative ones', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    expect(parsed.imports.map((i) => i.specifier)).toEqual(['os', 'psycopg2', '.models']);
    expect(parsed.imports.find((i) => i.specifier === '.models')?.isRelative).toBe(true);
    expect(parsed.imports.find((i) => i.specifier === 'psycopg2')?.imported).toEqual(['connect']);
  });

  it('detects decorator routes with the HTTP verb', () => {
    const parsed = parseFile('app/repo.py', source, 'python');
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0]).toMatchObject({ method: 'POST', path: '/users/<id>' });
  });

  it('names a table only when it is genuinely recoverable', () => {
    const parsed = parseFile('app/repo.py', source, 'python');

    const sql = parsed.databaseUses.find((u) => u.via === 'sql');
    expect(sql?.target).toBe('users');



    const targets = parsed.databaseUses.map((u) => u.target);
    expect(targets).toContain('User');
    expect(targets).not.toContain('cur');
    expect(targets).not.toContain('conn');
  });

  it('handles flask route with methods list', () => {
    const parsed = parseFile('app/api.py', "@app.route('/items', methods=['PUT', 'GET'])\ndef items():\n    pass\n", 'python');
    expect(parsed.routes[0]).toMatchObject({ method: 'PUT', path: '/items' });
  });

  it('does not treat keywords as calls', () => {
    const parsed = parseFile('app/x.py', 'def f(x):\n    if (x):\n        return (x)\n', 'python');
    const callees = parsed.calls.map((c) => c.callee);
    expect(callees).not.toContain('if');
    expect(callees).not.toContain('return');
  });

  it('ignores structure inside docstrings', () => {
    const parsed = parseFile(
      'app/doc.py',
      'def real():\n    """\n    def fake():\n        pass\n    """\n    pass\n',
      'python',
    );
    expect(parsed.symbols.map((s) => s.name)).toEqual(['real']);
  });
});

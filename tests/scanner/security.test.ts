import { describe, expect, it } from 'vitest';

import { securityScanner } from '@/scanner/scanners/security';
import { ruleIds, scanSource, scanContext, sourceFile } from './helpers/source';

describe('security scanner — detection', () => {
  it('flags SQL built by string concatenation', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      `function find(email) {\n  const q = "SELECT * FROM users WHERE email = '" + email + "'";\n  return db.raw(q);\n}`,
    );
    expect(ruleIds(findings)).toContain('security/sql-injection');
  });

  it('flags SQL built by template interpolation', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      'function find(id) {\n  return db.raw(`DELETE FROM users WHERE id = ${id}`);\n}',
    );
    expect(ruleIds(findings)).toContain('security/sql-injection');
  });

  it('flags command execution built from request input', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/ops.js',
      "app.get('/p', (req, res) => {\n  exec('ping -c 1 ' + req.query.host, cb);\n});",
    );
    expect(ruleIds(findings)).toContain('security/command-injection');
  });

  it('flags eval', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/run.js',
      'function run(expr) {\n  return eval(expr);\n}',
    );
    expect(ruleIds(findings)).toContain('security/code-injection-eval');
  });

  it('flags an unverified JWT decode', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/auth.js',
      'function who(token) {\n  return jwt.decode(token);\n}',
    );
    expect(ruleIds(findings)).toContain('security/jwt-unverified');
  });

  it("flags the 'none' JWT algorithm", async () => {
    const findings = await scanSource(
      securityScanner,
      'src/auth.js',
      "const t = jwt.sign(payload, null, { algorithm: 'none' });",
    );
    expect(ruleIds(findings)).toContain('security/jwt-alg-none');
  });

  it('flags md5 used on a password', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/auth.js',
      "const hashed = crypto.createHash('md5').update(password).digest('hex');",
    );
    expect(ruleIds(findings)).toContain('security/weak-hash');
  });
});

describe('security scanner — false positives', () => {
  it('stays silent on a clean parameterised query', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      "function find(email) {\n  return db.raw('SELECT * FROM users WHERE email = $1', [email]);\n}",
    );
    expect(ruleIds(findings)).not.toContain('security/sql-injection');
  });

  it('does not treat a commented-out example as live code', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/notes.js',
      '// Never do this: eval(userInput)\n// const q = "SELECT * FROM t WHERE a = " + b;\nexport const safe = 1;',
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores unsafe patterns inside test files', async () => {


    const file = sourceFile(
      'tests/injection.test.js',
      "it('rejects injection', () => {\n  expect(() => eval('1+1')).toBeDefined();\n});",
    );
    expect(file.isTest).toBe(true);
    const findings = await securityScanner.scan(scanContext([file]));
    expect(findings).toHaveLength(0);
  });

  it('does not flag a verified JWT call', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/auth.js',
      'const claims = jwt.verify(token, secret, { algorithms: ["RS256"] });',
    );
    expect(ruleIds(findings)).not.toContain('security/jwt-unverified');
  });

  it('does not flag sha-256 as a weak hash', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/hash.js',
      "const digest = crypto.createHash('sha256').update(data).digest('hex');",
    );
    expect(ruleIds(findings)).not.toContain('security/weak-hash');
  });

  it('leaves a clean file with no findings at all', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/math.ts',
      'export function add(a: number, b: number): number {\n  return a + b;\n}',
    );
    expect(findings).toHaveLength(0);
  });
});

describe('security scanner — reporting behaviour', () => {
  it('reports every occurrence, not just the first in a file', async () => {


    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      [
        'function a(email) {',
        '  return db.raw("SELECT * FROM users WHERE email = \'" + email + "\'");',
        '}',
        'function b(name) {',
        '  return db.raw(`SELECT id FROM users WHERE name = ${name}`);',
        '}',
      ].join('\n'),
    );
    const sql = findings.filter((f) => f.ruleId === 'security/sql-injection');
    expect(sql).toHaveLength(2);
    expect(new Set(sql.map((f) => f.lineStart)).size).toBe(2);
  });

  it('does not report the same statement twice from an overlapping window', async () => {
    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      'async function del(id) {\n  try {\n    await db.raw(`DELETE FROM users WHERE id = ${id}`);\n  } catch (e) {}\n}',
    );
    const sql = findings.filter((f) => f.ruleId === 'security/sql-injection');
    expect(sql).toHaveLength(1);
  });

  it('anchors the finding to the line carrying the vulnerability', async () => {

    const findings = await scanSource(
      securityScanner,
      'src/users.js',
      'async function del(id) {\n  try {\n    await db.raw(`DELETE FROM users WHERE id = ${id}`);\n  } catch (e) {}\n}',
    );
    const sql = findings.find((f) => f.ruleId === 'security/sql-injection');
    expect(sql?.lineStart).toBe(3);
    expect(sql?.evidence).toContain('DELETE FROM users');
  });

  it('caps a pathological file and records the overflow count', async () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `db.raw("SELECT * FROM t WHERE a = " + v${i});`,
    );
    const findings = (await scanSource(securityScanner, 'src/bulk.js', lines.join('\n'))) as Array<{
      ruleId: string;
      metadata?: Record<string, unknown>;
    }>;
    const sql = findings.filter((f) => f.ruleId === 'security/sql-injection');
    expect(sql.length).toBeLessThanOrEqual(5);
    const last = sql[sql.length - 1];
    expect(last?.metadata?.additionalOccurrences).toBeGreaterThan(0);
  });

  it('raises confidence when user input is nearby', async () => {
    const tainted = (await scanSource(
      securityScanner,
      'src/a.js',
      "app.get('/x', (req) => {\n  exec('ls ' + req.query.dir);\n});",
    )) as Array<{ ruleId: string; confidence: number }>;
    const plain = (await scanSource(
      securityScanner,
      'src/b.js',
      "exec('ls ' + someLocalVariable);",
    )) as Array<{ ruleId: string; confidence: number }>;

    const a = tainted.find((f) => f.ruleId === 'security/command-injection');
    const b = plain.find((f) => f.ruleId === 'security/command-injection');
    expect(a && b && a.confidence > b.confidence).toBe(true);
  });
});

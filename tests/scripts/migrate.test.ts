import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TABLE_NAMES } from '@/db/bootstrap';

const run = promisify(execFile);
const projectRoot = path.resolve(new URL('../../', import.meta.url).pathname);













describe('scripts/migrate.ts', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'codesentinel-migrate-'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('applies the schema to a fresh database and is safe to re-run', async () => {
    const env = {
      ...process.env,
      PGLITE_DATA_DIR: dataDir,
      DATABASE_URL: '',
      SESSION_SECRET: 'test-session-secret-value-at-least-32-chars',
    };

    const first = await run('npx', ['tsx', 'scripts/migrate.ts'], { cwd: projectRoot, env });
    expect(first.stdout).toContain('target database: pglite');
    expect(first.stdout).toContain(`done — ${TABLE_NAMES.length} tables expected`);
    expect(first.stdout).not.toContain('require is not defined');


    const second = await run('npx', ['tsx', 'scripts/migrate.ts'], { cwd: projectRoot, env });
    expect(second.stdout).toContain(`done — ${TABLE_NAMES.length} tables expected`);
  }, 120_000);
});

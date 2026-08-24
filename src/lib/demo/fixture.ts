import { access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The bundled demo fixture.
 *
 * IMPORTANT: this is a real directory of real (intentionally vulnerable) source
 * files on disk. CodeSentinel runs the exact same scanners over it as it does
 * over a cloned GitHub repository — no results are hard-coded or simulated.
 *
 * Everything derived from it is tagged `source: 'demo'` in the database so demo
 * output can never be presented as production scan data.
 */

export const DEMO_REPO_FULL_NAME = 'codesentinel/demo-repo';
export const DEMO_REPO_DIRNAME = 'demo-repo';

/** Absolute path to the fixture. Standalone deploys may run one directory down. */
export function demoFixturePath(): string {
  const candidates = [
    path.join(process.cwd(), 'fixtures', DEMO_REPO_DIRNAME),
    path.join(process.cwd(), '..', 'fixtures', DEMO_REPO_DIRNAME),
    path.join(process.cwd(), '..', '..', 'fixtures', DEMO_REPO_DIRNAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export async function demoFixtureExists(): Promise<boolean> {
  try {
    const target = demoFixturePath();
    await access(target);
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

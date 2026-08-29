import { access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';












export const DEMO_REPO_FULL_NAME = 'codesentinel/demo-repo';
export const DEMO_REPO_DIRNAME = 'demo-repo';


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

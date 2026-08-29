import { mkdtemp, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { GitHubClient } from '@/github/client';
import { createLogger } from '@/lib/logger';















const log = createLogger('guardian:checkout');

export interface Checkout {

  dir: string;

  cleanup: () => Promise<void>;
}


const MAX_TARBALL_BYTES = 100 * 1024 * 1024;

export async function checkoutRepository(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<Checkout> {
  const base = await mkdtemp(join(tmpdir(), 'codesentinel-'));
  const extractDir = join(base, 'src');
  await mkdir(extractDir, { recursive: true });

  const cleanup = async (): Promise<void> => {
    await rm(base, { recursive: true, force: true }).catch((err: Error) => {
      log.warn('Failed to clean up checkout', { dir: base, error: err.message });
    });
  };

  try {
    const buffer = await client.downloadTarball(owner, repo, ref);
    if (buffer.byteLength > MAX_TARBALL_BYTES) {
      throw new Error(`Repository tarball exceeds ${MAX_TARBALL_BYTES} bytes (${buffer.byteLength})`);
    }

    const tarPath = join(base, 'repo.tar.gz');
    await writeFile(tarPath, Buffer.from(buffer));



    await extractTarball(tarPath, extractDir);
    await rm(tarPath, { force: true });

    const entries = await readdir(extractDir);
    if (entries.length === 0) throw new Error('Tarball extracted to an empty directory');

    log.info('Checked out repository', { repo: `${owner}/${repo}`, ref, entries: entries.length });
    return { dir: extractDir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Extract with the system `tar`.
 *
 * `--strip-components=1` removes GitHub's wrapper directory. Extraction is
 * confined to `destination`; tar refuses absolute paths and `..` traversal by
 * default on GNU tar, which matters because the archive is untrusted.
 */
export function extractTarball(tarPath: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destination, '--strip-components=1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(new Error(`Failed to run tar: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

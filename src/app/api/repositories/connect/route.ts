import { NextResponse } from 'next/server';
import { z } from 'zod';

import { UnauthorizedError, getUserGitHubToken, requireUser } from '@/lib/auth/current-user';
import { GitHubClient } from '@/github/client';
import { connectGitHubRepository } from '@/lib/repositories';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:connect-repo');

const Body = z.object({
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();
    if (user.isDemo) {
      return NextResponse.json({ ok: false, error: 'Demo sessions cannot connect GitHub repositories.' }, { status: 400 });
    }

    const parsed = Body.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ ok: false, error: 'owner and name are required' }, { status: 400 });

    const token = await getUserGitHubToken(user.id);
    if (!token) {
      return NextResponse.json({ ok: false, error: 'Sign in with GitHub first.' }, { status: 400 });
    }

    const client = new GitHubClient({ token });
    const remote = await client.getRepository(parsed.data.owner, parsed.data.name);

    const repo = await connectGitHubRepository(user.id, {
      githubId: remote.id,
      owner: parsed.data.owner,
      name: parsed.data.name,
      fullName: remote.full_name,
      defaultBranch: remote.default_branch,
      isPrivate: remote.private,
      description: remote.description,
      primaryLanguage: remote.language,
      htmlUrl: remote.html_url,
    });

    log.info('Repository connected', { userId: user.id, fullName: repo.fullName });
    return NextResponse.json({ ok: true, repository: repo });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    log.error('Connect repository failed', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: 'Could not connect that repository.' }, { status: 502 });
  }
}

export function GET(): NextResponse {
  return NextResponse.json({ ok: false, error: 'Use POST to connect a repository.' }, { status: 405 });
}

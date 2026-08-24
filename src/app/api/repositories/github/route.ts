import { NextResponse } from 'next/server';

import { ForbiddenError, UnauthorizedError, getUserGitHubToken, requireUser } from '@/lib/auth/current-user';
import { GitHubClient } from '@/github/client';
import { createLogger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api:github-repos');

export async function GET(): Promise<NextResponse> {
  try {
    const user = await requireUser();
    if (user.isDemo) {
      return NextResponse.json({
        ok: false,
        error: 'Sign in with GitHub (not the demo workspace) to list your repositories.',
      }, { status: 400 });
    }

    const token = await getUserGitHubToken(user.id);
    if (!token) {
      return NextResponse.json({
        ok: false,
        error: 'No GitHub token on this account. Sign out and Connect GitHub again.',
      }, { status: 400 });
    }

    const client = new GitHubClient({ token });
    const repos = await client.listUserRepositories();
    return NextResponse.json({
      ok: true,
      repositories: repos.map((r) => ({
        githubId: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        isPrivate: r.private,
        description: r.description,
        primaryLanguage: r.language,
        htmlUrl: r.html_url,
      })),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Not allowed' }, { status: 403 });
    }
    log.error('Failed to list GitHub repositories', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, error: 'Could not list GitHub repositories.' }, { status: 502 });
  }
}

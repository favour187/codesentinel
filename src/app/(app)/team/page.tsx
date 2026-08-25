import { Users } from 'lucide-react';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';
import { EmptyState } from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Team' };

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const repos = await listRepositoriesForUser(user.id);

  return (
    <>
      <PageHeader
        title="Team"
        description="Who can see analysis results for your connected repositories."
      />

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-[hsl(var(--border))]">
            <li className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                {user.avatarUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={user.avatarUrl} alt="" className="size-8 rounded-full border border-[hsl(var(--border))]" />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded-full bg-[hsl(var(--muted))] text-xs font-semibold uppercase">
                    {user.login.slice(0, 2)}
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium">{user.name ?? user.login}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {user.isDemo ? 'Local demo identity' : `@${user.login}`}
                  </p>
                </div>
              </div>
              <Badge variant="primary">Owner</Badge>
            </li>
          </ul>

          <p className="mt-6 border-t border-[hsl(var(--border))] pt-5 text-xs leading-relaxed text-[hsl(var(--muted-foreground))]">
            Access is derived from repository ownership and explicit membership rows. Invites from GitHub
            collaborators are not synced automatically in this MVP.
          </p>
        </CardContent>
      </Card>

      <div className="mt-6">
        {repos.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No shared repositories"
            description="Connect a repository to manage who can view its analysis."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Repositories you can access</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-[hsl(var(--border))]">
                {repos.map((r) => (
                  <li key={r.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                    <span className="break-all font-mono text-sm">{r.fullName}</span>
                    {r.isDemo ? <Badge variant="medium">Demo</Badge> : <Badge variant="outline">GitHub</Badge>}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

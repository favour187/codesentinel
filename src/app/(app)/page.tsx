import { ShieldCheck, Radar, GitCommitHorizontal, Activity } from 'lucide-react';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ScoreRing, ScoreBar } from '@/components/dashboard/score-ring';
import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';
import { getLatestSnapshot, getRecentScans } from '@/lib/analysis-queries';
import { timeAgo } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };

/**
 * Overview — answers one question above the fold:
 * "Is this repository safe and healthy?"
 */
export default async function OverviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Connect a repository and CodeSentinel will start guarding it."
        />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const [snapshot, scans] = await Promise.all([getLatestSnapshot(repo.id), getRecentScans(repo.id, 5)]);

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Health summary for ${repo.fullName}.`}
        actions={
          <div className="flex items-center gap-2">
            {repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
            <Badge variant={repo.guardianEnabled ? 'success' : 'outline'}>
              <Radar className="size-3" aria-hidden="true" />
              Guardian {repo.guardianEnabled ? 'active' : 'off'}
            </Badge>
          </div>
        }
      />

      {!snapshot ? (
        <EmptyState
          icon={ShieldCheck}
          title="No scan has run yet"
          description={`${repo.fullName} is connected, but CodeSentinel has not analysed it yet. Health scores appear here after the first scan completes. Scanning arrives in Phase 2.`}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <Card>
            <CardContent className="flex flex-col items-center gap-8 p-8">
              <ScoreRing score={snapshot.health} label="Repository health" />
              <div className="grid w-full grid-cols-2 gap-x-6 gap-y-4 border-t border-[hsl(var(--border))] pt-6 text-center">
                <div>
                  <p className="text-lg font-semibold tabular-nums text-[hsl(var(--success))]">
                    {snapshot.issuesResolved}
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">Resolved</p>
                </div>
                <div>
                  <p className="text-lg font-semibold tabular-nums text-[hsl(var(--high))]">
                    {snapshot.issuesIntroduced}
                  </p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">Introduced</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Score breakdown</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <ScoreBar label="Security" score={snapshot.security} />
              <ScoreBar label="Reliability" score={snapshot.reliability} />
              <ScoreBar label="Code quality" score={snapshot.quality} />
              <ScoreBar label="Testing" score={snapshot.testing} />
              <ScoreBar label="Performance" score={snapshot.performance} />
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent scans</CardTitle>
          </CardHeader>
          <CardContent>
            {scans.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                No scans recorded yet.
              </p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {scans.map((scan) => (
                  <li key={scan.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium capitalize">{scan.trigger} scan</p>
                      <p className="text-xs text-[hsl(var(--muted-foreground))]">
                        {scan.commitSha ? `${scan.commitSha.slice(0, 7)} · ` : ''}
                        {timeAgo(scan.createdAt)}
                      </p>
                    </div>
                    <Badge variant={scan.status === 'completed' ? 'success' : scan.status === 'failed' ? 'critical' : 'outline'}>
                      {scan.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Guardian status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <Activity className="mt-0.5 size-4 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
              <div>
                <p className="text-sm">
                  {repo.guardianEnabled
                    ? 'Guardian is watching pushes and pull requests.'
                    : 'Guardian automation is not enabled for this repository.'}
                </p>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  Configure webhooks, policies and thresholds in Guardian.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t border-[hsl(var(--border))] pt-4">
              <GitCommitHorizontal className="mt-0.5 size-4 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
              <div>
                <p className="text-sm">Last scan {timeAgo(repo.lastScanAt)}</p>
                <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                  Default branch: <span className="font-mono">{repo.defaultBranch}</span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

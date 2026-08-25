import Link from 'next/link';
import { ShieldCheck, Radar } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ScoreRing, ScoreBar } from '@/components/dashboard/score-ring';
import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { ScanButton } from '@/components/dashboard/scan-button';
import { EnableGuardianButton } from '@/components/dashboard/enable-guardian-button';
import { DemoResetButton } from '@/components/dashboard/demo-reset-button';
import { Landing } from '@/components/marketing/landing';
import { getCurrentUser } from '@/lib/auth/current-user';
import { activateGuardianForConnectedRepo, listRepositoriesForUser } from '@/lib/repositories';
import { getLatestSnapshot, getOpenFindings, getRecentScans } from '@/lib/analysis-queries';
import { getRepositoryRisk } from '@/lib/guardian-risk';
import { timeAgo } from '@/lib/utils';
import type { Severity } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview' };

const SEV: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

export default async function OverviewPage() {
  const user = await getCurrentUser();
  if (!user) return <Landing />;

  let repos = await listRepositoriesForUser(user.id);
  for (const item of repos.filter((r) => !r.isDemo && !r.guardianEnabled)) {
    await activateGuardianForConnectedRepo(item.owner, item.name, item.fullName);
  }
  repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader
          title="Overview"
          description="Connect GitHub to begin protecting a repository, or load the demo fixture."
        />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const [snapshot, scans, findings, risk] = await Promise.all([
    getLatestSnapshot(repo.id),
    getRecentScans(repo.id, 5),
    getOpenFindings(repo.id, 5),
    getRepositoryRisk(repo.id),
  ]);

  const top = findings[0];

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Is ${repo.fullName} safe and healthy?`}
        actions={
          <div className="flex items-center gap-2">
            {repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
            <Badge variant={repo.guardianEnabled || repo.isDemo ? 'success' : 'outline'}>
              <Radar className="size-3" aria-hidden="true" />
              Guardian {repo.guardianEnabled || repo.isDemo ? 'active' : 'off'}
            </Badge>
            <ScanButton repositoryId={repo.id} />
            {repo.isDemo ? <DemoResetButton /> : null}
          </div>
        }
      />

      {!snapshot ? (
        <EmptyState
          icon={ShieldCheck}
          title="No scan has run yet"
          description="Run a scan to analyse this repository with the production scanners. Health scores appear after the first completed scan."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          <Card>
            <CardContent className="flex flex-col items-center gap-6 p-8">
              <ScoreRing score={snapshot.health} label="Health" />
              <div className="w-full text-center">
                <p className="text-xs text-[hsl(var(--muted-foreground))]">Current risk</p>
                <Badge variant={SEV[risk.level]} className="mt-2">
                  {risk.level.toUpperCase()}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dimensions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-5 sm:grid-cols-2">
              <ScoreBar label="Security" score={snapshot.security} />
              <ScoreBar label="Reliability" score={snapshot.reliability} />
              <ScoreBar label="Testing" score={snapshot.testing} />
              <ScoreBar label="Quality" score={snapshot.quality} />
            </CardContent>
          </Card>
        </div>
      )}

      {top ? (
        <Card className="mt-6">
          <CardContent className="p-6">
            <p className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              Highest-priority finding
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{top.title}</h2>
              <Badge variant={SEV[top.severity]}>{top.severity}</Badge>
            </div>
            {top.filePath ? (
              <p className="mt-1 break-all font-mono text-sm text-[hsl(var(--muted-foreground))]">
                {top.filePath}
                {top.lineStart ? `:${top.lineStart}` : ''}
              </p>
            ) : null}
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              {top.whyItMatters ?? top.description}
            </p>
            <div className="mt-4 flex flex-wrap gap-4 text-sm">
              <Link href={`/analysis`} className="text-[hsl(var(--primary))] underline-offset-4 hover:underline">
                View findings
              </Link>
              <Link href={`/fixes?finding=${top.id}`} className="text-[hsl(var(--primary))] underline-offset-4 hover:underline">
                Review a fix
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent findings</CardTitle>
          </CardHeader>
          <CardContent>
            {findings.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                {snapshot ? 'Your latest scan found no open issues.' : 'Run a scan to populate findings.'}
              </p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {findings.map((finding) => (
                  <li key={finding.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{finding.title}</p>
                      <p className="truncate font-mono text-xs text-[hsl(var(--muted-foreground))]">
                        {finding.filePath ?? finding.ruleId}
                      </p>
                    </div>
                    <Badge variant={SEV[finding.severity]}>{finding.severity}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

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
                      <p className="text-xs text-[hsl(var(--muted-foreground))]">{timeAgo(scan.createdAt)}</p>
                    </div>
                    <Badge
                      variant={
                        scan.status === 'completed' ? 'success' : scan.status === 'failed' ? 'critical' : 'outline'
                      }
                    >
                      {scan.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitPullRequest,
  Radar,
  Webhook,
} from 'lucide-react';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { RiskFactors } from '@/components/guardian/risk-factors';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';
import { getGuardianOverview } from '@/lib/guardian-queries';
import { getGuardianSignals } from '@/lib/guardian-risk';
import { getLatestSnapshot } from '@/lib/analysis-queries';
import { GuardianControlCenter } from '@/components/guardian/control-center';
import type { GuardedPullRequest, ScanJobSummary, WebhookDeliverySummary } from '@/lib/guardian-queries';
import type { ReactNode } from 'react';
import { formatDuration, timeAgo } from '@/lib/utils';
import type { Severity } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Guardian' };

const RISK_VARIANT: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

/**
 * Guardian — the continuous-scanning control room.
 *
 * Ordered by what a developer needs first: is the guardian actually connected
 * and receiving events, which pull requests are risky right now, and what is
 * the automation doing. Everything shown here comes from recorded webhook
 * deliveries and real scans; nothing is simulated.
 */
export default async function GuardianPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader
          title="Guardian"
          description="Connect a repository and the guardian will watch every push and pull request."
        />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const [overview, signals, snapshot] = await Promise.all([
    getGuardianOverview(repo.id),
    getGuardianSignals(repo.id),
    getLatestSnapshot(repo.id),
  ]);

  if (!overview) {
    return (
      <>
        <PageHeader title="Guardian" description={`Continuous scanning for ${repo.fullName}.`} />
        <EmptyState
          icon={Radar}
          title="Guardian data unavailable"
          description="This repository could not be loaded. It may have been disconnected."
        />
      </>
    );
  }

  const { connection, policy, deliveries, jobs, pullRequests, stats } = overview;
  const activeJobs = stats.queuedJobs + stats.runningJobs;

  return (
    <>
      <PageHeader
        title="Guardian"
        description={`Continuous scanning for ${connection.fullName}.`}
        actions={
          <div className="flex items-center gap-2">
            {repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
            {/* A demo repository has no event source, so "Paused" would read as
                a fault rather than the accurate "this never applied". */}
            {connection.source === 'demo' ? (
              <Badge variant="outline">
                <Radar className="size-3" aria-hidden="true" />
                Local scans only
              </Badge>
            ) : (
              <Badge variant={connection.guardianEnabled ? 'success' : 'outline'}>
                <Radar className="size-3" aria-hidden="true" />
                {connection.guardianEnabled ? 'Watching' : 'Paused'}
              </Badge>
            )}
          </div>
        }
      />

      <GuardianControlCenter
        active={connection.guardianEnabled || connection.source === 'demo'}
        health={snapshot?.health ?? null}
        risk={signals.risk}
        lastScanAt={connection.lastScanAt}
        events={signals.events}
        recommendations={signals.recommendations}
      />

      {signals.attackPaths.length > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Defensive attack paths</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {signals.attackPaths.slice(0, 5).map((path) => (
                <li key={path.hops.join('>')} className="text-sm">
                  <Badge variant={path.confidence === 'confirmed' ? 'high' : 'outline'}>
                    {path.confidence}
                  </Badge>
                  <span className="ml-2 font-mono text-xs">{path.hops.join(' → ')}</span>
                  <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{path.evidence}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {/* Connection state first: everything below is meaningless if events never arrive. */}
      <div className="mt-6">
      <ConnectionBanner
        installed={connection.installed}
        guardianEnabled={connection.guardianEnabled}
        source={connection.source}
        deliveriesLast7Days={stats.deliveriesLast7Days}
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Webhook}
          label="Deliveries (7d)"
          value={stats.deliveriesLast7Days}
          hint={`${stats.processedLast7Days} processed · ${stats.failedLast7Days} failed`}
          tone={stats.failedLast7Days > 0 ? 'warning' : 'default'}
        />
        <StatCard
          icon={Activity}
          label="Scan queue"
          value={activeJobs}
          hint={`${stats.runningJobs} running · ${stats.queuedJobs} queued`}
        />
        <StatCard
          icon={GitPullRequest}
          label="Risky pull requests"
          value={stats.openRiskyPullRequests}
          hint="Open PRs at high or critical risk"
          tone={stats.openRiskyPullRequests > 0 ? 'warning' : 'default'}
        />
        <StatCard
          icon={Clock}
          label="Last scan"
          value={connection.lastScanAt ? timeAgo(connection.lastScanAt) : 'Never'}
          hint={`Default branch: ${connection.defaultBranch}`}
        />
      </div>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">Pull requests under guard</h2>
        {pullRequests.length === 0 ? (
          <EmptyState
            icon={GitPullRequest}
            title="No pull requests scanned yet"
            description="When a pull request is opened or updated, the guardian scans its head commit, compares it against the base, and posts the risk assessment here and on GitHub."
          />
        ) : (
          <div className="space-y-4">
            {pullRequests.map((pr) => (
              <PullRequestCard key={pr.id} pr={pr} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent webhook deliveries</CardTitle>
          </CardHeader>
          <CardContent>
            {deliveries.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                No deliveries received yet.
              </p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {deliveries.map((delivery) => (
                  <DeliveryRow key={delivery.id} delivery={delivery} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Scan queue</CardTitle>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                Nothing queued. Jobs appear here when a webhook or schedule triggers a scan.
              </p>
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Active policy</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <PolicyItem
            label="Block merges at or above"
            value={<Badge variant={RISK_VARIANT[policy.failOnSeverity]}>{policy.failOnSeverity}</Badge>}
            hint="A new finding at this severity fails the check"
          />
          <PolicyItem label="Scan on push" value={<OnOff on={policy.scanOnPush} />} hint="Default branch only" />
          <PolicyItem label="Scan on pull request" value={<OnOff on={policy.scanOnPullRequest} />} />
          <PolicyItem label="Post PR comments" value={<OnOff on={policy.postPrComments} />} hint="One sticky comment, edited in place" />
          <PolicyItem label="Create GitHub checks" value={<OnOff on={policy.createChecks} />} />
          <PolicyItem
            label="Scheduled scan"
            value={<span className="text-sm font-medium capitalize">{policy.scanSchedule}</span>}
          />
        </CardContent>
      </Card>

      <p className="mt-6 text-xs text-[hsl(var(--muted-foreground))]">
        The guardian never modifies your code. It analyses, reports and requests changes — applying a fix
        always requires your explicit approval in Fix Center. A GitHub Check is a report; it only blocks
        a merge when branch protection requires that check.
      </p>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function ConnectionBanner({
  installed,
  guardianEnabled,
  source,
  deliveriesLast7Days,
}: {
  installed: boolean;
  guardianEnabled: boolean;
  source: string;
  deliveriesLast7Days: number;
}) {
  if (source === 'demo') {
    return (
      <Banner
        tone="info"
        icon={Radar}
        title="Demo repository — local fixture, no GitHub connection"
        body="Scans run against the bundled vulnerable fixture on disk. Webhook delivery and GitHub Checks require a real repository connected through the GitHub App."
      />
    );
  }

  if (!installed) {
    return (
      <Banner
        tone="warning"
        icon={AlertTriangle}
        title="No GitHub App installation linked"
        body="Push and pull request events cannot reach CodeSentinel until the GitHub App is installed on this repository. See docs/github-app-setup.md."
      />
    );
  }

  if (!guardianEnabled) {
    return (
      <Banner
        tone="warning"
        icon={AlertTriangle}
        title="Guardian is paused for this repository"
        body="Webhook deliveries are still recorded, but no scans are queued. Re-enable the guardian in Settings."
      />
    );
  }

  if (deliveriesLast7Days === 0) {
    return (
      <Banner
        tone="info"
        icon={Webhook}
        title="Connected, but no events received in the last 7 days"
        body="This is normal for a quiet repository. If you expected activity, check the webhook delivery log in your GitHub App settings."
      />
    );
  }

  return (
    <Banner
      tone="success"
      icon={CheckCircle2}
      title="Guardian is connected and receiving events"
      body="Pushes to the default branch and pull request updates are scanned automatically."
    />
  );
}

function Banner({
  tone,
  icon: Icon,
  title,
  body,
}: {
  tone: 'success' | 'warning' | 'info';
  icon: typeof Radar;
  title: string;
  body: string;
}) {
  const styles = {
    success: 'border-[hsl(var(--success))]/25 bg-[hsl(var(--success))]/5 text-[hsl(var(--success))]',
    warning: 'border-[hsl(var(--high))]/25 bg-[hsl(var(--high))]/5 text-[hsl(var(--high))]',
    info: 'border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 text-[hsl(var(--muted-foreground))]',
  }[tone];

  return (
    <div className={`flex items-start gap-3 rounded-lg border p-4 ${styles}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{body}</p>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon: typeof Radar;
  label: string;
  value: string | number;
  hint: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center gap-2 text-[hsl(var(--muted-foreground))]">
          <Icon className="size-3.5" aria-hidden="true" />
          <p className="text-xs font-medium">{label}</p>
        </div>
        <p
          className={`mt-2 text-2xl font-semibold tabular-nums ${
            tone === 'warning' ? 'text-[hsl(var(--high))]' : ''
          }`}
        >
          {value}
        </p>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p>
      </CardContent>
    </Card>
  );
}

function PullRequestCard({ pr }: { pr: GuardedPullRequest }) {
  const blocked = pr.checkConclusion === 'failure';

  return (
    <Card>
      <CardContent className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-[hsl(var(--muted-foreground))]">#{pr.number}</span>
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{pr.title ?? 'Untitled pull request'}</p>
            {pr.riskLevel ? (
              <Badge variant={RISK_VARIANT[pr.riskLevel]}>
                {pr.riskLevel} risk{pr.riskScore !== null ? ` · ${pr.riskScore}` : ''}
              </Badge>
            ) : (
              <Badge variant="outline">Not scanned</Badge>
            )}
            {blocked ? <Badge variant="critical">Blocked by policy</Badge> : null}
          </div>

          <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
            {pr.authorLogin ? `${pr.authorLogin} · ` : ''}
            <span className="font-mono">{pr.headRef ?? '?'}</span> → <span className="font-mono">{pr.baseRef ?? '?'}</span>
            {' · '}
            {timeAgo(pr.updatedAt)}
          </p>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Metric label="Files changed" value={pr.filesChanged} />
            <Metric label="Lines" value={`+${pr.additions} / −${pr.deletions}`} />
            <Metric label="Findings on head" value={pr.findingsOnHead} />
            <Metric label="State" value={pr.state} />
          </dl>
        </div>

        <div className="lg:border-l lg:border-[hsl(var(--border))] lg:pl-6">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Why this risk score
          </p>
          <RiskFactors factors={pr.riskFactors} />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-[hsl(var(--muted-foreground))]">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums capitalize">{value}</dd>
    </div>
  );
}

function DeliveryRow({ delivery }: { delivery: WebhookDeliverySummary }) {
  const variant =
    delivery.status === 'processed'
      ? 'success'
      : delivery.status === 'failed'
        ? 'critical'
        : 'outline';

  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {delivery.event}
          {delivery.action ? (
            <span className="text-[hsl(var(--muted-foreground))]">.{delivery.action}</span>
          ) : null}
        </p>
        {/* The reason an event was ignored is the whole point of this log. */}
        {delivery.message ? (
          <p className="mt-0.5 truncate text-xs text-[hsl(var(--muted-foreground))]" title={delivery.message}>
            {delivery.message}
          </p>
        ) : null}
        <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
          {timeAgo(delivery.createdAt)}
          {delivery.durationMs !== null ? ` · ${formatDuration(delivery.durationMs)}` : ''}
        </p>
      </div>
      <Badge variant={variant}>{delivery.status}</Badge>
    </li>
  );
}

function JobRow({ job }: { job: ScanJobSummary }) {
  const variant =
    job.status === 'completed'
      ? 'success'
      : job.status === 'failed'
        ? 'critical'
        : job.status === 'running'
          ? 'primary'
          : 'outline';

  return (
    <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium capitalize">
          {job.trigger.replace('_', ' ')}
          {job.pullRequestNumber ? ` · #${job.pullRequestNumber}` : ''}
        </p>
        <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
          {job.commitSha ? <span className="font-mono">{job.commitSha.slice(0, 7)}</span> : 'no commit'}
          {' · '}
          {timeAgo(job.createdAt)}
          {job.attempts > 1 ? ` · attempt ${job.attempts}/${job.maxAttempts}` : ''}
        </p>
        {job.error ? (
          <p className="mt-0.5 truncate text-xs text-[hsl(var(--critical))]" title={job.error}>
            {job.error}
          </p>
        ) : null}
      </div>
      <Badge variant={variant}>{job.status}</Badge>
    </li>
  );
}

function PolicyItem({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
      <div className="mt-1.5">{value}</div>
      {hint ? <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p> : null}
    </div>
  );
}

function OnOff({ on }: { on: boolean }) {
  return <Badge variant={on ? 'success' : 'outline'}>{on ? 'On' : 'Off'}</Badge>;
}

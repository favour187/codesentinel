import { ShieldAlert } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getOpenFindings } from '@/lib/analysis-queries';
import { listRepositoriesForUser } from '@/lib/repositories';
import { groupFindings } from '@/guardian/triage';
import type { Severity } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Analysis' };

const VARIANT: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

export default async function AnalysisPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader title="Analysis" description="Connect a repository to see real scanner findings." />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const findings = await getOpenFindings(repo.id, 200);
  const groups = groupFindings(findings);

  return (
    <>
      <PageHeader
        title="Analysis"
        description={`Open findings for ${repo.fullName}, grouped when they share a risk area.`}
        actions={repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
      />

      {findings.length === 0 ? (
        <EmptyState
          icon={ShieldAlert}
          title="No open findings"
          description="Your latest scan found no open issues. Run another scan after you change code."
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <Card key={group.key}>
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">{group.title}</h2>
                  <Badge variant={VARIANT[group.severity]}>{group.severity}</Badge>
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {group.findings.length} finding{group.findings.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul className="mt-4 divide-y divide-[hsl(var(--border))]">
                  {group.findings.map((finding) => {
                    const full = findings.find((f) => f.id === finding.id);
                    return (
                      <li key={finding.id} className="py-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{finding.title}</p>
                          <Badge variant={VARIANT[finding.severity]}>{finding.severity}</Badge>
                        </div>
                        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                          <div>
                            <dt className="text-xs text-[hsl(var(--muted-foreground))]">Where</dt>
                            <dd className="break-all font-mono text-xs">
                              {finding.filePath ?? 'repository-wide'}
                              {full?.lineStart ? `:${full.lineStart}` : ''}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-[hsl(var(--muted-foreground))]">Confidence</dt>
                            <dd>{full ? `${Math.round(full.confidence * 100)}%` : '—'}</dd>
                          </div>
                        </dl>
                        {full?.description ? (
                          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">{full.description}</p>
                        ) : null}
                        {full?.whyItMatters ? (
                          <p className="mt-2 text-sm">
                            <span className="font-medium">Why it matters. </span>
                            {full.whyItMatters}
                          </p>
                        ) : null}
                        {full?.remediation ? (
                          <p className="mt-2 text-sm">
                            <span className="font-medium">How to fix. </span>
                            {full.remediation}
                          </p>
                        ) : null}
                        <a
                          href={`/fixes?finding=${finding.id}`}
                          className="mt-3 inline-block text-sm text-[hsl(var(--primary))] underline-offset-4 hover:underline"
                        >
                          Review a suggested fix
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

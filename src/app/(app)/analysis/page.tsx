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
          description="Run a scan. This list only shows issues the scanners actually produced."
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
                  {group.findings.map((finding) => (
                    <li key={finding.id} className="py-3">
                      <p className="text-sm font-medium">{finding.title}</p>
                      <p className="mt-0.5 font-mono text-xs text-[hsl(var(--muted-foreground))]">
                        {finding.ruleId}
                        {finding.filePath ? ` · ${finding.filePath}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

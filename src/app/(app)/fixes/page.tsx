import { Wrench } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { FixPanel } from '@/components/fixes/fix-panel';
import { AIUnavailableNotice } from '@/components/ai/ai-disclosure';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';
import { getOpenFindings } from '@/lib/analysis-queries';
import { isAIConfigured } from '@/ai/router';
import { cn } from '@/lib/utils';
import type { Severity } from '@/db/schema';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fix Center' };

const SEVERITY_VARIANT: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};







export default async function FixCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ finding?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader
          title="Fix Center"
          description="Review proposed patches before anything touches your code."
        />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const findings = await getOpenFindings(repo.id, 100);
  const { finding: requestedId } = await searchParams;
  const selected = findings.find((f) => f.id === requestedId) ?? findings[0];

  return (
    <>
      <PageHeader
        title="Fix Center"
        description="Every fix is a proposal. CodeSentinel shows you the diff and the risks; you decide whether to apply it."
      />

      {findings.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No open findings"
          description="Nothing needs fixing right now. Run a scan from the Overview page after your next change."
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          {}
          <nav aria-label="Open findings" className="space-y-2 lg:max-h-[calc(100vh-14rem)] lg:overflow-y-auto lg:pr-1">
            <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
              {findings.length} open finding{findings.length === 1 ? '' : 's'}
            </p>

            {findings.map((finding) => {
              const isSelected = finding.id === selected?.id;
              return (
                <Link
                  key={finding.id}
                  href={`/fixes?finding=${finding.id}`}
                  scroll={false}
                  aria-current={isSelected ? 'true' : undefined}
                  className={cn(
                    'block rounded-lg border p-3 transition-colors',
                    isSelected
                      ? 'border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/5'
                      : 'border-[hsl(var(--border))] hover:bg-[hsl(var(--muted))]',
                  )}
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <span className="text-sm font-medium leading-snug">{finding.title}</span>
                    <Badge variant={SEVERITY_VARIANT[finding.severity]} className="w-fit">{finding.severity}</Badge>
                  </div>
                  {finding.filePath ? (
                    <p className="mt-1 break-all font-mono text-xs text-[hsl(var(--muted-foreground))]">
                      {finding.filePath}
                      {finding.lineStart ? `:${finding.lineStart}` : ''}
                    </p>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          {}
          <Card className="p-4 sm:p-6">
            {!isAIConfigured() ? <AIUnavailableNotice className="mb-6" /> : null}

            {selected ? (
              <FixPanel
                key={selected.id}
                finding={{
                  id: selected.id,
                  title: selected.title,
                  severity: selected.severity,
                  ruleId: selected.ruleId,
                  filePath: selected.filePath,
                  lineStart: selected.lineStart,
                  description: selected.description,
                  evidence: selected.evidence,
                  remediation: selected.remediation,
                  whyItMatters: selected.whyItMatters,
                }}
              />
            ) : (
              <EmptyState icon={Wrench} title="Select a finding" description="Choose a finding to review its fix." />
            )}
          </Card>
        </div>
      )}
    </>
  );
}

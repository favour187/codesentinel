import { FlaskConical } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getLatestChangedPaths } from '@/lib/codebase-queries';
import { listRepositoriesForUser } from '@/lib/repositories';
import { detectTestGaps, getTestIntelligence } from '@/testing/gaps';
import { prioritizeTests } from '@/testing/prioritize';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Testing' };

const SEVERITY_VARIANT = {
  high: 'high',
  medium: 'medium',
  low: 'low',
} as const;

export default async function TestingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader title="Testing" description="Connect a repository to discover its tests and gaps." />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const [intel, gaps, changedPaths] = await Promise.all([
    getTestIntelligence(repo.id),
    detectTestGaps(repo.id, undefined, { limit: 40 }),
    getLatestChangedPaths(repo.id),
  ]);

  const recommended =
    changedPaths.length > 0 ? await prioritizeTests(repo.id, changedPaths, { limit: 12 }) : [];

  const linkagePct = Math.round(intel.linkageRatio * 100);

  return (
    <>
      <PageHeader
        title="Testing"
        description={`What the scanners can prove about tests in ${repo.fullName}. Linkage is not line coverage.`}
        actions={repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
      />

      {intel.testFileCount === 0 && intel.sourceFileCount === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No scan has classified tests yet"
          description="After a scan, this page lists discovered test files, modules no test imports, and suggested cases from parsed signatures."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Test files" value={intel.testFileCount} hint={intel.frameworks.join(', ') || 'framework unknown'} />
            <Stat label="Test cases" value={intel.testCaseCount} />
            <Stat
              label="Module linkage"
              value={`${linkagePct}%`}
              hint={`${intel.testedFileCount} of ${intel.sourceFileCount} source files imported by a test`}
            />
            <Stat
              label="Untested source files"
              value={intel.untestedFiles.length}
              tone={intel.untestedFiles.length > 0 ? 'warning' : 'default'}
            />
          </div>

          <Card className="mt-6">
            <CardContent className="p-5 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
              {intel.coverageAvailable ? (
                <p>A coverage report was ingested for this scan.</p>
              ) : (
                <p>
                  No coverage report has been ingested. The percentage above is the share of source files a
                  test file imports — evidence a module is exercised, not a line-coverage number.
                </p>
              )}
            </CardContent>
          </Card>

          {intel.testsWithoutAssertions.length > 0 ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Tests without assertions</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 break-all font-mono text-sm">
                  {intel.testsWithoutAssertions.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold">Test gaps</h2>
            {gaps.length === 0 ? (
              <EmptyState
                icon={FlaskConical}
                title="No high-value gaps in exported symbols"
                description="Gaps are exported functions, classes or methods in source files that no test imports. Covered files are not listed — we do not pretend to know which function a suite actually calls."
              />
            ) : (
              <div className="space-y-4">
                {gaps.map((gap) => (
                  <Card key={`${gap.filePath}:${gap.symbolName}:${gap.lineStart}`}>
                    <CardContent className="p-5">
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                        <p className="text-sm font-semibold">{gap.symbolName}</p>
                        <Badge variant={SEVERITY_VARIANT[gap.severity]} className="w-fit">{gap.severity}</Badge>
                        <span className="break-all font-mono text-xs text-[hsl(var(--muted-foreground))]">
                          {gap.filePath}:{gap.lineStart}
                        </span>
                      </div>
                      <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">{gap.reason}</p>
                      {gap.signature ? (
                        <p className="mt-2 font-mono text-xs text-[hsl(var(--muted-foreground))]">{gap.signature}</p>
                      ) : null}
                      <ul className="mt-4 space-y-1.5 text-sm">
                        {gap.scenarios.map((scenario) => (
                          <li key={scenario.description}>
                            <span className="font-medium">{scenario.description}</span>
                            <span className="text-[hsl(var(--muted-foreground))]"> — {scenario.rationale}</span>
                          </li>
                        ))}
                      </ul>
                      {gap.existingTests.length > 0 ? (
                        <p className="mt-3 text-xs text-[hsl(var(--muted-foreground))]">
                          Nearby suites: {gap.existingTests.join(', ')}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold">Regression tests to run</h2>
            {recommended.length === 0 ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                {changedPaths.length === 0
                  ? 'No commit paths are recorded yet, so there is nothing to rank tests against.'
                  : 'No existing test file reaches the latest changed paths through the import graph.'}
              </p>
            ) : (
              <Card>
                <CardContent>
                  <ul className="divide-y divide-[hsl(var(--border))]">
                    {recommended.map((test) => (
                      <li key={test.testPath} className="py-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                          <p className="break-all font-mono text-sm">{test.testPath}</p>
                          <span className="tabular-nums text-xs text-[hsl(var(--muted-foreground))]">
                            {test.score}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{test.justification}</p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
        <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone === 'warning' ? 'text-[hsl(var(--high))]' : ''}`}>
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

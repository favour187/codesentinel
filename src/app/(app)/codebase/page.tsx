import { Network } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ArchitectureMap, ComponentEdges } from '@/components/codebase/architecture-map';
import { CodebaseSearch } from '@/components/codebase/codebase-search';
import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { previewChangeImpact } from '@/analysis/change-impact';
import { getCurrentUser } from '@/lib/auth/current-user';
import {
  getArchitectureOverview,
  getDependencyInventory,
  getLatestChangedPaths,
  getSearchIndex,
} from '@/lib/codebase-queries';
import { listRepositoriesForUser } from '@/lib/repositories';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Codebase' };

export default async function CodebasePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader
          title="Codebase"
          description="Connect a repository to build its architecture map from real files."
        />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const [architecture, inventory, searchIndex, changedPaths] = await Promise.all([
    getArchitectureOverview(repo.id),
    getDependencyInventory(repo.id),
    getSearchIndex(repo.id),
    getLatestChangedPaths(repo.id),
  ]);

  const impact =
    changedPaths.length > 0 ? await previewChangeImpact(repo.id, changedPaths.slice(0, 20)) : null;

  const names = Object.fromEntries(
    architecture.layers.flatMap((row) => row.components.map((c) => [c.key, c.name])),
  );

  return (
    <>
      <PageHeader
        title="Codebase"
        description={`Architecture, packages and search for ${repo.fullName}. Derived from the digital twin — not guessed.`}
        actions={repo.isDemo ? <Badge variant="medium">Demo fixture</Badge> : null}
      />

      {!architecture.indexed && inventory.total === 0 ? (
        <EmptyState
          icon={Network}
          title="Repository has not been indexed yet"
          description="Run a scan to extract files, imports, symbols and package manifests. The map stays empty until that evidence exists."
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Files indexed" value={architecture.fileCount} />
            <Stat label="Symbols" value={architecture.symbolCount} />
            <Stat label="Packages" value={inventory.total} hint={inventory.ecosystems.join(', ') || undefined} />
            <Stat
              label="Vulnerable packages"
              value={inventory.vulnerable}
              tone={inventory.vulnerable > 0 ? 'warning' : 'default'}
            />
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Search</CardTitle>
            </CardHeader>
            <CardContent>
              <CodebaseSearch documents={searchIndex} />
            </CardContent>
          </Card>

          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold">Architecture</h2>
            {architecture.layers.length === 0 ? (
              <EmptyState
                icon={Network}
                title="No components grouped yet"
                description="Components are derived from directory structure after a scan. Re-scan if files exist but this map is empty."
              />
            ) : (
              <ArchitectureMap layers={architecture.layers} />
            )}
          </section>

          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Import relationships</CardTitle>
              </CardHeader>
              <CardContent>
                <ComponentEdges edges={architecture.edges} names={names} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Detected API surface</CardTitle>
              </CardHeader>
              <CardContent>
                {architecture.routes.length === 0 ? (
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    No HTTP routes were detected from static evidence. Only explicit route literals are
                    listed.
                  </p>
                ) : (
                  <ul className="divide-y divide-[hsl(var(--border))]">
                    {architecture.routes.map((route) => (
                      <li key={`${route.route}:${route.filePath}`} className="py-2.5">
                        <p className="font-mono text-sm">{route.route}</p>
                        <p className="mt-0.5 font-mono text-xs text-[hsl(var(--muted-foreground))]">
                          {route.filePath}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Package dependencies</CardTitle>
            </CardHeader>
            <CardContent>
              {inventory.packages.length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  No manifests were parsed. Supported: package.json, requirements.txt, pyproject.toml.
                </p>
              ) : (
                <ul className="divide-y divide-[hsl(var(--border))]">
                  {inventory.packages.slice(0, 40).map((pkg) => (
                    <li
                      key={`${pkg.ecosystem}:${pkg.name}:${pkg.manifestPath ?? ''}`}
                      className="flex items-start justify-between gap-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {pkg.name}
                          <span className="ml-2 font-mono text-xs text-[hsl(var(--muted-foreground))]">
                            {pkg.version ?? pkg.versionSpec ?? ''}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                          {pkg.ecosystem}
                          {pkg.isDev ? ' · dev' : ''}
                          {pkg.manifestPath ? ` · ${pkg.manifestPath}` : ''}
                        </p>
                        {pkg.vulnerabilities[0] ? (
                          <p className="mt-1 text-xs text-[hsl(var(--high))]">
                            {pkg.vulnerabilities[0].id}: {pkg.vulnerabilities[0].summary}
                            {pkg.vulnerabilities.length > 1
                              ? ` · +${pkg.vulnerabilities.length - 1} more`
                              : ''}
                          </p>
                        ) : null}
                      </div>
                      {pkg.vulnerabilities.length > 0 ? (
                        <Badge variant={pkg.vulnerabilities[0]?.severity === 'critical' ? 'critical' : 'high'}>
                          {pkg.vulnerabilities.length}{' '}
                          {pkg.vulnerabilities.length === 1 ? 'advisory' : 'advisories'}
                        </Badge>
                      ) : (
                        <Badge variant="outline">clean</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {impact?.resolved ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Change impact (latest recorded commit)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {impact.changedFiles.length} changed file{impact.changedFiles.length === 1 ? '' : 's'} ·{' '}
                  {impact.affectedFiles.length} possible dependents · {impact.impactLevel} impact
                </p>
                {impact.riskFactors.length > 0 ? (
                  <ul className="space-y-2">
                    {impact.riskFactors.slice(0, 6).map((factor) => (
                      <li key={factor.label} className="text-sm">
                        <span className="font-medium">{factor.label}</span>
                        <span className="text-[hsl(var(--muted-foreground))]"> — {factor.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    No extra risk factors fired for this change.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {architecture.databases.length > 0 ? (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Database targets</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-2">
                  {architecture.databases.map((d) => (
                    <li key={`${d.target}:${d.filePath}`}>
                      <Badge variant="outline">{d.target}</Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
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
  value: number;
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

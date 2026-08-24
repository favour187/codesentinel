import * as React from 'react';
import { redirect } from 'next/navigation';
import { Check, X, Database, Sparkles, KeyRound, Webhook, FolderGit2 } from 'lucide-react';
import { GitHubIcon } from '@/components/ui/icons';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { GitHubRepoPicker } from '@/components/dashboard/github-repo-picker';
import { getCurrentUser } from '@/lib/auth/current-user';
import { listRepositoriesForUser } from '@/lib/repositories';
import { getFeatures } from '@/lib/env';
import { getDbKind } from '@/db';
import { timeAgo } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

interface StatusRowProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  enabled: boolean;
  detail: string;
  envHint?: string;
}

function StatusRow({ icon: Icon, label, enabled, detail, envHint }: StatusRowProps) {
  return (
    <li className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--muted))]">
        <Icon className="size-4 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{label}</p>
          <Badge variant={enabled ? 'success' : 'outline'}>
            {enabled ? <Check className="size-3" aria-hidden="true" /> : <X className="size-3" aria-hidden="true" />}
            {enabled ? 'Configured' : 'Not configured'}
          </Badge>
        </div>
        <p className="mt-1 text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">{detail}</p>
        {!enabled && envHint ? (
          <p className="mt-1.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">{envHint}</p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Settings reports the *actual* runtime configuration of this instance —
 * feature detection from validated environment variables, never a hard-coded
 * "all systems go" panel.
 */
export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const features = getFeatures();
  const dbKind = getDbKind();
  const repos = await listRepositoriesForUser(user.id);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Integration status for this CodeSentinel instance, derived from your environment configuration."
      />

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>System status</CardTitle>
            <CardDescription>
              CodeSentinel degrades gracefully: deterministic scanners always run, and optional integrations
              announce themselves as unavailable rather than failing silently.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-[hsl(var(--border))]">
              <StatusRow
                icon={Database}
                label="Database"
                enabled
                detail={
                  dbKind === 'postgres'
                    ? 'Connected to a PostgreSQL server via DATABASE_URL.'
                    : 'Using the embedded PGlite database (real PostgreSQL via WASM) at ./.data/pglite. Set DATABASE_URL to use a PostgreSQL server.'
                }
              />
              <StatusRow
                icon={GitHubIcon}
                label="GitHub OAuth"
                enabled={features.githubOAuth}
                detail="Lets developers sign in and connect the repositories they can access."
                envHint="GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET"
              />
              <StatusRow
                icon={Webhook}
                label="GitHub App & webhooks"
                enabled={features.githubApp && features.webhooks}
                detail="Required for Guardian automation: push/PR scanning, GitHub Checks and review comments."
                envHint="GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET"
              />
              <StatusRow
                icon={KeyRound}
                label="Credential encryption"
                enabled={features.encryptionKey}
                detail={
                  features.encryptionKey
                    ? 'Tokens are encrypted at rest with AES-256-GCM using a dedicated key.'
                    : 'Falling back to a key derived from SESSION_SECRET. Acceptable for local development; ENCRYPTION_KEY is mandatory in production.'
                }
                envHint="ENCRYPTION_KEY (openssl rand -base64 32)"
              />
              <StatusRow
                icon={Sparkles}
                label="AI explanations"
                enabled={features.llm}
                detail="Optional. AI explains and prioritises deterministic findings; it never generates findings on its own."
                envHint="FEATHERLESS_API_KEY, GROQ_API_KEY"
              />
            </ul>
          </CardContent>
        </Card>

        <Card id="repositories">
          <CardHeader>
            <CardTitle>Connected repositories</CardTitle>
            <CardDescription>Repositories CodeSentinel is allowed to analyse.</CardDescription>
          </CardHeader>
          <CardContent>
            {!user.isDemo && features.githubOAuth ? (
              <div className="mb-8">
                <p className="mb-3 text-sm font-medium">Add from GitHub</p>
                <GitHubRepoPicker />
              </div>
            ) : null}
            {repos.length === 0 ? (
              <EmptyState
                icon={FolderGit2}
                title="No repositories connected"
                description={
                  user.isDemo
                    ? 'You are in the demo workspace. Sign out and Connect GitHub to add a real repository.'
                    : 'Sign in with GitHub, then connect a repository from the list above.'
                }
              />
            ) : (
              <ul className="divide-y divide-[hsl(var(--border))]">
                {repos.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{r.fullName}</p>
                      <p className="mt-0.5 text-xs text-[hsl(var(--muted-foreground))]">
                        {r.primaryLanguage ? `${r.primaryLanguage} · ` : ''}
                        default branch <span className="font-mono">{r.defaultBranch}</span> · last scan{' '}
                        {timeAgo(r.lastScanAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.isDemo ? <Badge variant="medium">Demo fixture</Badge> : <Badge variant="outline">GitHub</Badge>}
                      <Badge variant={r.guardianEnabled ? 'success' : 'outline'}>
                        Guardian {r.guardianEnabled ? 'on' : 'off'}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Security posture</CardTitle>
            <CardDescription>Guarantees this build enforces.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2">
              {[
                'GitHub tokens encrypted with AES-256-GCM at rest',
                'Discovered secrets are fingerprinted, never stored or shown',
                'Webhook payloads verified via HMAC signature',
                'OAuth state parameter checked in constant time',
                'Session cookies are httpOnly, SameSite=Lax, signed',
                'Code is never modified without explicit approval',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-[hsl(var(--muted-foreground))]">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-[hsl(var(--success))]" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

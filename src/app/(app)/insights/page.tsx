import { TrendingUp } from 'lucide-react';
import { redirect } from 'next/navigation';

import { ConnectRepository } from '@/components/dashboard/connect-repository';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { getCurrentUser } from '@/lib/auth/current-user';
import { getSnapshotHistory } from '@/lib/analysis-queries';
import { insightSeries } from '@/lib/insights';
import { listRepositoriesForUser } from '@/lib/repositories';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Insights' };

export default async function InsightsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const repos = await listRepositoriesForUser(user.id);
  const repo = repos[0];

  if (!repo) {
    return (
      <>
        <PageHeader title="Insights" description="Connect a repository to see measured trends." />
        <ConnectRepository githubConnected={!user.isDemo} demoAvailable />
      </>
    );
  }

  const history = await getSnapshotHistory(repo.id, 30);
  const series = insightSeries(history);

  return (
    <>
      <PageHeader
        title="Insights"
        description={`Trajectories for ${repo.fullName} from stored health snapshots.`}
      />
      {history.length < 2 ? (
        <EmptyState
          icon={TrendingUp}
          title="Not enough history"
          description="Need at least two completed scans before a trajectory is honest."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Health" value={series.health} />
          <Metric label="Security" value={series.security} />
          <Metric label="Testing" value={series.testing} />
          <Metric label="Technical debt" value={series.debt} />
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const variant = value === 'improving' ? 'success' : value === 'degrading' ? 'high' : 'outline';
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
        <div className="mt-2">
          <Badge variant={variant}>{value}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}

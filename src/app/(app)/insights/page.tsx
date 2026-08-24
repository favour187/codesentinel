import { TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PhasePlaceholder } from '@/components/shared/phase-placeholder';

export const metadata = { title: 'Insights' };

export default function InsightsPage() {
  return (
    <>
      <PageHeader
        title="Insights"
        description="How this repository's health is trending over time."
      />
      <PhasePlaceholder
        icon={TrendingUp}
        title="Trends and technical debt"
        phase="Phase 7"
        description="Built from stored health snapshots and git history — no synthetic data. Shows where risk is accumulating and which problems keep coming back."
        capabilities={[
          'Health and security history',
          'Technical debt estimates',
          'Recurring problem detection',
          'Risk trends',
          'Repository activity',
          'Issue resolution trends',
        ]}
      />
    </>
  );
}

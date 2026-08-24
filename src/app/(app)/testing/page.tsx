import { FlaskConical } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PhasePlaceholder } from '@/components/shared/phase-placeholder';

export const metadata = { title: 'Testing' };

export default function TestingPage() {
  return (
    <>
      <PageHeader
        title="Testing"
        description="Test discovery, coverage signals and gaps in code that changed recently."
      />
      <PhasePlaceholder
        icon={FlaskConical}
        title="Test intelligence"
        phase="Phase 6"
        description="Discovers real test files, maps them to the modules they exercise via the import graph, and flags risky code paths that no test touches."
        capabilities={[
          'Test discovery across frameworks',
          'Coverage information where available',
          'Test-gap detection',
          'Suggested unit tests',
          'Suggested edge cases',
          'Regression-test suggestions',
        ]}
      />
    </>
  );
}

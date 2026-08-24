import { Wrench } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PhasePlaceholder } from '@/components/shared/phase-placeholder';

export const metadata = { title: 'Fix Center' };

export default function FixCenterPage() {
  return (
    <>
      <PageHeader
        title="Fix Center"
        description="Review proposed patches before anything touches your code. Nothing is ever applied automatically."
      />
      <PhasePlaceholder
        icon={Wrench}
        title="Reviewable fixes"
        phase="Phase 5"
        description="For every supported finding CodeSentinel prepares an explanation, the affected code, a unified diff and a suggested regression test — staged for explicit human approval."
        capabilities={[
          'Issue explanation in plain language',
          'Affected code with context',
          'Generated patch / unified diff',
          'Patch explanation',
          'Suggested regression test',
          'Explicit review and approval step',
        ]}
      />
    </>
  );
}

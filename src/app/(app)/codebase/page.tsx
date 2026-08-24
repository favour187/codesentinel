import { Network } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PhasePlaceholder } from '@/components/shared/phase-placeholder';

export const metadata = { title: 'Codebase' };

export default function CodebasePage() {
  return (
    <>
      <PageHeader
        title="Codebase"
        description="Repository intelligence: how your code is structured and how it connects."
      />
      <PhasePlaceholder
        icon={Network}
        title="Repository digital twin"
        phase="Phase 6"
        description="An AST-derived model of the repository — import relationships, module boundaries and detectable API surface — that powers blast-radius and change-impact analysis."
        capabilities={[
          'Architecture overview',
          'Import and dependency graph',
          'API map where detectable',
          'Component map',
          'Change-impact analysis',
          'Codebase search',
        ]}
      />
    </>
  );
}

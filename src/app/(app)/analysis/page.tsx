import { ShieldAlert } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { PhasePlaceholder } from '@/components/shared/phase-placeholder';

export const metadata = { title: 'Analysis' };

export default function AnalysisPage() {
  return (
    <>
      <PageHeader
        title="Analysis"
        description="Every finding produced by the deterministic scanners, grouped by category and severity."
      />
      <PhasePlaceholder
        icon={ShieldAlert}
        title="Findings explorer"
        phase="Phase 2–3"
        description="Once the scanner engine lands, this page lists real findings from your source code across nine categories, with a contextual side panel for evidence, confidence, impact and remediation."
        capabilities={[
          'Security, bugs, quality, dependencies',
          'Performance, reliability, secrets',
          'Architecture and infrastructure',
          'Severity and confidence filtering',
          'File and line-range attribution',
          'Remediation guidance per finding',
        ]}
      />
    </>
  );
}

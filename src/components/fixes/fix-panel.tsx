'use client';

import { useCallback, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FlaskConical,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeBlock, DiffView } from './diff-view';
import { AIDisclosure, ClaimList, ConfidenceBadge } from '@/components/ai/ai-disclosure';
import { cn } from '@/lib/utils';
import type { Severity } from '@/db/schema';

/**
 * Item 16: the fix review panel.
 *
 * The order on screen is the order a reviewer needs: what is wrong, why it
 * matters, the current code, the proposed change, the diff, the tests, the
 * risks. Every action is explicit — nothing generates or applies on mount.
 */

export interface FindingSummary {
  id: string;
  title: string;
  severity: Severity;
  ruleId: string;
  filePath: string | null;
  lineStart: number | null;
  description: string;
  evidence: string | null;
  remediation: string | null;
  whyItMatters: string | null;
}

interface Explanation {
  whatHappened: string;
  whyItMatters: string;
  impact: string;
  remediation: string;
  confidence: 'high' | 'medium' | 'low';
  claims: Array<{ kind: 'FACT' | 'INFERENCE' | 'RECOMMENDATION'; text: string }>;
}

interface GeneratedFix {
  fixId: string;
  title: string;
  explanation: string;
  filePath: string;
  originalCode: string;
  fixedCode: string;
  diff: { text: string; additions: number; deletions: number };
  risks: string[];
  testsToRun: string[];
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  provider: string;
  model: string;
}

interface GeneratedTests {
  framework: string;
  filePath: string;
  code: string;
  cases: Array<{ name: string; kind: string }>;
  notes: string;
}

const SEVERITY_VARIANT: Record<Severity, 'critical' | 'high' | 'medium' | 'low' | 'info'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info',
};

type Phase = 'idle' | 'loading' | 'error';

export function FixPanel({ finding }: { finding: FindingSummary }) {
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explanationMeta, setExplanationMeta] = useState<{ provider: string; model: string } | null>(null);
  const [explainPhase, setExplainPhase] = useState<Phase>('idle');
  const [explainError, setExplainError] = useState<string | null>(null);

  const [fix, setFix] = useState<GeneratedFix | null>(null);
  const [fixPhase, setFixPhase] = useState<Phase>('idle');
  const [fixError, setFixError] = useState<string | null>(null);

  const [tests, setTests] = useState<GeneratedTests | null>(null);
  const [testsPhase, setTestsPhase] = useState<Phase>('idle');
  const [testsError, setTestsError] = useState<string | null>(null);

  const runExplain = useCallback(
    async (regenerate = false) => {
      setExplainPhase('loading');
      setExplainError(null);
      try {
        const response = await fetch(
          `/api/findings/${finding.id}/explain${regenerate ? '?regenerate=true' : ''}`,
          { method: 'POST' },
        );
        const data = (await response.json()) as {
          ok: boolean;
          explanation?: Explanation;
          provider?: string;
          model?: string;
          error?: string;
        };

        if (!response.ok || !data.ok || !data.explanation) {
          setExplainError(data.error ?? 'The explanation could not be generated.');
          setExplainPhase('error');
          return;
        }

        setExplanation(data.explanation);
        setExplanationMeta({ provider: data.provider ?? '', model: data.model ?? '' });
        setExplainPhase('idle');
      } catch {
        setExplainError('Could not reach the server. Check your connection and try again.');
        setExplainPhase('error');
      }
    },
    [finding.id],
  );

  const runFix = useCallback(
    async (regenerate = false) => {
      setFixPhase('loading');
      setFixError(null);
      try {
        const response = await fetch(`/api/findings/${finding.id}/fix${regenerate ? '?regenerate=true' : ''}`, {
          method: 'POST',
        });
        const data = (await response.json()) as { ok: boolean; fix?: GeneratedFix; error?: string };

        if (!response.ok || !data.ok || !data.fix) {
          setFixError(data.error ?? 'A fix could not be generated for this finding.');
          setFixPhase('error');
          return;
        }

        setFix(data.fix);
        setFixPhase('idle');
      } catch {
        setFixError('Could not reach the server. Check your connection and try again.');
        setFixPhase('error');
      }
    },
    [finding.id],
  );

  const runTests = useCallback(async () => {
    setTestsPhase('loading');
    setTestsError(null);
    try {
      const response = await fetch(`/api/findings/${finding.id}/fix?mode=tests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fix ? { fixedCode: fix.fixedCode } : {}),
      });
      const data = (await response.json()) as { ok: boolean; tests?: GeneratedTests; error?: string };

      if (!response.ok || !data.ok || !data.tests) {
        setTestsError(data.error ?? 'Tests could not be generated.');
        setTestsPhase('error');
        return;
      }

      setTests(data.tests);
      setTestsPhase('idle');
    } catch {
      setTestsError('Could not reach the server. Check your connection and try again.');
      setTestsPhase('error');
    }
  }, [finding.id, fix]);

  return (
    <div className="space-y-8">
      {/* 1. What is wrong — always from the deterministic scanner. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[finding.severity]}>{finding.severity}</Badge>
          <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-xs text-[hsl(var(--muted-foreground))]">
            {finding.ruleId}
          </code>
          {finding.filePath ? (
            <span className="font-mono text-xs text-[hsl(var(--muted-foreground))]">
              {finding.filePath}
              {finding.lineStart ? `:${finding.lineStart}` : ''}
            </span>
          ) : null}
        </div>

        <h2 className="text-lg font-semibold tracking-tight">{finding.title}</h2>
        <p className="max-w-3xl text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
          {finding.description}
        </p>

        {finding.whyItMatters ? (
          <p className="max-w-3xl text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">
            <span className="font-medium text-[hsl(var(--foreground))]">Why it matters: </span>
            {finding.whyItMatters}
          </p>
        ) : null}
      </section>

      {/* 2. Current code. */}
      {finding.evidence ? (
        <Section title="Current code" subtitle="Captured by the scanner at the reported location.">
          <CodeBlock code={finding.evidence} startLine={finding.lineStart ?? 1} highlightLine={finding.lineStart} />
        </Section>
      ) : null}

      {/* 3. AI explanation — opt-in. */}
      <Section
        title="AI explanation"
        subtitle="An explanation of this finding in the context of your actual code."
        action={
          <Button
            variant={explanation ? 'ghost' : 'secondary'}
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => void runExplain(Boolean(explanation))}
            disabled={explainPhase === 'loading'}
          >
            {explainPhase === 'loading' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : explanation ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
            {explanation ? 'Regenerate' : 'Explain this finding'}
          </Button>
        }
      >
        {explainError ? <InlineError message={explainError} /> : null}

        {explainPhase === 'loading' && !explanation ? <LoadingLines /> : null}

        {explanation ? (
          <div className="space-y-5">
            <Field label="What happened" value={explanation.whatHappened} />
            <Field label="Why it matters" value={explanation.whyItMatters} />
            <Field label="Impact" value={explanation.impact} />
            <Field label="How to fix it" value={explanation.remediation} />

            <ClaimList claims={explanation.claims} />

            <AIDisclosure
              confidence={explanation.confidence}
              provider={explanationMeta?.provider ?? ''}
              model={explanationMeta?.model ?? ''}
            />
          </div>
        ) : null}
      </Section>

      {/* 4. The proposed fix. */}
      <Section
        title="Proposed fix"
        subtitle="Generated against the current contents of the file, then verified to apply cleanly."
        action={
          <Button
            variant={fix ? 'ghost' : 'secondary'}
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => void runFix(Boolean(fix))}
            disabled={fixPhase === 'loading' || !finding.filePath}
          >
            {fixPhase === 'loading' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : fix ? (
              <RefreshCw aria-hidden="true" />
            ) : (
              <Wrench aria-hidden="true" />
            )}
            {fix ? 'Regenerate' : 'Generate fix'}
          </Button>
        }
      >
        {!finding.filePath ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            This finding is not tied to a specific file, so no code fix can be generated for it.
          </p>
        ) : null}

        {fixError ? <InlineError message={fixError} /> : null}
        {fixPhase === 'loading' && !fix ? <LoadingLines /> : null}

        {fix ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium">{fix.title}</h4>
              <ConfidenceBadge confidence={fix.confidence} />
              <Badge variant="outline">
                +{fix.diff.additions} / −{fix.diff.deletions}
              </Badge>
            </div>

            <p className="text-sm leading-relaxed text-[hsl(var(--muted-foreground))]">{fix.explanation}</p>

            {fix.warnings.length > 0 ? (
              <div className="rounded-lg border border-[hsl(var(--medium))]/30 bg-[hsl(var(--medium))]/5 p-4">
                <p className="flex items-center gap-2 text-sm font-medium text-[hsl(var(--medium))]">
                  <TriangleAlert className="size-4" aria-hidden="true" />
                  Review this patch carefully
                </p>
                <ul className="mt-2 space-y-1 text-sm text-[hsl(var(--muted-foreground))]">
                  {fix.warnings.map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                Unified diff
              </p>
              <DiffView patch={fix.diff.text} />
            </div>

            {fix.risks.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Risks
                </p>
                <ul className="space-y-1.5 text-sm text-[hsl(var(--muted-foreground))]">
                  {fix.risks.map((risk) => (
                    <li key={risk} className="flex gap-2">
                      <AlertTriangle
                        className="mt-0.5 size-3.5 shrink-0 text-[hsl(var(--medium))]"
                        aria-hidden="true"
                      />
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {fix.testsToRun.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Run these before merging
                </p>
                <ul className="space-y-1 font-mono text-xs text-[hsl(var(--muted-foreground))]">
                  {fix.testsToRun.map((test) => (
                    <li key={test}>{test}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <AIDisclosure confidence={fix.confidence} provider={fix.provider} model={fix.model} />

            {/*
              Applying is deliberately not available yet rather than faked.
              Branch and pull-request creation needs write scopes the MVP does
              not request; a disabled control that explains itself is honest,
              a button that silently does nothing is not.
            */}
            <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--border))] pt-4">
              <Button variant="outline" size="sm" onClick={() => void runTests()} disabled={testsPhase === 'loading'}>
                {testsPhase === 'loading' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <FlaskConical aria-hidden="true" />
                )}
                Generate regression tests
              </Button>
              <Button variant="outline" size="sm" disabled title="Requires a GitHub App installation with write access">
                Create fix branch
              </Button>
              <Button variant="outline" size="sm" disabled title="Requires a GitHub App installation with write access">
                Create pull request
              </Button>
              <p className="w-full text-xs text-[hsl(var(--muted-foreground))]">
                CodeSentinel never modifies your repository. Branch and pull-request creation require a GitHub App
                installation with write access.
              </p>
            </div>
          </div>
        ) : null}
      </Section>

      {/* 5. Generated tests. */}
      {testsError || tests || testsPhase === 'loading' ? (
        <Section title="Regression tests" subtitle="Generated for review. CodeSentinel has not run them.">
          {testsError ? <InlineError message={testsError} /> : null}
          {testsPhase === 'loading' && !tests ? <LoadingLines /> : null}

          {tests ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="primary">{tests.framework}</Badge>
                <span className="font-mono text-xs text-[hsl(var(--muted-foreground))]">{tests.filePath}</span>
                <Badge variant="outline">not yet run</Badge>
              </div>

              {tests.cases.length > 0 ? (
                <ul className="space-y-1.5 text-sm">
                  {tests.cases.map((testCase) => (
                    <li key={testCase.name} className="flex items-start gap-2">
                      <Check className="mt-0.5 size-3.5 shrink-0 text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
                      <span>
                        {testCase.name}{' '}
                        <span className="text-[hsl(var(--muted-foreground))]">({testCase.kind})</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <CodeBlock code={tests.code} />

              {tests.notes ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  <span className="font-medium text-[hsl(var(--foreground))]">Setup required: </span>
                  {tests.notes}
                </p>
              ) : null}
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function Section({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-[hsl(var(--border))] pt-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          {subtitle ? <p className="text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</p> : null}
        </div>
        {action ? <div className="w-full shrink-0 sm:w-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{label}</p>
      <p className="text-sm leading-relaxed">{value}</p>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-3 text-sm text-[hsl(var(--muted-foreground))]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function LoadingLines() {
  return (
    <div className="space-y-2" aria-label="Loading" role="status">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className={cn('h-3 animate-pulse rounded bg-[hsl(var(--muted))]', i === 2 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

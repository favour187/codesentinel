import { z } from 'zod';




















export const ClaimKind = z.enum(['FACT', 'INFERENCE', 'RECOMMENDATION']);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const Claim = z.object({
  kind: ClaimKind,
  text: z.string().min(1).max(2000),
});
export type Claim = z.infer<typeof Claim>;





export const FindingExplanation = z.object({
  whatHappened: z.string().min(1).max(2000),
  whyItMatters: z.string().min(1).max(2000),
  impact: z.string().min(1).max(2000),
  remediation: z.string().min(1).max(3000),
  confidence: Confidence,
  claims: z.array(Claim).max(12).default([]),
});
export type FindingExplanation = z.infer<typeof FindingExplanation>;





export const FalsePositiveVerdict = z.enum(['LIKELY_TRUE', 'POSSIBLE', 'LIKELY_FALSE_POSITIVE']);
export type FalsePositiveVerdict = z.infer<typeof FalsePositiveVerdict>;

export const FalsePositiveAnalysis = z.object({
  verdict: FalsePositiveVerdict,
  reasoning: z.string().min(1).max(2000),

  evidence: z.array(z.string().min(1).max(500)).max(8).default([]),
  confidence: Confidence,
});
export type FalsePositiveAnalysis = z.infer<typeof FalsePositiveAnalysis>;





export const GeneratedFix = z.object({
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(3000),
  filePath: z.string().min(1).max(400),

  originalCode: z.string().min(1).max(8000),
  fixedCode: z.string().min(1).max(8000),
  risks: z.array(z.string().min(1).max(500)).max(8).default([]),
  testsToRun: z.array(z.string().min(1).max(300)).max(8).default([]),
  confidence: Confidence,
});
export type GeneratedFix = z.infer<typeof GeneratedFix>;





export const GeneratedTests = z.object({
  framework: z.string().min(1).max(50),
  filePath: z.string().min(1).max(400),
  code: z.string().min(1).max(12000),

  cases: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        kind: z.enum(['unit', 'edge', 'negative', 'regression']),
      }),
    )
    .max(20)
    .default([]),
  notes: z.string().max(1500).default(''),
});
export type GeneratedTests = z.infer<typeof GeneratedTests>;





export const PullRequestReview = z.object({
  summary: z.string().min(1).max(1500),
  riskAssessment: z.string().min(1).max(1500),
  importantFindings: z.array(z.string().min(1).max(500)).max(10).default([]),
  recommendedTests: z.array(z.string().min(1).max(300)).max(8).default([]),

  recommendation: z.enum(['APPROVE', 'REVIEW', 'REQUEST_CHANGES']),
  confidence: Confidence,
});
export type PullRequestReview = z.infer<typeof PullRequestReview>;





export const ChatAnswer = z.object({
  answer: z.string().min(1).max(4000),

  relevantFiles: z.array(z.string().min(1).max(400)).max(12).default([]),
  confidence: Confidence,
  claims: z.array(Claim).max(12).default([]),
});
export type ChatAnswer = z.infer<typeof ChatAnswer>;

export const ArchitectureExplanation = z.object({
  overview: z.string().min(1).max(3000),
  layers: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        role: z.string().min(1).max(600),
        files: z.array(z.string().min(1).max(400)).max(12).default([]),
      }),
    )
    .max(10)
    .default([]),
  authFlow: z.string().max(2000).default(''),
  dataFlow: z.string().max(2000).default(''),

  unknowns: z.array(z.string().min(1).max(400)).max(8).default([]),
  confidence: Confidence,
});
export type ArchitectureExplanation = z.infer<typeof ArchitectureExplanation>;

export const CodeArchaeology = z.object({
  summary: z.string().min(1).max(3000),

  keyCommits: z.array(z.string().min(1).max(64)).max(12).default([]),
  confidence: Confidence,
  unknowns: z.array(z.string().min(1).max(400)).max(6).default([]),
});
export type CodeArchaeology = z.infer<typeof CodeArchaeology>;

export const BlastRadiusExplanation = z.object({
  summary: z.string().min(1).max(2500),

  notableImpacts: z.array(z.string().min(1).max(500)).max(10).default([]),
  suggestedChecks: z.array(z.string().min(1).max(300)).max(8).default([]),
  confidence: Confidence,
});
export type BlastRadiusExplanation = z.infer<typeof BlastRadiusExplanation>;

export const DebtNarrative = z.object({
  summary: z.string().min(1).max(2500),
  priorities: z.array(z.string().min(1).max(400)).max(8).default([]),
  confidence: Confidence,
});
export type DebtNarrative = z.infer<typeof DebtNarrative>;












export function promptSchemaHint(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, description]) => `  "${key}": ${description}`);
  return `Respond with ONLY a JSON object, no prose and no markdown fence:\n{\n${lines.join(',\n')}\n}`;
}

export const CONFIDENCE_HINT = '"high" | "medium" | "low"';
export const CLAIMS_HINT =
  'array of at most 6 objects {"kind": "FACT" | "INFERENCE" | "RECOMMENDATION", "text": string}';

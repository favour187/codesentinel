import { z } from 'zod';

/**
 * Schemas for every AI response.
 *
 * Nothing an AI produces reaches the database or the UI without passing
 * through one of these. A model that hallucinates, drifts from the format, or
 * is hijacked by injected repository text produces output that simply fails
 * validation, and the feature degrades to "unavailable" instead of showing a
 * user something invented.
 *
 * Schemas are also the prompt contract: `promptSchemaHint` renders them into
 * the prompt, so the specification and the validation cannot drift apart.
 */

/**
 * Every claim is labelled by how it was arrived at:
 *  - FACT           read directly from deterministic scan data
 *  - INFERENCE      reasoned from that data, could be wrong
 *  - RECOMMENDATION a suggested action, not a statement about the code
 */
export const ClaimKind = z.enum(['FACT', 'INFERENCE', 'RECOMMENDATION']);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const Claim = z.object({
  kind: ClaimKind,
  text: z.string().min(1).max(2000),
});
export type Claim = z.infer<typeof Claim>;

/* -------------------------------------------------------------------------- */
/* 1. Finding explanation                                                     */
/* -------------------------------------------------------------------------- */

export const FindingExplanation = z.object({
  whatHappened: z.string().min(1).max(2000),
  whyItMatters: z.string().min(1).max(2000),
  impact: z.string().min(1).max(2000),
  remediation: z.string().min(1).max(3000),
  confidence: Confidence,
  claims: z.array(Claim).max(12).default([]),
});
export type FindingExplanation = z.infer<typeof FindingExplanation>;

/* -------------------------------------------------------------------------- */
/* 2. False-positive analysis                                                 */
/* -------------------------------------------------------------------------- */

export const FalsePositiveVerdict = z.enum(['LIKELY_TRUE', 'POSSIBLE', 'LIKELY_FALSE_POSITIVE']);
export type FalsePositiveVerdict = z.infer<typeof FalsePositiveVerdict>;

export const FalsePositiveAnalysis = z.object({
  verdict: FalsePositiveVerdict,
  reasoning: z.string().min(1).max(2000),
  /** Concrete observations supporting the verdict — shown to the user. */
  evidence: z.array(z.string().min(1).max(500)).max(8).default([]),
  confidence: Confidence,
});
export type FalsePositiveAnalysis = z.infer<typeof FalsePositiveAnalysis>;

/* -------------------------------------------------------------------------- */
/* 3. Fix generation                                                          */
/* -------------------------------------------------------------------------- */

export const GeneratedFix = z.object({
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(3000),
  filePath: z.string().min(1).max(400),
  /** Exact snippet being replaced — verified against the real file. */
  originalCode: z.string().min(1).max(8000),
  fixedCode: z.string().min(1).max(8000),
  risks: z.array(z.string().min(1).max(500)).max(8).default([]),
  testsToRun: z.array(z.string().min(1).max(300)).max(8).default([]),
  confidence: Confidence,
});
export type GeneratedFix = z.infer<typeof GeneratedFix>;

/* -------------------------------------------------------------------------- */
/* 4. Test generation                                                         */
/* -------------------------------------------------------------------------- */

export const GeneratedTests = z.object({
  framework: z.string().min(1).max(50),
  filePath: z.string().min(1).max(400),
  code: z.string().min(1).max(12000),
  /** What each test covers, so a reviewer can judge without reading the code. */
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

/* -------------------------------------------------------------------------- */
/* 5. Pull request review                                                     */
/* -------------------------------------------------------------------------- */

export const PullRequestReview = z.object({
  summary: z.string().min(1).max(1500),
  riskAssessment: z.string().min(1).max(1500),
  importantFindings: z.array(z.string().min(1).max(500)).max(10).default([]),
  recommendedTests: z.array(z.string().min(1).max(300)).max(8).default([]),
  /** Advisory only — CodeSentinel never blocks a merge on an AI opinion. */
  recommendation: z.enum(['APPROVE', 'REVIEW', 'REQUEST_CHANGES']),
  confidence: Confidence,
});
export type PullRequestReview = z.infer<typeof PullRequestReview>;

/* -------------------------------------------------------------------------- */
/* 6. Codebase chat / architecture / archaeology                              */
/* -------------------------------------------------------------------------- */

export const ChatAnswer = z.object({
  answer: z.string().min(1).max(4000),
  /** Paths the answer relied on. Validated against files actually supplied. */
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
  /** Explicitly listing the gaps is what keeps this honest. */
  unknowns: z.array(z.string().min(1).max(400)).max(8).default([]),
  confidence: Confidence,
});
export type ArchitectureExplanation = z.infer<typeof ArchitectureExplanation>;

export const CodeArchaeology = z.object({
  summary: z.string().min(1).max(3000),
  /** Commit SHAs supporting the narrative — checked against real history. */
  keyCommits: z.array(z.string().min(1).max(64)).max(12).default([]),
  confidence: Confidence,
  unknowns: z.array(z.string().min(1).max(400)).max(6).default([]),
});
export type CodeArchaeology = z.infer<typeof CodeArchaeology>;

export const BlastRadiusExplanation = z.object({
  summary: z.string().min(1).max(2500),
  /** Why these dependents matter — the graph itself is deterministic. */
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

/* -------------------------------------------------------------------------- */
/* Prompt contract rendering                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Describe the required JSON shape in the prompt.
 *
 * Hand-written per schema rather than generated from Zod: JSON Schema output
 * is verbose enough to crowd out the actual evidence, and the evidence is what
 * makes the answer correct.
 */
export function promptSchemaHint(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, description]) => `  "${key}": ${description}`);
  return `Respond with ONLY a JSON object, no prose and no markdown fence:\n{\n${lines.join(',\n')}\n}`;
}

export const CONFIDENCE_HINT = '"high" | "medium" | "low"';
export const CLAIMS_HINT =
  'array of at most 6 objects {"kind": "FACT" | "INFERENCE" | "RECOMMENDATION", "text": string}';

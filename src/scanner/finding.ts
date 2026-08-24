import { createHash } from 'node:crypto';

import type { Category, Severity } from '@/db/schema';
import { maskSecret } from '@/lib/crypto';
import type { Finding } from './types';

/**
 * Finding construction and normalization.
 *
 * All scanners must build findings through createFinding(); nothing constructs
 * the object literal directly. That gives us one place to guarantee:
 *   1. evidence is truncated and never contains raw secret material,
 *   2. fingerprints are computed identically everywhere,
 *   3. confidence is clamped and severities are valid.
 */

const MAX_EVIDENCE_LENGTH = 240;

export interface CreateFindingInput {
  ruleId: string;
  scannerId: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  evidence?: string | null;
  confidence?: number;
  whyItMatters?: string | null;
  remediation?: string | null;
  references?: Array<{ label: string; url?: string }>;
  relatedTests?: string[];
  metadata?: Record<string, unknown>;
  /**
   * Literal secret values that must be masked out of the evidence before it is
   * stored. Secret rules pass their captured match here.
   */
  redact?: string[];
  /**
   * Overrides the snippet used for fingerprinting. Rules whose evidence varies
   * between runs (timings, counts) pass a stable value instead.
   */
  fingerprintSeed?: string;
}

/** Collapses whitespace so trivial reformatting doesn't change identity. */
export function normalizeSnippet(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Stable identity for a finding across scans.
 *
 * Deliberately excludes line numbers: inserting a line above an issue must not
 * make it look like the old finding was resolved and a new one introduced.
 */
export function computeFingerprint(ruleId: string, filePath: string | null, snippet: string): string {
  return createHash('sha256')
    .update(`${ruleId}\u0000${filePath ?? ''}\u0000${normalizeSnippet(snippet)}`)
    .digest('hex')
    .slice(0, 32);
}

/** Masks every provided secret value inside a piece of evidence text. */
export function redactEvidence(evidence: string, secrets: readonly string[]): string {
  let out = evidence;
  for (const secret of secrets) {
    if (secret && secret.length >= 4 && out.includes(secret)) {
      out = out.split(secret).join(maskSecret(secret));
    }
  }
  return out;
}

/** Clamps to 0..1 and rounds to 2dp so composed confidences stay readable. */
export function roundConfidence(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function createFinding(input: CreateFindingInput): Finding {
  const filePath = input.filePath ?? null;
  const redact = input.redact ?? [];

  let evidence = input.evidence ?? null;
  if (evidence !== null) {
    evidence = redactEvidence(evidence.trim(), redact);
    if (evidence.length > MAX_EVIDENCE_LENGTH) {
      evidence = `${evidence.slice(0, MAX_EVIDENCE_LENGTH)}…`;
    }
  }

  // Fingerprint from the seed if given, else the REDACTED evidence, so raw
  // secret material is never hashed into a value we persist alongside a mask.
  const seed = input.fingerprintSeed ?? evidence ?? input.title;

  return {
    fingerprint: computeFingerprint(input.ruleId, filePath, seed),
    ruleId: input.ruleId,
    scannerId: input.scannerId,
    severity: input.severity,
    category: input.category,
    title: input.title,
    description: input.description,
    filePath,
    lineStart: input.lineStart ?? null,
    lineEnd: input.lineEnd ?? input.lineStart ?? null,
    evidence,
    // Rounded: rules compose confidence arithmetically (base + context
    // bonus), which otherwise surfaces artefacts like 0.7999999999999999.
    confidence: roundConfidence(input.confidence ?? 0.8),
    whyItMatters: input.whyItMatters ?? null,
    remediation: input.remediation ?? null,
    references: input.references ?? [],
    relatedTests: input.relatedTests ?? [],
    metadata: input.metadata ?? {},
  };
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Merges findings from all scanners into one canonical list.
 *
 * Two scanners can legitimately flag the same line (e.g. a secrets rule and a
 * security rule both matching a hardcoded token). Deduping by fingerprint keeps
 * the highest-severity instance and records which scanners agreed, which is a
 * useful confidence signal rather than duplicated noise in the UI.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();

  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing) {
      byFingerprint.set(finding.fingerprint, finding);
      continue;
    }

    const winner = SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity] ? finding : existing;
    const loser = winner === finding ? existing : finding;
    const corroborating = new Set<string>([
      ...(Array.isArray(winner.metadata.corroboratedBy) ? (winner.metadata.corroboratedBy as string[]) : []),
      loser.scannerId,
    ]);

    byFingerprint.set(finding.fingerprint, {
      ...winner,
      confidence: roundConfidence(Math.max(winner.confidence, loser.confidence) + 0.05),
      metadata: { ...winner.metadata, corroboratedBy: [...corroborating] },
    });
  }

  return sortFindings([...byFingerprint.values()]);
}

/** Canonical ordering: severity, then file, then line. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byFile = (a.filePath ?? '').localeCompare(b.filePath ?? '');
    if (byFile !== 0) return byFile;
    return (a.lineStart ?? 0) - (b.lineStart ?? 0);
  });
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function countByCategory(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  }
  return counts;
}

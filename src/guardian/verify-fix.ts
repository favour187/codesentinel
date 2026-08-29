




export type VerificationStatus = 'resolved' | 'still_present' | 'new_findings' | 'not_run';

export interface FixVerification {
  readonly originalResolved: boolean;
  readonly status: VerificationStatus;
  readonly remainingFingerprints: readonly string[];
  readonly newFingerprints: readonly string[];
  readonly testsPassed: number | null;
  readonly testsFailed: number | null;
  readonly summary: string;
}

export function verifyFix(input: {
  readonly originalFingerprint: string;
  readonly afterFingerprints: readonly string[];
  readonly beforeFingerprints: readonly string[];
  readonly testsPassed?: number | null;
  readonly testsFailed?: number | null;
}): FixVerification {
  const after = new Set(input.afterFingerprints);
  const before = new Set(input.beforeFingerprints);
  const originalResolved = !after.has(input.originalFingerprint);
  const remaining = [...after];
  const introduced = [...after].filter((fp) => !before.has(fp) && fp !== input.originalFingerprint);

  let status: VerificationStatus = 'not_run';
  if (input.testsFailed !== null && input.testsFailed !== undefined && input.testsFailed > 0) {
    status = 'still_present';
  } else if (!originalResolved) {
    status = 'still_present';
  } else if (introduced.length > 0) {
    status = 'new_findings';
  } else {
    status = 'resolved';
  }

  const testsNote =
    input.testsPassed == null
      ? 'Tests were not executed.'
      : `${input.testsPassed} passed${input.testsFailed ? `, ${input.testsFailed} failed` : ''}.`;

  return {
    originalResolved,
    status,
    remainingFingerprints: remaining,
    newFingerprints: introduced,
    testsPassed: input.testsPassed ?? null,
    testsFailed: input.testsFailed ?? null,
    summary:
      status === 'resolved'
        ? `Original finding gone. ${testsNote}`
        : status === 'new_findings'
          ? `Original finding gone, but ${introduced.length} new fingerprint(s) appeared. ${testsNote}`
          : `Original finding is still present. ${testsNote}`,
  };
}

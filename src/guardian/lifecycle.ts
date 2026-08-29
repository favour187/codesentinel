






export type FindingLifecycle = 'new' | 'known' | 'regressed' | 'resolved' | 'reopened';

export interface LifecycleInput {
  readonly fingerprint: string;
  readonly currentlyOpen: boolean;

  readonly firstSeenAt: Date | null;

  readonly lastResolvedAt: Date | null;
  readonly previouslyOpen: boolean;
}

export function classifyLifecycle(input: LifecycleInput): FindingLifecycle {
  if (input.currentlyOpen && input.lastResolvedAt) return 'regressed';
  if (input.currentlyOpen && input.previouslyOpen) return 'known';
  if (input.currentlyOpen && !input.previouslyOpen && input.firstSeenAt) return 'reopened';
  if (input.currentlyOpen) return 'new';
  if (input.lastResolvedAt) return 'resolved';
  return 'resolved';
}

export function isRecurring(input: LifecycleInput): boolean {
  return input.lastResolvedAt !== null && input.currentlyOpen;
}

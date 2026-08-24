import { dependencyScanner } from './scanners/dependencies';
import { infrastructureScanner } from './scanners/infrastructure';
import { qualityScanner } from './scanners/quality';
import { secretsScanner } from './scanners/secrets';
import { securityScanner } from './scanners/security';
import { testingScanner } from './scanners/testing';
import type { Scanner } from './types';

/**
 * The scanner registry.
 *
 * Adding a scanner means implementing the Scanner interface and appending it
 * here — the orchestrator, persistence and UI all work off this list, so
 * nothing else needs to change.
 */
export const SCANNERS: Scanner[] = [
  secretsScanner,
  securityScanner,
  dependencyScanner,
  qualityScanner,
  testingScanner,
  infrastructureScanner,
];

export function getScanner(id: string): Scanner | undefined {
  return SCANNERS.find((scanner) => scanner.id === id);
}

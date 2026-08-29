import { cicdScanner } from './scanners/cicd';
import { configScanner } from './scanners/config';
import { dependencyScanner } from './scanners/dependencies';
import { infrastructureScanner } from './scanners/infrastructure';
import { qualityScanner } from './scanners/quality';
import { secretsScanner } from './scanners/secrets';
import { securityScanner } from './scanners/security';
import { testingScanner } from './scanners/testing';
import type { Scanner } from './types';








export const SCANNERS: Scanner[] = [
  secretsScanner,
  securityScanner,
  dependencyScanner,
  qualityScanner,
  testingScanner,
  infrastructureScanner,
  cicdScanner,
  configScanner,
];

export function getScanner(id: string): Scanner | undefined {
  return SCANNERS.find((scanner) => scanner.id === id);
}

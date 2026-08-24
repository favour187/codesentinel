import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';

/**
 * Configuration guardian.
 *
 * Looks at env, package and compose files for obvious risky settings.
 * Secret values are redacted. Never prints the original credential.
 */

const SCANNER_ID = 'config';

function isConfig(file: SourceFile): boolean {
  if (file.language === 'dotenv') return true;
  const base = file.path.split('/').pop()?.toLowerCase() ?? '';
  return (
    /^(docker-compose|.+\.config\.(js|ts|mjs)|next\.config\.(js|ts|mjs)|vercel\.json|netlify\.toml)$/.test(base) ||
    file.language === 'dotenv'
  );
}

export function analyseConfig(file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  file.lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const n = index + 1;

    const env = /^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/.exec(line);
    if (env?.[1] && env[2] && file.language === 'dotenv' && !file.path.endsWith('.example')) {
      const name = env[1];
      let value = env[2].replace(/^['"]|['"]$/g, '');
      const secretName = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|ACCESS_KEY|CREDENTIAL)/i.test(name);
      const placeholder = /^(change-?me|example|placeholder|your[_-].+|xxx+|<.*>|\$\{.+\})/i.test(value);
      if (secretName && value.length >= 8 && !placeholder) {
        findings.push(
          createFinding({
            ruleId: 'config/dotenv-secret',
            scannerId: SCANNER_ID,
            severity: 'critical',
            category: 'secrets',
            title: 'Secret stored in a committed env file',
            description: `${name} is assigned a literal value in ${file.path}.`,
            filePath: file.path,
            lineStart: n,
            evidence: `${name}=••••••••`,
            redact: [value],
            confidence: 0.9,
            whyItMatters: 'Env files in git are a common source of leaked production credentials.',
            remediation: 'Rotate the credential, remove the file from git, and load it from a secret store at runtime.',
            fingerprintSeed: `config/dotenv-secret:${file.path}:${name}`,
            metadata: { secretLength: value.length },
          }),
        );
        value = '';
      }
    }

    if (/DEBUG\s*[:=]\s*(true|1|yes)/i.test(line) && /prod/i.test(file.path)) {
      findings.push(
        createFinding({
          ruleId: 'config/debug-in-production',
          scannerId: SCANNER_ID,
          severity: 'medium',
          category: 'reliability',
          title: 'Debug mode enabled in a production config',
          description: 'A production-named config file turns debug on.',
          filePath: file.path,
          lineStart: n,
          evidence: line,
          confidence: 0.75,
          whyItMatters: 'Debug mode often exposes stack traces and internal state.',
          remediation: 'Disable debug flags in production configuration.',
          fingerprintSeed: `config/debug:${file.path}`,
        }),
      );
    }

    if (/privileged:\s*true/i.test(line) || /hostNetwork:\s*true/i.test(line)) {
      findings.push(
        createFinding({
          ruleId: 'config/privileged-container',
          scannerId: SCANNER_ID,
          severity: 'high',
          category: 'infrastructure',
          title: 'Container configured with elevated host access',
          description: line,
          filePath: file.path,
          lineStart: n,
          evidence: line,
          confidence: 0.85,
          whyItMatters: 'Privileged or host-network containers weaken isolation.',
          remediation: 'Drop privileged/hostNetwork unless a documented exception exists in repository memory.',
          fingerprintSeed: `config/privileged:${file.path}:${n}`,
        }),
      );
    }
  });

  return findings;
}

export const configScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Configuration scanner',
  description: 'Reviews env, compose and app config for committed secrets and unsafe runtime flags.',
  categories: ['infrastructure', 'secrets'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    return ctx.files.filter(isConfig).flatMap(analyseConfig);
  },
};

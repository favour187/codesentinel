import { describe, expect, it } from 'vitest';

import { secretsScanner } from '@/scanner/scanners/secrets';
import { ruleIds, scanSource } from './helpers/source';

const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('secrets scanner — detection', () => {
  it('finds an AWS access key id', async () => {
    const findings = await scanSource(secretsScanner, 'src/config.js', `const key = '${AWS_KEY}';`);
    expect(ruleIds(findings)).toContain('secret/aws-access-key-id');
  });

  it('finds an AWS secret access key', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      `const awsSecretAccessKey = '${AWS_SECRET}';`,
    );
    expect(ruleIds(findings)).toContain('secret/aws-secret-access-key');
  });

  it('finds a hardcoded password without a provider prefix', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      "const password = 'SuperSecretP@ssw0rd123!';",
    );
    expect(ruleIds(findings)).toContain('secret/hardcoded-credential');
  });

  it('finds a high-entropy credential assigned to a plain identifier', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      "const dbUrl = 'postgres://admin:Xk9mQ2wLp7vZr4Ns@db.internal:5432/prod';",
    );
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('secrets scanner — never leaks the secret', () => {
  it('masks the secret value in the evidence', async () => {
    const findings = (await scanSource(
      secretsScanner,
      'src/config.js',
      "const password = 'SuperSecretP@ssw0rd123!';",
    )) as Array<{ evidence?: string | null }>;

    for (const finding of findings) {
      const evidence = finding.evidence ?? '';
      expect(evidence).not.toContain('SuperSecretP@ssw0rd123!');
      expect(evidence).toMatch(/[•*]/);
    }
  });

  it('does not put the raw secret anywhere in the serialised finding', async () => {


    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      `const key = '${AWS_SECRET}';`,
    );
    expect(JSON.stringify(findings)).not.toContain(AWS_SECRET);
  });
});

describe('secrets scanner — false positives', () => {
  it('ignores values read from the environment', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      'const password = process.env.DB_PASSWORD;\nconst key = process.env.AWS_SECRET_ACCESS_KEY;',
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores obvious placeholders', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      [
        "const password = 'changeme';",
        "const apiKey = 'your-api-key-here';",
        "const token = 'xxxxxxxxxxxx';",
        "const secret = 'TODO';",
      ].join('\n'),
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores .env.example templates', async () => {
    const findings = await scanSource(
      secretsScanner,
      '.env.example',
      'DB_PASSWORD=replace-me\nAWS_SECRET_ACCESS_KEY=\n',
    );
    expect(findings).toHaveLength(0);
  });

  it('ignores prose in markdown', async () => {
    const findings = await scanSource(
      secretsScanner,
      'README.md',
      `Set your password to something strong, e.g. \`${AWS_SECRET}\`.`,
    );
    expect(findings).toHaveLength(0);
  });

  it('does not flag a low-entropy ordinary string', async () => {
    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      "const message = 'hello world hello world';\nconst name = 'production';",
    );
    expect(findings).toHaveLength(0);
  });

  it('reports a provider-recognised secret exactly once', async () => {


    const findings = await scanSource(
      secretsScanner,
      'src/config.js',
      `const awsSecretAccessKey = '${AWS_SECRET}';`,
    );
    const lines = findings.map((f) => f.lineStart);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

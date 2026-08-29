import { describe, expect, it } from 'vitest';
import { analyseDockerfile, infrastructureScanner } from '@/scanner/scanners/infrastructure';
import { ruleIds, scanContext, sourceFile } from './helpers/source';







function dockerfile(content: string) {
  return sourceFile('Dockerfile', content);
}

function analyse(content: string) {
  return analyseDockerfile(dockerfile(content));
}

function rulesFor(content: string): string[] {
  return analyse(content).map((r) => r.ruleId);
}


const HARDENED = [
  'FROM node:22.11.0-slim',
  'WORKDIR /app',
  'COPY package*.json ./',
  'RUN npm ci --ignore-scripts',
  'COPY . .',
  'RUN useradd -r -u 10001 app',
  'USER app',
  'HEALTHCHECK --interval=30s CMD node healthcheck.js || exit 1',
  'CMD ["node", "server.js"]',
].join('\n');

describe('analyseDockerfile — clean baseline', () => {
  it('reports nothing for a hardened Dockerfile', () => {
    expect(analyse(HARDENED)).toEqual([]);
  });
});

describe('analyseDockerfile — base image', () => {
  it('flags an end-of-life base image', () => {
    const rules = rulesFor('FROM node:14\nUSER app\nHEALTHCHECK CMD true');
    expect(rules).toContain('infra/docker-eol-base-image');
  });

  it('flags end-of-life images across ecosystems', () => {
    const cases = ['python:3.6', 'ubuntu:16.04', 'debian:9', 'alpine:3.9', 'node:12-alpine'];
    for (const image of cases) {
      const rules = rulesFor(`FROM ${image}\nUSER app\nHEALTHCHECK CMD true`);
      expect(rules, image).toContain('infra/docker-eol-base-image');
    }
  });

  it('does not flag a currently supported base image', () => {
    for (const image of ['node:22-slim', 'python:3.12', 'ubuntu:24.04', 'debian:12', 'alpine:3.20']) {
      const rules = rulesFor(`FROM ${image}\nUSER app\nHEALTHCHECK CMD true`);
      expect(rules, image).not.toContain('infra/docker-eol-base-image');
    }
  });

  it('flags :latest and untagged images as unpinned', () => {
    expect(rulesFor('FROM node:latest\nUSER app\nHEALTHCHECK CMD true')).toContain(
      'infra/docker-unpinned-base-image',
    );
    expect(rulesFor('FROM node\nUSER app\nHEALTHCHECK CMD true')).toContain(
      'infra/docker-unpinned-base-image',
    );
  });

  it('does not flag an explicitly pinned image as unpinned', () => {
    expect(rulesFor('FROM node:22.11.0-slim\nUSER app\nHEALTHCHECK CMD true')).not.toContain(
      'infra/docker-unpinned-base-image',
    );
  });
});

describe('analyseDockerfile — root execution', () => {
  it('flags a Dockerfile with no USER instruction', () => {
    const findings = analyse('FROM node:22-slim\nHEALTHCHECK CMD true\nCMD ["node", "x.js"]');
    const root = findings.find((f) => f.ruleId === 'infra/docker-runs-as-root');

    expect(root).toBeDefined();
    expect(root?.severity).toBe('high');
    expect(root?.description).toMatch(/No USER instruction/i);
  });

  it('flags an explicit USER root', () => {
    expect(rulesFor('FROM node:22-slim\nUSER root\nHEALTHCHECK CMD true')).toContain(
      'infra/docker-runs-as-root',
    );
    expect(rulesFor('FROM node:22-slim\nUSER 0\nHEALTHCHECK CMD true')).toContain(
      'infra/docker-runs-as-root',
    );
  });

  it('does not flag a Dockerfile that drops to an unprivileged user', () => {
    expect(rulesFor('FROM node:22-slim\nUSER app\nHEALTHCHECK CMD true')).not.toContain(
      'infra/docker-runs-as-root',
    );
  });

  it('judges by the final USER, so switching to root then back is clean', () => {
    const content = [
      'FROM node:22-slim',
      'USER root',
      'RUN apt-get update',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');
    expect(rulesFor(content)).not.toContain('infra/docker-runs-as-root');
  });

  it('flags switching to root last, even if an unprivileged user came first', () => {
    const content = ['FROM node:22-slim', 'USER app', 'USER root', 'HEALTHCHECK CMD true'].join('\n');
    expect(rulesFor(content)).toContain('infra/docker-runs-as-root');
  });
});

describe('analyseDockerfile — secrets in image layers', () => {
  it('flags a literal secret assigned in ENV', () => {
    const content = [
      'FROM node:22-slim',
      'ENV API_TOKEN=sk_live_abcdef1234567890',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    const finding = analyse(content).find((f) => f.ruleId === 'infra/docker-secret-in-env');

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('critical');

    expect(finding?.redact).toContain('sk_live_abcdef1234567890');
  });

  it('does not emit the secret value in the persisted finding evidence', async () => {
    const content = [
      'FROM node:22-slim',
      'ENV DB_PASSWORD=SuperSecretValue123',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    const findings = await infrastructureScanner.scan(scanContext([dockerfile(content)]));
    const secret = findings.find((f) => f.ruleId === 'infra/docker-secret-in-env');

    expect(secret).toBeDefined();
    expect(JSON.stringify(secret)).not.toContain('SuperSecretValue123');
  });

  it('does not flag a variable reference or a placeholder', () => {
    const cases = [
      'ENV API_TOKEN=${API_TOKEN}',
      'ENV API_TOKEN=$API_TOKEN',
      'ENV DB_PASSWORD=changeme',
      'ENV SECRET_KEY=<your-key-here>',
    ];

    for (const line of cases) {
      const content = `FROM node:22-slim\n${line}\nUSER app\nHEALTHCHECK CMD true`;
      expect(rulesFor(content), line).not.toContain('infra/docker-secret-in-env');
    }
  });

  it('does not flag an ordinary non-secret environment variable', () => {
    const content = [
      'FROM node:22-slim',
      'ENV NODE_ENV=production',
      'ENV PORT=3000',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    expect(rulesFor(content)).not.toContain('infra/docker-secret-in-env');
  });
});

describe('analyseDockerfile — build-time execution', () => {
  it('flags a remote script piped into a shell', () => {
    const content = [
      'FROM node:22-slim',
      'RUN curl -fsSL https://example.test/install.sh | sh',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    expect(rulesFor(content)).toContain('infra/docker-remote-script-execution');
  });

  it('does not flag a download that is verified before running', () => {
    const content = [
      'FROM node:22-slim',
      'RUN curl -fsSL -o install.sh https://example.test/install.sh',
      'RUN echo "abc123  install.sh" | sha256sum -c - && sh install.sh',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    expect(rulesFor(content)).not.toContain('infra/docker-remote-script-execution');
  });

  it('flags npm install run with --unsafe-perm', () => {
    const content = [
      'FROM node:22-slim',
      'RUN npm install --unsafe-perm',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    expect(rulesFor(content)).toContain('infra/docker-unsafe-perm');
  });

  it('does not flag a plain npm ci', () => {
    expect(rulesFor('FROM node:22-slim\nRUN npm ci\nUSER app\nHEALTHCHECK CMD true')).not.toContain(
      'infra/docker-unsafe-perm',
    );
  });
});

describe('analyseDockerfile — healthcheck', () => {
  it('reports a missing HEALTHCHECK as informational only', () => {
    const finding = analyse('FROM node:22-slim\nUSER app').find(
      (f) => f.ruleId === 'infra/docker-no-healthcheck',
    );

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
  });

  it('does not report when a HEALTHCHECK is present', () => {
    expect(rulesFor(HARDENED)).not.toContain('infra/docker-no-healthcheck');
  });
});

describe('analyseDockerfile — comments and blank lines', () => {
  it('ignores directives that are commented out', () => {
    const content = [
      'FROM node:22-slim',
      '',
      '# USER root',
      '# ENV API_TOKEN=sk_live_abcdef1234567890',
      '# RUN curl https://example.test/x.sh | sh',
      'USER app',
      'HEALTHCHECK CMD true',
    ].join('\n');

    expect(analyse(content)).toEqual([]);
  });
});

describe('infrastructure scanner', () => {
  it('is always available', async () => {
    await expect(infrastructureScanner.isAvailable(scanContext([]))).resolves.toBe(true);
  });

  it('only inspects Dockerfiles and leaves other languages alone', async () => {
    const files = [
      sourceFile('src/app.js', "const token = 'not-a-dockerfile';\nmodule.exports = { token };"),
      sourceFile('README.md', '# FROM node:14\nUSER root'),
    ];

    await expect(infrastructureScanner.scan(scanContext(files))).resolves.toEqual([]);
  });

  it('returns an empty list for a repository with no Dockerfile', async () => {
    await expect(infrastructureScanner.scan(scanContext([]))).resolves.toEqual([]);
  });

  it('emits infrastructure-category findings with guidance and references', async () => {
    const content = 'FROM node:14\nRUN npm install --unsafe-perm\nCMD ["node", "x.js"]';
    const findings = await infrastructureScanner.scan(scanContext([dockerfile(content)]));

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.category).toBe('infrastructure');
      expect(finding.scannerId).toBe('infrastructure');
      expect(finding.filePath).toBe('Dockerfile');
      expect(finding.whyItMatters).toBeTruthy();
      expect(finding.remediation).toBeTruthy();
      expect(finding.references.length).toBeGreaterThan(0);
    }
  });

  it('produces stable, distinct fingerprints across runs', async () => {
    const content = 'FROM node:14\nRUN npm install --unsafe-perm\nCMD ["node", "x.js"]';
    const ctx = scanContext([dockerfile(content)]);

    const first = await infrastructureScanner.scan(ctx);
    const second = await infrastructureScanner.scan(ctx);

    expect(first.map((f) => f.fingerprint)).toEqual(second.map((f) => f.fingerprint));
    expect(new Set(first.map((f) => f.fingerprint)).size).toBe(first.length);
  });

  it('scans a Dockerfile with a suffix, such as Dockerfile.prod', async () => {
    const file = sourceFile('deploy/Dockerfile.prod', 'FROM node:14\nCMD ["node", "x.js"]');
    const findings = await infrastructureScanner.scan(scanContext([file]));

    expect(ruleIds(findings)).toContain('infra/docker-eol-base-image');
  });
});

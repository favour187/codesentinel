import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';
import type { Severity } from '@/db/schema';

/**
 * Infrastructure-as-code scanner (Dockerfiles).
 *
 * Container misconfiguration is a common real-world weakness that source-level
 * rules never see, and Dockerfiles are simple enough to analyse accurately
 * line-by-line.
 */

const SCANNER_ID = 'infrastructure';

/** Base images whose major version is long out of support. */
const EOL_IMAGES: Array<{ pattern: RegExp; note: string }> = [
  { pattern: /^node:(?:[0-9]|1[0-7])(?:[.-]|$)/i, note: 'Node.js 17 and earlier are end-of-life.' },
  { pattern: /^python:(?:2(?:\.\d+)?|3\.[0-7])(?:[.-]|$)/i, note: 'Python 3.7 and earlier are end-of-life.' },
  { pattern: /^ubuntu:(?:1[0-8])\.\d+/i, note: 'This Ubuntu release is past its support window.' },
  { pattern: /^debian:(?:[0-9]|10)(?:[.-]|$)/i, note: 'This Debian release is past its support window.' },
  { pattern: /^alpine:(?:2|3\.[0-9](?:[.-]|$)|3\.1[0-5])/i, note: 'This Alpine release no longer receives security updates.' },
];

interface DockerFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  description: string;
  whyItMatters: string;
  remediation: string;
  line: number;
  evidence: string;
  redact?: string[];
  confidence: number;
}

export function analyseDockerfile(file: SourceFile): DockerFinding[] {
  const results: DockerFinding[] = [];
  let lastUser: { value: string; line: number } | null = null;
  let hasHealthcheck = false;

  file.lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const lineNumber = index + 1;

    /* ------------------------------ base image ------------------------------ */
    const from = /^FROM\s+(\S+)/i.exec(line);
    if (from?.[1]) {
      const image = from[1];

      if (image.endsWith(':latest') || !image.includes(':')) {
        results.push({
          ruleId: 'infra/docker-unpinned-base-image',
          title: 'Container base image is not pinned to a version',
          severity: 'low',
          description: `The base image "${image}" uses :latest or no tag at all.`,
          whyItMatters:
            'An unpinned base image means two builds of the same commit can produce different containers. That breaks reproducibility and lets an upstream change reach production without any code review.',
          remediation: 'Pin an explicit version, ideally by digest: FROM node:22.11.0-slim@sha256:…',
          line: lineNumber,
          evidence: line,
          confidence: 0.9,
        });
      }

      for (const eol of EOL_IMAGES) {
        if (eol.pattern.test(image)) {
          results.push({
            ruleId: 'infra/docker-eol-base-image',
            title: 'Container built on an end-of-life base image',
            severity: 'high',
            description: `${eol.note} (image: ${image})`,
            whyItMatters:
              'End-of-life images stop receiving security patches, so every vulnerability disclosed after that date remains permanently unfixed in the container — including kernel-adjacent and OpenSSL issues that your application code cannot mitigate.',
            remediation: 'Upgrade to a currently supported release and rebuild, e.g. FROM node:22-slim.',
            line: lineNumber,
            evidence: line,
            confidence: 0.95,
          });
        }
      }
    }

    /* -------------------------------- USER --------------------------------- */
    const user = /^USER\s+(\S+)/i.exec(line);
    if (user?.[1]) lastUser = { value: user[1], line: lineNumber };

    /* ------------------------- secrets in ENV/ARG --------------------------- */
    const env = /^(?:ENV|ARG)\s+([A-Za-z_][\w]*)[\s=]+(.+)$/i.exec(line);
    if (env?.[1] && env[2]) {
      const name = env[1];
      const value = env[2].replace(/^["']|["']$/g, '').trim();
      const secretName = /(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|credential|private[_-]?key)/i.test(name);
      const looksReal = value.length >= 8 && !/^\$\{?\w+\}?$/.test(value) && !/^(?:changeme|example|placeholder|""|''|<.*>)$/i.test(value);

      if (secretName && looksReal) {
        results.push({
          ruleId: 'infra/docker-secret-in-env',
          title: 'Secret baked into the container image',
          severity: 'critical',
          description: `${name} is assigned a literal value in the Dockerfile.`,
          whyItMatters:
            'Every ENV and ARG value is stored in the image layer history. Anyone who can pull the image — or read the registry — can recover the credential with docker history, even if a later layer removes it.',
          remediation:
            'Inject secrets at runtime (docker run --env-file, or the orchestrator\'s secret store), or use BuildKit secret mounts: RUN --mount=type=secret,id=token …',
          line: lineNumber,
          evidence: line,
          redact: [value],
          confidence: 0.9,
        });
      }
    }

    if (/^HEALTHCHECK/i.test(line)) hasHealthcheck = true;

    /* ------------------------------ curl | sh ------------------------------- */
    if (/^RUN\b/i.test(line) && /(?:curl|wget)[^|]*\|\s*(?:ba)?sh/i.test(line)) {
      results.push({
        ruleId: 'infra/docker-remote-script-execution',
        title: 'Remote script piped directly into a shell',
        severity: 'high',
        description: 'A script is downloaded and executed in one step during the build.',
        whyItMatters:
          'The build blindly executes whatever the remote server returns at that moment. A compromised or hijacked host silently injects code into your image, and because nothing is pinned there is no way to detect the change.',
        remediation: 'Download to a file, verify a known checksum or signature, then execute it.',
        line: lineNumber,
        evidence: line,
        confidence: 0.85,
      });
    }

    /* ---------------------------- --unsafe-perm ----------------------------- */
    if (/--unsafe-perm/i.test(line)) {
      results.push({
        ruleId: 'infra/docker-unsafe-perm',
        title: 'Package install runs with --unsafe-perm',
        severity: 'medium',
        description: 'npm is invoked with --unsafe-perm, which runs lifecycle scripts as root.',
        whyItMatters:
          'Install scripts from any package in the dependency tree execute with full root privileges during the build, turning a single malicious transitive dependency into image compromise.',
        remediation: 'Remove --unsafe-perm and install as a non-root user, or use npm ci --ignore-scripts where possible.',
        line: lineNumber,
        evidence: line,
        confidence: 0.85,
      });
    }
  });

  /* ------------------------- container runs as root ------------------------- */
  const runsAsRoot = lastUser === null || /^(?:root|0)$/i.test((lastUser as { value: string }).value);
  if (runsAsRoot) {
    results.push({
      ruleId: 'infra/docker-runs-as-root',
      title: 'Container runs as the root user',
      severity: 'high',
      description:
        lastUser === null
          ? 'No USER instruction is present, so the container defaults to root.'
          : 'The final USER instruction sets the container to run as root.',
      whyItMatters:
        'If the application is compromised the attacker starts as root inside the container, which makes container-escape vulnerabilities and host mount abuse dramatically easier to exploit.',
      remediation: 'Create an unprivileged user and switch to it before CMD: RUN useradd -r -u 10001 app && USER app',
      line: lastUser === null ? 1 : (lastUser as { line: number }).line,
      evidence: lastUser === null ? 'No USER instruction' : `USER ${(lastUser as { value: string }).value}`,
      confidence: 0.9,
    });
  }

  if (!hasHealthcheck) {
    results.push({
      ruleId: 'infra/docker-no-healthcheck',
      title: 'Container defines no HEALTHCHECK',
      severity: 'info',
      description: 'The image has no HEALTHCHECK instruction.',
      whyItMatters:
        'Without a health probe the orchestrator only knows whether the process is running, not whether it is serving traffic. A deadlocked or unresponsive container keeps receiving requests.',
      remediation: 'Add a lightweight probe: HEALTHCHECK --interval=30s CMD curl -fsS http://localhost:3000/api/health || exit 1',
      line: 1,
      evidence: 'No HEALTHCHECK instruction',
      confidence: 0.9,
    });
  }

  return results;
}

export const infrastructureScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Infrastructure scanner',
  description: 'Analyses Dockerfiles for insecure base images, root execution and secrets baked into image layers.',
  categories: ['infrastructure'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      if (file.language !== 'dockerfile') continue;

      for (const result of analyseDockerfile(file)) {
        findings.push(
          createFinding({
            ruleId: result.ruleId,
            scannerId: SCANNER_ID,
            severity: result.severity,
            category: 'infrastructure',
            title: result.title,
            description: result.description,
            filePath: file.path,
            lineStart: result.line,
            evidence: result.evidence,
            redact: result.redact,
            confidence: result.confidence,
            whyItMatters: result.whyItMatters,
            remediation: result.remediation,
            references: [
              { label: 'Docker security best practices', url: 'https://docs.docker.com/develop/security-best-practices/' },
            ],
            fingerprintSeed: `${result.ruleId}:${file.path}`,
          }),
        );
      }
    }

    return findings;
  },
};

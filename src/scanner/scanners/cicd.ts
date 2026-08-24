import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';

/**
 * GitHub Actions / CI workflow scanner.
 *
 * Reads workflow YAML as text. Does not execute workflows. Flags obvious
 * unsafe patterns with evidence.
 */

const SCANNER_ID = 'cicd';

function isWorkflow(file: SourceFile): boolean {
  return /(^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(file.path);
}

export function analyseWorkflow(file: SourceFile): Finding[] {
  const findings: Finding[] = [];
  const text = file.content;

  const push = (opts: {
    ruleId: string;
    title: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    why: string;
    fix: string;
    line: number;
    evidence: string;
  }) => {
    findings.push(
      createFinding({
        ruleId: opts.ruleId,
        scannerId: SCANNER_ID,
        severity: opts.severity,
        category: 'infrastructure',
        title: opts.title,
        description: opts.description,
        filePath: file.path,
        lineStart: opts.line,
        evidence: opts.evidence,
        confidence: 0.8,
        whyItMatters: opts.why,
        remediation: opts.fix,
        fingerprintSeed: `${opts.ruleId}:${file.path}:${opts.line}`,
      }),
    );
  };

  file.lines.forEach((raw, index) => {
    const line = raw.trim();
    const n = index + 1;

    if (/pull_request_target/.test(line)) {
      push({
        ruleId: 'cicd/pull-request-target',
        title: 'Workflow uses pull_request_target',
        severity: 'high',
        description: 'pull_request_target runs in the base repository context and can expose secrets to untrusted PR code.',
        why: 'A forked pull request can execute with write access to repository secrets.',
        fix: 'Prefer pull_request. If you must use pull_request_target, never check out untrusted code before a review gate.',
        line: n,
        evidence: line,
      });
    }

    if (/\$\{\{\s*github\.event\.(?:comment|issue|pull_request|review)\.(?:body|title)/.test(line) && /run:|script:/.test(text)) {
      push({
        ruleId: 'cicd/untrusted-context-interpolation',
        title: 'Untrusted GitHub context interpolated into a script',
        severity: 'high',
        description: 'PR titles or comment bodies are expanded directly into a shell script.',
        why: 'Attackers control those fields. Interpolation into run: is a common injection path.',
        fix: 'Pass the value as an environment variable and read it from env, never via ${{ }} inside a script.',
        line: n,
        evidence: line,
      });
    }

    if (/permissions:\s*write-all|contents:\s*write/i.test(line)) {
      push({
        ruleId: 'cicd/excessive-permissions',
        title: 'Workflow requests write permissions',
        severity: 'medium',
        description: 'This workflow requests write access (write-all or contents: write).',
        why: 'A compromised workflow with write contents can push code or release artifacts.',
        fix: 'Set top-level permissions: read-all and grant the smallest write scope on the single job that needs it.',
        line: n,
        evidence: line,
      });
    }

    if (/curl[^\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/.test(line) || /wget[^\n]*\|\s*(?:ba)?sh/.test(line)) {
      push({
        ruleId: 'cicd/remote-script',
        title: 'CI pipes a remote script into a shell',
        severity: 'high',
        description: 'The workflow downloads and executes a script in one step.',
        why: 'The job runs whatever the remote host returns at that moment.',
        fix: 'Pin a release, verify a checksum, then execute.',
        line: n,
        evidence: line,
      });
    }

    if (/secrets\.\w+/.test(line) && /echo |printenv|console\.log/.test(line)) {
      push({
        ruleId: 'cicd/secret-in-log',
        title: 'Secret may be printed to CI logs',
        severity: 'critical',
        description: 'A secret reference appears on a line that also prints output.',
        why: 'CI logs are often readable by a wide audience.',
        fix: 'Never echo secrets. Mask them and pass via env to the tool that needs them.',
        line: n,
        evidence: line.replace(/secrets\.\w+/g, 'secrets.[redacted]'),
      });
    }
  });

  if (!/permissions\s*:/.test(text)) {
    push({
      ruleId: 'cicd/missing-permissions',
      title: 'Workflow does not declare permissions',
      severity: 'low',
      description: 'No permissions: block was found, so the default GITHUB_TOKEN scope applies.',
      why: 'Default token scopes have narrowed over time, but an explicit read-only default is safer.',
      fix: 'Add `permissions: contents: read` at the workflow root.',
      line: 1,
      evidence: 'No permissions: block',
    });
  }

  return findings;
}

export const cicdScanner: Scanner = {
  id: SCANNER_ID,
  name: 'CI/CD scanner',
  description: 'Analyses GitHub Actions workflows for unsafe triggers, permissions and secret handling. Does not execute jobs.',
  categories: ['infrastructure'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    return ctx.files.filter(isWorkflow).flatMap(analyseWorkflow);
  },
};

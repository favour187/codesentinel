import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';

/**
 * Hardcoded credential detection.
 *
 * Two complementary strategies:
 *   1. High-precision provider patterns (AWS, Stripe, GitHub, Slack, private
 *      keys) — distinctive prefixes, so confidence is high.
 *   2. Generic assignment detection (`password = "..."`) gated on a Shannon
 *      entropy threshold and a placeholder blocklist, which is where naive
 *      secret scanners generate most of their false positives.
 *
 * The matched credential is NEVER stored: every finding passes the captured
 * value through `redact`, so only a masked form (sk_live_••••••7dc) is
 * persisted or displayed.
 */

const SCANNER_ID = 'secrets';

interface SecretPattern {
  ruleId: string;
  title: string;
  regex: RegExp;
  /** Which capture group holds the secret itself. */
  secretGroup: number;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  minEntropy?: number;
  /**
   * Apply the placeholder blocklist to this provider rule. Off by default:
   * a real `AKIA...` key is a leak whatever it is named. On for rules whose
   * captured group is free-form text (connection-string passwords), where
   * `user:password@host` in docs would otherwise be reported as a live secret.
   */
  rejectPlaceholders?: boolean;
}

const PROVIDER_PATTERNS: SecretPattern[] = [
  {
    ruleId: 'secret/aws-access-key-id',
    title: 'AWS access key ID committed to source',
    regex: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16})\b/g,
    secretGroup: 1,
    severity: 'critical',
    description: 'An AWS access key ID is hardcoded in the repository.',
  },
  {
    ruleId: 'secret/aws-secret-access-key',
    title: 'AWS secret access key committed to source',
    regex: /aws.{0,20}?(?:secret|private).{0,20}?['"]([A-Za-z0-9/+=]{40})['"]/gi,
    secretGroup: 1,
    severity: 'critical',
    description: 'An AWS secret access key is hardcoded in the repository.',
  },
  {
    ruleId: 'secret/stripe-live-key',
    title: 'Stripe live API key committed to source',
    regex: /\b((?:sk|rk)_live_[0-9a-zA-Z]{10,99})\b/g,
    secretGroup: 1,
    severity: 'critical',
    description: 'A live Stripe secret key is hardcoded in the repository.',
  },
  {
    ruleId: 'secret/github-token',
    title: 'GitHub token committed to source',
    regex: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g,
    secretGroup: 1,
    severity: 'critical',
    description: 'A GitHub personal access or app token is hardcoded in the repository.',
  },
  {
    ruleId: 'secret/slack-token',
    title: 'Slack token committed to source',
    regex: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    secretGroup: 1,
    severity: 'high',
    description: 'A Slack API token is hardcoded in the repository.',
  },
  {
    ruleId: 'secret/private-key',
    title: 'Private key committed to source',
    regex: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)/g,
    secretGroup: 1,
    severity: 'critical',
    description: 'A cryptographic private key block is committed to the repository.',
  },
  {
    ruleId: 'secret/google-api-key',
    title: 'Google API key committed to source',
    regex: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    secretGroup: 1,
    severity: 'high',
    description: 'A Google API key is hardcoded in the repository.',
  },
  {
    // Credentials inside a connection URI are one of the most common real-world
    // leaks and are missed by keyword rules, because the password sits in the
    // URI authority rather than after a `password =`. Only the password
    // component is captured, so the host and database name stay readable in the
    // masked evidence and the finding is still actionable.
    ruleId: 'secret/connection-string-credential',
    title: 'Credentials embedded in a connection string',
    regex:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp|https?):\/\/[^\s:/@]+:([^\s:/@]{6,})@/gi,
    secretGroup: 1,
    severity: 'critical',
    description:
      'A connection string contains an inline username and password, exposing the credential to anyone with repository access.',
    rejectPlaceholders: true,
  },
];

/**
 * Generic `SOMETHING_SECRET = "value"` detection.
 * Entropy-gated because this pattern is otherwise a false-positive machine.
 */
const GENERIC_PATTERN: SecretPattern = {
  ruleId: 'secret/hardcoded-credential',
  title: 'Hardcoded credential in source code',
  // The prefix is optional: a bare `password: "..."` key must match just as a
  // prefixed `DB_PASSWORD = "..."` does.
  regex:
    /\b([A-Za-z0-9_]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential)[A-Za-z0-9_]{0,20})\s*[:=]\s*['"]([^'"\n]{8,120})['"]/gi,
  secretGroup: 2,
  severity: 'high',
  description: 'A credential-like value is assigned directly in source code.',
  minEntropy: 2.6,
};

/** Obvious non-secrets: samples, templates, env indirection. */
const PLACEHOLDER_PATTERN =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]+>|\$\{[^}]*\}|%[a-z_]+%|null|none|undefined|true|false|changeme|change[_-]?me|example|examples?|sample|placeholder|your[_-].*|my[_-]?secret|todo|tbd|redacted|dummy|test|testing|fake|foo|bar|baz|password|secret|token|abc123|123456\d*)$/i;

const ENV_INDIRECTION = /process\.env|os\.environ|getenv|import\.meta\.env|ENV\[|config\.get|vault|secretsmanager/i;

/** Shannon entropy in bits/char — random-looking strings score above ~3. */
export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const frequencies = new Map<string, number>();
  for (const char of value) frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function isLikelyPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return true;
  if (PLACEHOLDER_PATTERN.test(trimmed)) return true;
  if (ENV_INDIRECTION.test(trimmed)) return true;
  // A single repeated character, e.g. "aaaaaaaaaaaa".
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}

/** Files where credential-shaped strings are expected and not a finding. */
function isExampleFile(file: SourceFile): boolean {
  const p = file.path.toLowerCase();
  return p.endsWith('.env.example') || p.endsWith('.env.sample') || p.endsWith('.env.template');
}

function lineNumberAt(file: SourceFile, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < file.content.length; i += 1) {
    if (file.content[i] === '\n') line += 1;
  }
  return line;
}

function scanFile(file: SourceFile): Finding[] {
  if (isExampleFile(file)) return [];
  const findings: Finding[] = [];
  const patterns = [...PROVIDER_PATTERNS, GENERIC_PATTERN];

  /**
   * Values already reported by a high-precision provider rule. The generic
   * entropy rule would otherwise re-report the same credential at lower
   * confidence — one secret must produce exactly one finding, and the
   * provider-specific rule is the more useful of the two because it names the
   * provider whose key needs rotating.
   *
   * Provider patterns are ordered first in `patterns`, so this set is fully
   * populated by the time the generic rule runs.
   */
  const claimed = new Set<string>();

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    const isGeneric = pattern.minEntropy !== undefined;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(file.content)) !== null) {
      const secret = match[pattern.secretGroup];
      if (!secret) continue;

      if (isGeneric) {
        if (claimed.has(secret)) continue;
        if (isLikelyPlaceholder(secret)) continue;
        if (shannonEntropy(secret) < (pattern.minEntropy ?? 0)) continue;
      } else {
        if (pattern.rejectPlaceholders && isLikelyPlaceholder(secret)) continue;
        claimed.add(secret);
      }

      const line = lineNumberAt(file, match.index);
      const rawLine = file.lines[line - 1] ?? match[0];

      findings.push(
        createFinding({
          ruleId: pattern.ruleId,
          scannerId: SCANNER_ID,
          severity: pattern.severity,
          category: 'secrets',
          title: pattern.title,
          description: pattern.description,
          filePath: file.path,
          lineStart: line,
          evidence: rawLine,
          // Redaction is the whole point of this scanner: mask the value AND
          // fingerprint on a derived seed so the raw secret is never hashed
          // into anything stored next to the masked display form.
          redact: [secret],
          fingerprintSeed: `${pattern.ruleId}:${secret.slice(0, 4)}:${secret.length}`,
          confidence: isGeneric ? 0.7 : 0.95,
          whyItMatters:
            'Anyone with read access to the repository — including its full git history — can use this credential. Committed secrets are routinely harvested by automated scrapers within minutes of being pushed to a public repository.',
          remediation:
            'Revoke and rotate this credential now; assume it is compromised. Move the value into an environment variable or a secrets manager, add the config file to .gitignore, and purge it from git history (git filter-repo or BFG).',
          references: [
            { label: 'CWE-798: Use of Hard-coded Credentials', url: 'https://cwe.mitre.org/data/definitions/798.html' },
            { label: 'OWASP A07:2021 Identification and Authentication Failures', url: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/' },
          ],
          metadata: { entropy: Number(shannonEntropy(secret).toFixed(2)), secretLength: secret.length },
        }),
      );
    }
  }

  return findings;
}

export const secretsScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Secret scanner',
  description: 'Detects hardcoded credentials, API keys and private keys using provider patterns and entropy analysis.',
  categories: ['secrets'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of ctx.files) {
      if (file.language === 'markdown') continue; // docs legitimately show sample keys
      findings.push(...scanFile(file));
    }
    return findings;
  },
};

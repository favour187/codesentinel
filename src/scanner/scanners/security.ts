import { createFinding } from '../finding';
import type { Finding, ScanContext, Scanner, SourceFile } from '../types';
import type { Category, Severity } from '@/db/schema';












const SCANNER_ID = 'security';






const MAX_HITS_PER_RULE_PER_FILE = 5;


const USER_INPUT = /\breq(?:uest)?\.(?:body|query|params|headers|cookies)\b|\bctx\.request\b|\bevent\.(?:body|queryStringParameters)\b|\bprocess\.argv\b|\binput\(\)|\brequest\.(?:GET|POST|form|args|json)\b/;


const DYNAMIC_STRING = /\+\s*[A-Za-z_$][\w$.[\]]*|\$\{[^}]+\}|%s|\.format\(|f["']/;

interface Rule {
  ruleId: string;
  title: string;
  severity: Severity;
  category: Category;
  languages: string[] | 'any';

  match: RegExp;

  requires?: RegExp;

  unless?: RegExp;
  description: string;
  whyItMatters: string;
  remediation: string;
  references: Array<{ label: string; url?: string }>;
  confidence: number;
}

const RULES: Rule[] = [

  {
    ruleId: 'security/command-injection',
    title: 'Command injection via shell execution',
    severity: 'critical',
    category: 'security',
    languages: ['javascript', 'typescript'],
    match: /\b(?:child_process\.)?(?:exec|execSync|spawnSync|spawn)\s*\(/,
    requires: DYNAMIC_STRING,
    description:
      'A shell command is built from a dynamic value. If any part of that value is attacker-controlled, arbitrary commands can be executed on the host.',
    whyItMatters:
      'Shell metacharacters such as ; | && $() in the interpolated value let an attacker run commands as the application user — a direct path to full server compromise and lateral movement.',
    remediation:
      'Use execFile/spawn with an argument array so no shell is involved: execFile("tar", ["-czf", target, "/data"]). If a shell is unavoidable, validate the input against a strict allowlist.',
    references: [
      { label: 'CWE-78: OS Command Injection', url: 'https://cwe.mitre.org/data/definitions/78.html' },
      { label: 'OWASP A03:2021 Injection', url: 'https://owasp.org/Top10/A03_2021-Injection/' },
    ],
    confidence: 0.85,
  },
  {
    ruleId: 'security/python-shell-injection',
    title: 'Command injection via shell=True',
    severity: 'critical',
    category: 'security',
    languages: ['python'],
    match: /\bsubprocess\.(?:run|call|Popen|check_output)\s*\(|\bos\.(?:system|popen)\s*\(/,
    requires: /shell\s*=\s*True|\+|\.format\(|f["']|%\s/,
    description: 'A subprocess is invoked through a shell with a dynamically built command string.',
    whyItMatters:
      'With shell=True the command string is parsed by /bin/sh, so any injected metacharacter runs as a separate command with the application\'s privileges.',
    remediation:
      'Pass a list of arguments and leave shell=False (the default): subprocess.run(["journalctl", "-u", service]).',
    references: [
      { label: 'CWE-78: OS Command Injection', url: 'https://cwe.mitre.org/data/definitions/78.html' },
    ],
    confidence: 0.85,
  },
  {
    ruleId: 'security/code-injection-eval',
    title: 'Arbitrary code execution via eval()',
    severity: 'critical',
    category: 'security',
    languages: 'any',
    match: /\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*(?:input|request)/,
    unless: /\/\/.*eval|["'`][^"'`]*\beval\b[^"'`]*["'`]/,
    description: 'Code is evaluated at runtime from a dynamic expression.',
    whyItMatters:
      'eval() executes whatever it is given with the full privileges of the surrounding code. If the expression contains any user input this is remote code execution, and it also defeats most static analysis and CSP protections.',
    remediation:
      'Remove eval entirely. For data use JSON.parse; for dynamic dispatch use an explicit lookup table mapping allowed names to functions.',
    references: [
      { label: 'CWE-95: Eval Injection', url: 'https://cwe.mitre.org/data/definitions/95.html' },
    ],
    confidence: 0.9,
  },


  {
    ruleId: 'security/sql-injection',
    title: 'SQL injection through string concatenation',
    severity: 'critical',
    category: 'security',
    languages: 'any',
    match: /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE)\b[\s\S]{0,200}?(?:['"]\s*\+|\$\{|%s|\.format\()/i,
    description: 'A SQL statement is assembled by concatenating or interpolating values into the query string.',
    whyItMatters:
      'An attacker who controls the interpolated value can change the meaning of the query — reading every row in the table, bypassing authentication, or destroying data. SQL injection remains one of the most exploited web vulnerabilities.',
    remediation:
      'Use parameterised queries so values are never parsed as SQL: db.raw("SELECT * FROM users WHERE email = $1", [email]), or an ORM/query builder that parameterises by default.',
    references: [
      { label: 'CWE-89: SQL Injection', url: 'https://cwe.mitre.org/data/definitions/89.html' },
      { label: 'OWASP A03:2021 Injection', url: 'https://owasp.org/Top10/A03_2021-Injection/' },
    ],
    confidence: 0.8,
  },
  {
    ruleId: 'security/path-traversal',
    title: 'Path traversal in filesystem access',
    severity: 'high',
    category: 'security',
    languages: ['javascript', 'typescript', 'python'],
    match: /\b(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|open)\s*\(/,
    requires: DYNAMIC_STRING,
    unless: /path\.resolve|path\.normalize|sanitize|basename/,
    description: 'A filesystem path is built from a dynamic value without normalisation or containment checks.',
    whyItMatters:
      'A value containing ../ escapes the intended directory, letting an attacker read /etc/passwd, application source, or credentials — or overwrite arbitrary files.',
    remediation:
      'Resolve the path and verify it stays inside the base directory: const full = path.resolve(base, userPath); if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error("invalid path").',
    references: [
      { label: 'CWE-22: Path Traversal', url: 'https://cwe.mitre.org/data/definitions/22.html' },
    ],
    confidence: 0.7,
  },
  {
    ruleId: 'security/unsafe-deserialization',
    title: 'Unsafe deserialization of untrusted data',
    severity: 'high',
    category: 'security',
    languages: 'any',
    match: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*SafeLoader)|\bunserialize\s*\(|\bnode-serialize/,
    description: 'Untrusted data is deserialized with a mechanism that can instantiate arbitrary objects.',
    whyItMatters:
      'These deserializers can construct arbitrary types and invoke their constructors, which is reliably escalated to remote code execution by publicly available gadget chains.',
    remediation: 'Use a data-only format: json.loads, or yaml.safe_load / yaml.load(data, Loader=yaml.SafeLoader).',
    references: [
      { label: 'CWE-502: Deserialization of Untrusted Data', url: 'https://cwe.mitre.org/data/definitions/502.html' },
    ],
    confidence: 0.85,
  },
  {
    ruleId: 'security/xss-innerhtml',
    title: 'Potential XSS via unsanitised HTML injection',
    severity: 'high',
    category: 'security',
    languages: ['javascript', 'typescript'],
    match: /\.innerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/,
    requires: DYNAMIC_STRING,
    unless: /DOMPurify|sanitize/i,
    description: 'HTML is written to the DOM from a dynamic value without sanitisation.',
    whyItMatters:
      'Injected markup executes in the victim\'s session, allowing session-token theft, credential harvesting through fake forms, and actions performed as the user.',
    remediation: 'Use textContent for text, or sanitise with DOMPurify before assigning HTML.',
    references: [
      { label: 'CWE-79: Cross-site Scripting', url: 'https://cwe.mitre.org/data/definitions/79.html' },
    ],
    confidence: 0.7,
  },


  {
    ruleId: 'security/weak-hash',
    title: 'Weak hash algorithm used for sensitive data',
    severity: 'high',
    category: 'security',
    languages: 'any',
    match: /createHash\s*\(\s*['"](?:md5|sha1)['"]|hashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*"(?:MD5|SHA-?1)"/i,
    description: 'MD5 or SHA-1 is used to hash data.',
    whyItMatters:
      'MD5 and SHA-1 are fast and broken: passwords hashed with them fall to commodity GPU cracking and rainbow tables in minutes, and SHA-1 has practical collision attacks.',
    remediation:
      'For passwords use a slow, salted KDF — bcrypt, scrypt or Argon2 (e.g. bcrypt.hash(password, 12)). For integrity use SHA-256 or better.',
    references: [
      { label: 'CWE-327: Use of a Broken Cryptographic Algorithm', url: 'https://cwe.mitre.org/data/definitions/327.html' },
      { label: 'OWASP A02:2021 Cryptographic Failures', url: 'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/' },
    ],
    confidence: 0.8,
  },
  {
    ruleId: 'security/jwt-unverified',
    title: 'JWT decoded without signature verification',
    severity: 'critical',
    category: 'security',
    languages: ['javascript', 'typescript'],
    match: /\bjwt\.decode\s*\(|\bjsonwebtoken\.decode\s*\(|verify\s*:\s*false|\bdecode\s*\([^)]*\{\s*complete/,
    description: 'A JSON Web Token is decoded without verifying its signature.',
    whyItMatters:
      'decode() only base64-decodes the payload — it performs no cryptographic check. An attacker can forge any claims they like, including elevating themselves to an administrator account.',
    remediation: 'Use jwt.verify(token, secret, { algorithms: ["HS256"] }) and always pin the expected algorithm.',
    references: [
      { label: 'CWE-347: Improper Verification of Cryptographic Signature', url: 'https://cwe.mitre.org/data/definitions/347.html' },
    ],
    confidence: 0.9,
  },
  {
    ruleId: 'security/jwt-alg-none',
    title: 'JWT signing algorithm set to "none"',
    severity: 'critical',
    category: 'security',
    languages: 'any',
    match: /algorithm['"]?\s*:\s*['"]none['"]|alg['"]?\s*:\s*['"]none['"]/i,
    description: 'A JWT is issued with the "none" algorithm, which produces an unsigned token.',
    whyItMatters:
      'An unsigned token carries no integrity protection at all: anyone can edit the payload and the server will accept it. This is the classic complete authentication bypass.',
    remediation: 'Sign with HS256 or RS256 and reject the "none" algorithm on verification.',
    references: [
      { label: 'CWE-347: Improper Verification of Cryptographic Signature', url: 'https://cwe.mitre.org/data/definitions/347.html' },
    ],
    confidence: 0.95,
  },
  {
    ruleId: 'security/timing-unsafe-comparison',
    title: 'Timing-unsafe comparison of secret material',
    severity: 'medium',
    category: 'security',
    languages: ['javascript', 'typescript', 'python'],
    match: /\b(?:\w*(?:password|passwd|hash|token|secret|signature|hmac|apikey|api_key)\w*)\s*(?:===?|!==?)\s*\w+|\w+\s*(?:===?|!==?)\s*\w*(?:passwordHash|hashed|signature|hmac)\w*/i,
    unless: /timingSafeEqual|compare_digest|safeEqual|bcrypt\.compare|===\s*(?:null|undefined|''|"")/,
    description: 'Secret material is compared with a short-circuiting equality operator.',
    whyItMatters:
      'Standard comparison returns as soon as two bytes differ, so response time leaks how many leading bytes were correct. That side channel lets an attacker recover a token byte by byte.',
    remediation:
      'Use a constant-time comparison: crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)), hmac.compare_digest(a, b), or bcrypt.compare for passwords.',
    references: [
      { label: 'CWE-208: Observable Timing Discrepancy', url: 'https://cwe.mitre.org/data/definitions/208.html' },
    ],
    confidence: 0.55,
  },
  {
    ruleId: 'security/prototype-pollution',
    title: 'Prototype pollution risk in deep merge',
    severity: 'high',
    category: 'security',
    languages: ['javascript', 'typescript'],
    match: /_\.merge\s*\(|_\.mergeWith\s*\(|\$\.extend\s*\(\s*true|Object\.assign\s*\(\s*\w+\.prototype/,
    unless: /Object\.create\(null\)|hasOwnProperty|structuredClone/,
    description: 'A recursive merge is performed on objects that may come from untrusted input.',
    whyItMatters:
      'A payload containing __proto__ or constructor.prototype can add properties to Object.prototype, affecting every object in the process — commonly escalated to authentication bypass or remote code execution.',
    remediation:
      'Reject __proto__/constructor/prototype keys before merging, use a null-prototype target (Object.create(null)), or a merge utility that is documented as pollution-safe.',
    references: [
      { label: 'CWE-1321: Prototype Pollution', url: 'https://cwe.mitre.org/data/definitions/1321.html' },
    ],
    confidence: 0.6,
  },
  {
    ruleId: 'security/insecure-random',
    title: 'Insecure randomness used in a security context',
    severity: 'medium',
    category: 'security',
    languages: 'any',
    match: /Math\.random\s*\(\)|\brandom\.random\s*\(\)/,
    requires: /token|secret|password|key|nonce|salt|otp|session|reset/i,
    description: 'A non-cryptographic random number generator produces security-sensitive values.',
    whyItMatters:
      'Math.random is a predictable PRNG seeded from observable state. Tokens generated from it can be reproduced by an attacker, defeating password resets, session identifiers and one-time codes.',
    remediation: 'Use crypto.randomUUID(), crypto.randomBytes(32).toString("hex"), or secrets.token_urlsafe(32) in Python.',
    references: [
      { label: 'CWE-338: Use of Cryptographically Weak PRNG', url: 'https://cwe.mitre.org/data/definitions/338.html' },
    ],
    confidence: 0.65,
  },
  {
    ruleId: 'security/tls-verification-disabled',
    title: 'TLS certificate verification disabled',
    severity: 'high',
    category: 'security',
    languages: 'any',
    match: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|InsecureSkipVerify\s*:\s*true/,
    description: 'Certificate validation is turned off for outbound TLS connections.',
    whyItMatters:
      'Without certificate validation TLS provides encryption but no authentication, so any network attacker can transparently intercept and modify the traffic, including credentials in transit.',
    remediation: 'Leave verification enabled and install the correct CA certificate for internal services.',
    references: [
      { label: 'CWE-295: Improper Certificate Validation', url: 'https://cwe.mitre.org/data/definitions/295.html' },
    ],
    confidence: 0.85,
  },
];


function isCommentLine(line: string, language: string): boolean {
  const trimmed = line.trim();
  if (language === 'python' || language === 'shell' || language === 'yaml') return trimmed.startsWith('#');
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function ruleApplies(rule: Rule, file: SourceFile): boolean {
  if (rule.languages === 'any') return true;
  return rule.languages.includes(file.language);
}





function windowAt(file: SourceFile, index: number, size = 2): string {
  return file.lines.slice(index, index + size).join('\n');
}





function anchorLine(file: SourceFile, start: number, pattern: RegExp): number {
  const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  for (let j = start; j < Math.min(file.lines.length, start + 2); j += 1) {
    const candidate = file.lines[j] ?? '';
    if (/['"`]\s*\+|\$\{|%s|\.format\(/.test(candidate) && single.test(candidate)) return j;
  }

  for (let j = start; j < Math.min(file.lines.length, start + 2); j += 1) {
    if (/['"`]\s*\+|\$\{|%s|\.format\(/.test(file.lines[j] ?? '')) return j;
  }
  return start;
}

function scanFile(file: SourceFile): Finding[] {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    if (!ruleApplies(rule, file)) continue;
    const multiline = rule.ruleId === 'security/sql-injection';
    let hits = 0;
    let suppressed = 0;

    for (let i = 0; i < file.lines.length; i += 1) {
      const line = file.lines[i] ?? '';
      if (!line.trim() || isCommentLine(line, file.language)) continue;

      const haystack = multiline ? windowAt(file, i) : line;
      if (!rule.match.test(haystack)) continue;
      if (rule.requires && !rule.requires.test(haystack) && !USER_INPUT.test(haystack)) continue;
      if (rule.unless && rule.unless.test(haystack)) continue;







      hits += 1;
      if (hits > MAX_HITS_PER_RULE_PER_FILE) {
        suppressed += 1;
        continue;
      }





      const anchor = multiline ? anchorLine(file, i, rule.match) : i;


      const tainted = USER_INPUT.test(windowAt(file, Math.max(0, i - 3), 5));
      const confidence = Math.min(0.98, tainted ? rule.confidence + 0.1 : rule.confidence);

      findings.push(
        createFinding({
          ruleId: rule.ruleId,
          scannerId: SCANNER_ID,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          description: rule.description,
          filePath: file.path,
          lineStart: anchor + 1,
          lineEnd: anchor + 1,
          evidence: file.lines[anchor] ?? line,
          confidence,
          whyItMatters: rule.whyItMatters,
          remediation: rule.remediation,
          references: rule.references,
          metadata: { userInputNearby: tainted, language: file.language },
        }),
      );





      if (multiline) i += 1;
    }

    if (suppressed > 0) {
      const last = findings[findings.length - 1];
      if (last) last.metadata = { ...last.metadata, additionalOccurrences: suppressed };
    }
  }

  return findings;
}

export const securityScanner: Scanner = {
  id: SCANNER_ID,
  name: 'Security scanner',
  description:
    'Detects injection flaws, dangerous command execution, unsafe input handling, weak cryptography and authentication mistakes.',
  categories: ['security'],
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async scan(ctx: ScanContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const file of ctx.files) {
      if (file.isTest) continue;
      if (!['javascript', 'typescript', 'python', 'ruby', 'go', 'php', 'java'].includes(file.language)) continue;
      findings.push(...scanFile(file));
    }
    return findings;
  },
};

export const __testing = { RULES, USER_INPUT };

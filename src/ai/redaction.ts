import { maskSecret } from '@/lib/crypto';



















interface Rule {
  readonly name: string;
  readonly pattern: RegExp;

  readonly group: number;
}






const RULES: readonly Rule[] = [
  { name: 'aws-access-key', pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  { name: 'github-token', pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,})\b/g, group: 1 },
  { name: 'slack-token', pattern: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { name: 'stripe-key', pattern: /\b((?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,})\b/g, group: 1 },
  { name: 'google-api-key', pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, group: 1 },
  { name: 'openai-key', pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { name: 'sendgrid-key', pattern: /\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/g, group: 1 },
  { name: 'npm-token', pattern: /\b(npm_[A-Za-z0-9]{30,})\b/g, group: 1 },
  { name: 'jwt', pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, group: 1 },
  { name: 'private-key-block', pattern: /(-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----)/g, group: 1 },
  { name: 'basic-auth-url', pattern: /(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:([^\s@/]{4,})@/gi, group: 1 },




  {
    name: 'assigned-secret',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|encryption[_-]?key|session[_-]?secret|webhook[_-]?secret|credential)s?\b\s*[:=]\s*["'`]?([^\s"'`,;)}\]]{6,})["'`]?/gi,
    group: 1,
  },
];











const PLACEHOLDER =
  /^(?:x{3,}|\*{3,}|\.{3,}|<[^>]*>?|\$\{[^}]*\}?|%[a-z_]+%|process\.env\.[a-z_0-9.[\]'"]+|null|none|undefined|true|false|changeme|change[_-]?me|example|examples?|sample|placeholder|redacted|dummy|test|testing|fake|foo|bar|baz|your[_-].*|my[_-]?secret|todo|tbd|abc123|123456\d*)$/i;

export interface RedactionResult {
  readonly text: string;

  readonly redacted: readonly string[];
  readonly count: number;
}







export function redactSecrets(input: string): RedactionResult {
  if (!input) return { text: input, redacted: [], count: 0 };

  let text = input;
  const fired = new Set<string>();
  let count = 0;

  for (const rule of RULES) {

    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (match, ...groups) => {
      const value = rule.group === 0 ? match : (groups[rule.group - 1] as string | undefined);
      if (typeof value !== 'string' || value.length === 0) return match;
      if (PLACEHOLDER.test(value.trim())) return match;

      const masked =
        rule.name === 'private-key-block'
          ? '-----BEGIN PRIVATE KEY-----\n[redacted by CodeSentinel]\n-----END PRIVATE KEY-----'
          : maskSecret(value);

      fired.add(rule.name);
      count += 1;
      return match.replace(value, masked);
    });
  }

  return { text, redacted: [...fired].sort(), count };
}












export function neutralizeInjection(input: string): string {
  return input
    .replace(/^\s*(?:system|assistant|developer)\s*:/gim, '[role-marker]:')
    .replace(
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|system)\s+(?:instructions?|prompts?|rules?|directions?)/gi,
      '[instruction-override-attempt-removed]',
    )
    .replace(/<\/?(?:system|instructions?|prompt)>/gi, '[tag-removed]');
}






export function sanitizeRepositoryContent(input: string): RedactionResult {
  const redacted = redactSecrets(input);
  return { ...redacted, text: neutralizeInjection(redacted.text) };
}

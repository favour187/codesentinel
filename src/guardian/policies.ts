import type { PolicyAction, PolicyTrigger, Severity } from '@/db/schema';

/**
 * WHEN / IF / THEN evaluator.
 *
 * A rule fires only when every specified condition matches. Missing fields
 * mean "any". Actions never apply code — they only describe what Guardian
 * should request or report.
 */

export interface PolicyRuleView {
  readonly id?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: PolicyTrigger;
  readonly condition: { severity?: Severity; risk?: string; category?: string };
  readonly action: PolicyAction;
}

export interface PolicyContext {
  readonly trigger: PolicyTrigger;
  readonly severity?: Severity;
  readonly risk?: string;
  readonly category?: string;
}

export interface PolicyDecision {
  readonly ruleName: string;
  readonly action: PolicyAction;
  readonly blocksCheck: boolean;
}

const SEVERITY_ORDER: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

function atLeast(actual: Severity | undefined, min: Severity | undefined): boolean {
  if (!min) return true;
  if (!actual) return false;
  return SEVERITY_ORDER.indexOf(actual) >= SEVERITY_ORDER.indexOf(min);
}

export function evaluatePolicies(rules: readonly PolicyRuleView[], ctx: PolicyContext): PolicyDecision[] {
  const out: PolicyDecision[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.trigger !== ctx.trigger) continue;
    if (!atLeast(ctx.severity, rule.condition.severity)) continue;
    if (rule.condition.risk && rule.condition.risk !== ctx.risk) continue;
    if (rule.condition.category && rule.condition.category !== ctx.category) continue;
    out.push({
      ruleName: rule.name,
      action: rule.action,
      blocksCheck: rule.action === 'request_changes',
    });
  }
  return out;
}

export const DEFAULT_POLICY_RULES: PolicyRuleView[] = [
  {
    name: 'Critical findings must request changes',
    enabled: true,
    trigger: 'new_finding',
    condition: { severity: 'critical' },
    action: 'request_changes',
  },
  {
    name: 'High findings warn',
    enabled: true,
    trigger: 'new_finding',
    condition: { severity: 'high' },
    action: 'warn',
  },
  {
    name: 'Secrets block',
    enabled: true,
    trigger: 'secret_detected',
    condition: {},
    action: 'request_changes',
  },
  {
    name: 'High dependency risk warns',
    enabled: true,
    trigger: 'dependency_change',
    condition: { risk: 'high' },
    action: 'warn',
  },
];

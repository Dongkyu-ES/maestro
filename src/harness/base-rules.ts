export type Rule = {
  id: string;
  text: string;
  scope: 'global' | 'project' | 'path' | 'task' | 'provider';
  hardness: 'prompt_only' | 'policy_enforced' | 'verifier_enforced' | 'deprecated';
};

export type EnforcementBinding = {
  ruleId: string;
  policyId?: string;
  hookId?: string;
  verifierId?: string;
};

export type BaseRuleSet = {
  id: string;
  version: string;
  invariants: Rule[];
  projectRules: Rule[];
  providerHints: Record<string, Rule[]>;
  enforcement: EnforcementBinding[];
};

export type CompiledBaseRules = {
  promptSegment: string;
  includedRuleIds: string[];
  enforcedRuleIds: string[];
};

export function compileBaseRules(ruleset: BaseRuleSet, providerProfile?: string): CompiledBaseRules {
  const includedRules = getIncludedRules(ruleset, providerProfile);

  return {
    promptSegment: includedRules.map((rule) => rule.text).join('\n'),
    includedRuleIds: includedRules.map((rule) => rule.id),
    enforcedRuleIds: includedRules
      .filter((rule) => rule.hardness === 'policy_enforced' || rule.hardness === 'verifier_enforced')
      .map((rule) => rule.id),
  };
}

export function assertHardRulesBound(ruleset: BaseRuleSet): void {
  for (const rule of getAllRules(ruleset)) {
    if (rule.hardness === 'policy_enforced' && !hasNonEmptyBinding(ruleset.enforcement, rule.id, 'policyId')) {
      throw new Error(`Hard base rule ${rule.id} requires a non-empty policyId enforcement binding`);
    }
    if (rule.hardness === 'verifier_enforced' && !hasNonEmptyBinding(ruleset.enforcement, rule.id, 'verifierId')) {
      throw new Error(`Hard base rule ${rule.id} requires a non-empty verifierId enforcement binding`);
    }
  }
}

function getIncludedRules(ruleset: BaseRuleSet, providerProfile?: string): Rule[] {
  const providerRules = providerProfile ? (ruleset.providerHints[providerProfile] ?? []) : [];
  return [...ruleset.invariants, ...ruleset.projectRules, ...providerRules]
    .filter((rule) => rule.hardness !== 'deprecated')
    .sort(compareRulesById);
}

function getAllRules(ruleset: BaseRuleSet): Rule[] {
  return [
    ...ruleset.invariants,
    ...ruleset.projectRules,
    ...Object.keys(ruleset.providerHints)
      .sort()
      .flatMap((providerProfile) => ruleset.providerHints[providerProfile] ?? []),
  ];
}

function compareRulesById(left: Rule, right: Rule): number {
  return left.id.localeCompare(right.id);
}

function hasNonEmptyBinding(enforcement: EnforcementBinding[], ruleId: string, bindingKey: 'policyId' | 'verifierId'): boolean {
  return enforcement.some((binding) => binding.ruleId === ruleId && isNonEmpty(binding[bindingKey]));
}

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

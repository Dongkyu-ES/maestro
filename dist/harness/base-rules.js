export function compileBaseRules(ruleset, providerProfile) {
    const includedRules = getIncludedRules(ruleset, providerProfile);
    return {
        promptSegment: includedRules.map((rule) => rule.text).join('\n'),
        includedRuleIds: includedRules.map((rule) => rule.id),
        enforcedRuleIds: includedRules
            .filter((rule) => rule.hardness === 'policy_enforced' || rule.hardness === 'verifier_enforced')
            .map((rule) => rule.id),
    };
}
export function assertHardRulesBound(ruleset) {
    for (const rule of getAllRules(ruleset)) {
        if (rule.hardness === 'policy_enforced' && !hasNonEmptyBinding(ruleset.enforcement, rule.id, 'policyId')) {
            throw new Error(`Hard base rule ${rule.id} requires a non-empty policyId enforcement binding`);
        }
        if (rule.hardness === 'verifier_enforced' && !hasNonEmptyBinding(ruleset.enforcement, rule.id, 'verifierId')) {
            throw new Error(`Hard base rule ${rule.id} requires a non-empty verifierId enforcement binding`);
        }
    }
}
function getIncludedRules(ruleset, providerProfile) {
    const providerRules = providerProfile ? (ruleset.providerHints[providerProfile] ?? []) : [];
    return [...ruleset.invariants, ...ruleset.projectRules, ...providerRules]
        .filter((rule) => rule.hardness !== 'deprecated')
        .sort(compareRulesById);
}
function getAllRules(ruleset) {
    return [
        ...ruleset.invariants,
        ...ruleset.projectRules,
        ...Object.keys(ruleset.providerHints)
            .sort()
            .flatMap((providerProfile) => ruleset.providerHints[providerProfile] ?? []),
    ];
}
function compareRulesById(left, right) {
    return left.id.localeCompare(right.id);
}
function hasNonEmptyBinding(enforcement, ruleId, bindingKey) {
    return enforcement.some((binding) => binding.ruleId === ruleId && isNonEmpty(binding[bindingKey]));
}
function isNonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

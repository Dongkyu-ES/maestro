import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertHardRulesBound, compileBaseRules, type BaseRuleSet, type Rule } from './base-rules.js';

const promptOnlyRule: Rule = {
  id: 'base.prompt-only',
  text: 'Keep user-facing progress concrete.',
  scope: 'global',
  hardness: 'prompt_only',
};

const deprecatedRule: Rule = {
  id: 'base.deprecated',
  text: 'This rule should not be included.',
  scope: 'project',
  hardness: 'deprecated',
};

const verifierRule: Rule = {
  id: 'base.verifier-hard',
  text: 'Claim enforcement only when verifier evidence exists.',
  scope: 'task',
  hardness: 'verifier_enforced',
};

function makeRuleset(overrides: Partial<BaseRuleSet> = {}): BaseRuleSet {
  return {
    id: 'test-base-rules',
    version: '1.0.0',
    invariants: [],
    projectRules: [],
    providerHints: {},
    enforcement: [],
    ...overrides,
  };
}

test('T3 prompt_only rule appears in compiled prompt and included ids but not enforced ids', () => {
  const ruleset = makeRuleset({ invariants: [promptOnlyRule] });

  const compiled = compileBaseRules(ruleset);

  assert.match(compiled.promptSegment, /Keep user-facing progress concrete/);
  assert.deepEqual(compiled.includedRuleIds, ['base.prompt-only']);
  assert.deepEqual(compiled.enforcedRuleIds, []);
});

test('T3 deprecated rule is excluded entirely from compiled base rules', () => {
  const ruleset = makeRuleset({ invariants: [deprecatedRule], projectRules: [promptOnlyRule] });

  const compiled = compileBaseRules(ruleset);

  assert.equal(compiled.promptSegment.includes(deprecatedRule.text), false);
  assert.equal(compiled.includedRuleIds.includes(deprecatedRule.id), false);
  assert.equal(compiled.enforcedRuleIds.includes(deprecatedRule.id), false);
});

test('T3 compileBaseRules is deterministic for identical inputs', () => {
  const ruleset = makeRuleset({
    invariants: [promptOnlyRule],
    projectRules: [verifierRule],
    providerHints: {
      codex: [
        {
          id: 'base.provider-hint',
          text: 'Prefer native verifier surfaces.',
          scope: 'provider',
          hardness: 'prompt_only',
        },
      ],
    },
    enforcement: [{ ruleId: verifierRule.id, verifierId: 'verifier.base-rules' }],
  });

  assert.deepEqual(compileBaseRules(ruleset, 'codex'), compileBaseRules(ruleset, 'codex'));
});

test('T3 assertHardRulesBound rejects verifier_enforced rule with no enforcement entry naming the rule id', () => {
  const ruleset = makeRuleset({ projectRules: [verifierRule] });

  assert.throws(() => assertHardRulesBound(ruleset), /base\.verifier-hard/);
});

test('T3 assertHardRulesBound rejects verifier_enforced rule with undefined or empty verifier binding naming the rule id', () => {
  for (const verifierId of [undefined, '', '   ']) {
    const ruleset = makeRuleset({
      projectRules: [verifierRule],
      enforcement: [{ ruleId: verifierRule.id, verifierId }],
    });

    assert.throws(() => assertHardRulesBound(ruleset), /base\.verifier-hard/);
  }
});

test('T3 properly bound verifier_enforced rule is accepted and compiled as enforced', () => {
  const ruleset = makeRuleset({
    projectRules: [verifierRule],
    enforcement: [{ ruleId: verifierRule.id, verifierId: 'verifier.base-rules' }],
  });

  assert.doesNotThrow(() => assertHardRulesBound(ruleset));
  assert.deepEqual(compileBaseRules(ruleset).enforcedRuleIds, ['base.verifier-hard']);
});

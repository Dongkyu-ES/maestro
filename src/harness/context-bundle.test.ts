import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContextBundle, type ContextBundleInput, type ContextSection } from './context-bundle.js';

const hexSha256 = /^[a-f0-9]{64}$/;

const sections: ContextSection[] = [
  {
    id: 'goal.primary',
    kind: 'goal',
    text: 'Ship a reproducible context bundle.',
    sourceRef: 'task:T6',
  },
  {
    id: 'rule.canonical-order',
    kind: 'rule',
    text: 'Section order is canonicalized by kind and id.',
    sourceRef: 'contract:4.3',
  },
  {
    id: 'memory.current-runtime',
    kind: 'memory',
    text: 'Harness context hashes must be provider reproducible.',
    sourceRef: 'memory:runtime',
  },
  {
    id: 'provider.codex',
    kind: 'provider_hint',
    text: 'Use stable JSON for canonical hashing.',
    sourceRef: 'provider:codex',
  },
];

function makeInput(overrides: Partial<ContextBundleInput> = {}): ContextBundleInput {
  return {
    role: 'worker',
    providerProfile: 'codex-native',
    sections,
    includedRuleIds: ['rule.canonical-order', 'rule.hash-gate'],
    includedMemoryIds: ['memory.current-runtime'],
    toolPolicyId: 'tool-policy.default',
    acceptanceContractId: 'acceptance.T6',
    ...overrides,
  };
}

test('T6 buildContextBundle is deterministic for identical input', () => {
  const input = makeInput();

  const first = buildContextBundle(input);
  const second = buildContextBundle(input);

  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(first, second);
});

test('T6 buildContextBundle sha256 is invariant to input section order', () => {
  const forward = buildContextBundle(makeInput());
  const reversed = buildContextBundle(makeInput({ sections: [...sections].reverse() }));

  assert.equal(forward.sha256, reversed.sha256);
  assert.deepEqual(
    forward.sections.map((section) => `${section.kind}:${section.id}`),
    [
      'goal:goal.primary',
      'memory:memory.current-runtime',
      'provider_hint:provider.codex',
      'rule:rule.canonical-order',
    ],
  );
  assert.deepEqual(forward.sections, reversed.sections);
});

test('T6 buildContextBundle sha256 changes for section text, rule ids, or provider profile changes', () => {
  const base = buildContextBundle(makeInput());
  const changedText = buildContextBundle(
    makeInput({
      sections: sections.map((section) =>
        section.id === 'goal.primary' ? { ...section, text: `${section.text}\nWhitespace remains load-bearing.` } : section,
      ),
    }),
  );
  const addedRule = buildContextBundle(makeInput({ includedRuleIds: ['rule.hash-gate', 'rule.added', 'rule.canonical-order'] }));
  const changedProvider = buildContextBundle(makeInput({ providerProfile: 'openai-direct' }));

  assert.notEqual(base.sha256, changedText.sha256);
  assert.notEqual(base.sha256, addedRule.sha256);
  assert.notEqual(base.sha256, changedProvider.sha256);
});

test('T6 section sha256 is 64-hex and changes iff hashed section fields change', () => {
  const base = buildContextBundle(makeInput());
  const reorderedRules = buildContextBundle(makeInput({ includedRuleIds: ['rule.hash-gate', 'rule.canonical-order'] }));
  const changedText = buildContextBundle(
    makeInput({
      sections: sections.map((section) =>
        section.id === 'rule.canonical-order' ? { ...section, text: 'Changed section text.' } : section,
      ),
    }),
  );
  const changedKind = buildContextBundle(
    makeInput({
      sections: sections.map((section) =>
        section.id === 'rule.canonical-order' ? { ...section, kind: 'policy' } : section,
      ),
    }),
  );
  const changedSourceRef = buildContextBundle(
    makeInput({
      sections: sections.map((section) =>
        section.id === 'rule.canonical-order' ? { ...section, sourceRef: 'contract:4.3-revised' } : section,
      ),
    }),
  );

  const baseRule = base.sections.find((section) => section.id === 'rule.canonical-order');
  const reorderedRule = reorderedRules.sections.find((section) => section.id === 'rule.canonical-order');
  const textRule = changedText.sections.find((section) => section.id === 'rule.canonical-order');
  const kindRule = changedKind.sections.find((section) => section.id === 'rule.canonical-order');
  const sourceRule = changedSourceRef.sections.find((section) => section.id === 'rule.canonical-order');

  assert.ok(baseRule);
  assert.ok(reorderedRule);
  assert.ok(textRule);
  assert.ok(kindRule);
  assert.ok(sourceRule);
  assert.match(baseRule.sha256, hexSha256);
  assert.equal(baseRule.sha256, reorderedRule.sha256);
  assert.notEqual(baseRule.sha256, textRule.sha256);
  assert.notEqual(baseRule.sha256, kindRule.sha256);
  assert.notEqual(baseRule.sha256, sourceRule.sha256);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeOntologyProjections,
  findOntologyNode,
  rebuildOntologyProjection,
} from './ontology-projection.js';
import { policyRelationForDecision, projectToolPolicyDecisions, rebacForRisk } from './policy-projection.js';

test('decision maps to the policy->subject grammar relation', () => {
  assert.equal(policyRelationForDecision('allow'), 'permits');
  assert.equal(policyRelationForDecision('deny'), 'denies');
  assert.equal(policyRelationForDecision('ask'), 'requires_approval');
});

test('risk class maps to a ReBAC permission and sensitivity', () => {
  assert.deepEqual(rebacForRisk('read_only'), { permission: 'view', capability: 'can_view', sensitivity: 'none' });
  assert.deepEqual(rebacForRisk('mutating'), { permission: 'edit', capability: 'can_edit', sensitivity: 'moderate' });
  assert.deepEqual(rebacForRisk('destructive'), { permission: 'edit', capability: 'can_edit', sensitivity: 'high' });
  assert.deepEqual(rebacForRisk('credentialed'), { permission: 'execute', capability: 'can_execute', sensitivity: 'high' });
});

test('an allowed read_only decision grants a can_view capability edge', () => {
  const { nodes, edges } = projectToolPolicyDecisions([
    { tool: 'read_file', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:codex' },
  ]);
  assert.ok(nodes.find((n) => n.id === 'resource:tool:read_file' && n.type === 'Tool'));
  assert.ok(nodes.find((n) => n.id === 'policy:tool-rule:read_file' && n.type === 'Policy'));
  assert.ok(nodes.find((n) => n.id === 'policy:sensitivity:none' && n.type === 'Sensitivity'));
  // policy permits subject
  assert.ok(edges.find((e) => e.from === 'policy:tool-rule:read_file' && e.relation === 'permits' && e.to === 'subject:agent:codex'));
  // subject gets the capability
  assert.ok(edges.find((e) => e.from === 'subject:agent:codex' && e.relation === 'can_view' && e.to === 'resource:tool:read_file'));
});

test('a denied destructive decision grants NO capability edge', () => {
  const { edges } = projectToolPolicyDecisions([
    { tool: 'rm', decision: 'deny', risk: 'destructive', subjectId: 'subject:agent:codex' },
  ]);
  assert.ok(edges.find((e) => e.relation === 'denies' && e.to === 'subject:agent:codex'));
  assert.ok(!edges.some((e) => e.from === 'subject:agent:codex' && e.relation.startsWith('can_')), 'no capability granted on deny');
});

test('an ask decision records requires_approval but no capability', () => {
  const { edges } = projectToolPolicyDecisions([{ tool: 'curl', decision: 'ask', risk: 'network' }]);
  assert.ok(edges.find((e) => e.relation === 'requires_approval'));
  assert.ok(!edges.some((e) => e.relation.startsWith('can_')), 'ask grants no capability');
});

test('sensitivity is keyed by level and classifies the tool resource', () => {
  const { nodes, edges } = projectToolPolicyDecisions([{ tool: 'rm', decision: 'deny', risk: 'destructive' }]);
  const sens = nodes.find((n) => n.id === 'policy:sensitivity:high');
  assert.equal(sens?.attrs.level, 'high');
  assert.ok(edges.find((e) => e.from === 'policy:sensitivity:high' && e.relation === 'classifies' && e.to === 'resource:tool:rm'));
});

test('same tool at different risks classifies at multiple levels without overwriting (no false single risk)', () => {
  // Warden's classifier rates the same tool name differently by args (e.g. shell: read_only vs destructive).
  const { nodes, edges } = projectToolPolicyDecisions([
    { tool: 'shell', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:a' },
    { tool: 'shell', decision: 'allow', risk: 'destructive', subjectId: 'subject:agent:b' },
  ]);
  // The tool resource carries no single (overwritten) risk attr.
  const tool = nodes.find((n) => n.id === 'resource:tool:shell');
  assert.equal(tool?.attrs.risk, undefined);
  // Both levels are present as distinct nodes, each classifying the same tool — nothing is clobbered.
  assert.ok(edges.find((e) => e.from === 'policy:sensitivity:none' && e.relation === 'classifies' && e.to === 'resource:tool:shell'));
  assert.ok(edges.find((e) => e.from === 'policy:sensitivity:high' && e.relation === 'classifies' && e.to === 'resource:tool:shell'));
});

test('policy overlay is a subgraph (no projection envelope) and folds into a ledger-backed base', () => {
  const overlay = projectToolPolicyDecisions([
    { tool: 'read_file', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:codex' },
  ]);
  // It is a bare subgraph: no authority/as_of envelope it could fabricate.
  assert.ok(!('authority' in overlay));
  assert.ok(!('as_of' in overlay));
  // Fold into a real ledger-backed base (empty ledger here); result stays a non-authoritative projection.
  const base = rebuildOntologyProjection([]);
  const composed = composeOntologyProjections(base, overlay);
  assert.equal(composed.authority, false);
  assert.equal(composed.as_of, base.as_of); // inherits the base's deterministic as_of
  assert.ok(findOntologyNode(composed, 'resource:tool:read_file'));
  assert.ok(findOntologyNode(composed, 'policy:tool-rule:read_file'));
});

test('a later deny supersedes an earlier allow (no stale capability edge)', () => {
  const { edges } = projectToolPolicyDecisions([
    { tool: 'rm', decision: 'allow', risk: 'destructive', subjectId: 'subject:agent:codex', sourceEventId: 'e1' },
    { tool: 'rm', decision: 'deny', risk: 'destructive', subjectId: 'subject:agent:codex', sourceEventId: 'e2' },
  ]);
  // surviving decision is deny: a denies edge, and crucially NO can_* capability edge survives.
  assert.ok(edges.find((e) => e.relation === 'denies' && e.to === 'subject:agent:codex'));
  assert.ok(!edges.some((e) => e.from === 'subject:agent:codex' && e.relation.startsWith('can_')), 'earlier allow capability is gone');
  assert.ok(!edges.some((e) => e.relation === 'permits'), 'no stale permits edge');
});

test('two different subjects on the same tool keep independent decisions', () => {
  const { edges } = projectToolPolicyDecisions([
    { tool: 'read_file', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:codex' },
    { tool: 'read_file', decision: 'deny', risk: 'read_only', subjectId: 'subject:agent:claude' },
  ]);
  assert.ok(edges.find((e) => e.from === 'subject:agent:codex' && e.relation === 'can_view'), 'codex allowed');
  assert.ok(edges.find((e) => e.relation === 'denies' && e.to === 'subject:agent:claude'), 'claude denied');
  assert.ok(!edges.some((e) => e.from === 'subject:agent:claude' && e.relation.startsWith('can_')), 'claude has no capability');
});

test('same SUBJECT using one tool at different risks keeps every sensitivity classification', () => {
  // The decision dimension is last-wins per (subject,tool), but classification is cumulative: the same
  // subject running shell at read_only then destructive must keep BOTH level classifications.
  const { edges } = projectToolPolicyDecisions([
    { tool: 'shell', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:codex' },
    { tool: 'shell', decision: 'allow', risk: 'destructive', subjectId: 'subject:agent:codex' },
  ]);
  assert.ok(edges.find((e) => e.from === 'policy:sensitivity:none' && e.relation === 'classifies' && e.to === 'resource:tool:shell'));
  assert.ok(edges.find((e) => e.from === 'policy:sensitivity:high' && e.relation === 'classifies' && e.to === 'resource:tool:shell'));
  // Access control is current-state: the surviving allow is the destructive one -> can_edit.
  assert.ok(edges.find((e) => e.from === 'subject:agent:codex' && e.relation === 'can_edit' && e.to === 'resource:tool:shell'));
});

test('capability edge provenance is risk-specific (no read_only event on a destructive can_edit)', () => {
  const { edges } = projectToolPolicyDecisions([
    { tool: 'shell', decision: 'allow', risk: 'read_only', subjectId: 'subject:agent:codex', sourceEventId: 'e1' },
    { tool: 'shell', decision: 'allow', risk: 'destructive', subjectId: 'subject:agent:codex', sourceEventId: 'e2' },
  ]);
  const cap = edges.find((e) => e.from === 'subject:agent:codex' && e.relation === 'can_edit');
  // surviving grant is the destructive allow -> provenance is e2 ONLY, not the read_only e1.
  assert.deepEqual(cap?.source_event_ids, ['e2']);
});

test('repeated identical decisions on the same tool union provenance, not duplicate nodes', () => {
  const { nodes } = projectToolPolicyDecisions([
    { tool: 'read_file', decision: 'allow', risk: 'read_only', sourceEventId: 'e1' },
    { tool: 'read_file', decision: 'allow', risk: 'read_only', sourceEventId: 'e2' },
  ]);
  const tool = nodes.filter((n) => n.id === 'resource:tool:read_file');
  assert.equal(tool.length, 1);
  assert.deepEqual(tool[0].source_event_ids.sort(), ['e1', 'e2']);
});

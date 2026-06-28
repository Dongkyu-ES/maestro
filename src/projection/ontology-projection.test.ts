import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRuntimeEvent, readRuntimeEvents } from '../events/ledger.js';
import {
  findOntologyNode,
  ontologyNeighbors,
  ontologySpaceCounts,
  rebuildOntologyProjection,
} from './ontology-projection.js';

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'ontology-proj-'));
}

/** Build a realistic single-run ledger and return its validated events. */
function buildRunEvents(runDir: string, runId: string): void {
  appendRuntimeEvent(runDir, { runId, source: 'web', type: 'runtime.launch.requested', payload: {} });
  appendRuntimeEvent(runDir, {
    runId,
    sessionId: 's1',
    source: 'codex-adapter',
    type: 'runtime.session.started',
    payload: { adapter_kind: 'codex', runtime_label: 'native-harness-assisted' },
    artifactRefs: ['artifacts/execute/result.txt'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.requested',
    payload: { approval_id: 'ap1' },
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.decided',
    payload: { approval_id: 'ap1', decision: 'approved' },
  });
}

test('empty ledger projects an empty, non-authoritative graph', () => {
  const projection = rebuildOntologyProjection([]);
  assert.equal(projection.authority, false);
  assert.equal(projection.schema_version, 1);
  assert.deepEqual(projection.nodes, []);
  assert.deepEqual(projection.edges, []);
});

test('a completed run projects all expected spaces and a supports edge', () => {
  const dir = tmpRunDir();
  const runId = 'run-ok';
  buildRunEvents(dir, runId);
  appendRuntimeEvent(dir, { runId, source: 'harness', type: 'run.completed', payload: { adapter_kind: 'codex' } });
  const projection = rebuildOntologyProjection(readRuntimeEvents(dir));

  // resource: the run
  const runNode = findOntologyNode(projection, `resource:run:${runId}`);
  assert.ok(runNode, 'run resource node exists');
  assert.equal(runNode?.attrs.status, 'completed');
  assert.equal(runNode?.attrs.event_count, 5);

  // subject: executor agent + operator
  assert.ok(findOntologyNode(projection, 'subject:agent:codex'), 'codex agent node');
  assert.ok(findOntologyNode(projection, 'subject:user:operator'), 'operator node from web event');

  // lever: executor choice
  assert.ok(findOntologyNode(projection, 'lever:executor:codex'), 'executor lever node');

  // concept: runtime label
  assert.ok(findOntologyNode(projection, 'concept:label:native-harness-assisted'), 'concept label node');

  // policy: approval, decided status wins (last write)
  const policy = findOntologyNode(projection, 'policy:approval:ap1');
  assert.equal(policy?.attrs.status, 'approved');

  // claim + outcome
  const claim = findOntologyNode(projection, `claim:completion:${runId}`);
  assert.equal(claim?.attrs.declared_status, 'completed');
  const outcome = findOntologyNode(projection, `outcome:run:${runId}`);
  assert.equal(outcome?.attrs.result, 'completed');

  // every space populated except community (no clustering source in this ledger)
  const counts = ontologySpaceCounts(projection);
  for (const space of ['subject', 'resource', 'evidence', 'concept', 'claim', 'outcome', 'lever', 'policy'] as const)
    assert.ok(counts[space] >= 1, `space ${space} populated`);
  assert.equal(counts.community, 0);

  // supports edge: terminal evidence -> completion claim
  const supports = projection.edges.find((e) => e.relation === 'supports' && e.to === claim?.id);
  assert.ok(supports, 'a supports edge points at the completion claim');
  // lever optimizes outcome
  assert.ok(
    projection.edges.some((e) => e.from === 'lever:executor:codex' && e.relation === 'optimizes' && e.to === outcome?.id),
    'lever optimizes outcome',
  );
});

test('a failed run contradicts the completion claim (no false green)', () => {
  const dir = tmpRunDir();
  const runId = 'run-fail';
  buildRunEvents(dir, runId);
  appendRuntimeEvent(dir, { runId, source: 'harness', type: 'run.failed', payload: { adapter_kind: 'codex' } });
  const projection = rebuildOntologyProjection(readRuntimeEvents(dir));

  const claim = findOntologyNode(projection, `claim:completion:${runId}`);
  assert.equal(claim?.attrs.declared_status, 'failed');
  const contradicts = projection.edges.find((e) => e.relation === 'contradicts' && e.to === claim?.id);
  assert.ok(contradicts, 'a contradicts edge points at the completion claim');
  assert.ok(
    !projection.edges.some((e) => e.relation === 'supports' && e.to === claim?.id),
    'no supports edge on a failed run',
  );
});

test('projection refuses a tampered ledger', () => {
  const dir = tmpRunDir();
  const runId = 'run-tamper';
  buildRunEvents(dir, runId);
  const events = readRuntimeEvents(dir);
  // Corrupt a middle event's payload without fixing the hash chain.
  const tampered = events.map((e, i) => (i === 1 ? { ...e, payload: { ...e.payload, injected: true } } : e));
  assert.throws(() => rebuildOntologyProjection(tampered), /payload hash mismatch|hash chain/);
});

test('projection is rebuildable: identical graph from the same events', () => {
  const dir = tmpRunDir();
  const runId = 'run-stable';
  buildRunEvents(dir, runId);
  appendRuntimeEvent(dir, { runId, source: 'harness', type: 'run.completed', payload: { adapter_kind: 'codex' } });
  const events = readRuntimeEvents(dir);
  const a = rebuildOntologyProjection(events);
  const b = rebuildOntologyProjection(events);
  // Full-object equality: as_of is derived from the events (latest timestamp), not a wall clock,
  // so the ENTIRE projection is byte-identical across rebuilds — not just nodes/edges.
  assert.deepEqual(a, b);
  assert.equal(a.as_of, events.at(-1)?.timestamp); // as_of = latest event timestamp
});

test('neighbors walk returns a run resource its contained evidence', () => {
  const dir = tmpRunDir();
  const runId = 'run-neighbors';
  buildRunEvents(dir, runId);
  const projection = rebuildOntologyProjection(readRuntimeEvents(dir));
  const contains = ontologyNeighbors(projection, `resource:run:${runId}`).filter((e) => e.relation === 'contains');
  assert.ok(contains.length >= 4, 'run contains its ledger events as evidence');
});

test('multi-run ledger keeps runs separate and validates each chain', () => {
  const dirA = tmpRunDir();
  const dirB = tmpRunDir();
  buildRunEvents(dirA, 'run-a');
  buildRunEvents(dirB, 'run-b');
  const events = [...readRuntimeEvents(dirA), ...readRuntimeEvents(dirB)];
  const projection = rebuildOntologyProjection(events);
  assert.ok(findOntologyNode(projection, 'resource:run:run-a'));
  assert.ok(findOntologyNode(projection, 'resource:run:run-b'));
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  appendFactFromWriteRecord,
  appendMemoryFact,
  factFromWriteRecord,
  type MemoryFact,
  markFactsVerifiedByEvents,
  memoryFabricPath,
  readMemoryFabric,
  writeMemoryFabric,
} from './fabric.js';
import type { MemoryWriteRecord } from './records.js';

function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'fabric-'));
}

function writeRecord(overrides: Partial<MemoryWriteRecord> = {}): MemoryWriteRecord {
  return {
    schema_version: 1,
    memory_id: 'mw-1',
    scope: 'project',
    authority: 'operator_approved',
    source_event_ids: ['evt-1'],
    artifact_refs: [],
    key: 'build_cmd',
    value: 'npm run build',
    merge_policy: 'append',
    created_at: '2026-06-01T00:00:00.000Z',
    writer: 'unit-test',
    ...overrides,
  };
}

test('writeMemoryFabric publishes atomically and leaves no temp file behind', () => {
  const agentDir = tmpAgentDir();
  const fact: MemoryFact = {
    schema_version: 1,
    id: 'a',
    layer: 'vertical_project',
    key: 'k',
    value: 'v',
    source_event_ids: ['e1'],
    artifact_refs: [],
    created_at: '2026-06-01T00:00:00.000Z',
  };
  writeMemoryFabric(agentDir, { schema_version: 1, facts: [fact] });
  assert.deepEqual(readMemoryFabric(agentDir).facts, [fact]);
  // No `.tmp.<pid>` artifact lingers next to the published file.
  const dir = dirname(memoryFabricPath(agentDir));
  assert.equal(
    readdirSync(dir).some((f) => f.includes('.tmp.')),
    false,
  );
});

test('readMemoryFabric is full fidelity: a large store survives read-modify-write without truncation', () => {
  const agentDir = tmpAgentDir();
  const facts: MemoryFact[] = Array.from({ length: 2050 }, (_, i) => ({
    schema_version: 1,
    id: `f${i}`,
    layer: 'vertical_project',
    key: 'k',
    value: i,
    source_event_ids: ['e'],
    artifact_refs: [],
    created_at: '2026-06-01T00:00:00.000Z',
  }));
  writeMemoryFabric(agentDir, { schema_version: 1, facts });
  // Storage read returns ALL facts — the consumption cap belongs to the gate, not here.
  assert.equal(readMemoryFabric(agentDir).facts.length, 2050);
  // A read-modify-write (append) must not silently drop the older facts past any cap.
  appendMemoryFact(agentDir, {
    layer: 'vertical_project',
    key: 'extra',
    value: 'x',
    source_event_ids: ['e'],
    artifact_refs: [],
  });
  assert.equal(readMemoryFabric(agentDir).facts.length, 2051);
});

test('readMemoryFabric fails open on a malformed store (default-on read path must not crash a run)', () => {
  const agentDir = tmpAgentDir();
  const path = memoryFabricPath(agentDir);
  mkdirSync(join(agentDir, 'memory'), { recursive: true });
  writeFileSync(path, '{ this is not valid json');
  assert.deepEqual(readMemoryFabric(agentDir), { schema_version: 1, facts: [] });
  // Wrong shape (facts not an array) is also treated as empty rather than thrown.
  writeFileSync(path, JSON.stringify({ schema_version: 1, facts: 'oops' }));
  assert.deepEqual(readMemoryFabric(agentDir), { schema_version: 1, facts: [] });
});

test('factFromWriteRecord maps a write record onto the canonical fact, carrying provenance', () => {
  const fact = factFromWriteRecord(writeRecord({ scope: 'handoff' }));
  assert.equal(fact.id, 'mw-1');
  assert.equal(fact.layer, 'sequential_handoff');
  assert.equal(fact.key, 'build_cmd');
  assert.deepEqual(fact.source_event_ids, ['evt-1']);
  // The executable write->store binding carries no verification recency yet — it must be earned.
  assert.equal('last_verified_at' in fact, false);
});

test('appendFactFromWriteRecord validates then persists a stored fact (write->store is executable)', () => {
  const agentDir = tmpAgentDir();
  const stored = appendFactFromWriteRecord(agentDir, writeRecord());
  assert.equal(stored.layer, 'vertical_project');
  assert.deepEqual(
    readMemoryFabric(agentDir).facts.map((f) => f.id),
    [stored.id],
  );
  // An ungrounded write (no provenance) is rejected by validateMemoryWrite, never stored.
  assert.throws(
    () =>
      appendFactFromWriteRecord(agentDir, writeRecord({ memory_id: 'mw-2', source_event_ids: [], artifact_refs: [] })),
    /provenance/,
  );
  assert.equal(readMemoryFabric(agentDir).facts.length, 1);
});

test('markFactsVerifiedByEvents stamps only fully-covered facts and skips ungrounded ones', () => {
  const agentDir = tmpAgentDir();
  const covered = appendMemoryFact(agentDir, {
    layer: 'vertical_project',
    key: 'a',
    value: '1',
    source_event_ids: ['e1', 'e2'],
    artifact_refs: [],
  });
  const partial = appendMemoryFact(agentDir, {
    layer: 'vertical_project',
    key: 'b',
    value: '2',
    source_event_ids: ['e1', 'e9'],
    artifact_refs: [],
  });
  const artifactOnly = appendMemoryFact(agentDir, {
    layer: 'vertical_project',
    key: 'c',
    value: '3',
    source_event_ids: [],
    artifact_refs: ['art.json'],
  });

  const stamped = markFactsVerifiedByEvents(agentDir, ['e1', 'e2', 'e3'], '2026-06-05T00:00:00.000Z');
  assert.deepEqual(stamped, [covered.id]);

  const facts = new Map(readMemoryFabric(agentDir).facts.map((f) => [f.id, f]));
  assert.equal(facts.get(covered.id)?.last_verified_at, '2026-06-05T00:00:00.000Z');
  // Partial coverage (e9 not verified) and empty provenance are never stamped.
  assert.equal(facts.get(partial.id)?.last_verified_at, undefined);
  assert.equal(facts.get(artifactOnly.id)?.last_verified_at, undefined);
});

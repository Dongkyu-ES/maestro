import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalizeExactDuplicates,
  canonicalizeFabric,
  findDuplicateFactCandidates,
  mergeFactInto,
  resolveCanonicalFactId,
} from './canonicalize.js';
import { appendMemoryFact, type MemoryFact, readMemoryFabric } from './fabric.js';

function fact(over: Partial<MemoryFact> & { id: string; created_at: string }): MemoryFact {
  return {
    schema_version: 1,
    layer: 'vertical_project',
    key: 'k',
    value: 'v',
    source_event_ids: ['e1'],
    artifact_refs: [],
    ...over,
  };
}

test('exact duplicates (layer+key+value) are detected at similarity 1', () => {
  const facts = [
    fact({ id: 'a', created_at: '2026-01-01T00:00:00Z', source_event_ids: ['e1'] }),
    fact({ id: 'b', created_at: '2026-01-02T00:00:00Z', source_event_ids: ['e2'] }),
  ];
  const candidates = findDuplicateFactCandidates(facts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].canonical_id, 'a'); // earliest created_at wins
  assert.equal(candidates[0].alias_id, 'b');
  assert.equal(candidates[0].similarity, 1);
  assert.equal(candidates[0].method, 'exact_layer_key_value');
});

test('same key with different value is a drift collision, not an exact dup', () => {
  const facts = [
    fact({ id: 'a', created_at: '2026-01-01T00:00:00Z', value: 'one' }),
    fact({ id: 'b', created_at: '2026-01-02T00:00:00Z', value: 'two' }),
  ];
  const candidates = findDuplicateFactCandidates(facts);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].method, 'layer_key_value_drift');
  assert.ok(candidates[0].similarity < 1);
});

test('merge unions provenance and keeps the freshest verification stamp', () => {
  const canonical = fact({
    id: 'a',
    created_at: '2026-01-01T00:00:00Z',
    source_event_ids: ['e1'],
    artifact_refs: ['art/a'],
    last_verified_at: '2026-01-05T00:00:00Z',
  });
  const alias = fact({
    id: 'b',
    created_at: '2026-01-02T00:00:00Z',
    source_event_ids: ['e2'],
    artifact_refs: ['art/b'],
    last_verified_at: '2026-01-09T00:00:00Z',
  });
  const merged = mergeFactInto(canonical, alias);
  assert.deepEqual(merged.source_event_ids, ['e1', 'e2']);
  assert.deepEqual(merged.artifact_refs, ['art/a', 'art/b']);
  assert.equal(merged.last_verified_at, '2026-01-09T00:00:00Z'); // freshest
  assert.deepEqual(merged.merged_alias_ids, ['b']);
  assert.equal(merged.id, 'a'); // canonical identity preserved
});

test('canonicalizeExactDuplicates collapses dups but leaves drift untouched', () => {
  const facts = [
    fact({ id: 'a', created_at: '2026-01-01T00:00:00Z', source_event_ids: ['e1'] }),
    fact({ id: 'b', created_at: '2026-01-02T00:00:00Z', source_event_ids: ['e2'] }), // exact dup of a
    fact({ id: 'c', created_at: '2026-01-03T00:00:00Z', value: 'different' }), // drift, survives
  ];
  const { facts: out, merges } = canonicalizeExactDuplicates(facts);
  assert.equal(merges.length, 1);
  assert.equal(out.length, 2); // a (merged) + c
  const survivor = out.find((f) => f.id === 'a');
  assert.deepEqual(survivor?.source_event_ids, ['e1', 'e2']);
  assert.deepEqual(survivor?.merged_alias_ids, ['b']);
  assert.ok(out.some((f) => f.id === 'c'));
});

test('resolveCanonicalFactId follows the tombstone trail', () => {
  const facts = [
    fact({ id: 'a', created_at: '2026-01-01T00:00:00Z', merged_alias_ids: ['b', 'old-x'] }),
    fact({ id: 'c', created_at: '2026-01-02T00:00:00Z' }),
  ];
  assert.equal(resolveCanonicalFactId(facts, 'a'), 'a'); // already canonical
  assert.equal(resolveCanonicalFactId(facts, 'b'), 'a'); // alias -> canonical
  assert.equal(resolveCanonicalFactId(facts, 'old-x'), 'a'); // absorbed id -> canonical
  assert.equal(resolveCanonicalFactId(facts, 'zzz'), 'zzz'); // unknown -> unchanged
});

test('canonicalizeExactDuplicates is idempotent', () => {
  const facts = [
    fact({ id: 'a', created_at: '2026-01-01T00:00:00Z', source_event_ids: ['e1'] }),
    fact({ id: 'b', created_at: '2026-01-02T00:00:00Z', source_event_ids: ['e2'] }),
  ];
  const once = canonicalizeExactDuplicates(facts).facts;
  const twice = canonicalizeExactDuplicates(once);
  assert.equal(twice.merges.length, 0);
  assert.deepEqual(twice.facts, once);
});

test('canonicalizeFabric dedups a real on-disk fabric provenance-preservingly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canon-'));
  appendMemoryFact(dir, { layer: 'module_learning', key: 'fix', value: 'use X', source_event_ids: ['e1'], artifact_refs: [] });
  appendMemoryFact(dir, { layer: 'module_learning', key: 'fix', value: 'use X', source_event_ids: ['e2'], artifact_refs: [] });
  appendMemoryFact(dir, { layer: 'module_learning', key: 'fix', value: 'use Y', source_event_ids: ['e3'], artifact_refs: [] });

  const before = readMemoryFabric(dir);
  assert.equal(before.facts.length, 3);

  const result = canonicalizeFabric(dir);
  assert.equal(result.merged, 1);
  // "use X" vs "use Y" is a value-drift collision: NOT merged, but reported to the caller.
  assert.equal(result.driftCandidates.length, 1);
  assert.equal(result.driftCandidates[0].method, 'layer_key_value_drift');

  const after = readMemoryFabric(dir);
  assert.equal(after.facts.length, 2); // the two "use X" collapsed, "use Y" kept (drift survives)
  const survivor = after.facts.find((f) => JSON.stringify(f.value) === '"use X"');
  assert.deepEqual(survivor?.source_event_ids, ['e1', 'e2']); // no provenance lost
  assert.ok(after.facts.some((f) => JSON.stringify(f.value) === '"use Y"'), 'drift fact still in store');

  // running again is a no-op for merges, but the drift is still surfaced for operator resolution
  const second = canonicalizeFabric(dir);
  assert.equal(second.merged, 0);
  assert.equal(second.driftCandidates.length, 1);
});

test('drift candidates never reference an alias merged away in the same pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canon-'));
  // a=one, b=two, c=two: b and c are exact dups (collapse), a drifts from them.
  appendMemoryFact(dir, { layer: 'vertical_project', key: 'k', value: 'one', source_event_ids: ['e1'], artifact_refs: [] });
  appendMemoryFact(dir, { layer: 'vertical_project', key: 'k', value: 'two', source_event_ids: ['e2'], artifact_refs: [] });
  appendMemoryFact(dir, { layer: 'vertical_project', key: 'k', value: 'two', source_event_ids: ['e3'], artifact_refs: [] });

  const result = canonicalizeFabric(dir);
  assert.equal(result.merged, 1); // c merged into b

  const survivingIds = new Set(readMemoryFabric(dir).facts.map((f) => f.id));
  // Every reported drift candidate references only facts that still exist (no merged-away alias).
  for (const c of result.driftCandidates) {
    assert.ok(survivingIds.has(c.canonical_id), `canonical ${c.canonical_id} survives`);
    assert.ok(survivingIds.has(c.alias_id), `alias ${c.alias_id} survives`);
  }
  assert.equal(result.driftCandidates.length, 1); // a <-> b, with c gone
});

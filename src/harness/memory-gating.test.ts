import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendMemoryFact, type MemoryFact, markFactsVerifiedByEvents } from '../memory/fabric.js';
import {
  assertNoStaleAsFact,
  buildMemoryContextSections,
  classifyMemoryForInjection,
  gatingViewFromFact,
  loadGatedMemoryFromFabric,
  type MemoryEntry,
} from './memory-gating.js';

const now = '2026-06-05T00:00:00.000Z';
const freshnessWindowMs = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'memory-1',
    category: 'project_fact',
    claim: 'The harness uses provenance-bound context.',
    scope: 'test',
    source: 'unit-test',
    confidence: 'high',
    createdAt: '2026-06-01T00:00:00.000Z',
    sourceEventIds: ['evt-1'],
    ...overrides,
  };
}

test('T5 recently verified project_fact is injected as confirmed_fact', () => {
  const entry = makeEntry({ id: 'recent-project-fact', lastVerifiedAt: '2026-06-04T23:30:00.000Z' });

  assert.equal(classifyMemoryForInjection(entry, { now, freshnessWindowMs }), 'confirmed_fact');
  assert.deepEqual(buildMemoryContextSections([entry], { now, freshnessWindowMs }).injectedFactIds, [
    'recent-project-fact',
  ]);
});

test('T5 stale or unverified project_fact is labeled and rejected if forged as confirmed_fact', () => {
  const stale = makeEntry({ id: 'stale-project-fact', lastVerifiedAt: '2026-06-01T00:00:00.000Z' });
  const unverified = makeEntry({ id: 'unverified-project-fact' });

  assert.equal(classifyMemoryForInjection(stale, { now, freshnessWindowMs }), 'stale');
  assert.equal(classifyMemoryForInjection(unverified, { now, freshnessWindowMs }), 'unverified');

  const built = buildMemoryContextSections([stale, unverified], { now, freshnessWindowMs });
  assert.deepEqual(built.injectedFactIds, []);
  assert.match(built.sections.find((section) => section.id === stale.id)?.text ?? '', /^\[stale\]/);
  assert.match(built.sections.find((section) => section.id === unverified.id)?.text ?? '', /^\[unverified\]/);

  assert.throws(
    () => assertNoStaleAsFact([stale, unverified], { now, freshnessWindowMs, injectedFactIds: [stale.id] }),
    /stale-project-fact/,
  );
  assert.throws(
    () => assertNoStaleAsFact([stale, unverified], { now, freshnessWindowMs, injectedFactIds: [unverified.id] }),
    /unverified-project-fact/,
  );
});

test('T5 rejected memory entry is always excluded', () => {
  const entry = makeEntry({ id: 'rejected-entry', category: 'rejected', lastVerifiedAt: '2026-06-04T23:30:00.000Z' });

  assert.equal(classifyMemoryForInjection(entry, { now, freshnessWindowMs }), 'excluded');
});

test('gate #4 provenance half: a recently verified fact with NO provenance is not confirmed_fact', () => {
  // Recency alone is not enough — without ledger provenance the fact is ungrounded.
  const recentButUngrounded = makeEntry({
    id: 'ungrounded-fact',
    sourceEventIds: [],
    lastVerifiedAt: '2026-06-04T23:30:00.000Z',
  });

  assert.equal(classifyMemoryForInjection(recentButUngrounded, { now, freshnessWindowMs }), 'unverified');
  assert.deepEqual(buildMemoryContextSections([recentButUngrounded], { now, freshnessWindowMs }).injectedFactIds, []);
  assert.throws(
    () =>
      assertNoStaleAsFact([recentButUngrounded], { now, freshnessWindowMs, injectedFactIds: [recentButUngrounded.id] }),
    /ungrounded-fact/,
  );
});

test('gatingViewFromFact projects the canonical MemoryFact so the gate consumes one provenance model', () => {
  const fact: MemoryFact = {
    schema_version: 1,
    id: 'fact-1',
    layer: 'vertical_project',
    key: 'build_cmd',
    value: 'npm run build',
    run_id: 'run-9',
    source_event_ids: ['evt-a', 'evt-b'],
    artifact_refs: [],
    created_at: '2026-06-01T00:00:00.000Z',
    last_verified_at: '2026-06-04T23:30:00.000Z',
  };

  const view = gatingViewFromFact(fact);
  assert.deepEqual(view.sourceEventIds, ['evt-a', 'evt-b']);
  assert.equal(view.lastVerifiedAt, '2026-06-04T23:30:00.000Z');
  // Provenance + recency carried over → the canonical fact gates as a confirmed fact.
  assert.equal(classifyMemoryForInjection(view, { now, freshnessWindowMs }), 'confirmed_fact');

  // A blocked/failed outcome is not a durable fact: it projects as hypothesis (never confirmed).
  const blocked = gatingViewFromFact({ ...fact, id: 'fact-2', outcome: 'blocked' });
  assert.equal(classifyMemoryForInjection(blocked, { now, freshnessWindowMs }), 'unverified');
});

test('loadGatedMemoryFromFabric: a stored fact is unverified until a verifier stamps it, then confirmed', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'fabric-gate-'));
  appendMemoryFact(agentDir, {
    id: 'mem-build',
    layer: 'vertical_project',
    key: 'build_cmd',
    value: 'npm run build',
    source_event_ids: ['e1'],
    artifact_refs: [],
  });

  // Before any verification stamp, the stored fact has provenance but no recency → not injectable.
  const before = loadGatedMemoryFromFabric(agentDir);
  assert.equal(before.length, 1);
  assert.equal(classifyMemoryForInjection(before[0], { now, freshnessWindowMs }), 'unverified');

  // A passing verifier stamps last_verified_at on the facts grounded in the verified events.
  markFactsVerifiedByEvents(agentDir, ['e1'], now);
  const after = loadGatedMemoryFromFabric(agentDir);
  assert.equal(classifyMemoryForInjection(after[0], { now, freshnessWindowMs }), 'confirmed_fact');
});

test('T5 buildMemoryContextSections is deterministic', () => {
  const entries = [
    makeEntry({ id: 'z-memory', lastVerifiedAt: '2026-06-04T23:30:00.000Z' }),
    makeEntry({ id: 'a-memory', claim: 'Earlier id sorts first.' }),
  ];

  assert.deepEqual(
    buildMemoryContextSections(entries, { now, freshnessWindowMs }),
    buildMemoryContextSections(entries, { now, freshnessWindowMs }),
  );
});

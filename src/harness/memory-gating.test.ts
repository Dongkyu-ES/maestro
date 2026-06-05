import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoStaleAsFact,
  buildMemoryContextSections,
  classifyMemoryForInjection,
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
    ...overrides,
  };
}

test('T5 recently verified project_fact is injected as confirmed_fact', () => {
  const entry = makeEntry({ id: 'recent-project-fact', lastVerifiedAt: '2026-06-04T23:30:00.000Z' });

  assert.equal(classifyMemoryForInjection(entry, { now, freshnessWindowMs }), 'confirmed_fact');
  assert.deepEqual(buildMemoryContextSections([entry], { now, freshnessWindowMs }).injectedFactIds, ['recent-project-fact']);
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

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRuntimeEvent, readRuntimeEvents } from '../events/ledger.js';
import { IMPACT_QUESTIONS, WARDEN_IMPACT, analyzeImpact, simulateLever } from './impact.js';
import { rebuildOntologyProjection } from './ontology-projection.js';

test('analyzeImpact reports only the categories the change touches', () => {
  const report = analyzeImpact({ spaces: ['claim'], touchesData: true });
  assert.deepEqual(report.categories.sort(), ['I1', 'I3']);
  // each finding carries the manifest question
  for (const f of report.findings) assert.equal(f.question, IMPACT_QUESTIONS[f.category]);
});

test('all seven impact categories are reachable', () => {
  const report = analyzeImpact({
    spaces: ['policy'],
    touchesData: true,
    touchesRelations: true,
    touchesPermissions: true,
    touchesLogic: true,
    touchesCache: true,
    touchesDownstream: true,
  });
  assert.deepEqual(report.categories.sort(), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7']);
});

test('promotion apply always touches the index cache (I6) and data (I1)', () => {
  const mem = WARDEN_IMPACT.promotionApply('memory');
  assert.ok(mem.categories.includes('I1'));
  assert.ok(mem.categories.includes('I6'));
  // a policy promotion additionally touches permissions + logic
  const pol = WARDEN_IMPACT.promotionApply('policy');
  assert.ok(pol.categories.includes('I4'));
  assert.ok(pol.categories.includes('I5'));
  // memory promotion does NOT touch permissions
  assert.ok(!mem.categories.includes('I4'));
});

test('memory canonicalize touches data + relations (alias trail)', () => {
  const report = WARDEN_IMPACT.memoryCanonicalize();
  assert.ok(report.categories.includes('I1'));
  assert.ok(report.categories.includes('I2'));
});

test('lever simulation reports the observed control surface of an executor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'impact-'));
  const runId = 'run-lever';
  appendRuntimeEvent(dir, {
    runId,
    source: 'codex-adapter',
    type: 'runtime.session.started',
    payload: { adapter_kind: 'codex' },
  });
  // Real terminal events come from harness/runtime-manager WITHOUT an adapter_kind — the executor
  // must still be linked to the outcome from the earlier session.started, not this event.
  appendRuntimeEvent(dir, { runId, source: 'harness', type: 'run.completed', payload: {} });
  const projection = rebuildOntologyProjection(readRuntimeEvents(dir));

  const sim = simulateLever(projection, 'lever:executor:codex');
  assert.ok(sim.affectedOutcomes.includes(`outcome:run:${runId}`), 'executor lever reaches the run outcome');
  assert.ok(sim.affectedNodes.includes(`resource:run:${runId}`), 'lever affects the run resource');
});

test('lever simulation on an unknown lever returns nothing', () => {
  const projection = rebuildOntologyProjection([]);
  const sim = simulateLever(projection, 'lever:executor:ghost');
  assert.deepEqual(sim.affectedOutcomes, []);
  assert.deepEqual(sim.affectedNodes, []);
});

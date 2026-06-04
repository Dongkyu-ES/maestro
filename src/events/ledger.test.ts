import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRuntimeEvent, payloadHash, readRuntimeEvents, validateRuntimeLedger } from './ledger.js';

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), 'dominic-ledger-'));
}

function appendThreeEvents(runDir: string) {
  appendRuntimeEvent(runDir, {
    runId: 'run-ledger',
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { step: 1 },
  });
  appendRuntimeEvent(runDir, {
    runId: 'run-ledger',
    source: 'runtime-manager',
    type: 'runtime.session.started',
    payload: { step: 2 },
  });
  appendRuntimeEvent(runDir, {
    runId: 'run-ledger',
    source: 'runtime-manager',
    type: 'run.completed',
    payload: { step: 3 },
  });
  return readRuntimeEvents(runDir);
}

test('freshly appended runtime ledger validates as a three-event hash chain', () => {
  const events = appendThreeEvents(tempRunDir());

  assert.equal(events.length, 3);
  assert.doesNotThrow(() => validateRuntimeLedger(events));
});

test('middle event payload forgery is rejected when only its payload hash is recomputed', () => {
  const events = appendThreeEvents(tempRunDir());
  events[1].payload = { step: 2, forged: true };
  events[1].payload_sha256 = payloadHash(events[1].payload);

  assert.throws(() => validateRuntimeLedger(events), /broken event hash chain/);
});

test('mutating a previous event hash link is rejected', () => {
  const events = appendThreeEvents(tempRunDir());
  const replacement = events[1].prev_event_sha256.startsWith('f') ? 'e' : 'f';
  events[1].prev_event_sha256 = `${replacement}${events[1].prev_event_sha256.slice(1)}`;

  assert.throws(() => validateRuntimeLedger(events));
});

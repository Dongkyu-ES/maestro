import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendRuntimeEvent,
  assertEvidenceBoundToLedgerHead,
  createRuntimeLedgerHeadBinding,
  payloadHash,
  readRuntimeEvents,
  validateRuntimeLedger,
} from './ledger.js';

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


test('current ledger-head binding rejects stale evidence after later events append', () => {
  const runDir = tempRunDir();
  appendRuntimeEvent(runDir, {
    runId: 'run-ledger',
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { step: 1 },
  });
  const staleBinding = createRuntimeLedgerHeadBinding(readRuntimeEvents(runDir));
  appendRuntimeEvent(runDir, {
    runId: 'run-ledger',
    source: 'runtime-manager',
    type: 'run.completed',
    payload: { step: 2 },
  });

  assert.throws(() => assertEvidenceBoundToLedgerHead(staleBinding, readRuntimeEvents(runDir)), /stale evidence event count/);
});

test('current ledger-head binding rejects a tampered head hash even when event count matches', () => {
  const events = appendThreeEvents(tempRunDir());
  const binding = createRuntimeLedgerHeadBinding(events);
  const replacement = binding.ledger_head_sha256.startsWith('f') ? 'e' : 'f';
  const forged = { ...binding, ledger_head_sha256: `${replacement}${binding.ledger_head_sha256.slice(1)}` };

  assert.throws(() => assertEvidenceBoundToLedgerHead(forged, events), /ledger head mismatch/);
});

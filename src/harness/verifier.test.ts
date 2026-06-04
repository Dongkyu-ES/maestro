import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRuntimeEvent, createRuntimeLedgerHeadBinding, readRuntimeEvents } from '../events/ledger.js';
import { assertVerifierInputSensitive, runVerifier } from './verifier.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'm7-verifier-'));
}

test('M7 shared verifier rejects constant artifact decisions with digest-sensitive input', () => {
  const root = tmpRoot();
  writeFileSync(join(root, 'artifact.txt'), 'real evidence');
  const good = runVerifier({ type: 'artifact', root, artifactRef: 'artifact.txt' });
  assert.equal(good.status, 'supported');
  assertVerifierInputSensitive(
    { type: 'artifact', root, artifactRef: 'artifact.txt' },
    { type: 'artifact', root, artifactRef: 'missing.txt' },
  );
});

test('M7 ledger verifier rejects stale head bindings instead of accepting old evidence', () => {
  const root = tmpRoot();
  const runDir = join(root, 'run');
  appendRuntimeEvent(runDir, { runId: 'run-m7', source: 'runtime-manager', type: 'goal.received', payload: { ok: true } });
  const stale = createRuntimeLedgerHeadBinding(readRuntimeEvents(runDir));
  appendRuntimeEvent(runDir, { runId: 'run-m7', source: 'runtime-manager', type: 'run.completed', payload: { ok: true } });
  const result = runVerifier({ type: 'ledger', root, events: readRuntimeEvents(runDir), ledgerBinding: stale });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /stale evidence event count/);
});

test('M7 review custody verifier rejects model prose and self-signed review theater', () => {
  const root = tmpRoot();
  assert.equal(
    runVerifier({ type: 'review_custody', root, reviewCustody: { signed: true, custodyAttested: false, issuerTrusted: true } }).status,
    'blocked',
  );
  assert.equal(
    runVerifier({ type: 'review_custody', root, reviewCustody: { signed: true, custodyAttested: true, issuerTrusted: true } }).status,
    'supported',
  );
});

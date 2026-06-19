import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const expectedSha256 = createHash('sha256').update('real evidence').digest('hex');
  const good = runVerifier({ type: 'artifact', root, artifactRef: 'artifact.txt', expectedSha256 });
  assert.equal(good.status, 'supported');
  assertVerifierInputSensitive(
    { type: 'artifact', root, artifactRef: 'artifact.txt', expectedSha256 },
    { type: 'artifact', root, artifactRef: 'missing.txt', expectedSha256 },
  );
  const digestless = runVerifier({ type: 'artifact', root, artifactRef: 'artifact.txt' });
  assert.equal(digestless.status, 'unproven');
  assert.match(digestless.reason, /requires expectedSha256/);
});


test('G002 artifact verifier rejects symlink evidence even when the target exists outside root', () => {
  const root = tmpRoot();
  const outside = join(tmpRoot(), 'outside.txt');
  writeFileSync(outside, 'outside evidence');
  symlinkSync(outside, join(root, 'link.txt'));
  const expectedSha256 = createHash('sha256').update('outside evidence').digest('hex');
  const result = runVerifier({ type: 'artifact', root, artifactRef: 'link.txt', expectedSha256 });
  assert.equal(result.status, 'unproven');
  assert.match(result.reason, /symlinked|outside root/);
});

test('G002 test verifier is non-executing and cannot create side effects', () => {
  const root = tmpRoot();
  const result = runVerifier({
    type: 'test',
    root,
    command: ['node', '-e', "require('fs').writeFileSync('verifier-rce.txt','owned')"],
    mustInclude: ['anything'],
  });
  assert.equal(result.status, 'unproven');
  assert.match(result.reason, /non-executing/);
  assert.equal(runVerifier({ type: 'artifact', root, artifactRef: 'verifier-rce.txt', expectedSha256: 'x' }).status, 'unproven');
});



test('G012 diff verifier is non-executing and requires digest-bound status artifact', () => {
  const root = tmpRoot();
  const unproven = runVerifier({ type: 'diff', root, forbiddenChangedPaths: ['secret.txt'] });
  assert.equal(unproven.status, 'unproven');
  assert.match(unproven.reason, /non-executing/);

  const statusText = ' M safe.txt\n M secret.txt\n';
  writeFileSync(join(root, 'git-status.txt'), statusText);
  const expected = createHash('sha256').update(statusText).digest('hex');
  const blocked = runVerifier({
    type: 'diff',
    root,
    diffStatusArtifactRef: 'git-status.txt',
    diffStatusExpectedSha256: expected,
    forbiddenChangedPaths: ['secret.txt'],
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /secret\.txt/);

  const supported = runVerifier({
    type: 'diff',
    root,
    diffStatusArtifactRef: 'git-status.txt',
    diffStatusExpectedSha256: expected,
    forbiddenChangedPaths: ['other.txt'],
  });
  assert.equal(supported.status, 'supported');
});

test('G012 diff verifier catches a rename INTO a forbidden path (rename-aware parse)', () => {
  const root = tmpRoot();
  const statusText = 'R  scratch.txt -> .github/workflows/ci.yml\n';
  writeFileSync(join(root, 'git-status.txt'), statusText);
  const expected = createHash('sha256').update(statusText).digest('hex');
  const blocked = runVerifier({
    type: 'diff',
    root,
    diffStatusArtifactRef: 'git-status.txt',
    diffStatusExpectedSha256: expected,
    forbiddenChangedPaths: ['.github/workflows/ci.yml'],
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /\.github\/workflows\/ci\.yml/);
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

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertEvidenceRefsResolve, type Artifact, parseArtifactRef, recordArtifact, resolveArtifact } from './artifacts.js';

function makeRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'dominic-artifacts-'));
}

function writeRunArtifact(root: string, runId: string, relPath: string, contents: string): void {
  const absPath = path.join(root, '.agent/runs', runId, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents);
}

test('T8 recorded artifact resolves true and emits artifact ref grammar', () => {
  const root = makeRoot();
  writeRunArtifact(root, 'run-1', 'logs/verifier.log', 'verifier evidence\n');

  const artifact = recordArtifact(root, 'run-1', 'logs/verifier.log', 'log');

  assert.deepEqual(parseArtifactRef(artifact.ref), { runId: 'run-1', relPath: 'logs/verifier.log' });
  assert.equal(artifact.ref, 'artifact://run-1/logs/verifier.log');
  assert.equal(artifact.storedRelPath, '.agent/runs/run-1/logs/verifier.log');
  assert.equal(resolveArtifact(root, artifact), true);
  assert.doesNotThrow(() => assertEvidenceRefsResolve(root, [artifact]));
});

test('T8 bare non-grammar evidence string does not parse or resolve', () => {
  const root = makeRoot();
  const forged: Artifact = {
    ref: 'some-evidence',
    kind: 'log',
    sha256: '0'.repeat(64),
    storedRelPath: '.agent/runs/run-1/logs/verifier.log',
  };

  assert.equal(parseArtifactRef(forged.ref), null);
  assert.equal(resolveArtifact(root, forged), false);
  assert.throws(() => assertEvidenceRefsResolve(root, [forged]), /some-evidence/);
});

test('T8 modified stored artifact fails sha256 resolution', () => {
  const root = makeRoot();
  writeRunArtifact(root, 'run-1', 'json/result.json', '{"status":"pass"}\n');
  const artifact = recordArtifact(root, 'run-1', 'json/result.json', 'json');

  writeRunArtifact(root, 'run-1', 'json/result.json', '{"status":"forged"}\n');

  assert.equal(resolveArtifact(root, artifact), false);
});

test('T8 traversal artifact ref does not parse or resolve', () => {
  const root = makeRoot();
  const forged: Artifact = {
    ref: 'artifact://run/../../etc/passwd',
    kind: 'file',
    sha256: '0'.repeat(64),
    storedRelPath: '.agent/runs/run/../../etc/passwd',
  };

  assert.equal(parseArtifactRef(forged.ref), null);
  assert.equal(resolveArtifact(root, forged), false);
});

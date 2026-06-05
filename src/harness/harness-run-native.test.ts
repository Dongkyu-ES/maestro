import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHarnessSlice } from './harness-run.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-run-native-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'target.txt'), 'before\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

function fakeCodex(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-harness-native-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

const EDITING_FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const msg = 'fake executor edited target.txt';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-native-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
fs.writeFileSync(path.join(cwd, 'target.txt'), 'after\\n');
process.exit(0);
`;

test('T12 harness run derives native session surface from codex adapter', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({
    root,
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'native-positive',
  });

  assert.equal(report.state, 'completed');
  assert.equal(report.verifier.status, 'supported');
  assert.equal(report.nativeHarnessAssisted, true);
  assert.equal(report.unownedSurfaces.includes('native_session'), true);
});

test('T12 harness run derived native surfaces are deterministic', async () => {
  const first = await runHarnessSlice({
    root: tmpRepo(),
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'native-deterministic-a',
  });
  const second = await runHarnessSlice({
    root: tmpRepo(),
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'native-deterministic-b',
  });

  assert.deepEqual(first.unownedSurfaces, second.unownedSurfaces);
  assert.deepEqual(first.unownedSurfaces, ['native_session']);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents, validateRuntimeLedger } from '../events/ledger.js';
import { runHarnessSlice } from './harness-run.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-run-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'fake-harness-codex-'));
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
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-harness-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
fs.writeFileSync(path.join(cwd, 'target.txt'), 'after\\n');
process.exit(0);
`;

const NOOP_FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const msg = 'fake executor claims success without edits';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-harness-noop' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
process.exit(0);
`;

test('T1 harness slice completes only with digest-bound tool-effect evidence', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({
    root,
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'positive',
  });
  assert.equal(report.state, 'completed');
  assert.equal(report.nativeHarnessAssisted, true);
  assert.equal(report.unownedSurfaces.length > 0, true);
  assert.match(report.contextSha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'after\n');

  const runDir = join(root, '.agent', 'runs', 'positive');
  const events = readRuntimeEvents(runDir);
  validateRuntimeLedger(events);
  assert.equal(report.ledgerHead.event_count, events.length);
  assert.equal(events.some((event) => event.type === 'context.built' && event.payload.context_sha256 === report.contextSha256), true);
  assert.equal(events.some((event) => event.type === 'tool.execution.completed'), true);
  assert.equal(events.some((event) => event.type === 'run.completed'), true);
});

test('T1 harness slice blocks forged executor success when no git diff evidence exists', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({
    root,
    goal: 'claim completion without changing files',
    executorBin: fakeCodex(NOOP_FAKE_CODEX),
    runId: 'forgery',
  });
  assert.equal(report.state, 'blocked');
  assert.equal(report.verifier.status, 'unproven');
  assert.match(report.verifier.reason, /no tool-effect git diff evidence/);

  const runDir = join(root, '.agent', 'runs', 'forgery');
  const events = readRuntimeEvents(runDir);
  validateRuntimeLedger(events);
  const transition = events.find((event) => event.type === 'state.transitioned');
  assert.equal(transition?.payload.state, 'blocked');
  assert.equal(transition?.payload.authority, 'verifier.completed');
  assert.equal(events.some((event) => event.type === 'run.blocked'), true);
});

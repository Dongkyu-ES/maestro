import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents, validateRuntimeLedger } from '../events/ledger.js';
import { runHarnessSlice } from './harness-run.js';
import { runHooks, type HookHandler } from './hooks.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-hooks-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'fake-harness-hooks-codex-'));
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
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-harness-hooks-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
fs.writeFileSync(path.join(cwd, 'target.txt'), 'after\\n');
process.exit(0);
`;

test('T2 runHooks orders handlers by priority then id and returns first non-continue outcome', () => {
  const calls: string[] = [];
  const handlers: HookHandler[] = [
    {
      id: 'z-continue',
      event: 'BeforeToolExecution',
      priority: 10,
      run: () => {
        calls.push('z-continue');
        return { decision: 'continue', hookId: 'z-continue' };
      },
    },
    {
      id: 'b-block',
      event: 'BeforeToolExecution',
      priority: 1,
      run: () => {
        calls.push('b-block');
        return { decision: 'block', hookId: 'b-block', reason: 'first block' };
      },
    },
    {
      id: 'a-continue',
      event: 'BeforeToolExecution',
      priority: 1,
      run: () => {
        calls.push('a-continue');
        return { decision: 'continue', hookId: 'a-continue' };
      },
    },
    {
      id: 'ignored-event',
      event: 'BeforeStateTransition',
      priority: -100,
      run: () => {
        calls.push('ignored-event');
        return { decision: 'block', hookId: 'ignored-event' };
      },
    },
  ];

  const outcome = runHooks('BeforeToolExecution', handlers, { ok: true });

  assert.deepEqual(calls, ['a-continue', 'b-block']);
  assert.deepEqual(outcome, { decision: 'block', hookId: 'b-block', reason: 'first block' });
});

test('T2 BeforeToolExecution hook block prevents executor effects from being accepted as completion', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({
    root,
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'hook-blocks-tool',
    hooks: [
      {
        id: 'deny-tool-effects',
        event: 'BeforeToolExecution',
        run: () => ({ decision: 'block', hookId: 'deny-tool-effects', reason: 'policy denied tool effects' }),
      },
    ],
  });

  assert.equal(report.state, 'blocked');
  assert.equal(report.verifier.status, 'blocked');
  assert.match(report.verifier.reason, /deny-tool-effects/);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'after\n');

  const runDir = join(root, '.agent', 'runs', 'hook-blocks-tool');
  const events = readRuntimeEvents(runDir);
  validateRuntimeLedger(events);
  const transition = events.find((event) => event.type === 'state.transitioned');
  assert.equal(transition?.payload.state, 'blocked');
  assert.equal(transition?.payload.authority, 'hook:deny-tool-effects');
  assert.equal(events.some((event) => event.type === 'hook.completed' && event.payload.hook_id === 'deny-tool-effects'), true);
  assert.equal(events.some((event) => event.type === 'tool.execution.completed'), false);
  assert.equal(events.some((event) => event.type === 'verifier.completed'), false);
  assert.equal(events.some((event) => event.type === 'run.completed'), false);
  assert.equal(events.some((event) => event.type === 'run.blocked'), true);
});

test('T2 continue hook allows the same tool-effect run to complete', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({
    root,
    goal: 'edit target.txt',
    executorBin: fakeCodex(EDITING_FAKE_CODEX),
    runId: 'hook-continues-tool',
    hooks: [
      {
        id: 'allow-tool-effects',
        event: 'BeforeToolExecution',
        run: () => ({ decision: 'continue', hookId: 'allow-tool-effects' }),
      },
    ],
  });

  assert.equal(report.state, 'completed');
  assert.equal(report.verifier.status, 'supported');
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'after\n');

  const runDir = join(root, '.agent', 'runs', 'hook-continues-tool');
  const events = readRuntimeEvents(runDir);
  validateRuntimeLedger(events);
  assert.equal(events.some((event) => event.type === 'tool.execution.completed'), true);
  assert.equal(events.some((event) => event.type === 'run.completed'), true);
  assert.equal(events.some((event) => event.type === 'hook.completed'), false);
});

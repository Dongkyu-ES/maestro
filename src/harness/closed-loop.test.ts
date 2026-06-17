import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents } from '../events/ledger.js';
import { runClosedLoop } from './closed-loop.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'closed-loop-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'target.txt'), 'before\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

function fakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-closed-loop-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const prompt = args.at(-1) || '';

if (process.env.CLOSED_LOOP_EXECUTOR_MODE === 'auth') {
  process.stderr.write('Error: 401 Unauthorized - not logged in\\n');
  process.exit(1);
}

function emit(text) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-closed-loop' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
  if (out) fs.writeFileSync(out, text + '\\n');
}

if (prompt.includes('isolated adversarial harness critic')) {
  if (process.env.CLOSED_LOOP_CRITIC_MODE === 'pass') {
    emit(JSON.stringify({ met: true, theater_found: [], unmet_criteria: [], required_next: [], confidence: 0.99 }));
  } else {
    emit(JSON.stringify({ met: false, theater_found: ['executor self-claim unsupported'], unmet_criteria: ['real behavior not proven'], required_next: ['show goal behavior in evidence'], confidence: 0.9 }));
  }
  process.exit(0);
}

if (prompt.includes('isolated stall strategist')) {
  if (process.env.CLOSED_LOOP_STRATEGIST_MARKER) fs.writeFileSync(process.env.CLOSED_LOOP_STRATEGIST_MARKER, 'invoked\\n');
  emit(JSON.stringify({ new_strategy: 'try a different decomposition with explicit behavior evidence', tool_to_create: null }));
  process.exit(0);
}

if (process.env.CLOSED_LOOP_EXECUTOR_MODE === 'edit') {
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'after\\n');
  emit('executor claims done after real edit');
  process.exit(0);
}

fs.writeFileSync(path.join(cwd, 'noop.txt'), 'executor claim without goal behavior\\n');
emit('executor claims done after useless no-op change');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const next = values[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('SELF-CLAIM IGNORED: critic rejection prevents done despite executor claim', async () => {
  const root = tmpRepo();
  const report = await withEnv(
    {
      CLOSED_LOOP_EXECUTOR_MODE: 'noop',
      CLOSED_LOOP_CRITIC_MODE: 'fail',
    },
    () =>
      runClosedLoop({
        root,
        goal: 'change target.txt to after',
        acceptanceContract: 'target.txt must contain after and evidence must show it',
        maxIters: 1,
        executorBin: fakeCodex(),
      }),
  );

  assert.equal(report.status, 'blocked');
  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0]?.deterministicStatus, 'supported');
  assert.equal(report.iterations[0]?.critic.met, false);
  assert.deepEqual(report.persistent_unmet_criteria, ['real behavior not proven']);
});

test('GENUINE PASS: deterministic verifier plus isolated critic ends done', async () => {
  const root = tmpRepo();
  const report = await withEnv(
    {
      CLOSED_LOOP_EXECUTOR_MODE: 'edit',
      CLOSED_LOOP_CRITIC_MODE: 'pass',
    },
    () =>
      runClosedLoop({
        root,
        goal: 'change target.txt to after',
        acceptanceContract: 'target.txt must contain after and evidence must show it',
        maxIters: 2,
        executorBin: fakeCodex(),
      }),
  );

  assert.equal(report.status, 'done');
  assert.equal(report.iterations.length, 1);
  assert.equal(report.iterations[0]?.done, true);
  assert.equal(readFileSync(join(root, 'target.txt'), 'utf8'), 'after\n');
});

test('STALL->ESCALATE: repeated unmet criteria invokes stall strategist', async () => {
  const root = tmpRepo();
  const marker = join(tmpdir(), `closed-loop-strategist-${Date.now()}`);
  const report = await withEnv(
    {
      CLOSED_LOOP_EXECUTOR_MODE: 'noop',
      CLOSED_LOOP_CRITIC_MODE: 'fail',
      CLOSED_LOOP_STRATEGIST_MARKER: marker,
    },
    () =>
      runClosedLoop({
        root,
        goal: 'change target.txt to after',
        acceptanceContract: 'target.txt must contain after and evidence must show it',
        maxIters: 2,
        stall: 2,
        executorBin: fakeCodex(),
      }),
  );

  assert.equal(report.status, 'blocked');
  assert.equal(existsSync(marker), true);
  const events = readRuntimeEvents(report.runDir);
  assert.equal(events.some((event) => event.type === 'loop.stalled'), true);
  assert.equal(events.some((event) => event.type === 'loop.escalated'), true);
});

test('AUTH FAILURE CLASSIFIED: executor 401 ends blocked with a classified incident, no crash', async () => {
  const root = tmpRepo();
  const report = await withEnv(
    { CLOSED_LOOP_EXECUTOR_MODE: 'auth' },
    () =>
      runClosedLoop({
        root,
        goal: 'change target.txt to after',
        acceptanceContract: 'target.txt must contain after',
        maxIters: 2,
        executorBin: fakeCodex(),
      }),
  );

  assert.equal(report.status, 'blocked');
  const events = readRuntimeEvents(report.runDir);
  const errorEvent = events.find((event) => event.type === 'loop.executor_error');
  assert.ok(errorEvent, 'a loop.executor_error event must be recorded');
  assert.equal((errorEvent?.payload as { error_class?: string }).error_class, 'auth');
});

test('VERIFY EXIT GATES COMPLETION: a failing verify command blocks done even when slice + critic pass', async () => {
  const root = tmpRepo();
  const report = await withEnv(
    { CLOSED_LOOP_EXECUTOR_MODE: 'edit', CLOSED_LOOP_CRITIC_MODE: 'pass' },
    () =>
      runClosedLoop({
        root,
        goal: 'change target.txt to after',
        acceptanceContract: 'target.txt must contain after',
        maxIters: 1,
        executorBin: fakeCodex(),
        verifyCmd: 'exit 3',
      }),
  );

  assert.equal(report.status, 'blocked');
  assert.equal(report.iterations[0]?.deterministicStatus, 'supported');
  assert.equal(report.iterations[0]?.verify.exit_code, 3);
  assert.equal(report.iterations[0]?.verify.passed, false);
  assert.equal(report.iterations[0]?.done, false);
});

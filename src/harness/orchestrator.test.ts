import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents } from '../events/ledger.js';
import { readFileSync } from 'node:fs';
import { makeCliExecutor } from './compare.js';
import { reconcileWorkers, runParallelWorkers, runTaskGraph } from './orchestrator.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

// Fake codex: if the goal names a "*.txt" file, create it (a real change → verifier
// supported); otherwise emit text only (no change → unproven/blocked).
function fakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-orch-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const prompt = args.at(-1) || '';
const m = prompt.match(/write ([\\w.-]+\\.txt)(?: CONTENT (.+))?/);
if (m) fs.writeFileSync(path.join(cwd, m[1]), (m[2] || ('work by ' + m[1])) + '\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

test('FAN-OUT: parallel workers run in isolated worktrees; ledger records refs + per-worker verdicts', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });

  const report = await runParallelWorkers({
    root,
    goal: 'parallel demo',
    workers: [
      { workerId: 'alice', goal: 'write alice.txt with the result', executor },
      { workerId: 'bob', goal: 'think about it but change nothing observable', executor },
    ],
    concurrency: 2,
  });

  const alice = report.workers.find((w) => w.workerId === 'alice');
  const bob = report.workers.find((w) => w.workerId === 'bob');

  // alice made a real change → verifier supported; bob made none → blocked.
  assert.equal(alice?.state, 'completed');
  assert.equal(alice?.verifierStatus, 'supported');
  assert.ok(alice?.outputRef?.startsWith('agent://alice+'), 'alice carries an evidence ref, not raw output');
  assert.equal(bob?.state, 'blocked');
  assert.equal(report.supportedCount, 1);

  // Isolation: alice.txt exists only in alice's worktree.
  assert.equal(existsSync(join(root, '.agent', 'worktrees', 'alice', 'alice.txt')), true);
  assert.equal(existsSync(join(root, '.agent', 'worktrees', 'bob', 'alice.txt')), false);
  assert.equal(existsSync(join(root, 'alice.txt')), false);

  // Parent ledger: spawned x2, joined x2, fanin x1 — and joined payloads carry refs not raw.
  const events = readRuntimeEvents(report.parentRunDir);
  assert.equal(events.filter((e) => e.type === 'orchestration.spawned').length, 2);
  const joined = events.filter((e) => e.type === 'orchestration.joined');
  assert.equal(joined.length, 2);
  assert.equal(events.filter((e) => e.type === 'orchestration.fanin').length, 1);
  for (const e of joined) assert.ok(!('diff' in (e.payload as object)), 'joined event must not carry raw diff');
});

test('DAG: a node runs only after its deps are verifier-supported; unsupported deps skip downstream', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });

  const report = await runTaskGraph({
    root,
    goal: 'schema -> endpoints -> tests',
    concurrency: 2,
    nodes: [
      { id: 'schema', goal: 'write schema.txt', executor },
      { id: 'endpoints', goal: 'write endpoints.txt', deps: ['schema'], executor },
      { id: 'tests', goal: 'write tests.txt', deps: ['endpoints'], executor },
    ],
  });

  // All three genuinely supported, run in 3 sequential waves (chain).
  assert.equal(report.supportedCount, 3);
  assert.equal(report.waves, 3);
  assert.deepEqual(report.nodes.map((n) => n.nodeState), ['supported', 'supported', 'supported']);

  // stage.advanced waves are single-node and ordered by dependency.
  const stages = readRuntimeEvents(report.parentRunDir).filter((e) => e.type === 'orchestration.stage.advanced');
  assert.deepEqual(stages.map((e) => (e.payload as { node_ids: string[] }).node_ids), [['schema'], ['endpoints'], ['tests']]);
});

test('DAG: a blocked dep (no change) skips downstream rather than running it', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });

  const report = await runTaskGraph({
    root,
    concurrency: 2,
    nodes: [
      { id: 'base', goal: 'analyze only, change nothing', executor }, // no write → blocked
      { id: 'dependent', goal: 'write dependent.txt', deps: ['base'], executor },
    ],
  });

  const base = report.nodes.find((n) => n.workerId === 'base');
  const dependent = report.nodes.find((n) => n.workerId === 'dependent');
  assert.equal(base?.nodeState, 'blocked');
  assert.equal(dependent?.nodeState, 'skipped');
  assert.match(dependent?.skippedReason ?? '', /unsupported deps: base/);
  // downstream never spawned a worktree
  assert.equal(existsSync(join(root, '.agent', 'worktrees', 'dependent')), false);
});

test('DAG: cycles and dangling deps are rejected before any spawn', async () => {
  const root = tmpRepo();
  await assert.rejects(
    () => runTaskGraph({ root, nodes: [{ id: 'a', goal: 'x', deps: ['b'] }, { id: 'b', goal: 'y', deps: ['a'] }] }),
    /cycle/,
  );
  await assert.rejects(
    () => runTaskGraph({ root, nodes: [{ id: 'a', goal: 'x', deps: ['ghost'] }] }),
    /unknown node/,
  );
});

test('RECONCILE: non-overlapping worker changes merge into one verified tree', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const fan = await runParallelWorkers({
    root,
    workers: [
      { workerId: 'a', goal: 'write a.txt', executor },
      { workerId: 'b', goal: 'write b.txt', executor },
    ],
  });
  const order = fan.workers.map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath }));
  const recon = reconcileWorkers({ root, reconId: 'recon-ok', order });

  assert.deepEqual(recon.merged.sort(), ['a', 'b']);
  assert.equal(recon.quarantined.length, 0);
  assert.equal(readFileSync(join(recon.reconWorktree, 'a.txt'), 'utf8').includes('work'), true);
  assert.equal(readFileSync(join(recon.reconWorktree, 'b.txt'), 'utf8').includes('work'), true);
});

test('RECONCILE: a conflicting worker is quarantined, not force-merged', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const fan = await runParallelWorkers({
    root,
    workers: [
      { workerId: 'c1', goal: 'write shared.txt CONTENT line-from-c1', executor },
      { workerId: 'c2', goal: 'write shared.txt CONTENT line-from-c2', executor },
    ],
  });
  const order = fan.workers.map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath }));
  const recon = reconcileWorkers({ root, reconId: 'recon-conflict', order });

  assert.equal(recon.merged.length, 1);
  assert.equal(recon.quarantined.length, 1);
  assert.match(recon.quarantined[0].reason, /merge conflict/);
});

test('RECONCILE: a merge that breaks the verify command is reverted + quarantined', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const fan = await runParallelWorkers({ root, workers: [{ workerId: 'v1', goal: 'write ok.txt', executor }] });
  const order = fan.workers.map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath }));
  // verify fails once ok.txt is present → the merge must be reverted and the worker quarantined.
  const recon = reconcileWorkers({ root, reconId: 'recon-verify', order, verifyCmd: 'test ! -f ok.txt' });

  assert.equal(recon.merged.length, 0);
  assert.equal(recon.quarantined.length, 1);
  assert.match(recon.quarantined[0].reason, /verify failed/);
  assert.equal(existsSync(join(recon.reconWorktree, 'ok.txt')), false); // reverted
});

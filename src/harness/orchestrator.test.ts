import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents } from '../events/ledger.js';
import { makeCliExecutor } from './compare.js';
import { runParallelWorkers } from './orchestrator.js';

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
const m = prompt.match(/write ([\\w.-]+\\.txt)/);
if (m) fs.writeFileSync(path.join(cwd, m[1]), 'work by ' + m[1] + '\\n');
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

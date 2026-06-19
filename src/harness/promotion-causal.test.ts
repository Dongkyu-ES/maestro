import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeCliExecutor } from './compare.js';
import { verifyPromotionCausal } from './promotion-causal.js';

const PROMOTION_MARKER = 'PROMOTION_MARKER_CAUSAL_ON';
const IGNORED_FILLER = 'IGNORED_FILLER_CAUSAL_OFF!';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'promotion-causal-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'fake-promotion-causal-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

const MARKER_DECISION_FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const prompt = args.at(-1) || '';
const decision = prompt.includes('${PROMOTION_MARKER}') ? 'promoted' : 'baseline';
const msg = 'decision=' + decision;
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-promotion-causal' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
process.exit(0);
`;

const UNSTABLE_FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const counterPath = path.join(path.dirname(process.argv[1]), 'counter.txt');
const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;
fs.writeFileSync(counterPath, String(count));
const prompt = args.at(-1) || '';
const decision = prompt.includes('${PROMOTION_MARKER}') ? 'promoted' : 'baseline-' + count;
const msg = 'decision=' + decision;
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-promotion-causal-unstable' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
process.exit(0);
`;

test('T4 promotion causal verifier proves promotion-only context changes executor decision', async () => {
  const root = tmpRepo();
  const report = await verifyPromotionCausal({
    root,
    goal: 'decide based on causal promotion context',
    promotion: { id: 'known-marker', text: PROMOTION_MARKER },
    executorBin: fakeCodex(MARKER_DECISION_FAKE_CODEX),
  });

  assert.equal(report.causal, true);
  assert.equal(report.baselineDecision, 'baseline');
  assert.equal(report.controlDecision, 'baseline');
  assert.equal(report.treatmentDecision, 'promoted');
  assert.equal(report.contextDeltaIsPromotionOnly, true);
  assert.equal(report.baselineContextSha256, report.controlContextSha256);
  assert.notEqual(report.controlContextSha256, report.treatmentContextSha256);
  assert.equal(existsSync(join(root, '.agent', 'hard-gates', 'promotion-causal-verification.json')), true);
});

test('T4 promotion causal verifier rejects equal-length ignored filler as non-causal', async () => {
  assert.equal(IGNORED_FILLER.length, PROMOTION_MARKER.length);
  const root = tmpRepo();
  const report = await verifyPromotionCausal({
    root,
    goal: 'decide based on causal promotion context',
    promotion: { id: 'ignored-filler', text: IGNORED_FILLER },
    executorBin: fakeCodex(MARKER_DECISION_FAKE_CODEX),
  });

  assert.equal(report.causal, false);
  assert.equal(report.baselineDecision, 'baseline');
  assert.equal(report.controlDecision, 'baseline');
  assert.equal(report.treatmentDecision, 'baseline');
  assert.equal(report.contextDeltaIsPromotionOnly, true);
});

test('T4 promotion causal verifier accepts a pluggable executor (executor pass-through)', async () => {
  // Guards the `executor` seam (used by `warden promotion verify-causal --executor claude`): a
  // HarnessExecutor passed directly must drive all three arms, same as `executorBin`.
  const root = tmpRepo();
  const executor = makeCliExecutor({
    name: 'fake-pluggable',
    bin: fakeCodex(MARKER_DECISION_FAKE_CODEX),
    buildArgs: (p) => ['exec', p],
  });
  const report = await verifyPromotionCausal({
    root,
    goal: 'decide based on causal promotion context',
    promotion: { id: 'known-marker', text: PROMOTION_MARKER },
    executor,
  });

  assert.equal(report.causal, true);
  assert.equal(report.baselineDecision, report.controlDecision);
  assert.equal(report.treatmentDecision, 'promoted');
  assert.equal(report.contextDeltaIsPromotionOnly, true);
});

test('T4 promotion causal verifier rejects unstable baseline and control decisions', async () => {
  const root = tmpRepo();
  const report = await verifyPromotionCausal({
    root,
    goal: 'decide based on causal promotion context',
    promotion: { id: 'known-marker', text: PROMOTION_MARKER },
    executorBin: fakeCodex(UNSTABLE_FAKE_CODEX),
  });

  assert.equal(report.causal, false);
  assert.notEqual(report.baselineDecision, report.controlDecision);
  assert.equal(report.treatmentDecision, 'promoted');
  assert.equal(report.contextDeltaIsPromotionOnly, true);
});

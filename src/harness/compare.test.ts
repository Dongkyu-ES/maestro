import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderComparisonMarkdown, runHarnessComparison } from './compare.js';

const SECRET = 'sk-proj-COMPARE000011112222abcd';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'compare-test-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'target.txt'), 'before\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

function fakeCodex(scenario: 'leak' | 'auth'): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-compare-test-codex-'));
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
const SECRET = ${JSON.stringify(SECRET)};
const SCENARIO = ${JSON.stringify(scenario)};
function emit(text) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } }) + '\\n');
  if (out) fs.writeFileSync(out, text + '\\n');
}
if (SCENARIO === 'auth') { process.stderr.write('Error: 401 Unauthorized\\n'); process.exit(1); }
if (prompt.includes('isolated adversarial harness critic')) {
  emit(JSON.stringify({ met: false, theater_found: ['no goal behavior'], unmet_criteria: ['real behavior not proven'], required_next: ['edit target.txt'], confidence: 0.9, drift_suspected: false }));
  process.exit(0);
}
if (prompt.includes('isolated stall strategist')) {
  emit(JSON.stringify({ new_strategy: 'edit target.txt directly', tool_to_create: null }));
  process.exit(0);
}
fs.writeFileSync(path.join(cwd, 'noop.txt'), 'token=' + SECRET + '\\n');
emit('claims done after no-op');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

test('COMPARE: dh layers redact + block self-claims that the raw lane lets through', async () => {
  const report = await runHarnessComparison({
    root: tmpRepo(),
    goal: 'change target.txt to after',
    acceptanceContract: 'target.txt must contain after; evidence must show behavior',
    executorBin: fakeCodex('leak'),
    verifyCmd: 'test -f target.txt',
    maxIters: 2,
  });
  const raw = report.lanes.find((l) => l.name === 'raw');
  const slice = report.lanes.find((l) => l.name === 'dh-slice');
  const loop = report.lanes.find((l) => l.name === 'dh-loop');

  assert.equal(raw?.metrics.secretLeaked, true);
  assert.equal(slice?.metrics.secretLeaked, false);
  assert.equal(loop?.metrics.secretLeaked, false);
  assert.equal(raw?.metrics.selfClaimBlocked, false);
  assert.equal(loop?.metrics.selfClaimBlocked, true);
  assert.equal(loop?.metrics.coverageChecked, true);
  assert.ok(renderComparisonMarkdown(report).includes('secret leaked'));
});

test('COMPARE: dh-loop classifies an auth failure instead of crashing', async () => {
  const report = await runHarnessComparison({
    root: tmpRepo(),
    goal: 'change target.txt to after',
    acceptanceContract: 'target.txt must contain after',
    executorBin: fakeCodex('auth'),
    maxIters: 2,
  });
  const loop = report.lanes.find((l) => l.name === 'dh-loop');
  assert.equal(loop?.metrics.exitClassified, true);
  assert.equal(loop?.metrics.state, 'blocked');
});

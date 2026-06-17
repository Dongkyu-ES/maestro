import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHarnessSlice } from './harness-run.js';

const SECRET = 'sk-proj-REDACTME0000111122223333abcd';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'redaction-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', 'seed.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'base'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

function fakeCodexPlantingSecret(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-redaction-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
fs.writeFileSync(path.join(cwd, 'config.txt'), 'api_key=' + ${JSON.stringify(SECRET)} + '\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'token is ' + ${JSON.stringify(SECRET)} } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

test('REDACTION: persisted evidence sinks contain no raw secret and the diff verifier still passes', async () => {
  const root = tmpRepo();
  const report = await runHarnessSlice({ root, goal: 'write a config file', executorBin: fakeCodexPlantingSecret() });

  const runDir = join(root, report.runDir);
  const diff = readFileSync(join(runDir, 'tool-git-diff.patch'), 'utf8');
  const status = readFileSync(join(runDir, 'tool-git-status.txt'), 'utf8');
  const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
  const codexEvents = readFileSync(join(runDir, 'codex-events.jsonl'), 'utf8');

  assert.equal(diff.includes(SECRET), false, 'diff must not contain the raw secret');
  assert.ok(diff.includes('[REDACTED]'), 'diff must show the redaction marker');
  assert.equal(status.includes(SECRET), false, 'status must not contain the raw secret');
  assert.equal(events.includes(SECRET), false, 'ledger events must not contain the raw secret');
  assert.equal(codexEvents.includes(SECRET), false, 'codex events must not contain the raw secret');

  // Redaction must not break the digest-bound verifier: the change is still recognized.
  assert.equal(report.state, 'completed');
  assert.equal(report.verifier.status, 'supported');
});

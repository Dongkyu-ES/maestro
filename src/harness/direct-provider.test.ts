import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type DirectProviderTransport, makeDirectProviderExecutor, parseFileDirectives } from './direct-provider.js';
import { runHarnessSlice } from './harness-run.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'direct-provider-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'target.txt'), 'before\n');
  execFileSync('git', ['add', 'target.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fixedTransport(response: { text: string; refused?: boolean }): DirectProviderTransport {
  return async () => response;
}

test('parseFileDirectives extracts FILE blocks and ignores surrounding prose', () => {
  const text = 'rationale here\n<<<FILE a.txt\nhello\n>>>FILE\nmore prose\n<<<FILE dir/b.txt\nline1\nline2\n>>>FILE';
  assert.deepEqual(parseFileDirectives(text), [
    { path: 'a.txt', content: 'hello' },
    { path: 'dir/b.txt', content: 'line1\nline2' },
  ]);
  assert.deepEqual(parseFileDirectives('no blocks here'), []);
});

test('direct-provider run produces a real diff the SAME verifier supports, labeled NOT native-harness-assisted', async () => {
  const root = tmpRepo();
  const executor = makeDirectProviderExecutor({
    name: 'anthropic-direct',
    transport: fixedTransport({ text: 'done.\n<<<FILE target.txt\nafter the direct edit\n>>>FILE' }),
  });

  const report = await runHarnessSlice({ root, goal: 'edit target.txt', executorLabel: 'anthropic-direct', executor });

  // Same evidence contract as the CLI executors: a real git diff → verifier supported → completed.
  assert.equal(report.state, 'completed');
  assert.equal(report.verifier.status, 'supported');
  // Product owns the single-turn apply loop, so this is honestly NOT native-harness-assisted.
  assert.equal(report.nativeHarnessAssisted, false);
});

test('direct label stays native-harness-assisted=false even when the repo has CLAUDE.md/AGENTS.md', async () => {
  const root = tmpRepo();
  // A direct turn never loads these — they must not flip the product-owned label.
  writeFileSync(join(root, 'CLAUDE.md'), '# instructions\n');
  writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add instruction files'], { cwd: root, stdio: 'ignore' });

  const executor = makeDirectProviderExecutor({
    name: 'anthropic-direct',
    // Even a transcript that name-drops native surfaces must not flip the label.
    transport: fixedTransport({ text: 'I will not read CLAUDE.md.\n<<<FILE target.txt\nafter\n>>>FILE' }),
  });
  const report = await runHarnessSlice({ root, goal: 'edit target.txt', executorLabel: 'anthropic-direct', executor });

  assert.equal(report.state, 'completed');
  assert.equal(report.nativeHarnessAssisted, false);
});

test('a direct edit cannot write into .git or .agent (no evidence forgery / repo corruption)', async () => {
  const root = tmpRepo();
  const executor = makeDirectProviderExecutor({
    name: 'anthropic-direct',
    transport: fixedTransport({
      text: '<<<FILE .agent/forged.json\n{"completion":"passed"}\n>>>FILE\n<<<FILE .git/hooks/pre-commit\nrm -rf /\n>>>FILE\n<<<FILE ok.txt\nfine\n>>>FILE',
    }),
  });

  await runHarnessSlice({ root, goal: 'try to forge evidence', executorLabel: 'anthropic-direct', executor });

  assert.equal(existsSync(join(root, 'ok.txt')), true);
  assert.equal(existsSync(join(root, '.agent', 'forged.json')), false);
  assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
});

test('a refusal yields no edits → no diff → the verifier does not report a forged success', async () => {
  const root = tmpRepo();
  const executor = makeDirectProviderExecutor({
    name: 'anthropic-direct',
    transport: fixedTransport({ text: 'REFUSE: not enough context', refused: true }),
  });

  const report = await runHarnessSlice({ root, goal: 'edit target.txt', executorLabel: 'anthropic-direct', executor });

  assert.notEqual(report.state, 'completed');
  assert.notEqual(report.verifier.status, 'supported');
  assert.equal(report.nativeHarnessAssisted, false);
});

test('directives with unsafe paths are skipped, never written outside cwd', async () => {
  const root = tmpRepo();
  const executor = makeDirectProviderExecutor({
    name: 'anthropic-direct',
    transport: fixedTransport({ text: '<<<FILE ../escape.txt\nmalicious\n>>>FILE\n<<<FILE safe.txt\nok\n>>>FILE' }),
  });

  await runHarnessSlice({ root, goal: 'try to escape', executorLabel: 'anthropic-direct', executor });

  assert.equal(existsSync(join(root, 'safe.txt')), true);
  // The traversal path was skipped — nothing written to the parent of the repo.
  assert.equal(existsSync(join(root, '..', 'escape.txt')), false);
});

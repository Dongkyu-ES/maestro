import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { storePhaseArtifact } from './evidence-store.js';
import type { HarnessExecutor } from './harness-run.js';
import { runIsolatedWorker } from './orchestrator.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-inputs-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fakeExecutor(writeFile: string, assertInput?: { path: string; content: string }): HarnessExecutor {
  return async (opts) => {
    if (assertInput) {
      assert.equal(readFileSync(join(opts.cwd, assertInput.path), 'utf8'), assertInput.content);
    }
    writeFileSync(join(opts.cwd, writeFile), 'worker output\n');
    return {
      label: opts.label ?? 'executor',
      cwd: opts.cwd,
      command: 'fake executor',
      started_at: new Date(0).toISOString(),
      ended_at: new Date(0).toISOString(),
      exit_code: 0,
      signal: null,
      timed_out: false,
      cancelled: false,
      last_message: 'done',
      event_count: 1,
      stdout: '',
      stderr: '',
    };
  };
}

test('isolated worker materializes verified inputRefs into the worktree before executor runs', async () => {
  const root = tmpRepo();
  const sourceFile = join(root, 'research-output.txt');
  const inputContent = 'RESEARCH_OUTPUT';
  writeFileSync(sourceFile, inputContent);
  const ref = storePhaseArtifact({
    root,
    skillRunId: 'run-inputs',
    phase: 'research',
    sourceFile,
    relativePath: 'handoff/research-output.txt',
  });

  const result = await runIsolatedWorker({
    root,
    workerId: 'execute',
    goal: 'consume research output',
    executor: fakeExecutor('execute-output.txt', { path: ref.relativePath, content: inputContent }),
    inputRefs: [ref],
  });

  assert.equal(result.state, 'completed');
  assert.equal(readFileSync(join(result.worktreePath, ref.relativePath), 'utf8'), inputContent);
  assert.equal(existsSync(join(result.worktreePath, 'execute-output.txt')), true);
});

test('isolated worker without inputRefs preserves no-input behavior', async () => {
  const root = tmpRepo();

  const result = await runIsolatedWorker({
    root,
    workerId: 'execute-no-input',
    goal: 'write output without materialized inputs',
    executor: fakeExecutor('no-input-output.txt'),
  });

  assert.equal(result.state, 'completed');
  assert.equal(existsSync(join(result.worktreePath, 'no-input-output.txt')), true);
  assert.equal(existsSync(join(result.worktreePath, 'handoff', 'research-output.txt')), false);
});

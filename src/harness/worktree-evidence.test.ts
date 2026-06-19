import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureWorktreeDiff, reconstructAndRun } from './worktree-evidence.js';

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-evidence-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  return root;
}
function commitAll(root: string, msg: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root });
}

// The load-bearing #1 claim: the skill path can now grade MULTI-FILE repo work, not just one
// self-contained artifact. lib.mjs and main.mjs must BOTH be correct for the operator test to pass.
test('worktree-evidence: a multi-file change is captured and graded by reconstruction', () => {
  const root = initRepo();
  writeFileSync(join(root, 'lib.mjs'), 'export const x = 1;\n');
  writeFileSync(join(root, 'main.mjs'), "import { x } from './lib.mjs';\nexport const out = x * 2;\n");
  commitAll(root, 'base');

  // "Executor" edits BOTH files: x=5 and *3 → out should be 15.
  writeFileSync(join(root, 'lib.mjs'), 'export const x = 5;\n');
  writeFileSync(join(root, 'main.mjs'), "import { x } from './lib.mjs';\nexport const out = x * 3;\n");

  const evidence = captureWorktreeDiff(root);
  assert.deepEqual(evidence.changedFiles.sort(), ['lib.mjs', 'main.mjs']);

  const check = { path: 'check.mjs', content: "import { out } from './main.mjs';\nif (out !== 15) { console.error('got', out); process.exit(1); }\n" };
  const result = reconstructAndRun({ root, baseCommit: evidence.baseCommit, patch: evidence.patch, testFiles: [check], command: ['node', 'check.mjs'] });
  assert.equal(result.ran, true);
  assert.equal(result.passed, true, result.reason);
});

// Forgery: an executor that edits its own grader is overwritten — testFiles overlay LAST.
test('worktree-evidence: executor edit to the grader is overwritten by the operator testFile (overlay last)', () => {
  const root = initRepo();
  writeFileSync(join(root, 'lib.mjs'), 'export const x = 1;\n');
  writeFileSync(join(root, 'check.mjs'), 'process.exit(1);\n'); // a placeholder grader in the repo
  commitAll(root, 'base');

  // Executor does NOT fix lib (x stays 1) but tries to neuter the grader to always pass.
  writeFileSync(join(root, 'check.mjs'), 'process.exit(0);\n');
  const evidence = captureWorktreeDiff(root);

  // The operator's REAL grader requires x === 99; overlaid last, it beats the executor's check.mjs edit.
  const realCheck = { path: 'check.mjs', content: "import { x } from './lib.mjs';\nprocess.exit(x === 99 ? 0 : 1);\n" };
  const result = reconstructAndRun({ root, baseCommit: evidence.baseCommit, patch: evidence.patch, testFiles: [realCheck], command: ['node', 'check.mjs'] });
  assert.equal(result.passed, false, 'executor cannot pass by editing the grader it is judged by');
});

test('worktree-evidence: an unreachable base commit fails closed (never a silent pass)', () => {
  const root = initRepo();
  writeFileSync(join(root, 'a.txt'), 'a\n');
  commitAll(root, 'base');
  const result = reconstructAndRun({ root, baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', patch: '', testFiles: [], command: ['node', '-e', 'process.exit(0)'] });
  assert.equal(result.ran, false);
  assert.equal(result.passed, false);
  assert.match(result.reason, /not reachable/);
});

test('worktree-evidence: a patch that does not apply onto the base fails closed', () => {
  const root = initRepo();
  writeFileSync(join(root, 'a.txt'), 'original\n');
  commitAll(root, 'base');
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const bogusPatch = 'diff --git a/a.txt b/a.txt\nindex 0000000..1111111 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-NONEXISTENT CONTEXT\n+changed\n';
  const result = reconstructAndRun({ root, baseCommit, patch: bogusPatch, testFiles: [], command: ['node', '-e', 'process.exit(0)'] });
  assert.equal(result.ran, false);
  assert.match(result.reason, /did not apply/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask, collectRun, createRun, extractFilesChanged, initProject, isSecretPath, listTasks, renderRun, safeJoin } from './core.js';

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# tmp\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

test('init, task, basic run lifecycle creates v0 artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  initProject(dir);
  const task = addTask('smoke task', dir);
  assert.equal(listTasks(dir).length, 1);
  const run = createRun(task.id, {}, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'completed');
  for (const artifact of ['run.yaml', 'task.md', 'context.md', 'prompt.md', 'baseline-status.txt', 'baseline-diff.patch', 'collect-status.txt', 'collect-diff.patch', 'diff.patch', 'result.md', 'review.md', 'next-actions.md']) {
    assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, artifact)), true, artifact);
  }
});

test('roles mode creates and preserves v1 artifacts during collect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  const task = addTask('roles task', dir);
  const run = createRun(task.id, { mode: 'roles' }, dir);
  const outputPath = join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md');
  writeFileSync(outputPath, '# Worker Output\n\n## Files Changed\n- src/real.ts\n');
  collectRun(run.id, dir);
  assert.match(readFileSync(outputPath, 'utf8'), /src\/real\.ts/);
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'manager-plan.md')), true);
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml')), true);
});

test('multi mode creates physical worktrees, bounds workers, and reports conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 9 }, dir);
  assert.equal(run.max_workers, 3);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  const humanSynthesis = join(dir, '.agent', 'runs', run.id, 'synthesis.md');
  const humanConflict = join(dir, '.agent', 'runs', run.id, 'conflict-report.md');
  writeFileSync(humanSynthesis, 'KEEP_ME_SYNTHESIS');
  writeFileSync(humanConflict, 'KEEP_ME_CONFLICT');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- src/shared.ts\n');
  writeFileSync(join(base, 'worker-002.md'), '# Worker Output\n\n## Files Changed\n- src/shared.ts\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'), /Status: blocked/);
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'), /src\/shared\.ts/);
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'review.md'), 'utf8'), /blocked/);
  assert.equal(readFileSync(humanSynthesis, 'utf8'), 'KEEP_ME_SYNTHESIS');
  assert.equal(readFileSync(humanConflict, 'utf8'), 'KEEP_ME_CONFLICT');
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  assert.doesNotMatch(order, /worktree_unavailable/);
});

test('multi mode reports clear when worker changed files are disjoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi clear task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  const order1 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const order2 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-002.yaml'), 'utf8');
  const ws1 = order1.match(/isolated_workspace: \"([^\"]+)\"/)![1];
  const ws2 = order2.match(/isolated_workspace: \"([^\"]+)\"/)![1];
  writeFileSync(join(ws1, 'src-a.txt'), 'worker 1');
  writeFileSync(join(ws2, 'src-b.txt'), 'worker 2');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- src-a.txt\n');
  writeFileSync(join(base, 'worker-002.md'), '# Worker Output\n\n## Files Changed\n- src-b.txt\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'completed');
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'), /Status: clear/);
});

test('multi mode detects actual worktree conflicts even when worker output omits files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi actual conflict task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const order1 = readFileSync(join(runDir, 'work-orders', 'worker-001.yaml'), 'utf8');
  const order2 = readFileSync(join(runDir, 'work-orders', 'worker-002.yaml'), 'utf8');
  const ws1 = order1.match(/isolated_workspace: "([^"]+)"/)![1];
  const ws2 = order2.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws1, 'shared.txt'), 'worker 1');
  writeFileSync(join(ws2, 'shared.txt'), 'worker 2');
  writeFileSync(join(runDir, 'worker-outputs', 'worker-001.md'), '# Worker Output\n\n## Files Changed\n\n## Risks\n');
  writeFileSync(join(runDir, 'worker-outputs', 'worker-002.md'), '# Worker Output\n\n## Files Changed\n\n## Risks\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  const report = readFileSync(join(runDir, 'conflict-report.generated.md'), 'utf8');
  assert.match(report, /Status: blocked/);
  assert.match(report, /shared\.txt/);
  assert.match(report, /actual worktree changes not declared/);
});

test('multi mode blocks stale declared files absent from actual worktree diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi stale declaration task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'worker-outputs', 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- src/stale.ts\n\n## Risks\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  const report = readFileSync(join(runDir, 'conflict-report.generated.md'), 'utf8');
  assert.match(report, /Status: blocked/);
  assert.match(report, /declared files not present in worktree diff/);
});

test('multi mode blocks denied paths from worker outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi denied task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- .env\n');
  collectRun(run.id, dir);
  const report = readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8');
  assert.match(report, /Status: blocked/);
  assert.match(report, /Denied Paths/);
});

test('extractFilesChanged reads the Files Changed section only', () => {
  assert.deepEqual(extractFilesChanged('# Worker Output\n\n## Files Changed\n- src/a.ts\n- `src/b.ts`\n\n## Risks\n- src/nope.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(extractFilesChanged('# Worker Output\n\n## Files Changed\n\n## Risks\n'), []);
});

test('run viewer includes generated v2 evidence files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('viewer evidence task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  collectRun(run.id, dir);
  const html = renderRun(run.id, dir);
  assert.match(html, /synthesis\.generated\.md/);
  assert.match(html, /conflict-report\.generated\.md/);
});

test('secret path detection and safeJoin reject unsafe paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  initProject(dir);
  assert.equal(isSecretPath('.env'), true);
  assert.equal(isSecretPath('nested/id_rsa'), true);
  assert.equal(isSecretPath('src/index.ts'), false);
  assert.throws(() => safeJoin(dir, '..', 'escape.txt'), /escapes project root/);
  assert.throws(() => safeJoin(dir, '.env'), /refusing secret path/);
});

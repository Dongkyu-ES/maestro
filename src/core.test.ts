import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  addProject,
  addTask,
  applyApprovedPromotion,
  applyApprovedProposal,
  cancelRun,
  collectRun,
  createApproval,
  createRun,
  extractFilesChanged,
  initProject,
  isSecretPath,
  listApprovals,
  listPromotions,
  listProjects,
  listTasks,
  loadIndex,
  proposeApply,
  reconcileRuns,
  redact,
  resolveApproval,
  resolvePromotion,
  safeJoin,
  startRun,
  updateTask,
} from './core.js';
import { renderHtml, renderRun } from './view.js';

function currentReviewInputHashForTest(dir = process.cwd()): string {
  const digest = createHash('sha256');
  for (const rel of [
    'src/core.ts',
    'src/cli.ts',
    'src/core.test.ts',
    'scripts/live-integration-smoke.mjs',
    'docs/milestones/HARD_COMPLETION_GATES.md',
    'docs/milestones/FULL_PRODUCT_ROADMAP.md',
    'docs/milestones/DOGFOOD_REPORT.md',
  ]) {
    const fp = join(dir, rel);
    digest.update(rel);
    digest.update(existsSync(fp) ? readFileSync(fp) : 'missing');
  }
  return digest.digest('hex');
}

function writePassingReviewGate(dir = process.cwd()): void {
  const reviewDir = join(dir, '.agent', 'review-gates');
  const notificationDir = join(reviewDir, 'subagent-notifications');
  mkdirSync(notificationDir, { recursive: true });
  const reviewerArtifact = join(reviewDir, 'code-reviewer.md');
  const architectArtifact = join(reviewDir, 'architect.md');
  const reviewerId = '019e0000-0000-7000-8000-000000000001';
  const architectId = '019e0000-0000-7000-8000-000000000002';
  const reviewerText =
    'code-reviewer independent review\nRecommendation: APPROVE\nAgent: 019e0000-0000-7000-8000-000000000001\nEvidence: reviewed current diff, hard gate artifacts, malformed process handling, stale reconciliation behavior, live integration smoke, and provenance checks with no remaining blockers. Commands: npm test; scripts/live-integration-smoke.mjs.\n';
  const architectText =
    'architect independent review\nArchitectural Status: CLEAR\nAgent: 019e0000-0000-7000-8000-000000000002\nEvidence: reviewed current diff, attestation boundary, local web runtime contract, reconciliation artifact, independent review provenance, and product ceiling behavior with no architectural blockers. Commands: npm test; quality gate.\n';
  writeFileSync(reviewerArtifact, reviewerText);
  writeFileSync(architectArtifact, architectText);
  writeFileSync(
    join(notificationDir, `${reviewerId}.json`),
    JSON.stringify({ agent_path: reviewerId, status: { completed: reviewerText } }, null, 2),
  );
  writeFileSync(
    join(notificationDir, `${architectId}.json`),
    JSON.stringify({ agent_path: architectId, status: { completed: architectText } }, null, 2),
  );
  const inputHash = currentReviewInputHashForTest(dir);
  writeFileSync(
    join(dir, '.agent', 'independent-review-gate.json'),
    JSON.stringify(
      {
        status: 'PASS',
        input_sha256: inputHash,
        codeReview: {
          recommendation: 'APPROVE',
          architectStatus: 'CLEAR',
          independentReview: {
            codeReviewer: {
              agentRole: 'code-reviewer',
              agent_id: reviewerId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: '2026-06-01T00:00:00.000Z',
              reviewed_input_sha256: inputHash,
              artifact_path: '.agent/review-gates/code-reviewer.md',
              artifact_sha256: createHash('sha256').update(reviewerText).digest('hex'),
              notification_path: `.agent/review-gates/subagent-notifications/${reviewerId}.json`,
              commands: ['npm test', 'scripts/live-integration-smoke.mjs'],
              evidence: 'artifact-backed approve',
            },
            architect: {
              agentRole: 'architect',
              agent_id: architectId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: '2026-06-01T00:00:00.000Z',
              reviewed_input_sha256: inputHash,
              artifact_path: '.agent/review-gates/architect.md',
              artifact_sha256: createHash('sha256').update(architectText).digest('hex'),
              notification_path: `.agent/review-gates/subagent-notifications/${architectId}.json`,
              commands: ['npm test', 'node dist/cli.js quality gate --write'],
              evidence: 'artifact-backed clear',
            },
          },
        },
      },
      null,
      2,
    ),
  );
}

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# tmp\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
}

async function startForEvidence(run: { id: string }, dir: string): Promise<void> {
  const command = 'node -e "console.log(process.env.WORKER_ID || process.env.ROLE || "ok")"';
  const started = await startRun(run.id, { command, timeoutMs: 5000 }, dir);
  if (started.status === 'awaiting_approval') {
    const approval = listApprovals(dir).find(
      (a) => a.run_id === run.id && a.type === 'shell_mutation' && a.status === 'requested',
    );
    assert.ok(approval);
    resolveApproval(approval.id, 'approved', dir);
    await startRun(run.id, { command, timeoutMs: 5000 }, dir);
  }
}

async function approveShellMutation(run: { id: string }, dir: string, command: string): Promise<void> {
  await startRun(run.id, { command, timeoutMs: 5000 }, dir);
  const approval = listApprovals(dir).find(
    (a) => a.run_id === run.id && a.type === 'shell_mutation' && a.status === 'requested',
  );
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
}

test('init, task, basic run lifecycle creates v0 artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('smoke task', dir);
  assert.equal(listTasks(dir).length, 1);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'completed');
  for (const artifact of [
    'run.yaml',
    'task.md',
    'context.md',
    'prompt.md',
    'baseline-status.txt',
    'baseline-diff.patch',
    'collect-status.txt',
    'collect-diff.patch',
    'diff.patch',
    'result.md',
    'review.md',
    'next-actions.md',
  ]) {
    assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, artifact)), true, artifact);
  }
});

test('promotion engine classifies a passing run into a memory candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('passing task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.decision, 'pass');
  const promotions = listPromotions(dir).filter((p) => p.run_id === run.id);
  const memory = promotions.find((p) => p.target_type === 'memory');
  assert.ok(memory, 'passing run yields a memory candidate');
  assert.equal(memory!.status, 'proposed');
  assert.equal(memory!.target_path, '.agent/memory/project-facts.md');
  assert.equal(existsSync(memory!.proposal_path), true);
  // A clean pass must not spam policy/agent_instruction guards.
  assert.equal(
    promotions.some((p) => p.target_type === 'policy' || p.target_type === 'agent_instruction'),
    false,
  );
});

test('promotion engine classifies a blocked run into policy and agent_instruction candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('blocked task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- src/shared.ts\n');
  writeFileSync(join(base, 'worker-002.md'), '# Worker Output\n\n## Files Changed\n- src/shared.ts\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.decision, 'blocked');
  const promotions = listPromotions(dir).filter((p) => p.run_id === run.id);
  assert.ok(
    promotions.some((p) => p.target_type === 'policy'),
    'blocked run with System Patch Suggestions yields a policy candidate',
  );
  assert.ok(
    promotions.some((p) => p.target_type === 'agent_instruction'),
    'blocked run yields an agent_instruction candidate',
  );
  assert.ok(promotions.every((p) => p.status === 'proposed'));
});

test('promotion engine classifies a multi run into a workflow candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('workflow task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  const order1 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const order2 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-002.yaml'), 'utf8');
  const ws1 = order1.match(/isolated_workspace: "([^"]+)"/)![1];
  const ws2 = order2.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws1, 'wf-a.txt'), 'worker 1');
  writeFileSync(join(ws2, 'wf-b.txt'), 'worker 2');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- wf-a.txt\n');
  writeFileSync(join(base, 'worker-002.md'), '# Worker Output\n\n## Files Changed\n- wf-b.txt\n');
  collectRun(run.id, dir);
  const promotions = listPromotions(dir).filter((p) => p.run_id === run.id);
  assert.ok(
    promotions.some((p) => p.target_type === 'workflow'),
    'multi run with a scheduler/work-orders yields a workflow candidate',
  );
});

test('applyApprovedPromotion writes the target artifact and sets status applied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('apply memory task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  collectRun(run.id, dir);
  const memory = listPromotions(dir).find((p) => p.run_id === run.id && p.target_type === 'memory');
  assert.ok(memory);
  resolvePromotion(memory!.id, 'approved', dir);
  const applied = applyApprovedPromotion(memory!.id, dir);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied_path, '.agent/memory/project-facts.md');
  const factsPath = join(dir, '.agent', 'memory', 'project-facts.md');
  assert.equal(existsSync(factsPath), true);
  assert.match(readFileSync(factsPath, 'utf8'), new RegExp(`<!-- promotion:${memory!.id} -->`));
  // Idempotent: re-applying is a safe no-op and does not duplicate content.
  const before = readFileSync(factsPath, 'utf8');
  const again = applyApprovedPromotion(memory!.id, dir);
  assert.equal(again.status, 'applied');
  assert.equal(readFileSync(factsPath, 'utf8'), before);
});

test('applyApprovedPromotion throws when the promotion is only proposed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('proposed only task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  collectRun(run.id, dir);
  const memory = listPromotions(dir).find((p) => p.run_id === run.id && p.target_type === 'memory');
  assert.ok(memory);
  assert.equal(memory!.status, 'proposed');
  assert.throws(() => applyApprovedPromotion(memory!.id, dir), /not approved/);
});

test('a rejected promotion cannot be applied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('rejected task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  collectRun(run.id, dir);
  const memory = listPromotions(dir).find((p) => p.run_id === run.id && p.target_type === 'memory');
  assert.ok(memory);
  const rejected = resolvePromotion(memory!.id, 'rejected', dir);
  assert.equal(rejected.status, 'rejected');
  assert.throws(() => applyApprovedPromotion(memory!.id, dir), /not approved/);
  assert.equal(existsSync(join(dir, '.agent', 'memory', 'project-facts.md')), false);
});

test('roles mode creates and preserves v1 artifacts during collect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  const task = addTask('roles task', dir);
  const run = createRun(task.id, { mode: 'roles' }, dir);
  const outputPath = join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md');
  writeFileSync(outputPath, '# Worker Output\n\n## Files Changed\n- README.md\n');
  await approveShellMutation(run, dir, 'node -e "console.log(2)"');
  await startRun(run.id, { command: 'node -e "console.log(2)"' }, dir);
  collectRun(run.id, dir);
  assert.match(readFileSync(outputPath, 'utf8'), /README\.md/);
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'manager-plan.md')), true);
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml')), true);
});

test('multi mode creates physical worktrees, bounds workers, and reports conflicts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 9 }, dir);
  await startForEvidence(run, dir);
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
  assert.match(
    readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'),
    /Status: blocked/,
  );
  assert.match(
    readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'),
    /src\/shared\.ts/,
  );
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'review.md'), 'utf8'), /blocked/);
  assert.equal(readFileSync(humanSynthesis, 'utf8'), 'KEEP_ME_SYNTHESIS');
  assert.equal(readFileSync(humanConflict, 'utf8'), 'KEEP_ME_CONFLICT');
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  assert.doesNotMatch(order, /worktree_unavailable/);
});

test('multi mode reports clear when worker changed files are disjoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi clear task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  const order1 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const order2 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-002.yaml'), 'utf8');
  const ws1 = order1.match(/isolated_workspace: "([^"]+)"/)![1];
  const ws2 = order2.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws1, 'src-a.txt'), 'worker 1');
  writeFileSync(join(ws2, 'src-b.txt'), 'worker 2');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- src-a.txt\n');
  writeFileSync(join(base, 'worker-002.md'), '# Worker Output\n\n## Files Changed\n- src-b.txt\n');
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'completed');
  assert.match(
    readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8'),
    /Status: clear/,
  );
});

test('multi mode detects actual worktree conflicts even when worker output omits files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi actual conflict task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
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

test('multi mode blocks stale declared files absent from actual worktree diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi stale declaration task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(
    join(runDir, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- src/stale.ts\n\n## Risks\n',
  );
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  const report = readFileSync(join(runDir, 'conflict-report.generated.md'), 'utf8');
  assert.match(report, /Status: blocked/);
  assert.match(report, /declared files not present in worktree diff/);
});

test('multi mode blocks denied paths from worker outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('multi denied task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const base = join(dir, '.agent', 'runs', run.id, 'worker-outputs');
  writeFileSync(join(base, 'worker-001.md'), '# Worker Output\n\n## Files Changed\n- .env\n');
  collectRun(run.id, dir);
  const report = readFileSync(join(dir, '.agent', 'runs', run.id, 'conflict-report.generated.md'), 'utf8');
  assert.match(report, /Status: blocked/);
  assert.match(report, /Denied Paths/);
});

test('project registry, durable index, approvals, and web controls are product-visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const project = addProject(dir);
  assert.equal(
    listProjects().some((p) => p.id === project.id),
    true,
  );
  const task = addTask('product visible task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  collectRun(run.id, dir);
  const index = loadIndex(dir);
  assert.equal(index.tasks.length >= 1, true);
  assert.equal(index.runs.length >= 1, true);
  assert.match(renderHtml(dir), /Create Task/);
  assert.match(renderRun(run.id, dir), /executor.process.json/);
});

test('failed executor creates approval-visible changes_requested state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('failing executor task', dir);
  const run = createRun(task.id, { command: 'node -e "process.exit(7)"' }, dir);
  await approveShellMutation(run, dir, 'node -e "process.exit(7)"');
  await startRun(run.id, {}, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'completed');
  assert.equal(collected.decision, 'changes_requested');
  assert.equal(
    listApprovals(dir).some((a) => a.run_id === run.id),
    true,
  );
});

test('apply proposal creates approval-gated patch bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('apply proposal task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const ws = order.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws, 'proposal.txt'), 'proposal');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- proposal.txt\n',
  );
  const collected = collectRun(run.id, dir);
  assert.equal(collected.decision, 'pass');
  const approval = proposeApply(run.id, dir);
  assert.equal(approval.type, 'apply_proposal');
  assert.equal(approval.status, 'requested');
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'apply-proposal', 'worker-001.patch')), true);
});

test('multi mode scheduler launches workers in bounded parallel and records scheduler evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('parallel workers task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const started = Date.now();
  await startRun(run.id, { command: 'node -e "setTimeout(()=>console.log(process.cwd()), 300)"' }, dir);
  const elapsed = Date.now() - started;
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'scheduler.json')), true);
  assert.equal(elapsed < 560, true, `expected parallel elapsed < 560ms, got ${elapsed}`);
});

test('cancelRun persists cancelled status and does not collect artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('cancel task', dir);
  const run = createRun(task.id, {}, dir);
  const cancelled = cancelRun(run.id, dir);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(loadIndex(dir).runs.find((r) => r.id === run.id)?.status, 'cancelled');
  assert.equal(existsSync(join(dir, '.agent', 'runs', run.id, 'collect-status.txt')), false);
});

test('approved apply proposal applies patch and records applied approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('approved apply task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const ws = order.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws, 'apply-output.txt'), 'from worker');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- apply-output.txt\n',
  );
  const collected = collectRun(run.id, dir);
  assert.equal(collected.decision, 'pass');
  const approval = proposeApply(run.id, dir);
  resolveApproval(approval.id, 'approved', dir);
  const applied = applyApprovedProposal(approval.id, dir);
  assert.equal(applied.status, 'applied');
  assert.equal(readFileSync(join(dir, 'apply-output.txt'), 'utf8'), 'from worker');
});

test('task update ignores undefined fields and default run command is not persisted as undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('metadata integrity task', dir);
  const updated = (await import('./core.js')).updateTask(task.id, { status: 'done' as any }, dir);
  assert.equal(updated.title, 'metadata integrity task');
  const run = createRun(task.id, {}, dir);
  const runYaml = readFileSync(join(dir, '.agent', 'runs', run.id, 'run.yaml'), 'utf8');
  assert.doesNotMatch(runYaml, /undefined/);
  await startRun(run.id, {}, dir);
  const commandText = readFileSync(join(dir, '.agent', 'runs', run.id, 'executor-command.txt'), 'utf8');
  assert.match(commandText, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(commandText, /^node\s/);
  collectRun(run.id, dir);
  assert.equal(
    readFileSync(join(dir, '.agent', 'runs', run.id, 'executor.process.json'), 'utf8').includes(
      'Dominic Orchestration task adapter executed',
    ),
    true,
  );
});

test('run UI distinguishes approval waits from completed results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('operator approval task', dir);
  const run = createRun(task.id, {}, dir);
  const blocked = await startRun(run.id, { command: 'python3 -c "open("side.txt","w").write("x")"' }, dir);
  assert.equal(blocked.status, 'awaiting_approval');
  const home = renderHtml(dir);
  assert.match(home, /Command waiting:/);
  assert.match(home, /Waiting for your approval above; this is not a completed result/);
  const detail = renderRun(run.id, dir);
  assert.match(detail, /Not a result yet/);
  assert.match(detail, /No process evidence yet/);
});

test('web start ignores unconfirmed natural-language command text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('ignore natural language command task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, { command: undefined }, dir);
  const commandText = readFileSync(join(dir, '.agent', 'runs', run.id, 'executor-command.txt'), 'utf8');
  assert.doesNotMatch(commandText, /^진행해$/);
  assert.match(commandText, /Dominic Orchestration task adapter executed/);
});

test('blocked multi-worker run cannot create apply proposal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('blocked apply task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 2 }, dir);
  await startForEvidence(run, dir);
  const order1 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const order2 = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-002.yaml'), 'utf8');
  const ws1 = order1.match(/isolated_workspace: "([^"]+)"/)![1];
  const ws2 = order2.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws1, 'README.md'), '# tmp\nworker 1');
  writeFileSync(join(ws2, 'README.md'), '# tmp\nworker 2');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- README.md\n',
  );
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-002.md'),
    '# Worker Output\n\n## Files Changed\n- README.md\n',
  );
  collectRun(run.id, dir);
  assert.throws(() => proposeApply(run.id, dir), /not eligible|clear multi-worker/);
});

test('approved apply proposal is atomic when later patch fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('atomic apply task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const ws = order.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws, 'good.txt'), 'good');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- good.txt\n',
  );
  collectRun(run.id, dir);
  const approval = proposeApply(run.id, dir);
  const proposalDir = join(dir, '.agent', 'runs', run.id, 'apply-proposal');
  writeFileSync(join(proposalDir, 'z-invalid.patch'), 'this is not a patch\n');
  const { createHash } = await import('node:crypto');
  const patches = ['worker-001.patch', 'z-invalid.patch'].map((f) => join(proposalDir, f));
  const digest = createHash('sha256');
  for (const patch of patches) digest.update(readFileSync(patch));
  const sha = digest.digest('hex');
  writeFileSync(
    join(proposalDir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: run.id,
        patches: ['worker-001.patch', 'z-invalid.patch'],
        sha256: sha,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const approvalPath = join(dir, '.agent', 'approvals', `${approval.id}.json`);
  const approvalJson = JSON.parse(readFileSync(approvalPath, 'utf8'));
  approvalJson.proposal_sha256 = sha;
  writeFileSync(approvalPath, JSON.stringify(approvalJson, null, 2));
  resolveApproval(approval.id, 'approved', dir);
  assert.throws(() => applyApprovedProposal(approval.id, dir));
  assert.equal(existsSync(join(dir, 'good.txt')), false);
});

test('cancelRun terminates an active process through cancel.requested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('live cancel task', dir);
  const run = createRun(task.id, {}, dir);
  const command = "node -e \"setTimeout(()=>require('fs').writeFileSync('should-not-exist.txt','done'), 1200)\"";
  await approveShellMutation(run, dir, command);
  const started = startRun(run.id, { command, timeoutMs: 5000 }, dir);
  await new Promise((resolve) => setTimeout(resolve, 150));
  cancelRun(run.id, dir);
  await started;
  assert.equal(existsSync(join(dir, 'should-not-exist.txt')), false);
  const log = readFileSync(join(dir, '.agent', 'runs', run.id, 'executor.process.json'), 'utf8');
  assert.match(log, /"exit_code": 130/);
});

test('multi-worker does not execute when isolated worktree is unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  const task = addTask('non git multi task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startRun(run.id, { command: 'pwd > where-am-i.txt' }, dir);
  assert.equal(existsSync(join(dir, '.agent', 'runs', 'where-am-i.txt')), false);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
});

test('applyApprovedProposal rejects non-apply approvals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('manual approval cannot apply', dir);
  const run = createRun(task.id, {}, dir);
  const approval = createApproval(run.id, 'manual', 'medium', 'manual', dir);
  resolveApproval(approval.id, 'approved', dir);
  assert.throws(() => applyApprovedProposal(approval.id, dir), /not an apply_proposal/);
});

test('cleanupWorktrees removes git worktree registrations and filesystem artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('cleanup worktrees task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  const before = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  assert.match(before, new RegExp(run.id));
  (await import('./core.js')).cleanupWorktrees(dir);
  const after = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(after, new RegExp(run.id));
});

test('createApproval cannot forge apply_proposal approvals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('forged approval task', dir);
  const run = createRun(task.id, {}, dir);
  assert.throws(() => createApproval(run.id, 'apply_proposal', 'high', 'forged', dir), /proposeApply/);
});

test('proposeApply fails closed if a worker worktree disappears after collect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('missing worktree proposal task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const orderPath = join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml');
  const order = readFileSync(orderPath, 'utf8');
  const ws = order.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws, 'gone.txt'), 'gone');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- gone.txt\n',
  );
  collectRun(run.id, dir);
  execFileSync('git', ['worktree', 'remove', '--force', ws], { cwd: dir, stdio: 'ignore' });
  assert.throws(() => proposeApply(run.id, dir), /workspace unavailable/);
});

test('cancelRun terminates descendant process group side effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('process tree cancel task', dir);
  const run = createRun(task.id, {}, dir);
  const command =
    "node -e \"require('child_process').spawn(process.execPath,['-e','setTimeout(()=>require(\\'fs\\').writeFileSync(\\'descendant.txt\\',\\'bad\\'),700)'],{stdio:'ignore'}); setTimeout(()=>{},2000)\"";
  const started = startRun(run.id, { command, timeoutMs: 5000 }, dir);
  await new Promise((resolve) => setTimeout(resolve, 150));
  cancelRun(run.id, dir);
  await started;
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(existsSync(join(dir, 'descendant.txt')), false);
});

test('reconcileRuns fails malformed process evidence instead of completing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(join(runDir, 'review.md'), '# Review\n\n## Decision\npass\n');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8') +
      'started_at: "2026-01-01T00:00:00.000Z"\nended_at: "2026-01-01T00:00:01.000Z"\ndecision: "pass"\n',
  );
  const result = reconcileRuns(dir);
  const yamlText = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(yamlText, /status: "failed"/);
  assert.equal(existsSync(join(runDir, 'process-evidence-errors.json')), true);
  assert.equal(result.repaired >= 1, true);
});

test('reconcileRuns downgrades already completed runs with malformed process evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('completed malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(join(runDir, 'review.md'), '# Review\n\n## Decision\npass\n');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8').replace('status: "created"', 'status: "completed"') +
      'started_at: "2026-01-01T00:00:00.000Z"\nended_at: "2026-01-01T00:00:01.000Z"\ndecision: "pass"\nexit_code: 0\n',
  );
  reconcileRuns(dir);
  const yamlText = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(yamlText, /status: "failed"/);
  assert.match(yamlText, /exit_code: 1/);
});

test('collectRun blocks malformed process evidence instead of passing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('collect malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8') + 'started_at: "2026-01-01T00:00:00.000Z"\n',
  );
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  assert.equal(collected.decision, 'blocked');
  assert.equal(collected.exit_code, 1);
  assert.match(readFileSync(join(runDir, 'review.md'), 'utf8'), /Invalid process evidence/);
  assert.equal(existsSync(join(runDir, 'process-evidence-errors.json')), true);
});

test('reconcileRuns fails active runs with malformed process evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('active malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8').replace('status: "created"', 'status: "collecting"') +
      'started_at: "2026-01-01T00:00:00.000Z"\n',
  );
  const result = reconcileRuns(dir);
  const yamlText = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(yamlText, /status: "failed"/);
  assert.match(yamlText, /decision: "blocked"/);
  assert.equal(result.repaired >= 1, true);
});

test('reconcileRuns fails cancelled runs with malformed process evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('cancelled malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(join(runDir, 'cancel.requested'), '2026-01-01T00:00:00.000Z');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8').replace('status: "created"', 'status: "cancelled"') +
      'started_at: "2026-01-01T00:00:00.000Z"\nended_at: "2026-01-01T00:00:01.000Z"\n',
  );
  const result = reconcileRuns(dir);
  const yamlText = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(yamlText, /status: "failed"/);
  assert.match(yamlText, /decision: "blocked"/);
  assert.equal(result.repaired >= 1, true);
});

test('reconcileRuns overwrites stale pass decision when process evidence is malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('stale pass malformed process task', dir);
  const run = createRun(task.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(join(runDir, 'executor.process.json'), '{bad json');
  writeFileSync(join(runDir, 'cancel.requested'), '2026-01-01T00:00:00.000Z');
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8').replace('status: "created"', 'status: "cancelled"') +
      'started_at: "2026-01-01T00:00:00.000Z"\nended_at: "2026-01-01T00:00:01.000Z"\ndecision: "pass"\n',
  );
  reconcileRuns(dir);
  const yamlText = readFileSync(join(runDir, 'run.yaml'), 'utf8');
  assert.match(yamlText, /status: "failed"/);
  assert.match(yamlText, /decision: "blocked"/);
  assert.doesNotMatch(yamlText, /decision: "pass"/);
});

test('product gate rejects forged manual independent review artifacts', async () => {
  const reviewDir = join(process.cwd(), '.agent', 'review-gates');
  mkdirSync(reviewDir, { recursive: true });
  const reviewerArtifact = join(reviewDir, 'forged-code-reviewer.md');
  const architectArtifact = join(reviewDir, 'forged-architect.md');
  writeFileSync(
    reviewerArtifact,
    'code-reviewer independent review\nRecommendation: APPROVE\nEvidence: This text intentionally looks plausible and contains enough words to prove metadata provenance is required, not just a regex over approving prose.\n',
  );
  writeFileSync(
    architectArtifact,
    'architect independent review\nArchitectural Status: CLEAR\nEvidence: This text intentionally looks plausible and contains enough words to prove metadata provenance is required, not just a regex over clearing prose.\n',
  );
  const digest = createHash('sha256');
  for (const rel of [
    'src/core.ts',
    'src/cli.ts',
    'src/core.test.ts',
    'scripts/live-integration-smoke.mjs',
    'docs/milestones/HARD_COMPLETION_GATES.md',
    'docs/milestones/FULL_PRODUCT_ROADMAP.md',
    'docs/milestones/DOGFOOD_REPORT.md',
  ]) {
    const fp = join(process.cwd(), rel);
    digest.update(rel);
    digest.update(existsSync(fp) ? readFileSync(fp) : 'missing');
  }
  writeFileSync(
    join(process.cwd(), '.agent', 'independent-review-gate.json'),
    JSON.stringify(
      {
        status: 'PASS',
        input_sha256: digest.digest('hex'),
        codeReview: {
          recommendation: 'APPROVE',
          architectStatus: 'CLEAR',
          independentReview: {
            codeReviewer: {
              agentRole: 'code-reviewer',
              artifact_path: '.agent/review-gates/forged-code-reviewer.md',
              evidence: 'manual approve',
            },
            architect: {
              agentRole: 'architect',
              artifact_path: '.agent/review-gates/forged-architect.md',
              evidence: 'manual clear',
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const report = (await import('./product-gate.js')).runProductGate(process.cwd());
  assert.equal(report.decision, 'FAIL');
  assert.equal(
    report.checks.some((check) => check.name === 'Hard Completion Ceiling Gate' && check.status === 'FAIL'),
    true,
  );
});

test('product gate rejects metadata-complete review forgery without notification envelope', async () => {
  const reviewDir = join(process.cwd(), '.agent', 'review-gates');
  mkdirSync(reviewDir, { recursive: true });
  const reviewerId = '019e1111-1111-7111-8111-111111111111';
  const architectId = '019e2222-2222-7222-8222-222222222222';
  const reviewerText =
    'code-reviewer independent review\nRecommendation: APPROVE\nEvidence: plausible enough review text with commands npm test and live smoke, but there is no matching subagent notification envelope.\n';
  const architectText =
    'architect independent review\nArchitectural Status: CLEAR\nEvidence: plausible enough architecture text with commands quality gate and live smoke, but there is no matching subagent notification envelope.\n';
  writeFileSync(join(reviewDir, 'metadata-forged-code-reviewer.md'), reviewerText);
  writeFileSync(join(reviewDir, 'metadata-forged-architect.md'), architectText);
  const inputHash = currentReviewInputHashForTest(process.cwd());
  writeFileSync(
    join(process.cwd(), '.agent', 'independent-review-gate.json'),
    JSON.stringify(
      {
        status: 'PASS',
        input_sha256: inputHash,
        codeReview: {
          recommendation: 'APPROVE',
          architectStatus: 'CLEAR',
          independentReview: {
            codeReviewer: {
              agentRole: 'code-reviewer',
              agent_id: reviewerId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: '2026-06-01T00:00:00.000Z',
              reviewed_input_sha256: inputHash,
              artifact_path: '.agent/review-gates/metadata-forged-code-reviewer.md',
              artifact_sha256: createHash('sha256').update(reviewerText).digest('hex'),
              notification_path: `.agent/review-gates/subagent-notifications/${reviewerId}.json`,
              commands: ['npm test', 'scripts/live-integration-smoke.mjs'],
            },
            architect: {
              agentRole: 'architect',
              agent_id: architectId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: '2026-06-01T00:00:00.000Z',
              reviewed_input_sha256: inputHash,
              artifact_path: '.agent/review-gates/metadata-forged-architect.md',
              artifact_sha256: createHash('sha256').update(architectText).digest('hex'),
              notification_path: `.agent/review-gates/subagent-notifications/${architectId}.json`,
              commands: ['npm test', 'node dist/cli.js quality gate --write'],
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const report = (await import('./product-gate.js')).runProductGate(process.cwd());
  assert.equal(report.decision, 'FAIL');
});

test('extractFilesChanged reads the Files Changed section only', () => {
  assert.deepEqual(
    extractFilesChanged('# Worker Output\n\n## Files Changed\n- src/a.ts\n- `src/b.ts`\n\n## Risks\n- src/nope.ts'),
    ['src/a.ts', 'src/b.ts'],
  );
  assert.deepEqual(extractFilesChanged('# Worker Output\n\n## Files Changed\n\n## Risks\n'), []);
});

test('run viewer includes generated v2 evidence files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('viewer evidence task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  collectRun(run.id, dir);
  const html = renderRun(run.id, dir);
  assert.match(html, /synthesis\.generated\.md/);
  assert.match(html, /conflict-report\.generated\.md/);
});

test('renderHtml self-heals a fresh uninitialized repo instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  const html = renderHtml(dir);
  assert.match(html, /Dominic Orchestration/);
  assert.equal(existsSync(join(dir, '.agent', 'index.json')), true);
});

test('renderRun rejects traversal and secret files inside run artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  const task = addTask('render safety task', dir);
  const run = createRun(task.id, {}, dir);
  writeFileSync(join(dir, '.agent', 'runs', run.id, '.env'), 'RUN_SECRET=1');
  assert.throws(() => renderRun('../..', dir), /invalid run id/);
  const html = renderRun(run.id, dir);
  assert.doesNotMatch(html, /RUN_SECRET|SECRET=1/);
});

test('collectRun preserves cancelled as terminal state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('cancel terminal task', dir);
  const run = createRun(task.id, {}, dir);
  cancelRun(run.id, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'cancelled');
});

test('web task board exposes task update and archive controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  addTask('web crud task', dir);
  const html = renderHtml(dir);
  assert.match(html, /Update Task/);
  assert.match(html, /Archive/);
});

test('applyApprovedProposal uses manifest patch set as authoritative and rejects extras', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('manifest authority task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const order = readFileSync(join(dir, '.agent', 'runs', run.id, 'work-orders', 'worker-001.yaml'), 'utf8');
  const ws = order.match(/isolated_workspace: "([^"]+)"/)![1];
  writeFileSync(join(ws, 'manifest.txt'), 'manifest');
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'worker-outputs', 'worker-001.md'),
    '# Worker Output\n\n## Files Changed\n- manifest.txt\n',
  );
  collectRun(run.id, dir);
  const approval = proposeApply(run.id, dir);
  resolveApproval(approval.id, 'approved', dir);
  writeFileSync(
    join(dir, '.agent', 'runs', run.id, 'apply-proposal', 'extra.patch'),
    'diff --git a/extra.txt b/extra.txt\nnew file mode 100644\nindex 0000000..45b983b\n--- /dev/null\n+++ b/extra.txt\n@@ -0,0 +1 @@\n+extra\n',
  );
  assert.throws(() => applyApprovedProposal(approval.id, dir), /patch set differs/);
});

test('applyApprovedProposal checks whole bundle before applying valid conflicting later patch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('whole bundle atomic task', dir);
  const run = createRun(task.id, { mode: 'multi', maxWorkers: 1 }, dir);
  await startForEvidence(run, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  writeFileSync(
    join(runDir, 'run.yaml'),
    readFileSync(join(runDir, 'run.yaml'), 'utf8').replace('status: "created"', 'status: "completed"') +
      'decision: "pass"\n',
  );
  const proposalDir = join(runDir, 'apply-proposal');
  mkdirSync(proposalDir, { recursive: true });
  const patch1 =
    'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..d95f3ad\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+one\n';
  const patch2 =
    'diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..56a6051\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+two\n';
  writeFileSync(join(proposalDir, 'a.patch'), patch1);
  writeFileSync(join(proposalDir, 'b.patch'), patch2);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256');
  digest.update(patch1);
  digest.update(patch2);
  const sha = digest.digest('hex');
  writeFileSync(
    join(proposalDir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: run.id,
        patches: ['a.patch', 'b.patch'],
        sha256: sha,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  const approval = createApproval(run.id, 'manual', 'high', 'manual', dir);
  const approvalPath = join(dir, '.agent', 'approvals', `${approval.id}.json`);
  const approvalJson = JSON.parse(readFileSync(approvalPath, 'utf8'));
  approvalJson.type = 'apply_proposal';
  approvalJson.proposal_sha256 = sha;
  approvalJson.proposal_path = `.agent/runs/${run.id}/apply-proposal`;
  approvalJson.status = 'approved';
  writeFileSync(approvalPath, JSON.stringify(approvalJson, null, 2));
  assert.throws(() => applyApprovedProposal(approval.id, dir));
  assert.equal(existsSync(join(dir, 'new.txt')), false);
});

test('renderRun ignores symlinks that point outside the run directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE_SECRET');
  const task = addTask('symlink render task', dir);
  const run = createRun(task.id, {}, dir);
  symlinkSync(join(dir, 'outside.txt'), join(dir, '.agent', 'runs', run.id, 'innocent-link.txt'));
  const html = renderRun(run.id, dir);
  assert.doesNotMatch(html, /OUTSIDE_SECRET|innocent-link/);
});

test('task status updates reject invalid statuses from core paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('invalid status task', dir);
  assert.throws(() => updateTask(task.id, { status: 'not-a-status' as any }, dir), /invalid task status/);
});

test('renderHtml escapes task titles for HTML attributes and includes csrf hidden inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  addTask('x" autofocus onfocus="globalThis.pwned=1', dir);
  const html = renderHtml(dir, 'csrf-token');
  assert.match(html, /name="csrf" value="csrf-token"/);
  assert.doesNotMatch(html, /autofocus onfocus/);
  assert.match(html, /&quot;/);
});

test('safeJoin rejects non-existent paths outside the project root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  initProject(dir);
  assert.throws(() => safeJoin(dir, '..', 'outside-does-not-exist', 'file.txt'), /escapes project root/);
});

test('createRun rejects invalid run modes before web metadata can persist XSS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('invalid mode task', dir);
  assert.throws(() => createRun(task.id, { mode: '<img src=x onerror=alert(1)>' as any }, dir), /invalid run mode/);
});

test('dashboard escapes persisted run and approval metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('metadata escape task', dir);
  const run = createRun(task.id, {}, dir);
  const runYaml = join(dir, '.agent', 'runs', run.id, 'run.yaml');
  writeFileSync(
    runYaml,
    readFileSync(runYaml, 'utf8').replace('mode: "basic"', 'mode: "<img src=x onerror=alert(1)>"'),
  );
  createApproval(run.id, 'manual<img src=x onerror=alert(2)>', 'medium', 'summary', dir);
  const html = renderHtml(dir, 'csrf');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test('basic and roles runs are not eligible for apply proposal because they mutate live workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('basic apply not eligible', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, {}, dir);
  collectRun(run.id, dir);
  assert.throws(() => proposeApply(run.id, dir), /isolated multi-worker/);
});

test('collectRun blocks unstarted runs instead of passing placeholder artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('unstarted collect task', dir);
  const run = createRun(task.id, {}, dir);
  const collected = collectRun(run.id, dir);
  assert.equal(collected.status, 'failed');
  assert.equal(collected.decision, 'blocked');
  assert.match(
    readFileSync(join(dir, '.agent', 'runs', run.id, 'review.md'), 'utf8'),
    /before start\/execution evidence/,
  );
});

test('commands are redacted and mutating commands require approval before execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('policy redaction task', dir);
  const run = createRun(task.id, {}, dir);
  const command = 'node -e "console.log("sk-1234567890SECRET"); require("fs").writeFileSync("side.txt","x")"';
  const blocked = await startRun(run.id, { command }, dir);
  assert.equal(blocked.status, 'awaiting_approval');
  assert.equal(existsSync(join(dir, 'side.txt')), false);
  const approval = listApprovals(dir).find((a) => a.run_id === run.id && a.type === 'shell_mutation');
  assert.ok(approval);
  assert.ok(approval.command_sha256);
  resolveApproval(approval.id, 'approved', dir);
  await startRun(run.id, { command }, dir);
  const html = renderRun(run.id, dir);
  assert.doesNotMatch(html, /sk-1234567890SECRET/);
  assert.match(html, /\[REDACTED\]/);
});

test('operator shell commands fail closed unless readonly allowlisted or approved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('python bypass task', dir);
  const run = createRun(task.id, {}, dir);
  const blocked = await startRun(run.id, { command: 'python3 -c "open("side.txt","w").write("x")"' }, dir);
  assert.equal(blocked.status, 'awaiting_approval');
  assert.equal(existsSync(join(dir, 'side.txt')), false);
  assert.ok(listApprovals(dir).some((a) => a.run_id === run.id && a.type === 'shell_mutation'));

  const readonlyRun = createRun(task.id, {}, dir);
  const started = await startRun(readonlyRun.id, { command: 'git status --short' }, dir);
  assert.equal(started.status, 'collecting');

  const chainedRun = createRun(task.id, {}, dir);
  const chained = await startRun(
    chainedRun.id,
    { command: 'git status --short; python3 -c "open(\\"chained.txt\\",\\"w\\").write(\\"x\\")"' },
    dir,
  );
  assert.equal(chained.status, 'awaiting_approval');
  assert.equal(existsSync(join(dir, 'chained.txt')), false);

  const substitutionRun = createRun(task.id, {}, dir);
  const substitution = await startRun(
    substitutionRun.id,
    { command: 'node -e "console.log($(python3 -c \'open(\\"sub.txt\\",\\"w\\").write(\\"x\\")\'))"' },
    dir,
  );
  assert.equal(substitution.status, 'awaiting_approval');
  assert.equal(existsSync(join(dir, 'sub.txt')), false);
});

test('shell mutation approvals are bound to the exact command digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('command digest approval task', dir);
  const run = createRun(task.id, {}, dir);
  const first = `python3 -c "open('one.txt','w').write('1')"`;
  const second = `python3 -c "open('two.txt','w').write('2')"`;
  await startRun(run.id, { command: first }, dir);
  const firstApproval = listApprovals(dir).find(
    (a) => a.run_id === run.id && a.type === 'shell_mutation' && a.status === 'requested',
  );
  assert.ok(firstApproval?.command_sha256);
  resolveApproval(firstApproval.id, 'approved', dir);
  await startRun(run.id, { command: second }, dir);
  assert.equal(existsSync(join(dir, 'two.txt')), false);
  const secondApproval = listApprovals(dir).find(
    (a) =>
      a.run_id === run.id &&
      a.type === 'shell_mutation' &&
      a.status === 'requested' &&
      a.command_sha256 !== firstApproval.command_sha256,
  );
  assert.ok(secondApproval);

  const freshRun = createRun(task.id, {}, dir);
  await startRun(freshRun.id, { command: first }, dir);
  const freshApproval = listApprovals(dir).find(
    (a) => a.run_id === freshRun.id && a.type === 'shell_mutation' && a.status === 'requested',
  );
  assert.ok(freshApproval);
  resolveApproval(freshApproval.id, 'approved', dir);
  await startRun(freshRun.id, { command: first }, dir);
  assert.equal(existsSync(join(dir, 'one.txt')), true);
});

test('roles mode passes distinct ROLE context to manager worker and reviewer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('role env task', dir);
  const run = createRun(task.id, { mode: 'roles' }, dir);
  await approveShellMutation(run, dir, 'node -e "console.log(process.env.ROLE)"');
  await startRun(run.id, { command: 'node -e "console.log(process.env.ROLE)"' }, dir);
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'manager.stdout.log'), 'utf8'), /manager/);
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'worker-001.stdout.log'), 'utf8'), /worker/);
  assert.match(readFileSync(join(dir, '.agent', 'runs', run.id, 'reviewer.stdout.log'), 'utf8'), /reviewer/);
});

test('unsafe-host auth does not leak tokens on unmatched POST', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const port = 15000 + Math.floor(Math.random() * 1000);
  const child = spawn(
    process.execPath,
    [
      new URL('../dist/cli.js', import.meta.url).pathname,
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--unsafe-host',
      '--auth-token',
      'secret-token',
    ],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const unauth = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    const unauthText = await unauth.text();
    assert.equal(unauth.status, 404);
    assert.doesNotMatch(unauthText, /secret-token|csrf/);
    const authed = await fetch(`http://127.0.0.1:${port}/?auth=secret-token`);
    const text = await authed.text();
    assert.equal(authed.status, 200);
    assert.match(text, /Dominic Orchestration/);
    assert.doesNotMatch(text, /secret-token/);
    const cookie = authed.headers.get('set-cookie') || '';
    assert.match(cookie, /agent_auth=/);
    const csrf = text.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: `csrf=${csrf}&title=unsafe-host-task`,
    });
    assert.equal(created.status, 303);
    const loopbackAlias = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: `http://localhost:${port}` },
      body: `csrf=${csrf}&title=localhost-origin-task`,
    });
    assert.equal(loopbackAlias.status, 303);
    const badOrigin = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'http://evil.local' },
      body: `csrf=${csrf}&title=bad-origin-task`,
    });
    assert.equal(badOrigin.status, 500);
    assert.equal(await badOrigin.text(), 'invalid origin');
  } finally {
    child.kill('SIGTERM');
  }
});

test('readonly shell allowlist rejects mutating git output flags and redacts GitHub tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-'));
  gitInit(dir);
  const task = addTask('readonly hardening task', dir);
  const run = createRun(task.id, {}, dir);
  const blocked = await startRun(run.id, { command: 'git diff --output=side.txt' }, dir);
  assert.equal(blocked.status, 'awaiting_approval');
  assert.equal(existsSync(join(dir, 'side.txt')), false);

  const tokenRun = createRun(task.id, {}, dir);
  const tokenCommand = 'python3 -c "print("ghp_1234567890abcdefTOKEN")"';
  await startRun(tokenRun.id, { command: tokenCommand }, dir);
  const approval = listApprovals(dir).find(
    (a) => a.run_id === tokenRun.id && a.type === 'shell_mutation' && a.status === 'requested',
  );
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
  await startRun(tokenRun.id, { command: tokenCommand }, dir);
  const html = renderRun(tokenRun.id, dir);
  assert.doesNotMatch(html, /ghp_1234567890abcdefTOKEN/);
  assert.match(html, /\[REDACTED\]/);
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

test('redact masks multi-vendor secret formats, not just OpenAI/GitHub', () => {
  const leaky = [
    'sk-ABCDEFGH12345678',
    'sk-ant-api03-ABCDEFGH12345678',
    'ghp_1234567890abcdefTOKEN',
    'github_pat_11ABCDEFG0abcdefghij',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-123456789012-abcdefghijklmnop',
    'sk_live_abcdefghijklmnop12345678',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123456',
    'aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY',
    'password: SuperSecret12345',
  ];
  for (const secret of leaky) {
    const masked = redact(`prefix ${secret} suffix`);
    const token = secret.split(/[:=]/).pop()!.trim();
    assert.ok(!masked.includes(token), `redact leaked: ${secret} -> ${masked}`);
    assert.match(masked, /\[REDACTED\]/);
  }
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  assert.ok(!redact(pem).includes('MIIEowIBAAKCAQEA'));
  assert.equal(redact('postgres://admin:hunter2@db.internal:5432/app'), 'postgres://[REDACTED]@db.internal:5432/app');
  // non-secret text must pass through unchanged
  assert.equal(redact('Dominic Orchestration task adapter executed'), 'Dominic Orchestration task adapter executed');
});

test('hard completion ceiling requires independent review and reconciliation artifacts', async () => {
  const reviewPath = join(process.cwd(), '.agent', 'independent-review-gate.json');
  rmSync(reviewPath, { force: true });
  reconcileRuns(process.cwd());
  const withoutReview = (await import('./product-gate.js')).runProductGate(process.cwd());
  assert.equal(withoutReview.decision, 'FAIL');
  writePassingReviewGate(process.cwd());
  const report = (await import('./product-gate.js')).runProductGate(process.cwd());
  assert.equal(report.decision, 'PASS');
  assert.equal(report.completion_ceiling, 95);
  assert.match(report.completion_label, /completion candidate/);
  assert.equal(
    report.checks.some((check) => check.name === 'Hard Completion Ceiling Gate' && check.status === 'PASS'),
    true,
  );
  assert.equal(
    report.result_reality_delta.some((row) => /Hard completion ceiling/.test(row.target) && row.status === 'PASS'),
    true,
  );
});

test('fake string-only repo cannot pass the product gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-fake-gate-'));
  mkdirSync(join(dir, 'docs', 'milestones'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'dominic_orchestration_PRD.md'),
    '로컬 웹서비스 로컬 에이전트 작업 v0: Single Run + Review v1: Manager + Worker + Reviewer v2: Bounded Multi-Worker',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'),
    'Anti-Self-Deception Critic Gate Scope Integrity Gate rubber-stamp 원 PRD Result-Reality Delta',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'),
    '| Area | 95% Product Pass Definition | Current Baseline | Status |\n| --- | --- | --- | --- |\n| Installable CLI | x | x | PASS |',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'DOGFOOD_REPORT.md'),
    'FINAL_PRODUCT_SMOKE_PASS WEB_CSRF_SMOKE_PASS FINAL_POLICY_EVIDENCE_PASS basic_run= multi_run= approval=',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_GATE_RERUN_REPORT.md'),
    'Result-Reality Delta | Original PRD / v0-v2 target | Current runnable evidence | Delta | Forbidden completion claim Allowed completion claim Why the previous loop failed implementation-friendly grading Final wording guard',
  );
  writeFileSync(
    join(dir, 'src', 'core.test.ts'),
    'test( fake ) executor.process.json scheduler.json worker-001.process.json actual worktree changes not declared declared files not present in worktree diff unsafe-host auth does not leak tokens hard completion ceiling requires independent review and reconciliation artifacts fake string-only repo cannot pass the product gate product gate durable report contains report_path after hard gates pass',
  );
  const report = (await import('./product-gate.js')).runProductGate(dir);
  assert.equal(report.decision, 'FAIL');
  assert.equal(
    report.checks.some((check) => check.name === 'Product Completeness Gate' && check.status === 'FAIL'),
    true,
  );
  assert.equal(
    report.result_reality_delta.some((row) => row.status === 'FAIL'),
    true,
  );
});

test('product gate durable report contains report_path after hard gates pass', async () => {
  reconcileRuns(process.cwd());
  writePassingReviewGate(process.cwd());
  const report = (await import('./product-gate.js')).runProductGate(process.cwd(), { write: true });
  assert.equal(report.decision, 'PASS');
  assert.equal(report.completion_ceiling, 95);
  assert.ok(report.report_path);
  const written = JSON.parse(readFileSync(join(process.cwd(), report.report_path), 'utf8'));
  assert.equal(written.report_path, report.report_path);
  assert.ok(Array.isArray(written.result_reality_delta));
});

test('shaped scaffold with fake CLI and dogfood strings still fails without dogfood artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-shaped-gate-'));
  mkdirSync(join(dir, 'docs', 'milestones'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: { agent: './dist/cli.js' } }));
  writeFileSync(
    join(dir, 'dist', 'cli.js'),
    'if(process.argv.includes("--version")) console.log("dominic-orchestration 0.1.0"); else console.log("agent quality gate [--write]\nagent run create|start|collect|cancel|latest\nagent apply propose|approved");',
  );
  writeFileSync(
    join(dir, 'dominic_orchestration_PRD.md'),
    '로컬 웹서비스 로컬 에이전트 작업 v0: Single Run + Review v1: Manager + Worker + Reviewer v2: Bounded Multi-Worker',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'),
    'Anti-Self-Deception Critic Gate Scope Integrity Gate rubber-stamp 원 PRD Result-Reality Delta',
  );
  const rows = [
    'Installable CLI',
    'Web UI',
    'Project registry',
    'Durable index',
    'v0 run lifecycle',
    'v1 role execution',
    'Executor adapter',
    'Policy/approval',
    'Promotion proposals',
    'v2 scheduler',
    'v2 worktrees',
    'Conflict detection',
    'Apply/merge proposal',
    'Dogfood',
    'Scope integrity',
    'Anti-self-deception critic',
  ];
  writeFileSync(
    join(dir, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'),
    '| Area | 95% Product Pass Definition | Current Baseline | Status |\n| --- | --- | --- | --- |\n' +
      rows.map((r) => `| ${r} | x | x | PASS |`).join('\n') +
      '\nUI shows worker lanes Run detail UI showing all required evidence',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_GATE_RERUN_REPORT.md'),
    'Result-Reality Delta | Original PRD / v0-v2 target | Current runnable evidence | Delta | Forbidden completion claim Allowed completion claim Why the previous loop failed implementation-friendly grading Final wording guard CLI/Web controls agent quality gate --write',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'DOGFOOD_REPORT.md'),
    'FINAL_PRODUCT_SMOKE_PASS WEB_CSRF_SMOKE_PASS FINAL_POLICY_EVIDENCE_PASS root=/tmp/missing-dogfood basic_run=run-fake multi_run=run-fake2 approval=approval-fake',
  );
  writeFileSync(
    join(dir, 'src', 'core.test.ts'),
    'test('.repeat(49) +
      ' executor.process.json scheduler.json worker-001.process.json roles mode passes distinct ROLE context actual worktree changes not declared declared files not present in worktree diff multi mode detects actual worktree conflicts multi mode blocks stale declared files absent from actual worktree diff unsafe-host auth does not leak tokens readonly shell allowlist rejects mutating git output flags secret path detection and safeJoin reject unsafe paths shell mutation approvals are bound to the exact command digest applyApprovedProposal checks whole bundle before applying fake string-only repo cannot pass the product gate product gate durable report contains report_path after hard gates pass hard completion ceiling requires independent review and reconciliation artifacts',
  );
  const report = (await import('./product-gate.js')).runProductGate(dir);
  assert.equal(report.decision, 'FAIL');
  assert.equal(
    report.checks.some((check) => check.name === 'Dogfood Gate' && check.status === 'FAIL'),
    true,
  );
  assert.equal(
    report.result_reality_delta.some((row) => row.target.startsWith('Real execution') && row.status === 'FAIL'),
    true,
  );
});

test('minimal fake dogfood artifacts still fail coherence checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-fake-artifacts-'));
  mkdirSync(join(dir, 'docs', 'milestones'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const dogRoot = join(dir, 'dogfood');
  const basic = 'run-basic';
  const multi = 'run-multi';
  const approval = 'approval-apply';
  mkdirSync(join(dogRoot, '.agent', 'runs', basic), { recursive: true });
  mkdirSync(join(dogRoot, '.agent', 'runs', multi), { recursive: true });
  mkdirSync(join(dogRoot, '.agent', 'approvals'), { recursive: true });
  writeFileSync(join(dogRoot, '.agent', 'runs', basic, 'executor.process.json'), JSON.stringify({ exit_code: 0 }));
  writeFileSync(join(dogRoot, '.agent', 'runs', basic, 'review.md'), 'pass');
  writeFileSync(
    join(dogRoot, '.agent', 'runs', multi, 'scheduler.json'),
    JSON.stringify({ workers: ['worker-001', 'worker-002'] }),
  );
  writeFileSync(join(dogRoot, '.agent', 'runs', multi, 'conflict-report.generated.md'), 'Status: clear');
  writeFileSync(
    join(dogRoot, '.agent', 'approvals', `${approval}.json`),
    JSON.stringify({ id: approval, run_id: multi, type: 'apply_proposal' }),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: { agent: './dist/cli.js' } }));
  writeFileSync(
    join(dir, 'dist', 'cli.js'),
    'if(process.argv.includes("--version")) console.log("dominic-orchestration 0.1.0"); else console.log("agent quality gate [--write]\nagent run create|start|collect|cancel|latest\nagent apply propose|approved");',
  );
  writeFileSync(
    join(dir, 'dominic_orchestration_PRD.md'),
    '로컬 웹서비스 로컬 에이전트 작업 v0: Single Run + Review v1: Manager + Worker + Reviewer v2: Bounded Multi-Worker',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'),
    'Anti-Self-Deception Critic Gate Scope Integrity Gate rubber-stamp 원 PRD Result-Reality Delta',
  );
  const rows = [
    'Installable CLI',
    'Web UI',
    'Project registry',
    'Durable index',
    'v0 run lifecycle',
    'v1 role execution',
    'Executor adapter',
    'Policy/approval',
    'Promotion proposals',
    'v2 scheduler',
    'v2 worktrees',
    'Conflict detection',
    'Apply/merge proposal',
    'Dogfood',
    'Scope integrity',
    'Anti-self-deception critic',
  ];
  writeFileSync(
    join(dir, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'),
    '| Area | 95% Product Pass Definition | Current Baseline | Status |\n| --- | --- | --- | --- |\n' +
      rows.map((r) => `| ${r} | x | x | PASS |`).join('\n') +
      '\nUI shows worker lanes Run detail UI showing all required evidence',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'DOGFOOD_REPORT.md'),
    `FINAL_PRODUCT_SMOKE_PASS WEB_CSRF_SMOKE_PASS FINAL_POLICY_EVIDENCE_PASS root=${dogRoot} basic_run=${basic} multi_run=${multi} approval=${approval}`,
  );
  writeFileSync(
    join(dir, 'src', 'core.test.ts'),
    'test('.repeat(49) +
      ' executor.process.json scheduler.json worker-001.process.json roles mode passes distinct ROLE context actual worktree changes not declared declared files not present in worktree diff multi mode detects actual worktree conflicts multi mode blocks stale declared files absent from actual worktree diff unsafe-host auth does not leak tokens readonly shell allowlist rejects mutating git output flags secret path detection and safeJoin reject unsafe paths shell mutation approvals are bound to the exact command digest applyApprovedProposal checks whole bundle before applying fake string-only repo cannot pass the product gate product gate durable report contains report_path after hard gates pass hard completion ceiling requires independent review and reconciliation artifacts',
  );
  const report = (await import('./product-gate.js')).runProductGate(dir);
  assert.equal(report.decision, 'FAIL');
  assert.equal(
    report.result_reality_delta.some((row) => row.target.startsWith('Real execution') && row.status === 'FAIL'),
    true,
  );
});

test('forged dogfood proposal digest fails product gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dominic-orch-forged-digest-'));
  mkdirSync(join(dir, 'docs', 'milestones'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const dogRoot = join(dir, 'dogfood');
  const basic = 'run-basic';
  const multi = 'run-multi';
  const approval = 'approval-apply';
  const basicDir = join(dogRoot, '.agent', 'runs', basic);
  const multiDir = join(dogRoot, '.agent', 'runs', multi);
  const proposalDir = join(multiDir, 'apply-proposal');
  mkdirSync(basicDir, { recursive: true });
  mkdirSync(proposalDir, { recursive: true });
  mkdirSync(join(dogRoot, '.agent', 'approvals'), { recursive: true });
  writeFileSync(
    join(basicDir, 'run.yaml'),
    `id: "${basic}"\nmode: "basic"\nstatus: "completed"\ndecision: "pass"\nexit_code: 0\n`,
  );
  writeFileSync(
    join(basicDir, 'executor.process.json'),
    JSON.stringify({ label: 'executor', exit_code: 0, stdout: 'Dominic Orchestration task adapter executed' }),
  );
  writeFileSync(join(basicDir, 'review.md'), '## Decision\npass');
  writeFileSync(
    join(multiDir, 'run.yaml'),
    `id: "${multi}"\nmode: "multi"\nstatus: "completed"\ndecision: "pass"\nexit_code: 0\nmax_workers: 2\n`,
  );
  writeFileSync(
    join(multiDir, 'scheduler.json'),
    JSON.stringify({
      strategy: 'bounded-parallel',
      workers: ['worker-001', 'worker-002'],
      ended_at: new Date().toISOString(),
    }),
  );
  writeFileSync(join(multiDir, 'conflict-report.generated.md'), 'Status: clear\nworker-001\nworker-002');
  writeFileSync(
    join(proposalDir, 'worker-001.patch'),
    'diff --git a/x.txt b/x.txt\nnew file mode 100644\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n',
  );
  const badSha = '0'.repeat(64);
  writeFileSync(
    join(proposalDir, 'manifest.json'),
    JSON.stringify({ run_id: multi, patches: ['worker-001.patch'], sha256: badSha }),
  );
  writeFileSync(
    join(dogRoot, '.agent', 'approvals', `${approval}.json`),
    JSON.stringify({
      id: approval,
      run_id: multi,
      type: 'apply_proposal',
      status: 'applied',
      proposal_path: `.agent/runs/${multi}/apply-proposal`,
      proposal_sha256: badSha,
    }),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ bin: { agent: './dist/cli.js' } }));
  writeFileSync(
    join(dir, 'dist', 'cli.js'),
    'if(process.argv.includes("--version")) console.log("dominic-orchestration 0.1.0"); else console.log("agent quality gate [--write]\nagent run create|start|collect|cancel|latest\nagent apply propose|approved");',
  );
  writeFileSync(
    join(dir, 'dominic_orchestration_PRD.md'),
    '로컬 웹서비스 로컬 에이전트 작업 v0: Single Run + Review v1: Manager + Worker + Reviewer v2: Bounded Multi-Worker',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'),
    'Anti-Self-Deception Critic Gate Scope Integrity Gate rubber-stamp 원 PRD Result-Reality Delta',
  );
  const rows = [
    'Installable CLI',
    'Web UI',
    'Project registry',
    'Durable index',
    'v0 run lifecycle',
    'v1 role execution',
    'Executor adapter',
    'Policy/approval',
    'Promotion proposals',
    'v2 scheduler',
    'v2 worktrees',
    'Conflict detection',
    'Apply/merge proposal',
    'Dogfood',
    'Scope integrity',
    'Anti-self-deception critic',
  ];
  writeFileSync(
    join(dir, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'),
    '| Area | 95% Product Pass Definition | Current Baseline | Status |\n| --- | --- | --- | --- |\n' +
      rows.map((r) => `| ${r} | x | x | PASS |`).join('\n') +
      '\nUI shows worker lanes Run detail UI showing all required evidence',
  );
  writeFileSync(
    join(dir, 'docs', 'milestones', 'DOGFOOD_REPORT.md'),
    `FINAL_PRODUCT_SMOKE_PASS WEB_CSRF_SMOKE_PASS FINAL_POLICY_EVIDENCE_PASS root=${dogRoot} basic_run=${basic} multi_run=${multi} approval=${approval}`,
  );
  writeFileSync(
    join(dir, 'src', 'core.test.ts'),
    'test('.repeat(49) +
      ' executor.process.json scheduler.json worker-001.process.json roles mode passes distinct ROLE context actual worktree changes not declared declared files not present in worktree diff multi mode detects actual worktree conflicts multi mode blocks stale declared files absent from actual worktree diff unsafe-host auth does not leak tokens readonly shell allowlist rejects mutating git output flags secret path detection and safeJoin reject unsafe paths shell mutation approvals are bound to the exact command digest applyApprovedProposal checks whole bundle before applying fake string-only repo cannot pass the product gate product gate durable report contains report_path after hard gates pass hard completion ceiling requires independent review and reconciliation artifacts',
  );
  const report = (await import('./product-gate.js')).runProductGate(dir);
  assert.equal(report.decision, 'FAIL');
  assert.equal(
    report.result_reality_delta.some((row) => row.target.startsWith('Real execution') && row.status === 'FAIL'),
    true,
  );
});

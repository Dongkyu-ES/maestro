import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';

export type TaskStatus = 'inbox' | 'scoped' | 'ready' | 'running' | 'review' | 'changes_requested' | 'done' | 'blocked' | 'cancelled' | 'abandoned';
export type RunStatus = 'created' | 'planning' | 'dispatching' | 'workers_running' | 'collecting' | 'reviewing' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type RunMode = 'basic' | 'roles' | 'multi';

export interface TaskMeta {
  schema_version: number;
  id: string;
  title: string;
  status: TaskStatus;
  priority: 'low' | 'normal' | 'high';
  created_at: string;
  updated_at: string;
}

export interface RunMeta {
  schema_version: number;
  id: string;
  task_id: string;
  status: RunStatus;
  executor: 'omx' | 'codex';
  mode: RunMode;
  run_dir: string;
  max_workers?: number;
  created_at: string;
  updated_at: string;
}

export const AGENT_DIR = '.agent';
const SECRET_PATTERNS = [/^\.env(\..*)?$/, /.*\.pem$/, /.*\.key$/, /^id_rsa$/, /^id_ed25519$/, /^secrets\..*/, /^\.ssh(\/.*)?$/, /^\.config(\/.*)?$/];

export function nowIso(): string {
  return new Date().toISOString();
}

export function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
}

export function uniqueId(prefix: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}-${slug(label).slice(0, 24)}`;
}

export function projectRoot(cwd = process.cwd()): string {
  return realpathSync(cwd);
}

export function safeJoin(root: string, ...parts: string[]): string {
  const target = resolve(root, ...parts);
  const parent = existsSync(target) ? target : dirname(target);
  const realParent = existsSync(parent) ? realpathSync(parent) : realpathSync(root);
  const rel = relative(realpathSync(root), realParent).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../')) {
    throw new Error(`path escapes project root: ${target}`);
  }
  const rootRel = relative(realpathSync(root), target).replaceAll('\\', '/');
  if (isSecretPath(rootRel)) throw new Error(`refusing secret path: ${rootRel}`);
  return target;
}


export function isSecretPath(rootRelativePath: string): boolean {
  const normalized = rootRelativePath.replaceAll('\\', '/');
  return normalized.split('/').some((part, idx, arr) => {
    const rest = arr.slice(idx).join('/');
    return SECRET_PATTERNS.some((pattern) => pattern.test(part) || pattern.test(rest));
  });
}

export function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }

export function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  writeFileSync(path, content);
  return true;
}

export function yaml(meta: Record<string, unknown>): string {
  return Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n';
}

export function frontmatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${yaml(meta)}---\n\n${body.trim()}\n`;
}

export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const raw = text.slice(4, end).trim();
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    try { value = JSON.parse(value); } catch {}
    out[key] = String(value);
  }
  return out;
}

export function git(args: string[], cwd = process.cwd()): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    return String(err.stderr || err.message || err);
  }
}

export function initProject(cwd = process.cwd()): string[] {
  const root = projectRoot(cwd);
  const created: string[] = [];
  const agent = safeJoin(root, AGENT_DIR);
  ensureDir(agent);
  const ts = nowIso();
  const projectId = slug(basename(root));
  const files: [string, string][] = [
    ['project.yaml', yaml({ schema_version: 1, id: projectId, name: basename(root), root_path: root, agent_dir: AGENT_DIR, default_executor: 'omx', created_at: ts, updated_at: ts })],
    ['policies/tool-policy.yaml', `defaults:\n  max_workers: 1\n  require_approval_for_writes: true\n  require_approval_for_network: true\n  require_approval_for_shell_mutation: true\n\ntools:\n  filesystem.read:\n    default: allow\n  git.status:\n    default: allow\n  git.diff:\n    default: allow\n`],
    ['policies/approval-policy.yaml', `approvals:\n  file_write:\n    required: true\n    auto_approve_paths:\n      - ".agent/runs/"\n  git_commit:\n    required: true\n  git_push:\n    required: true\n`],
    ['evals/rubric.md', `# Agent Run Review Rubric\n\n- Goal Fit: 0-2\n- Artifact Boundary: 0-2\n- Tool Discipline: 0-2\n- Reviewability: 0-2\n- Reusability: 0-2\n\nPass: score >= 8 and no blocking issue.\n`],
  ];
  for (const [rel, content] of files) if (writeIfMissing(safeJoin(root, AGENT_DIR, rel), content)) created.push(join(AGENT_DIR, rel));
  for (const dir of ['tasks', 'runs', 'logs', 'cache']) ensureDir(safeJoin(root, AGENT_DIR, dir));
  return created;
}

export function addTask(title: string, cwd = process.cwd()): TaskMeta {
  initProject(cwd);
  const root = projectRoot(cwd);
  const ts = nowIso();
  const id = uniqueId('task', title);
  const meta: TaskMeta = { schema_version: 1, id, title, status: 'ready', priority: 'normal', created_at: ts, updated_at: ts };
  const body = `# Task: ${title}\n\n## Goal\n${title}\n\n## Context\n\n## Constraints\n\n## Done Means\n\n## Preferred Executor\nomx\n\n## Notes\n`;
  writeFileSync(safeJoin(root, AGENT_DIR, 'tasks', `${id}.md`), frontmatter(meta as unknown as Record<string, unknown>, body));
  return meta;
}

export function listTasks(cwd = process.cwd()): TaskMeta[] {
  const root = projectRoot(cwd);
  const dir = safeJoin(root, AGENT_DIR, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
    return { schema_version: Number(meta.schema_version || 1), id: meta.id || f.replace(/\.md$/, ''), title: meta.title || meta.id || f, status: (meta.status || 'ready') as TaskStatus, priority: (meta.priority || 'normal') as 'normal', created_at: meta.created_at || '', updated_at: meta.updated_at || '' };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function taskPath(taskId: string, cwd = process.cwd()): string {
  return safeJoin(projectRoot(cwd), AGENT_DIR, 'tasks', `${taskId}.md`);
}

export function updateTaskStatus(taskId: string, status: TaskStatus, cwd = process.cwd()): void {
  const p = taskPath(taskId, cwd);
  const text = readFileSync(p, 'utf8');
  const meta = { ...parseFrontmatter(text), status, updated_at: nowIso() };
  const body = text.slice(text.indexOf('\n---', 4) + 4).trim();
  writeFileSync(p, frontmatter(meta, body));
}

export function createRun(taskId: string, options: { mode?: RunMode; executor?: 'omx' | 'codex'; maxWorkers?: number } = {}, cwd = process.cwd()): RunMeta {
  initProject(cwd);
  const root = projectRoot(cwd);
  const taskFile = taskPath(taskId, cwd);
  if (!existsSync(taskFile)) throw new Error(`task not found: ${taskId}`);
  const ts = nowIso();
  const id = uniqueId('run', taskId);
  const mode = options.mode || 'basic';
  const runDirRel = join(AGENT_DIR, 'runs', id);
  const runDir = safeJoin(root, runDirRel);
  ensureDir(runDir);
  const meta: RunMeta = { schema_version: 1, id, task_id: taskId, status: mode === 'basic' ? 'created' : 'planning', executor: options.executor || 'omx', mode, run_dir: runDirRel, max_workers: mode === 'multi' ? Math.min(Math.max(options.maxWorkers || 2, 1), 3) : 1, created_at: ts, updated_at: ts };
  writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
  const taskText = readFileSync(taskFile, 'utf8');
  writeFileSync(join(runDir, 'task.md'), taskText);
  writeFileSync(join(runDir, 'context.md'), `# Context\n\nProject: ${basename(root)}\nTask: ${taskId}\nMode: ${mode}\nCreated: ${ts}\n`);
  writeFileSync(join(runDir, 'prompt.md'), buildPrompt(taskId, mode, meta.max_workers || 1));
  writeFileSync(join(runDir, 'baseline-status.txt'), git(['status', '--short', '--branch'], root));
  writeFileSync(join(runDir, 'baseline-diff.patch'), git(['diff'], root));
  if (mode === 'roles') createRoleArtifacts(runDir, taskId);
  if (mode === 'multi') createMultiArtifacts(runDir, taskId, meta.max_workers || 2, root, id);
  updateTaskStatus(taskId, 'running', cwd);
  return meta;
}

function buildPrompt(taskId: string, mode: RunMode, maxWorkers: number): string {
  return `# Agent Run Prompt\n\nTask: ${taskId}\nMode: ${mode}\nMax workers: ${maxWorkers}\n\nFollow AGENTS.md and write results back to this run folder.\n\nSemi-auto command example:\n\n\`\`\`bash\nomx --prompt-file .agent/runs/<run-id>/prompt.md\n\`\`\`\n`;
}

function createRoleArtifacts(runDir: string, taskId: string): void {
  writeIfMissing(join(runDir, 'manager-plan.md'), `# Manager Plan

## Restated Goal
Execute ${taskId}.

## Context Needed
Task snapshot, policy summary, current diff.

## Proposed Strategy
Create one bounded worker order.

## Work Orders
worker-001

## Risks
Scope drift; missing verification.

## Acceptance Criteria
Worker output and review are complete.

## Recommendation
Proceed with one worker.
`);
  ensureDir(join(runDir, 'work-orders'));
  ensureDir(join(runDir, 'worker-outputs'));
  writeIfMissing(join(runDir, 'work-orders', 'worker-001.yaml'), yaml({ id: 'worker-001', role: 'worker', task_id: taskId, allowed_tools: ['filesystem.read', 'git.diff'], max_minutes: 30, status: 'queued' }));
  writeIfMissing(join(runDir, 'worker-outputs', 'worker-001.md'), `# Worker Output

## Objective
Execute ${taskId}.

## Summary
Pending external executor work.

## Actions Taken

## Files Read

## Files Changed

## Diff Summary

## Tests Run

## Risks

## Follow-ups

## Completion Against Acceptance Criteria
Pending collect.
`);
  writeIfMissing(join(runDir, 'transcript.md'), '# Transcript\n\nTranscript collection is optional in v1 and may be unavailable for semi-auto OMX runs.\n');
  writeIfMissing(join(runDir, 'tool-calls.jsonl'), '');
}

function createMultiArtifacts(runDir: string, taskId: string, maxWorkers: number, root: string, runId: string): void {
  ensureDir(join(runDir, 'work-orders'));
  ensureDir(join(runDir, 'worker-outputs'));
  const workerCount = Math.min(maxWorkers, 3);
  for (let i = 1; i <= workerCount; i++) {
    const id = `worker-${String(i).padStart(3, '0')}`;
    const branchName = `agent/${runId}/${id}`;
    const workspacePath = createWorkerWorktree(root, runId, id, branchName);
    writeIfMissing(join(runDir, 'work-orders', `${id}.yaml`), yaml({ id, role: 'worker', task_id: taskId, isolated_workspace: workspacePath, branch_name: branchName, allowed_tools: ['filesystem.read', 'git.diff'], status: 'queued' }));
    writeIfMissing(join(runDir, 'worker-outputs', `${id}.md`), `# Worker Output

## Objective
Bounded worker ${id} for ${taskId}.

## Summary
Pending external executor work.

## Files Changed

## Risks

## Completion Against Acceptance Criteria
Pending collect.
`);
  }
  writeIfMissing(join(runDir, 'synthesis.md'), `# Synthesis

This file is reserved for human/manager synthesis notes. Orchestrator-generated synthesis is written to \`synthesis.generated.md\`.
`);
  writeIfMissing(join(runDir, 'conflict-report.md'), `# Conflict Report

This file is reserved for human review notes. Orchestrator-generated conflict evidence is written to \`conflict-report.generated.md\`.
`);
  writeFileSync(join(runDir, 'synthesis.generated.md'), '# Synthesis\n\nStatus: pending\n');
  writeFileSync(join(runDir, 'conflict-report.generated.md'), '# Conflict Report\n\nStatus: pending\n');
}

function createWorkerWorktree(root: string, runId: string, workerId: string, branchName: string): string {
  const worktreeBase = resolve(dirname(root), `${basename(root)}.agent-worktrees`, runId);
  const worktreePath = join(worktreeBase, workerId);
  ensureDir(worktreeBase);
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
    if (!existsSync(worktreePath)) {
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    return worktreePath;
  } catch (err: any) {
    const reason = String(err.stderr || err.message || err).trim().split('\n')[0];
    return `worktree_unavailable:${worktreePath}:${reason}`;
  }
}

export function collectRun(runId: string, cwd = process.cwd()): RunMeta {
  const root = projectRoot(cwd);
  const runDir = safeJoin(root, AGENT_DIR, 'runs', runId);
  if (!existsSync(runDir)) throw new Error(`run not found: ${runId}`);
  const runMeta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  writeFileSync(join(runDir, 'collect-status.txt'), git(['status', '--short', '--branch'], root));
  const diff = git(['diff'], root);
  writeFileSync(join(runDir, 'collect-diff.patch'), diff);
  writeFileSync(join(runDir, 'diff.patch'), diff);
  if (!existsSync(join(runDir, 'result.md'))) writeFileSync(join(runDir, 'result.md'), `# Result\n\n## Summary\nCollected run ${runId}.\n\n## Evidence\n- baseline-status.txt\n- collect-status.txt\n- diff.patch\n`);
  if (runMeta.mode === 'multi') updateConflictAndSynthesis(runDir);
  const decision = writeReview(runDir, runMeta.mode || 'basic');
  writeNextActions(runDir);
  runMeta.status = decision === 'pass' ? 'completed' : decision === 'blocked' ? 'failed' : 'completed';
  runMeta.updated_at = nowIso();
  writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>));
  updateTaskStatus(runMeta.task_id, decision === 'pass' ? 'done' : decision === 'blocked' ? 'blocked' : 'changes_requested', cwd);
  return runMeta;
}

function updateConflictAndSynthesis(runDir: string): void {
  const outputsDir = join(runDir, 'worker-outputs');
  const outputs = existsSync(outputsDir) ? readdirSync(outputsDir).filter((f) => f.endsWith('.md')).sort() : [];
  const changedByWorker = new Map<string, string[]>();
  const denied: string[] = [];
  const evidenceIssues: string[] = [];
  const worktreeIssues = collectWorktreeIssues(runDir);
  const worktreeChanges = collectWorktreeChanges(runDir, worktreeIssues);

  for (const output of outputs) {
    const workerId = output.replace(/\.md$/, '');
    const text = readFileSync(join(outputsDir, output), 'utf8');
    const declaredFiles = extractFilesChanged(text);
    const actualFiles = worktreeChanges.get(workerId) || [];
    const mergedFiles = new Set([...actualFiles, ...declaredFiles]);
    for (const file of mergedFiles) {
      if (isSecretPath(file)) denied.push(`${workerId}: ${file}`);
      const workers = changedByWorker.get(file) || [];
      workers.push(workerId);
      changedByWorker.set(file, workers);
    }
    const undeclared = actualFiles.filter((file) => !declaredFiles.includes(file));
    const staleDeclared = declaredFiles.filter((file) => !actualFiles.includes(file));
    if (undeclared.length) evidenceIssues.push(`${workerId}: actual worktree changes not declared (${undeclared.join(', ')})`);
    if (staleDeclared.length) evidenceIssues.push(`${workerId}: declared files not present in worktree diff (${staleDeclared.join(', ')})`);
  }

  for (const [workerId, files] of worktreeChanges.entries()) {
    if (outputs.includes(`${workerId}.md`)) continue;
    for (const file of files) {
      if (isSecretPath(file)) denied.push(`${workerId}: ${file}`);
      const workers = changedByWorker.get(file) || [];
      workers.push(workerId);
      changedByWorker.set(file, workers);
    }
    if (files.length) evidenceIssues.push(`${workerId}: worktree has changes but worker output is missing`);
  }

  const overlaps = [...changedByWorker.entries()].filter(([, workers]) => new Set(workers).size > 1);
  const hasConflict = overlaps.length > 0 || denied.length > 0 || worktreeIssues.length > 0 || evidenceIssues.length > 0;
  const status = hasConflict ? 'blocked' : 'clear';
  const conflictLines = [
    '# Conflict Report',
    '',
    `Status: ${status}`,
    '',
    `Workers reviewed: ${outputs.length}`,
    '',
    '## Overlapping Files',
    overlaps.length ? overlaps.map(([file, workers]) => `- ${file}: ${[...new Set(workers)].join(', ')}`).join('\n') : 'None.',
    '',
    '## Denied Paths',
    denied.length ? denied.map((item) => `- ${item}`).join('\n') : 'None.',
    '',
    '## Worktree Issues',
    worktreeIssues.length ? worktreeIssues.map((item) => `- ${item}`).join('\n') : 'None.',
    '',
    '## Evidence Mismatches',
    evidenceIssues.length ? evidenceIssues.map((item) => `- ${item}`).join('\n') : 'None.',
    '',
    '## Changed Files by Worker',
    changedByWorker.size ? [...changedByWorker.entries()].map(([file, workers]) => `- ${file}: ${workers.join(', ')}`).join('\n') : 'No changed files reported by worker outputs or worktrees.',
    ''
  ];
  writeFileSync(join(runDir, 'conflict-report.generated.md'), conflictLines.join('\n'));
  writeFileSync(join(runDir, 'synthesis.generated.md'), `# Synthesis

## Accepted Outputs
${outputs.map((o) => `- ${o}`).join('\n')}

## Rejected Outputs
${hasConflict ? '- Conflicting, denied, non-isolated, or mismatched worker evidence requires review before apply.' : 'None.'}

## Conflicts
${hasConflict ? 'Blocking conflicts, denied paths, worktree issues, or evidence mismatches found. See conflict-report.generated.md.' : 'No blocking conflicts detected from worker-reported changed files and actual worktree diffs.'}

## Risks
External executor work requires human review before destructive apply/merge/push operations.

## Recommendation
${hasConflict ? 'Do not apply automatically; resolve blockers first.' : 'Proceed to review.'}
`);
}


function collectWorktreeIssues(runDir: string): string[] {
  const workOrdersDir = join(runDir, 'work-orders');
  if (!existsSync(workOrdersDir)) return ['missing work-orders directory'];
  const issues: string[] = [];
  for (const file of readdirSync(workOrdersDir).filter((f) => f.endsWith('.yaml')).sort()) {
    const order = readYaml(join(workOrdersDir, file));
    const workspace = String(order.isolated_workspace || '');
    if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) {
      issues.push(`${file}: isolated workspace unavailable (${workspace || 'missing'})`);
    }
  }
  return issues;
}

function collectWorktreeChanges(runDir: string, issues: string[]): Map<string, string[]> {
  const workOrdersDir = join(runDir, 'work-orders');
  const changes = new Map<string, string[]>();
  if (!existsSync(workOrdersDir)) return changes;
  for (const file of readdirSync(workOrdersDir).filter((f) => f.endsWith('.yaml')).sort()) {
    const workerId = file.replace(/\.yaml$/, '');
    const order = readYaml(join(workOrdersDir, file));
    const workspace = String(order.isolated_workspace || '');
    if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) continue;
    try {
      const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: workspace, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim().split(' -> ').pop() || '')
        .filter(Boolean);
      changes.set(workerId, [...new Set([...tracked, ...status])].sort());
    } catch (err: any) {
      issues.push(`${file}: failed to inspect worktree (${String(err.stderr || err.message || err).trim().split('\n')[0]})`);
      changes.set(workerId, []);
    }
  }
  return changes;
}

export function extractFilesChanged(workerOutput: string): string[] {
  const lines = workerOutput.split('\n');
  const files: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Files Changed\s*$/.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line.trim())) break;
    if (!inSection) continue;
    const cleaned = line.replace(/^[-*]\s*/, '').trim();
    if (!cleaned || /^none\.?$/i.test(cleaned) || /^pending/i.test(cleaned) || /^#/.test(cleaned)) continue;
    files.push(cleaned.split(/\s+/)[0].replace(/^`|`$/g, '').replace(/[:,]$/g, ''));
  }
  return files;
}

function writeReview(runDir: string, mode: RunMode): 'pass' | 'changes_requested' | 'blocked' {
  const required = ['run.yaml', 'task.md', 'context.md', 'prompt.md', 'baseline-status.txt', 'baseline-diff.patch', 'collect-status.txt', 'collect-diff.patch', 'diff.patch', 'result.md'];
  if (mode === 'roles') required.push('manager-plan.md', 'work-orders/worker-001.yaml', 'worker-outputs/worker-001.md');
  if (mode === 'multi') required.push('synthesis.md', 'conflict-report.md', 'synthesis.generated.md', 'conflict-report.generated.md');
  const missing = required.filter((rel) => !existsSync(join(runDir, rel)));
  const conflictPath = existsSync(join(runDir, 'conflict-report.generated.md')) ? 'conflict-report.generated.md' : 'conflict-report.md';
  const conflictReport = existsSync(join(runDir, conflictPath)) ? readFileSync(join(runDir, conflictPath), 'utf8') : '';
  const hasConflict = /Status: blocked/.test(conflictReport);
  const hasIssue = missing.length > 0 || hasConflict;
  const score = hasIssue ? 6 : 9;
  const decision: 'pass' | 'changes_requested' | 'blocked' = hasConflict ? 'blocked' : missing.length ? 'changes_requested' : 'pass';
  const blockingIssues = [
    ...missing.map((m) => `- Missing ${m}`),
    ...(hasConflict ? ['- Conflict report is blocked'] : [])
  ];
  writeFileSync(join(runDir, 'review.md'), `# Review

## Score
${score}

## Rubric Breakdown
- Goal Fit: ${hasIssue ? 1 : 2}
- Artifact Boundary: ${hasIssue ? 1 : 2}
- Tool Discipline: 2
- Reviewability: ${hasIssue ? 1 : 2}
- Reusability: 1

## Blocking Issues
${blockingIssues.length ? blockingIssues.join('\n') : 'None.'}

## Required Changes
${hasIssue ? 'Create missing required artifacts or resolve blocked conflicts.' : 'None.'}

## Risks
Semi-auto executor evidence still requires human review before destructive operations.

## Decision
${decision}

## System Patch Suggestions
Keep milestone quality gates up to date as runtime behavior matures.
`);
  return decision;
}

function writeNextActions(runDir: string): void {
  writeFileSync(join(runDir, 'next-actions.md'), `# Next Actions\n\n## Immediate\nReview diff.patch and review.md.\n\n## Suggested System Patches\nNone for deterministic scaffold.\n\n## Promotion Candidates\nNone.\n\n## Blockers\nNone recorded.\n`);
}

export function readYaml(path: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    try { out[key] = JSON.parse(raw); } catch { out[key] = raw; }
  }
  return out;
}

export function latestRunId(cwd = process.cwd()): string | null {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'runs');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort();
  return runs.at(-1) || null;
}

export function renderHtml(cwd = process.cwd()): string {
  const tasks = listTasks(cwd);
  const runDir = safeJoin(projectRoot(cwd), AGENT_DIR, 'runs');
  const runs = existsSync(runDir) ? readdirSync(runDir).filter((f) => statSync(join(runDir, f)).isDirectory()).sort().reverse() : [];
  return `<!doctype html><html><head><meta charset="utf-8"><title>Dominic Orchestration</title><style>body{font-family:system-ui;margin:2rem;max-width:1100px}pre{background:#111;color:#eee;padding:1rem;overflow:auto}a{color:#06c}.card{border:1px solid #ddd;padding:1rem;margin:.75rem 0;border-radius:8px}</style></head><body><h1>Dominic Orchestration</h1><h2>Tasks</h2>${tasks.map(t=>`<div class=card><b>${escapeHtml(t.title)}</b><br><code>${t.id}</code> — ${t.status}</div>`).join('')}<h2>Runs</h2>${runs.map(r=>`<div class=card><a href="/run/${encodeURIComponent(r)}">${r}</a></div>`).join('')}</body></html>`;
}

export function renderRun(runId: string, cwd = process.cwd()): string {
  const root = projectRoot(cwd);
  const runDir = safeJoin(root, AGENT_DIR, 'runs', runId);
  const names = ['run.yaml', 'result.md', 'review.md', 'next-actions.md', 'diff.patch', 'synthesis.md', 'synthesis.generated.md', 'conflict-report.md', 'conflict-report.generated.md'].filter((f) => existsSync(join(runDir, f)));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(runId)}</title><style>body{font-family:system-ui;margin:2rem}pre{background:#111;color:#eee;padding:1rem;overflow:auto;white-space:pre-wrap}</style></head><body><a href="/">← back</a><h1>${escapeHtml(runId)}</h1>${names.map(n=>`<h2>${n}</h2><pre>${escapeHtml(readFileSync(join(runDir,n),'utf8'))}</pre>`).join('')}</body></html>`;
}

function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

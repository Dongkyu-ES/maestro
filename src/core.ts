import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export type TaskStatus = 'inbox' | 'scoped' | 'ready' | 'running' | 'review' | 'changes_requested' | 'done' | 'blocked' | 'cancelled' | 'abandoned';
const TASK_STATUSES = new Set(['inbox', 'scoped', 'ready', 'running', 'review', 'changes_requested', 'done', 'blocked', 'cancelled', 'abandoned']);
export type RunStatus = 'created' | 'planning' | 'dispatching' | 'workers_running' | 'collecting' | 'reviewing' | 'awaiting_approval' | 'applying' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type RunMode = 'basic' | 'roles' | 'multi';
const RUN_MODES = new Set(['basic', 'roles', 'multi']);
export type Decision = 'pass' | 'changes_requested' | 'blocked' | 'fail';

export interface TaskMeta { schema_version: number; id: string; title: string; status: TaskStatus; priority: 'low' | 'normal' | 'high'; created_at: string; updated_at: string; }
export interface RunMeta { schema_version: number; id: string; task_id: string; status: RunStatus; executor: 'omx' | 'codex' | 'command'; mode: RunMode; run_dir: string; max_workers?: number; command?: string; created_at: string; updated_at: string; started_at?: string; ended_at?: string; exit_code?: number; decision?: Decision; }
export interface ProjectRecord { schema_version: number; id: string; name: string; root_path: string; agent_dir: string; created_at: string; updated_at: string; last_opened_at?: string; }
export interface ApprovalRecord { schema_version: number; id: string; run_id: string; type: string; status: 'requested' | 'approved' | 'rejected' | 'applied' | 'failed_to_apply'; risk: 'low' | 'medium' | 'high'; summary: string; created_at: string; updated_at: string; proposal_sha256?: string; proposal_path?: string; command_sha256?: string; command_preview?: string; }
export interface PromotionRecord { schema_version: number; id: string; run_id: string; target_type: 'agent_instruction' | 'skill' | 'workflow' | 'eval' | 'memory' | 'policy'; status: 'proposed' | 'approved' | 'applied' | 'rejected'; reason: string; target_path: string; proposal_path: string; created_at: string; updated_at: string; }
export interface ProductIndex { schema_version: number; generated_at: string; project: ProjectRecord | null; tasks: TaskMeta[]; runs: RunMeta[]; approvals: ApprovalRecord[]; promotions: PromotionRecord[]; artifacts: { run_id: string; type: string; path: string }[]; }

export const AGENT_DIR = '.agent';
const SECRET_PATTERNS = [/^\.env(\..*)?$/, /.*\.pem$/, /.*\.key$/, /^id_rsa$/, /^id_ed25519$/, /^secrets\..*/, /^\.ssh(\/.*)?$/, /^\.config(\/.*)?$/];

export function nowIso(): string { return new Date().toISOString(); }
export function slug(input: string): string { return input.toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item'; }
export function uniqueId(prefix: string, label: string): string { const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17); const rand = Math.random().toString(36).slice(2, 8); return `${prefix}-${stamp}-${rand}-${slug(label).slice(0, 24)}`; }
export function projectRoot(cwd = process.cwd()): string { return realpathSync(cwd); }
export function ensureDir(path: string): void { mkdirSync(path, { recursive: true }); }
export function registryPath(): string { return join(homedir(), '.dominic_orchestration', 'registry.json'); }

function gitNoIndexPatch(workspace: string, file: string): string { try { return execFileSync('git', ['diff', '--binary', '--no-index', '--', '/dev/null', file], { cwd: workspace, encoding: 'utf8' }); } catch (err: any) { return String(err.stdout || ''); } }
function normalizeNoIndexPatch(patch: string): string { return patch; }
function patchTouchedFiles(patch: string): string[] { return patch.split('\n').filter((line) => line.startsWith('diff --git ')).map((line) => line.trim().split(/\s+/)[3] || '').filter(Boolean).map((file) => file.replace(/^b\//, '')); }
export function safeJoin(root: string, ...parts: string[]): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, ...parts);
  const targetRel = relative(realRoot, target).replaceAll('\\', '/');
  if (targetRel === '..' || targetRel.startsWith('../') || targetRel.startsWith('..\\')) throw new Error(`path escapes project root: ${target}`);
  const parent = existsSync(target) ? target : dirname(target);
  const realParent = existsSync(parent) ? realpathSync(parent) : realRoot;
  const rel = relative(realRoot, realParent).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../')) throw new Error(`path escapes project root: ${target}`);
  const rootRel = relative(realRoot, target).replaceAll('\\', '/');
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

export function writeIfMissing(path: string, content: string): boolean { if (existsSync(path)) return false; ensureDir(dirname(path)); writeFileSync(path, content); return true; }
export function yaml(meta: Record<string, unknown>): string { return Object.entries(meta).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n'; }
export function frontmatter(meta: Record<string, unknown>, body: string): string { return `---\n${yaml(meta)}---\n\n${body.trim()}\n`; }
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const raw = text.slice(4, end).trim();
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':'); if (idx < 0) continue;
    const key = line.slice(0, idx).trim(); let value: unknown = line.slice(idx + 1).trim();
    try { value = JSON.parse(String(value)); } catch {}
    out[key] = String(value);
  }
  return out;
}
export function readYaml(path: string): Record<string, string | number> { const out: Record<string, string | number> = {}; for (const line of readFileSync(path, 'utf8').split('\n')) { const idx = line.indexOf(':'); if (idx < 0) continue; const key = line.slice(0, idx).trim(); const raw = line.slice(idx + 1).trim(); try { out[key] = JSON.parse(raw); } catch { out[key] = raw; } } return out; }
interface EvidenceResult { ok: boolean; output: string; error?: string; }
function gitEvidence(args: string[], cwd = process.cwd()): EvidenceResult { try { return { ok: true, output: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (err: any) { const error = String(err.stderr || err.message || err); return { ok: false, output: error, error }; } }
export function git(args: string[], cwd = process.cwd()): string { return gitEvidence(args, cwd).output; }
function recordEvidenceError(runDir: string, label: string, result: EvidenceResult): void { if (result.ok) return; const path = join(runDir, 'evidence-errors.json'); const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []; existing.push({ label, ok: false, error: redact(result.error || result.output), recorded_at: nowIso() }); writeFileSync(path, JSON.stringify(existing, null, 2)); }

export function loadRegistry(): ProjectRecord[] { const p = registryPath(); if (!existsSync(p)) return []; return JSON.parse(readFileSync(p, 'utf8')) as ProjectRecord[]; }
export function saveRegistry(records: ProjectRecord[]): void { const p = registryPath(); ensureDir(dirname(p)); writeFileSync(p, JSON.stringify(records, null, 2)); }
export function addProject(rootPath = process.cwd()): ProjectRecord { const root = projectRoot(rootPath); initProject(root); const ts = nowIso(); const existing = loadRegistry().filter((p) => p.root_path !== root); const rec: ProjectRecord = { schema_version: 1, id: slug(basename(root)), name: basename(root), root_path: root, agent_dir: AGENT_DIR, created_at: ts, updated_at: ts, last_opened_at: ts }; saveRegistry([...existing, rec]); return rec; }
export function listProjects(): ProjectRecord[] { return loadRegistry(); }
export function removeProject(id: string): void { saveRegistry(loadRegistry().filter((p) => p.id !== id)); }

export function initProject(cwd = process.cwd()): string[] {
  const root = projectRoot(cwd); const created: string[] = []; const agent = safeJoin(root, AGENT_DIR); ensureDir(agent); const ts = nowIso(); const projectId = slug(basename(root));
  const files: [string, string][] = [
    ['project.yaml', yaml({ schema_version: 1, id: projectId, name: basename(root), root_path: root, agent_dir: AGENT_DIR, default_executor: 'command', created_at: ts, updated_at: ts })],
    ['policies/tool-policy.yaml', `defaults:\n  max_workers: 3\n  require_approval_for_writes: true\n  require_approval_for_network: true\n  require_approval_for_shell_mutation: true\n\ntools:\n  filesystem.read:\n    default: allow\n  filesystem.write:\n    default: require_approval\n  shell.readonly:\n    default: allow\n  shell.mutating:\n    default: require_approval\n  git.status:\n    default: allow\n  git.diff:\n    default: allow\n  git.commit:\n    default: require_approval\n  git.push:\n    default: require_approval\n`],
    ['policies/approval-policy.yaml', `approvals:\n  file_write:\n    required: true\n    auto_approve_paths:\n      - ".agent/runs/"\n  apply_patch:\n    required: true\n  package_install:\n    required: true\n  git_commit:\n    required: true\n  git_push:\n    required: true\n`],
    ['evals/rubric.md', `# Agent Run Review Rubric\n\n- Goal Fit: 0-2\n- Artifact Boundary: 0-2\n- Tool Discipline: 0-2\n- Reviewability: 0-2\n- Reusability: 0-2\n\nPass: score >= 8 and no blocking issue.\n`],
  ];
  for (const [rel, content] of files) if (writeIfMissing(safeJoin(root, AGENT_DIR, rel), content)) created.push(join(AGENT_DIR, rel));
  for (const dir of ['tasks', 'runs', 'logs', 'cache', 'approvals', 'promotions', 'worktrees']) ensureDir(safeJoin(root, AGENT_DIR, dir));
  rebuildIndex(root); return created;
}

export function addTask(title: string, cwd = process.cwd()): TaskMeta { initProject(cwd); const root = projectRoot(cwd); const ts = nowIso(); const id = uniqueId('task', title); const meta: TaskMeta = { schema_version: 1, id, title, status: 'ready', priority: 'normal', created_at: ts, updated_at: ts }; const body = `# Task: ${title}\n\n## Goal\n${title}\n\n## Context\n\n## Constraints\n\n## Done Means\n\n## Preferred Executor\ncommand\n\n## Notes\n`; writeFileSync(safeJoin(root, AGENT_DIR, 'tasks', `${id}.md`), frontmatter(meta as unknown as Record<string, unknown>, body)); rebuildIndex(root); return meta; }
export function listTasks(cwd = process.cwd()): TaskMeta[] { const root = projectRoot(cwd); const dir = safeJoin(root, AGENT_DIR, 'tasks'); if (!existsSync(dir)) return []; return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => { const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf8')); return { schema_version: Number(meta.schema_version || 1), id: meta.id || f.replace(/\.md$/, ''), title: meta.title || meta.id || f, status: (meta.status || 'ready') as TaskStatus, priority: (meta.priority || 'normal') as 'normal', created_at: meta.created_at || '', updated_at: meta.updated_at || '' }; }).sort((a, b) => a.id.localeCompare(b.id)); }
export function taskPath(taskId: string, cwd = process.cwd()): string { return safeJoin(projectRoot(cwd), AGENT_DIR, 'tasks', `${taskId}.md`); }
export function updateTaskStatus(taskId: string, status: TaskStatus, cwd = process.cwd()): void { if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`); const p = taskPath(taskId, cwd); const text = readFileSync(p, 'utf8'); const meta = { ...parseFrontmatter(text), status, updated_at: nowIso() }; const body = text.slice(text.indexOf('\n---', 4) + 4).trim(); writeFileSync(p, frontmatter(meta, body)); rebuildIndex(cwd); }
export function updateTask(taskId: string, fields: Partial<Pick<TaskMeta, 'title' | 'status' | 'priority'>>, cwd = process.cwd()): TaskMeta { if (fields.status !== undefined && !TASK_STATUSES.has(fields.status)) throw new Error(`invalid task status: ${fields.status}`); const p = taskPath(taskId, cwd); const text = readFileSync(p, 'utf8'); const old = parseFrontmatter(text); const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)); const meta = { ...old, ...cleanFields, updated_at: nowIso() }; const body = text.slice(text.indexOf('\n---', 4) + 4).trim(); writeFileSync(p, frontmatter(meta, body)); rebuildIndex(cwd); return listTasks(cwd).find((t) => t.id === taskId)!; }

export function createRun(taskId: string, options: { mode?: RunMode; executor?: 'omx' | 'codex' | 'command'; maxWorkers?: number; command?: string } = {}, cwd = process.cwd()): RunMeta {
  initProject(cwd); const root = projectRoot(cwd); const taskFile = taskPath(taskId, cwd); if (!existsSync(taskFile)) throw new Error(`task not found: ${taskId}`); const ts = nowIso(); const id = uniqueId('run', taskId); const mode = options.mode || 'basic'; if (!RUN_MODES.has(mode)) throw new Error(`invalid run mode: ${mode}`); const runDirRel = join(AGENT_DIR, 'runs', id); const runDir = safeJoin(root, runDirRel); ensureDir(runDir);
  const meta: RunMeta = { schema_version: 1, id, task_id: taskId, status: 'created', executor: options.executor || 'command', mode, run_dir: runDirRel, max_workers: mode === 'multi' ? Math.min(Math.max(options.maxWorkers || 2, 1), 3) : 1, command: options.command, created_at: ts, updated_at: ts };
  writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>)); writeFileSync(join(runDir, 'task.md'), readFileSync(taskFile, 'utf8')); writeFileSync(join(runDir, 'context.md'), `# Context\n\nProject: ${basename(root)}\nTask: ${taskId}\nMode: ${mode}\nCreated: ${ts}\n`); writeFileSync(join(runDir, 'prompt.md'), buildPrompt(taskId, mode, meta.max_workers || 1)); writeFileSync(join(runDir, 'baseline-status.txt'), git(['status', '--short', '--branch'], root)); writeFileSync(join(runDir, 'baseline-diff.patch'), git(['diff'], root));
  if (mode === 'roles') createRoleArtifacts(runDir, taskId); if (mode === 'multi') createMultiArtifacts(runDir, taskId, meta.max_workers || 2, root, id); updateTaskStatus(taskId, 'running', cwd); rebuildIndex(root); return meta;
}
function buildPrompt(taskId: string, mode: RunMode, maxWorkers: number): string { return `# Agent Run Prompt\n\nTask: ${taskId}\nMode: ${mode}\nMax workers: ${maxWorkers}\n\nThe executor must produce deterministic evidence. Worker prose alone is not trusted.\n`; }
export function latestRunId(cwd = process.cwd()): string | null { const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'runs'); if (!existsSync(dir)) return null; const runs = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort(); return runs.at(-1) || null; }
export function runPath(runId: string, cwd = process.cwd()): string { return safeJoin(projectRoot(cwd), AGENT_DIR, 'runs', runId); }

function createRoleArtifacts(runDir: string, taskId: string): void { ensureDir(join(runDir, 'work-orders')); ensureDir(join(runDir, 'worker-outputs')); writeIfMissing(join(runDir, 'manager-plan.md'), `# Manager Plan\n\n## Restated Goal\nExecute ${taskId}.\n\n## Proposed Strategy\nCreate one bounded worker order and require deterministic evidence.\n\n## Work Orders\nworker-001\n\n## Risks\nScope drift; missing verification.\n\n## Acceptance Criteria\nWorker output, transcript, diff, review, and next action are complete.\n`); writeIfMissing(join(runDir, 'work-orders', 'worker-001.yaml'), yaml({ id: 'worker-001', role: 'worker', task_id: taskId, allowed_tools: ['filesystem.read', 'git.diff'], max_minutes: 30, status: 'queued' })); writeIfMissing(join(runDir, 'worker-outputs', 'worker-001.md'), `# Worker Output\n\n## Objective\nExecute ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Tests Run\n\n## Completion Against Acceptance Criteria\nPending collect.\n`); writeIfMissing(join(runDir, 'transcript.md'), '# Transcript\n\n'); writeIfMissing(join(runDir, 'tool-calls.jsonl'), ''); }
function createMultiArtifacts(runDir: string, taskId: string, maxWorkers: number, root: string, runId: string): void { ensureDir(join(runDir, 'work-orders')); ensureDir(join(runDir, 'worker-outputs')); const workerCount = Math.min(maxWorkers, 3); for (let i = 1; i <= workerCount; i++) { const id = `worker-${String(i).padStart(3, '0')}`; const branchName = `agent/${runId}/${id}`; const workspacePath = createWorkerWorktree(root, runId, id, branchName); writeIfMissing(join(runDir, 'work-orders', `${id}.yaml`), yaml({ id, role: 'worker', task_id: taskId, isolated_workspace: workspacePath, branch_name: branchName, allowed_tools: ['filesystem.read', 'git.diff'], status: 'queued' })); writeIfMissing(join(runDir, 'worker-outputs', `${id}.md`), `# Worker Output\n\n## Objective\nBounded worker ${id} for ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Completion Against Acceptance Criteria\nPending collect.\n`); } writeIfMissing(join(runDir, 'synthesis.md'), '# Synthesis\n\nHuman/manager synthesis notes. Generated evidence is in synthesis.generated.md.\n'); writeIfMissing(join(runDir, 'conflict-report.md'), '# Conflict Report\n\nHuman review notes. Generated evidence is in conflict-report.generated.md.\n'); writeFileSync(join(runDir, 'synthesis.generated.md'), '# Synthesis\n\nStatus: pending\n'); writeFileSync(join(runDir, 'conflict-report.generated.md'), '# Conflict Report\n\nStatus: pending\n'); }
function createWorkerWorktree(root: string, runId: string, workerId: string, branchName: string): string { const worktreeBase = resolve(dirname(root), `${basename(root)}.agent-worktrees`, runId); const worktreePath = join(worktreeBase, workerId); ensureDir(worktreeBase); try { execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }); if (!existsSync(worktreePath)) execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); return worktreePath; } catch (err: any) { const reason = String(err.stderr || err.message || err).trim().split('\n')[0]; return `worktree_unavailable:${worktreePath}:${reason}`; } }

export async function startRun(runId: string, options: { command?: string; timeoutMs?: number } = {}, cwd = process.cwd()): Promise<RunMeta> { const root = projectRoot(cwd); const runDir = runPath(runId, cwd); const meta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta; if (meta.status === 'cancelled' || existsSync(join(runDir, 'cancel.requested'))) { meta.status = 'cancelled'; meta.ended_at = meta.ended_at || nowIso(); meta.updated_at = nowIso(); writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>)); rebuildIndex(root); return meta; } meta.status = meta.mode === 'multi' ? 'workers_running' : meta.mode === 'roles' ? 'dispatching' : 'collecting'; meta.started_at = nowIso(); meta.updated_at = meta.started_at; writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
  const defaultCommand = `${JSON.stringify(process.execPath)} -e "console.log('Dominic Orchestration task adapter executed')"`;
  const command = options.command || meta.command || defaultCommand; writeFileSync(join(runDir, 'executor-command.txt'), redact(command));
  if (requiresShellApproval(command, options.command !== undefined || meta.command !== undefined) && !hasApprovedShellMutation(runId, command, cwd)) { createApprovalInternal(runId, 'shell_mutation', 'high', `Mutating shell command requires approval for run ${runId}`, cwd, { command_sha256: commandDigest(command), command_preview: redact(command).slice(0, 240) }); meta.status = 'awaiting_approval'; meta.updated_at = nowIso(); writeFileSync(join(runDir, 'policy-blocked.md'), `# Policy Blocked\n\nMutating shell command requires approval before execution.\n`); writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>)); rebuildIndex(root); return meta; }
  if (meta.mode === 'roles') await runRoles(runDir, root, command, options.timeoutMs); else if (meta.mode === 'multi') await runMultiWorkers(runDir, command, options.timeoutMs); else await runCommand(runDir, root, command, 'executor', options.timeoutMs);
  return readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
}
interface ProcessLog { label: string; cwd: string; command: string; started_at: string; ended_at: string; exit_code: number; signal?: NodeJS.Signals | null; timed_out?: boolean; stdout: string; stderr: string; }
function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void { if (child.pid) { try { process.kill(-child.pid, signal); return; } catch {} } try { child.kill(signal); } catch {} }
function runCommand(runDir: string, cwd: string, command: string, label: string, timeoutMs = 30000, extraEnv: Record<string, string> = {}): Promise<number> { const started = nowIso(); return new Promise((resolve) => { let stdout = ''; let stderr = ''; let settled = false; let cancelled = false; const childEnv = { ...process.env, PATH: process.env.PATH ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', ...extraEnv }; const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv }); writeFileSync(join(runDir, `${label}.pid`), String(child.pid || '')); const cancelPath = join(runDir, 'cancel.requested'); const timer = setTimeout(() => { if (settled) return; terminateProcessTree(child, 'SIGTERM'); setTimeout(() => { if (!settled) terminateProcessTree(child, 'SIGKILL'); }, 1000).unref(); }, timeoutMs); const cancelTimer = setInterval(() => { if (settled) return; if (existsSync(cancelPath)) { cancelled = true; terminateProcessTree(child, 'SIGTERM'); setTimeout(() => { if (!settled) terminateProcessTree(child, 'SIGKILL'); }, 1000).unref(); } }, 100); child.stdout.on('data', (chunk) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString(); }); child.on('error', (err) => { stderr += err.message; }); child.on('close', (code, signal) => { settled = true; clearTimeout(timer); clearInterval(cancelTimer); const timedOut = signal === 'SIGKILL' || (signal === 'SIGTERM' && !cancelled); const log: ProcessLog = { label, cwd, command: redact(command), started_at: started, ended_at: nowIso(), exit_code: cancelled ? 130 : code ?? (timedOut ? 124 : 1), signal, timed_out: timedOut, stdout: redact(stdout), stderr: redact(stderr) }; writeFileSync(join(runDir, `${label}.process.json`), JSON.stringify(log, null, 2)); writeFileSync(join(runDir, `${label}.stdout.log`), log.stdout); writeFileSync(join(runDir, `${label}.stderr.log`), log.stderr); resolve(log.exit_code); }); }); }
async function runRoles(runDir: string, root: string, command: string, timeoutMs?: number): Promise<void> { const managerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'manager'), 'manager', timeoutMs, { ROLE: 'manager' }); appendFile(join(runDir, 'manager-plan.md'), `
## Process Evidence
manager exit: ${managerExit}
`); const workerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'worker').replaceAll('{worker}', 'worker-001'), 'worker-001', timeoutMs, { ROLE: 'worker', WORKER_ID: 'worker-001' }); appendFile(join(runDir, 'worker-outputs', 'worker-001.md'), `
## Process Exit
${workerExit}
`); const reviewerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'reviewer'), 'reviewer', timeoutMs, { ROLE: 'reviewer' }); appendFile(join(runDir, 'review.md'), `
## Reviewer Process Evidence
reviewer exit: ${reviewerExit}
`); }
async function runMultiWorkers(runDir: string, command: string, timeoutMs?: number): Promise<void> { const ordersDir = join(runDir, 'work-orders'); const files = readdirSync(ordersDir).filter((f) => f.endsWith('.yaml')).sort(); const startedAt = nowIso(); writeFileSync(join(runDir, 'scheduler.json'), JSON.stringify({ schema_version: 1, started_at: startedAt, max_workers: files.length, strategy: 'bounded-parallel', workers: files.map((file) => file.replace(/\.yaml$/, '')) }, null, 2)); await Promise.all(files.map(async (file) => { const workerId = file.replace(/\.yaml$/, ''); const order = readYaml(join(ordersDir, file)); const workspace = String(order.isolated_workspace || ''); if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) { const log: ProcessLog = { label: workerId, cwd: workspace || '', command, started_at: nowIso(), ended_at: nowIso(), exit_code: 125, stderr: `isolated workspace unavailable: ${workspace || 'missing'}`, stdout: '' }; writeFileSync(join(runDir, `${workerId}.process.json`), JSON.stringify(log, null, 2)); appendFile(join(runDir, 'worker-outputs', `${workerId}.md`), `\n## Process Exit\n125\n`); return; } const exit = await runCommand(runDir, workspace, command.replaceAll('{worker}', workerId), workerId, timeoutMs, { ROLE: 'worker', WORKER_ID: workerId }); appendGeneratedWorkerFiles(runDir, workerId, workspace); appendFile(join(runDir, 'worker-outputs', `${workerId}.md`), `\n## Process Exit\n${exit}\n`); })); const scheduler = JSON.parse(readFileSync(join(runDir, 'scheduler.json'), 'utf8')); scheduler.ended_at = nowIso(); writeFileSync(join(runDir, 'scheduler.json'), JSON.stringify(scheduler, null, 2)); }
function appendFile(path: string, text: string): void { writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + text : text); }
function appendGeneratedWorkerFiles(runDir: string, workerId: string, workspace: string): void { const outputPath = join(runDir, 'worker-outputs', `${workerId}.md`); if (!existsSync(outputPath)) return; const text = readFileSync(outputPath, 'utf8'); if (!/Pending execution|Pending collect/.test(text)) return; const files = collectChangedFilesFromWorkspace(workspace); if (!files.length) return; appendFile(outputPath, `
## Files Changed
${files.map((file) => `- ${file}`).join('\n')}
`); }
function redact(s: string): string { return s.replace(/(sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]'); }
function requiresShellApproval(command: string, operatorProvided: boolean): boolean { if (!operatorProvided) return false; return !isReadonlyShellCommand(command); }
function isReadonlyShellCommand(command: string): boolean { const trimmed = command.trim(); if (/[;&|<>`$(){}\[\]\n\r]/.test(trimmed)) return false; const parts = trimmed.split(/\s+/); const [cmd, sub, ...args] = parts; const safeFlags = new Set(['--short', '--branch', '--stat', '--name-only', '--name-status', '--oneline', '--decorate', '--porcelain', '--porcelain=v1', '--porcelain=v2']); if (cmd === 'pwd' && parts.length === 1) return true; if (cmd === 'ls') return args.every((a) => /^-[A-Za-z]+$/.test(a) || /^[A-Za-z0-9_./-]+$/.test(a)); if (cmd === 'cat') return args.length > 0 && args.every((a) => /^[A-Za-z0-9_./-]+$/.test(a) && !isSecretPath(a)); if (cmd !== 'git') return false; if (sub === 'worktree' && args[0] === 'list') return args.slice(1).every((a) => safeFlags.has(a)); if (!['status', 'diff', 'show', 'log', 'rev-parse', 'branch'].includes(sub || '')) return false; return args.every((a) => safeFlags.has(a) || /^[A-Za-z0-9_./:-]+$/.test(a) && !a.startsWith('--output') && a !== '-o'); }
function commandDigest(command: string): string { return createHash('sha256').update(command).digest('hex'); }
function hasApprovedShellMutation(runId: string, command: string, cwd = process.cwd()): boolean { const digest = commandDigest(command); return listApprovals(cwd).some((a) => a.run_id === runId && a.type === 'shell_mutation' && a.status === 'approved' && a.command_sha256 === digest); }

export function collectRun(runId: string, cwd = process.cwd()): RunMeta { const root = projectRoot(cwd); const runDir = runPath(runId, cwd); const runMeta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta; if (runMeta.status === 'cancelled') return runMeta; if (!hasStartedEvidence(runDir, runMeta)) { runMeta.status = 'failed'; runMeta.decision = 'blocked'; runMeta.ended_at = nowIso(); runMeta.updated_at = runMeta.ended_at; writeFileSync(join(runDir, 'review.md'), `# Review\n\n## Decision\nblocked\n\n## Blocking Issues\n- Run was collected before start/execution evidence existed.\n`); writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>)); updateTaskStatus(runMeta.task_id, 'blocked', cwd); rebuildIndex(root); return runMeta; } runMeta.status = 'collecting'; writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>)); const collectStatus = gitEvidence(['status', '--short', '--branch'], root); const collectDiff = gitEvidence(['diff'], root); writeFileSync(join(runDir, 'collect-status.txt'), collectStatus.output); const diff = collectDiff.output; writeFileSync(join(runDir, 'collect-diff.patch'), diff); writeFileSync(join(runDir, 'diff.patch'), diff); recordEvidenceError(runDir, 'collect-status', collectStatus); recordEvidenceError(runDir, 'collect-diff', collectDiff); if (!existsSync(join(runDir, 'result.md'))) writeFileSync(join(runDir, 'result.md'), `# Result\n\n## Summary\nCollected run ${runId}.\n\n## Evidence\n- baseline-status.txt\n- collect-status.txt\n- diff.patch\n`); if (runMeta.mode === 'multi') updateConflictAndSynthesis(runDir); const decision = existsSync(join(runDir, 'cancel.requested')) ? 'blocked' : writeReview(runDir, runMeta.mode || 'basic'); writeNextActions(runDir, decision); createPromotionProposal(runDir, runMeta.id); if (decision !== 'pass') createApproval(runMeta.id, decision === 'blocked' ? 'conflict_resolution' : 'changes_requested', 'high', `Run ${runMeta.id} requires ${decision}`, cwd); runMeta.status = decision === 'pass' ? 'completed' : decision === 'blocked' ? 'failed' : 'completed'; runMeta.decision = decision; runMeta.exit_code = readExitCode(runDir); runMeta.ended_at = nowIso(); runMeta.updated_at = runMeta.ended_at; writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>)); updateTaskStatus(runMeta.task_id, decision === 'pass' ? 'done' : decision === 'blocked' ? 'blocked' : 'changes_requested', cwd); rebuildIndex(root); return runMeta; }
function hasStartedEvidence(runDir: string, meta: RunMeta): boolean { if (!meta.started_at) return false; if (meta.mode === 'basic') return existsSync(join(runDir, 'executor.process.json')); if (meta.mode === 'roles') return ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json'].every((f) => existsSync(join(runDir, f))); if (meta.mode === 'multi') { const ordersDir = join(runDir, 'work-orders'); if (!existsSync(join(runDir, 'scheduler.json')) || !existsSync(ordersDir)) return false; const workers = readdirSync(ordersDir).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, '')); return workers.length > 0 && workers.every((workerId) => existsSync(join(runDir, `${workerId}.process.json`))); } return false; }
export function cancelRun(runId: string, cwd = process.cwd()): RunMeta { const root = projectRoot(cwd); const runDir = runPath(runId, cwd); writeFileSync(join(runDir, 'cancel.requested'), nowIso()); const runMeta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta; runMeta.status = 'cancelled'; runMeta.ended_at = nowIso(); runMeta.updated_at = runMeta.ended_at; writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>)); writeFileSync(join(runDir, 'cancelled.md'), `# Cancelled\n\nRun ${runId} was cancelled at ${runMeta.ended_at}.\n`); updateTaskStatus(runMeta.task_id, 'cancelled', cwd); rebuildIndex(root); return runMeta; }
function readExitCode(runDir: string): number { return readRunProcessSummary(runDir).exitCode ?? 1; }

function updateConflictAndSynthesis(runDir: string): void { const outputsDir = join(runDir, 'worker-outputs'); const outputs = existsSync(outputsDir) ? readdirSync(outputsDir).filter((f) => f.endsWith('.md')).sort() : []; const changedByWorker = new Map<string, string[]>(); const denied: string[] = []; const evidenceIssues: string[] = []; const worktreeIssues = collectWorktreeIssues(runDir); const worktreeChanges = collectWorktreeChanges(runDir, worktreeIssues); for (const output of outputs) { const workerId = output.replace(/\.md$/, ''); const text = readFileSync(join(outputsDir, output), 'utf8'); const declaredFiles = extractFilesChanged(text); const actualFiles = worktreeChanges.get(workerId) || []; const mergedFiles = new Set([...actualFiles, ...declaredFiles]); for (const file of mergedFiles) { if (isSecretPath(file)) denied.push(`${workerId}: ${file}`); const workers = changedByWorker.get(file) || []; workers.push(workerId); changedByWorker.set(file, workers); } const undeclared = actualFiles.filter((file) => !declaredFiles.includes(file)); const staleDeclared = declaredFiles.filter((file) => !actualFiles.includes(file) && !(actualFiles.includes('README.md') && file === 'README.md')); if (undeclared.length) evidenceIssues.push(`${workerId}: actual worktree changes not declared (${undeclared.join(', ')})`); if (staleDeclared.length) evidenceIssues.push(`${workerId}: declared files not present in worktree diff (${staleDeclared.join(', ')})`); } for (const [workerId, files] of worktreeChanges.entries()) { if (outputs.includes(`${workerId}.md`)) continue; for (const file of files) { if (isSecretPath(file)) denied.push(`${workerId}: ${file}`); const workers = changedByWorker.get(file) || []; workers.push(workerId); changedByWorker.set(file, workers); } if (files.length) evidenceIssues.push(`${workerId}: worktree has changes but worker output is missing`); } const overlaps = [...changedByWorker.entries()].filter(([, workers]) => new Set(workers).size > 1); const hasConflict = overlaps.length > 0 || denied.length > 0 || worktreeIssues.length > 0 || evidenceIssues.length > 0; const status = hasConflict ? 'blocked' : 'clear'; writeFileSync(join(runDir, 'conflict-report.generated.md'), ['# Conflict Report', '', `Status: ${status}`, '', `Workers reviewed: ${outputs.length}`, '', '## Overlapping Files', overlaps.length ? overlaps.map(([file, workers]) => `- ${file}: ${[...new Set(workers)].join(', ')}`).join('\n') : 'None.', '', '## Denied Paths', denied.length ? denied.map((item) => `- ${item}`).join('\n') : 'None.', '', '## Worktree Issues', worktreeIssues.length ? worktreeIssues.map((item) => `- ${item}`).join('\n') : 'None.', '', '## Evidence Mismatches', evidenceIssues.length ? evidenceIssues.map((item) => `- ${item}`).join('\n') : 'None.', '', '## Changed Files by Worker', changedByWorker.size ? [...changedByWorker.entries()].map(([file, workers]) => `- ${file}: ${workers.join(', ')}`).join('\n') : 'No changed files reported by worker outputs or worktrees.', ''].join('\n')); writeFileSync(join(runDir, 'synthesis.generated.md'), `# Synthesis\n\n## Accepted Outputs\n${outputs.map((o) => `- ${o}`).join('\n')}\n\n## Rejected Outputs\n${hasConflict ? '- Conflicting, denied, non-isolated, or mismatched worker evidence requires review before apply.' : 'None.'}\n\n## Conflicts\n${hasConflict ? 'Blocking conflicts, denied paths, worktree issues, or evidence mismatches found. See conflict-report.generated.md.' : 'No blocking conflicts detected from worker-reported changed files and actual worktree diffs.'}\n\n## Recommendation\n${hasConflict ? 'Do not apply automatically; resolve blockers first.' : 'Proceed to review.'}\n`); }
function collectWorktreeIssues(runDir: string): string[] { const workOrdersDir = join(runDir, 'work-orders'); if (!existsSync(workOrdersDir)) return ['missing work-orders directory']; const issues: string[] = []; for (const file of readdirSync(workOrdersDir).filter((f) => f.endsWith('.yaml')).sort()) { const order = readYaml(join(workOrdersDir, file)); const workspace = String(order.isolated_workspace || ''); if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) issues.push(`${file}: isolated workspace unavailable (${workspace || 'missing'})`); } return issues; }
function collectWorktreeChanges(runDir: string, issues: string[]): Map<string, string[]> { const workOrdersDir = join(runDir, 'work-orders'); const changes = new Map<string, string[]>(); if (!existsSync(workOrdersDir)) return changes; for (const file of readdirSync(workOrdersDir).filter((f) => f.endsWith('.yaml')).sort()) { const workerId = file.replace(/\.yaml$/, ''); const order = readYaml(join(workOrdersDir, file)); const workspace = String(order.isolated_workspace || ''); if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) continue; try { changes.set(workerId, collectChangedFilesFromWorkspace(workspace)); } catch (err: any) { issues.push(`${file}: failed to inspect worktree (${String(err.stderr || err.message || err).trim().split('\n')[0]})`); changes.set(workerId, []); } } return changes; }
function collectChangedFilesFromWorkspace(workspace: string): string[] { const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter(Boolean); const status = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => line.slice(3).trim().split(' -> ').pop() || '').filter(Boolean); return [...new Set([...tracked, ...status])].sort(); }
export function extractFilesChanged(workerOutput: string): string[] { const lines = workerOutput.split('\n'); const files: string[] = []; let inSection = false; for (const line of lines) { if (/^##\s+Files Changed\s*$/.test(line.trim())) { inSection = true; continue; } if (inSection && /^##\s+/.test(line.trim())) { inSection = false; continue; } if (!inSection) continue; const cleaned = line.replace(/^[-*]\s*/, '').trim(); if (!cleaned || /^none\.?$/i.test(cleaned) || /^pending/i.test(cleaned) || /^#/.test(cleaned)) continue; files.push(cleaned.split(/\s+/)[0].replace(/^`|`$/g, '').replace(/[:,]$/g, '')); } return [...new Set(files)]; }

function writeReview(runDir: string, mode: RunMode): Decision { const required = ['run.yaml', 'task.md', 'context.md', 'prompt.md', 'baseline-status.txt', 'baseline-diff.patch', 'collect-status.txt', 'collect-diff.patch', 'diff.patch', 'result.md']; if (mode === 'basic') required.push('executor.process.json'); if (mode === 'roles') required.push('manager-plan.md', 'work-orders/worker-001.yaml', 'worker-outputs/worker-001.md', 'manager.process.json', 'worker-001.process.json', 'reviewer.process.json'); if (mode === 'multi') { required.push('scheduler.json', 'synthesis.md', 'conflict-report.md', 'synthesis.generated.md', 'conflict-report.generated.md'); const ordersDir = join(runDir, 'work-orders'); if (existsSync(ordersDir)) for (const file of readdirSync(ordersDir).filter((f) => f.endsWith('.yaml'))) required.push(`${file.replace(/\.yaml$/, '')}.process.json`); } const missing = required.filter((rel) => !existsSync(join(runDir, rel))); const conflictPath = existsSync(join(runDir, 'conflict-report.generated.md')) ? 'conflict-report.generated.md' : 'conflict-report.md'; const conflictReport = existsSync(join(runDir, conflictPath)) ? readFileSync(join(runDir, conflictPath), 'utf8') : ''; const hasConflict = /Status: blocked/.test(conflictReport); const processSummary = readRunProcessSummary(runDir); if (processSummary.invalid > 0) writeFileSync(join(runDir, 'process-evidence-errors.json'), JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2)); const exitCode = processSummary.exitCode ?? 1; const evidenceErrors = existsSync(join(runDir, 'evidence-errors.json')) ? JSON.parse(readFileSync(join(runDir, 'evidence-errors.json'), 'utf8')) as any[] : []; const processInvalid = processSummary.valid === 0 || processSummary.invalid > 0; const hasIssue = missing.length > 0 || hasConflict || exitCode !== 0 || evidenceErrors.length > 0 || processInvalid; const score = hasIssue ? 6 : 9; const decision: Decision = hasConflict || evidenceErrors.length > 0 || processInvalid ? 'blocked' : hasIssue ? 'changes_requested' : 'pass'; const blockingIssues = [...missing.map((m) => `- Missing ${m}`), ...(hasConflict ? ['- Conflict report is blocked'] : []), ...(evidenceErrors.length ? evidenceErrors.map((e) => `- Evidence capture failed: ${e.label}`) : []), ...(processSummary.errors.length ? processSummary.errors.map((e) => `- Invalid process evidence: ${e}`) : []), ...(exitCode !== 0 ? [`- Executor exit code ${exitCode}`] : [])]; writeFileSync(join(runDir, 'review.md'), `# Review\n\n## Score\n${score}\n\n## Rubric Breakdown\n- Goal Fit: ${hasIssue ? 1 : 2}\n- Artifact Boundary: ${hasIssue ? 1 : 2}\n- Tool Discipline: 2\n- Reviewability: ${hasIssue ? 1 : 2}\n- Reusability: 1\n\n## Blocking Issues\n${blockingIssues.length ? blockingIssues.join('\n') : 'None.'}\n\n## Required Changes\n${hasIssue ? 'Resolve missing artifacts, failed executor, or blocked conflicts.' : 'None.'}\n\n## Risks\nDestructive operations still require approval.\n\n## Decision\n${decision}\n\n## System Patch Suggestions\n${decision === 'pass' ? 'None.' : 'Create blocker-resolution task before claiming completion.'}\n`); return decision; }
function writeNextActions(runDir: string, decision: Decision): void { writeFileSync(join(runDir, 'next-actions.md'), `# Next Actions\n\n## Immediate\n${decision === 'pass' ? 'Review artifacts and close or promote learnings.' : 'Resolve review blockers before completion.'}\n\n## Suggested System Patches\n${decision === 'pass' ? 'None.' : 'Use approval/promotion workflow for durable fixes.'}\n\n## Blockers\n${decision === 'pass' ? 'None recorded.' : 'See review.md and conflict-report.generated.md.'}\n`); }

export function createApproval(runId: string, type: string, risk: 'low' | 'medium' | 'high', summary: string, cwd = process.cwd()): ApprovalRecord { if (type === 'apply_proposal') throw new Error('apply_proposal approvals must be created by proposeApply'); return createApprovalInternal(runId, type, risk, summary, cwd); }
function createApprovalInternal(runId: string, type: string, risk: 'low' | 'medium' | 'high', summary: string, cwd = process.cwd(), extra: Partial<ApprovalRecord> = {}): ApprovalRecord { const root = projectRoot(cwd); initProject(root); const ts = nowIso(); const rec: ApprovalRecord = { schema_version: 1, id: uniqueId('approval', type), run_id: runId, type, status: 'requested', risk, summary, created_at: ts, updated_at: ts, ...extra }; writeFileSync(safeJoin(root, AGENT_DIR, 'approvals', `${rec.id}.json`), JSON.stringify(rec, null, 2)); rebuildIndex(root); return rec; }
export function listApprovals(cwd = process.cwd()): ApprovalRecord[] { const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'approvals'); if (!existsSync(dir)) return []; return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
export function resolveApproval(id: string, status: 'approved' | 'rejected', cwd = process.cwd()): ApprovalRecord { const p = safeJoin(projectRoot(cwd), AGENT_DIR, 'approvals', `${id}.json`); const rec = JSON.parse(readFileSync(p, 'utf8')) as ApprovalRecord; rec.status = status; rec.updated_at = nowIso(); writeFileSync(p, JSON.stringify(rec, null, 2)); rebuildIndex(cwd); return rec; }
function createPromotionProposal(runDir: string, runId: string): void { const text = existsSync(join(runDir, 'review.md')) ? readFileSync(join(runDir, 'review.md'), 'utf8') : ''; if (!/System Patch Suggestions\n(?!None\.)/s.test(text)) return; const ts = nowIso(); const proposalPath = join(runDir, 'promotions.md'); const rec: PromotionRecord = { schema_version: 1, id: uniqueId('promotion', runId), run_id: runId, target_type: 'memory', status: 'proposed', reason: 'Review suggested durable system patch.', target_path: '.agent/memory/project-facts.md', proposal_path: proposalPath, created_at: ts, updated_at: ts }; writeFileSync(proposalPath, `# Promotion Proposal\n\nReason: ${rec.reason}\n\nReview excerpt is in review.md.\n`); writeFileSync(join(dirname(dirname(runDir)), 'promotions', `${rec.id}.json`), JSON.stringify(rec, null, 2)); }
export function listPromotions(cwd = process.cwd()): PromotionRecord[] { const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'promotions'); if (!existsSync(dir)) return []; return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))); }

export function rebuildIndex(cwd = process.cwd()): ProductIndex { const root = projectRoot(cwd); ensureDir(safeJoin(root, AGENT_DIR)); const projectPath = safeJoin(root, AGENT_DIR, 'project.yaml'); const project = existsSync(projectPath) ? readYaml(projectPath) as unknown as ProjectRecord : null; const runsDir = safeJoin(root, AGENT_DIR, 'runs'); const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((f) => statSync(join(runsDir, f)).isDirectory() && existsSync(join(runsDir, f, 'run.yaml'))).map((f) => normalizeRunMeta(readYaml(join(runsDir, f, 'run.yaml')) as unknown as RunMeta, join(runsDir, f))).sort((a, b) => a.id.localeCompare(b.id)) : []; const artifacts: { run_id: string; type: string; path: string }[] = []; for (const run of runs) { const dir = join(root, run.run_dir); if (!existsSync(dir)) continue; for (const rel of listFilesRecursive(dir)) artifacts.push({ run_id: run.id, type: rel, path: join(run.run_dir, rel) }); } const index: ProductIndex = { schema_version: 1, generated_at: nowIso(), project, tasks: listTasks(root), runs, approvals: listApprovals(root), promotions: listPromotions(root), artifacts }; writeFileSync(safeJoin(root, AGENT_DIR, 'index.json'), JSON.stringify(index, null, 2)); return index; }
function listFilesRecursive(rootDir: string, prefix = ''): string[] { const out: string[] = []; for (const name of readdirSync(join(rootDir, prefix)).sort()) { const rel = prefix ? join(prefix, name) : name; const full = join(rootDir, rel); const st = lstatSync(full); if (st.isSymbolicLink()) continue; if (st.isDirectory()) out.push(...listFilesRecursive(rootDir, rel)); else out.push(rel); } return out; }
export function loadIndex(cwd = process.cwd()): ProductIndex { const p = safeJoin(projectRoot(cwd), AGENT_DIR, 'index.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : rebuildIndex(cwd); }


export function proposeApply(runId: string, cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const runDir = runPath(runId, cwd);
  const run = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  if (run.status !== 'completed' || run.decision !== 'pass') throw new Error(`run ${runId} is not eligible for apply proposal; collect a passing run first`);
  if (run.mode === 'multi') {
    const conflictPath = join(runDir, 'conflict-report.generated.md');
    if (!existsSync(conflictPath) || !/Status: clear/.test(readFileSync(conflictPath, 'utf8'))) throw new Error(`run ${runId} has no clear multi-worker conflict report`);
  }
  const proposalDir = join(runDir, 'apply-proposal');
  ensureDir(proposalDir);
  const patches: string[] = [];
  if (run.mode === 'multi') {
    const workOrdersDir = join(runDir, 'work-orders');
    for (const file of readdirSync(workOrdersDir).filter((f) => f.endsWith('.yaml')).sort()) {
      const workerId = file.replace(/\.yaml$/, '');
      const order = readYaml(join(workOrdersDir, file));
      const workspace = String(order.isolated_workspace || '');
      if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) throw new Error(`cannot create apply proposal: ${workerId} isolated workspace unavailable`);
      const files = collectChangedFilesFromWorkspace(workspace);
      const denied = files.filter(isSecretPath);
      if (denied.length) throw new Error(`refusing apply proposal with denied paths from ${workerId}: ${denied.join(', ')}`);
      const patch = git(['diff', '--binary', 'HEAD'], workspace) + git(['diff', '--binary', '--cached'], workspace) + git(['ls-files', '--others', '--exclude-standard'], workspace).split('\n').filter(Boolean).map((file) => normalizeNoIndexPatch(gitNoIndexPatch(workspace, file))).join('\n');
      const patchPath = join(proposalDir, `${workerId}.patch`);
      writeFileSync(patchPath, patch);
      patches.push(patchPath);
    }
  } else {
    throw new Error(`apply proposal requires isolated multi-worker run; ${run.mode} runs mutate the live workspace directly`);
  }
  if (!patches.some((patchPath) => readFileSync(patchPath, 'utf8').trim())) throw new Error(`apply proposal for ${runId} has no patch content`); const digest = createHash('sha256'); for (const patchPath of patches) digest.update(readFileSync(patchPath)); const proposalSha = digest.digest('hex'); const manifest = { schema_version: 1, run_id: runId, patches: patches.map((x) => relative(proposalDir, x)), sha256: proposalSha, created_at: nowIso() }; writeFileSync(join(proposalDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(proposalDir, 'README.md'), `# Apply Proposal\n\nRun: ${runId}\n\nThis proposal is approval-gated. Review patch files before applying.\n\nPatches:\n${patches.map((x) => `- ${x}`).join('\n')}\n`);
  return createApprovalInternal(runId, 'apply_proposal', 'high', `Review apply proposal for ${runId}: ${relative(root, proposalDir)}`, cwd, { proposal_sha256: proposalSha, proposal_path: relative(root, proposalDir) });
}

export function applyApprovedProposal(approvalId: string, cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const approvalPath = safeJoin(root, AGENT_DIR, 'approvals', `${approvalId}.json`);
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8')) as ApprovalRecord;
  if (approval.status !== 'approved') throw new Error(`approval ${approvalId} is not approved`);
  if (approval.type !== 'apply_proposal') throw new Error(`approval ${approvalId} is not an apply_proposal`);
  const runDir = runPath(approval.run_id, cwd);
  const run = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta; if (run.status !== 'completed' || run.decision !== 'pass') throw new Error(`run ${approval.run_id} is not eligible for apply`);
  const proposalDir = join(runDir, 'apply-proposal');
  if (!existsSync(proposalDir)) throw new Error(`missing apply proposal for ${approval.run_id}`);
  const manifestPath = join(proposalDir, 'manifest.json'); if (!existsSync(manifestPath)) throw new Error(`missing apply proposal manifest for ${approval.run_id}`); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); if (manifest.run_id !== approval.run_id) throw new Error(`apply proposal run mismatch for ${approval.run_id}`); const manifestPatches = Array.isArray(manifest.patches) ? manifest.patches : []; if (!manifestPatches.length) throw new Error(`apply proposal manifest has no patches for ${approval.run_id}`); const seen = new Set<string>(); const patches = manifestPatches.map((relPath: string) => { if (typeof relPath !== 'string' || relPath.startsWith('/') || relPath.includes('..')) throw new Error(`invalid manifest patch path: ${relPath}`); if (seen.has(relPath)) throw new Error(`duplicate manifest patch path: ${relPath}`); seen.add(relPath); const full = safeJoin(proposalDir, relPath); if (!existsSync(full) || !readFileSync(full, 'utf8').trim()) throw new Error(`missing manifest patch: ${relPath}`); return full; }); const diskPatches = readdirSync(proposalDir).filter((f) => f.endsWith('.patch')).sort(); const manifestNames = [...seen].map((x) => basename(x)).sort(); if (JSON.stringify(diskPatches) !== JSON.stringify(manifestNames)) throw new Error(`apply proposal patch set differs from manifest for ${approval.run_id}`); const touched = new Set<string>(); for (const patch of patches) { const content = readFileSync(patch, 'utf8'); if (!content.trim().startsWith('diff --git ')) throw new Error(`invalid patch content: ${basename(patch)}`); for (const file of patchTouchedFiles(content)) { if (touched.has(file)) throw new Error(`apply proposal has overlapping patch target: ${file}`); touched.add(file); } } const digest = createHash('sha256'); for (const patch of patches) digest.update(readFileSync(patch)); const actualSha = digest.digest('hex'); if (manifest.sha256 !== actualSha || approval.proposal_sha256 !== actualSha) throw new Error(`apply proposal digest mismatch for ${approval.run_id}`);
  try {
    const bundlePath = join(proposalDir, 'bundle.patch'); writeFileSync(bundlePath, patches.map((patch: string) => readFileSync(patch, 'utf8')).join('\n'));
    execFileSync('git', ['apply', '--check', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['apply', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) { approval.status = 'failed_to_apply'; approval.updated_at = nowIso(); writeFileSync(approvalPath, JSON.stringify(approval, null, 2)); throw new Error(String(err.stderr || err.message || err)); }
  approval.status = 'applied'; approval.updated_at = nowIso(); writeFileSync(approvalPath, JSON.stringify(approval, null, 2)); rebuildIndex(root); return approval;
}

export interface ProductGateCheck { name: string; status: 'PASS' | 'FAIL'; evidence: string; }
export interface ProductGateDelta { target: string; evidence: string; delta: string; status: 'PASS' | 'FAIL'; }
export interface ProductGateReport { schema_version: number; generated_at: string; decision: 'PASS' | 'FAIL'; scope: string; completion_ceiling: number; completion_label: string; result_reality_delta: ProductGateDelta[]; checks: ProductGateCheck[]; report_path?: string; }
function hasAll(text: string, needles: string[]): boolean { return needles.every((needle) => text.includes(needle)); }
function readIfExists(path: string): string { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
function gateCheck(name: string, ok: boolean, evidence: string): ProductGateCheck { return { name, status: ok ? 'PASS' : 'FAIL', evidence }; }
function jsonIfExists(path: string): any { try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; } }
function commandEvidence(root: string, args: string[], mustInclude: string[]): boolean { try { const out = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }); return mustInclude.every((needle) => out.includes(needle)); } catch { return false; } }
function markdownTableRows(text: string): string[][] { return text.split('\n').filter((line) => /^\|.*\|$/.test(line.trim()) && !/^\|\s*-/.test(line.trim())).map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim())); }
function hasPassingMatrixRows(roadmap: string, requiredAreas: string[]): boolean { const rows = markdownTableRows(roadmap); return requiredAreas.every((area) => rows.some((row) => row[0] === area && row.at(-1) === 'PASS')) && !rows.some((row) => row.at(-1) === 'FAIL'); }
function countTests(testText: string): number { return [...testText.matchAll(/\btest\(/g)].length; }

function runProcessJsonFiles(runDir: string): string[] { return existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith('.process.json')).sort() : []; }
function readRunProcessSummary(runDir: string): { exitCode: number | null; stderr: string; stdout: string; valid: number; invalid: number; errors: string[] } {
  const files = runProcessJsonFiles(runDir);
  if (!files.length) return { exitCode: null, stderr: '', stdout: '', valid: 0, invalid: 0, errors: [] };
  let exitCode = 0; let stderr = ''; let stdout = ''; let valid = 0; let invalid = 0; const errors: string[] = [];
  for (const file of files) {
    try { const p = JSON.parse(readFileSync(join(runDir, file), 'utf8')); if (typeof p.exit_code !== 'number') throw new Error('missing numeric exit_code'); valid++; if (p.exit_code !== 0) exitCode = p.exit_code; stderr += String(p.stderr || ''); stdout += String(p.stdout || ''); } catch (err: any) { invalid++; errors.push(`${file}: ${String(err.message || err)}`); }
  }
  if (valid === 0 || invalid > 0) exitCode = 1;
  return { exitCode, stderr, stdout, valid, invalid, errors };
}
function normalizeRunMeta(meta: RunMeta, runDir: string): RunMeta {
  const out = { ...meta };
  const hasCancel = existsSync(join(runDir, 'cancel.requested'));
  const hasEnded = Boolean(out.ended_at);
  const processSummary = readRunProcessSummary(runDir);
  const hasReview = existsSync(join(runDir, 'review.md')) && Boolean(out.decision);
  const processOk = processSummary.valid > 0 && processSummary.invalid === 0 && processSummary.exitCode === 0;
  if (processSummary.invalid > 0) writeFileSync(join(runDir, 'process-evidence-errors.json'), JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2));
  if (processSummary.invalid > 0) { out.status = 'failed'; out.decision = 'blocked'; out.exit_code = processSummary.exitCode ?? 1; out.ended_at = out.ended_at || nowIso(); out.updated_at = nowIso(); return out; }
  if (hasCancel) { out.status = 'cancelled'; out.ended_at = out.ended_at || nowIso(); out.updated_at = out.updated_at || out.ended_at; return out; }
  if (['completed', 'failed', 'timed_out'].includes(String(out.status)) && processSummary.exitCode !== null && !processOk) { out.status = 'failed'; out.exit_code = processSummary.exitCode ?? 1; out.updated_at = nowIso(); return out; }
  if (activeStatus(out.status) && hasEnded) { out.status = hasReview && processOk ? 'completed' : 'failed'; out.exit_code = processSummary.exitCode ?? out.exit_code; return out; }
  if (out.status === 'created' && processSummary.exitCode !== null) { out.status = hasReview && processOk ? 'completed' : 'failed'; out.exit_code = processSummary.exitCode; out.ended_at = out.ended_at || nowIso(); return out; }
  return out;
}
export function reconcileRuns(cwd = process.cwd()): { checked: number; repaired: number; repairs: string[] } {
  const root = projectRoot(cwd); const agentDir = safeJoin(root, AGENT_DIR); ensureDir(agentDir); const dir = safeJoin(root, AGENT_DIR, 'runs'); if (!existsSync(dir)) { const empty = { checked: 0, repaired: 0, repairs: [] as string[] }; writeFileSync(join(agentDir, 'reconciliation.json'), JSON.stringify({ status: 'PASS', ...empty, generated_at: nowIso() }, null, 2)); return empty; }
  let checked = 0; let repaired = 0; const repairs: string[] = [];
  for (const runId of readdirSync(dir).filter((f) => existsSync(join(dir, f, 'run.yaml'))).sort()) {
    checked++; const runDir = join(dir, runId); const p = join(runDir, 'run.yaml'); const before = readYaml(p) as unknown as RunMeta; const after = normalizeRunMeta(before, runDir); const beforeText = yaml(before as unknown as Record<string, unknown>); const afterText = yaml(after as unknown as Record<string, unknown>);
    const cmdPath = join(runDir, 'executor-command.txt'); let repairedCommand = false; const cmd = readIfExists(cmdPath).trim(); if (/^(진행해|다시|해봐|좋아|ㅇㅋ|오케이)(\s|$)/.test(cmd)) { writeFileSync(cmdPath, `[reconciled natural-language operator reply; not an executable command] ${cmd}\n`); repairedCommand = true; } if (beforeText !== afterText || repairedCommand) { writeFileSync(p, afterText); repaired++; repairs.push(`${runId}: ${before.status} -> ${after.status}${repairedCommand ? '; reconciled natural-language command' : ''}`); }
  }
  const result = { checked, repaired, repairs };
  writeFileSync(join(agentDir, 'reconciliation.json'), JSON.stringify({ status: repaired === 0 ? 'PASS' : 'FAIL', ...result, generated_at: nowIso() }, null, 2));
  rebuildIndex(root); return result;
}

function activeStatus(status: unknown): boolean { return ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(status)); }

function currentReviewInputHash(root: string): string {
  const digest = createHash('sha256');
  for (const rel of ['src/core.ts', 'src/cli.ts', 'src/core.test.ts', 'scripts/live-integration-smoke.mjs', 'docs/milestones/HARD_COMPLETION_GATES.md', 'docs/milestones/FULL_PRODUCT_ROADMAP.md', 'docs/milestones/DOGFOOD_REPORT.md']) {
    const p = join(root, rel); digest.update(rel); digest.update(existsSync(p) ? readFileSync(p) : 'missing');
  }
  return digest.digest('hex');
}
function sha256Text(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function reviewArtifactOk(root: string, reviewGate: any): boolean {
  if (!reviewGate || reviewGate.status !== 'PASS') return false;
  const inputHash = currentReviewInputHash(root);
  if (reviewGate.input_sha256 !== inputHash) return false;
  const cr = reviewGate.codeReview;
  if (cr?.recommendation !== 'APPROVE' || cr?.architectStatus !== 'CLEAR') return false;
  const reviewer = cr.independentReview?.codeReviewer;
  const architect = cr.independentReview?.architect;
  const reviewerPath = reviewer?.artifact_path;
  const architectPath = architect?.artifact_path;
  if (!reviewerPath || !architectPath || reviewerPath === architectPath) return false;
  const invalidReviewText = (text: string): boolean => /\b(fake|placeholder|stub|dummy|todo|lorem)\b/i.test(text) || text.trim().split(/\s+/).length < 25;
  const validAgentId = (id: unknown): boolean => typeof id === 'string' && /^019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  const validIso = (x: unknown): boolean => typeof x === 'string' && !Number.isNaN(Date.parse(x));
  const reviewerFull = join(root, reviewerPath);
  const architectFull = join(root, architectPath);
  if (typeof reviewerPath !== 'string' || typeof architectPath !== 'string' || reviewerPath.startsWith('/') || architectPath.startsWith('/') || reviewerPath.includes('..') || architectPath.includes('..')) return false;
  if (!existsSync(reviewerFull) || !existsSync(architectFull)) return false;
  const reviewerText = readFileSync(reviewerFull, 'utf8');
  const architectText = readFileSync(architectFull, 'utf8');
  const reviewerSha = sha256Text(reviewerText);
  const architectSha = sha256Text(architectText);
  if (invalidReviewText(reviewerText) || invalidReviewText(architectText)) return false;
  if (!/code-reviewer/i.test(reviewerText) || !/recommendation\s*:\s*APPROVE/i.test(reviewerText)) return false;
  if (!/architect/i.test(architectText) || !/architectural status\s*:\s*CLEAR/i.test(architectText)) return false;
  for (const [entry, role, sha] of [[reviewer, 'code-reviewer', reviewerSha], [architect, 'architect', architectSha]] as const) {
    if (entry?.agentRole !== role) return false;
    if (entry?.artifact_sha256 !== sha) return false;
    if (entry?.reviewed_input_sha256 !== inputHash) return false;
    if (!validAgentId(entry?.agent_id)) return false;
    if (entry?.source !== 'codex-native-subagent') return false;
    if (entry?.status !== 'completed') return false;
    if (!validIso(entry?.completed_at)) return false;
    if (!Array.isArray(entry?.commands) || entry.commands.length < 2) return false;
    const notificationPath = entry?.notification_path;
    if (typeof notificationPath !== 'string' || notificationPath.startsWith('/') || notificationPath.includes('..')) return false;
    const notification = jsonIfExists(join(root, notificationPath));
    const completedText = String(notification?.status?.completed || '');
    if (notification?.agent_path !== entry.agent_id) return false;
    if (sha256Text(completedText) !== sha) return false;
    if (completedText !== (role === 'code-reviewer' ? reviewerText : architectText)) return false;
    if (role === 'code-reviewer' && !/Recommendation\s*:\s*APPROVE/i.test(completedText)) return false;
    if (role === 'architect' && !/Architectural Status\s*:\s*CLEAR/i.test(completedText)) return false;
  }
  return true;
}
function hardGateRows(text: string): { total: number; fail: number; pass: number } {
  const rows = markdownTableRows(text).filter((row) => row.length >= 3 && row[0] !== 'Gate');
  return { total: rows.length, fail: rows.filter((row) => row.at(-1) === 'FAIL').length, pass: rows.filter((row) => row.at(-1) === 'PASS').length };
}
function contradictoryRunEvidence(root: string): string[] {
  const dir = join(root, AGENT_DIR, 'runs');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const runId of readdirSync(dir).filter((f) => existsSync(join(dir, f, 'run.yaml'))).sort()) {
    const runDir = join(dir, runId);
    const meta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
    const hasEnded = Boolean(meta.ended_at);
    const hasCancel = existsSync(join(runDir, 'cancel.requested'));
    const hasProcess = readdirSync(runDir).some((f) => f.endsWith('.process.json'));
    if (activeStatus(meta.status) && (hasEnded || hasCancel)) out.push(`${runId}: active status ${meta.status} with ended/cancel evidence`);
    if (meta.status === 'created' && hasProcess) out.push(`${runId}: created status with process evidence`);
    const cmdPath = join(runDir, 'executor-command.txt');
    const cmd = readIfExists(cmdPath).trim();
    if (/^(진행해|다시|해봐|좋아|ㅇㅋ|오케이)(\s|$)/.test(cmd)) out.push(`${runId}: natural-language operator reply captured as command (${cmd.slice(0, 40)})`);
  }
  return out;
}

function dogfoodEvidence(rootDir: string, dogfood: string): { ok: boolean; root: string; basicRun: string; multiRun: string; approval: string; evidence: string } {
  const root = dogfood.match(/root=([^\s]+)/)?.[1] || '';
  const basicRun = dogfood.match(/basic_run=([^\s]+)/)?.[1] || '';
  const multiRun = dogfood.match(/multi_run=([^\s]+)/)?.[1] || '';
  const approval = dogfood.match(/approval=([^\s]+)/)?.[1] || '';
  const basicDir = root && basicRun ? join(root, AGENT_DIR, 'runs', basicRun) : '';
  const multiDir = root && multiRun ? join(root, AGENT_DIR, 'runs', multiRun) : '';
  const approvalPath = root && approval ? join(root, AGENT_DIR, 'approvals', `${approval}.json`) : '';
  const basicYaml = basicDir && existsSync(join(basicDir, 'run.yaml')) ? readYaml(join(basicDir, 'run.yaml')) : {};
  const multiYaml = multiDir && existsSync(join(multiDir, 'run.yaml')) ? readYaml(join(multiDir, 'run.yaml')) : {};
  const basicProcess = basicDir ? jsonIfExists(join(basicDir, 'executor.process.json')) : null;
  const scheduler = multiDir ? jsonIfExists(join(multiDir, 'scheduler.json')) : null;
  const approvalJson = approvalPath ? jsonIfExists(approvalPath) : null;
  const manifestPath = approvalJson?.proposal_path ? join(root, String(approvalJson.proposal_path), 'manifest.json') : '';
  const manifest = manifestPath ? jsonIfExists(manifestPath) : null;
  const patchFiles = manifestPath && Array.isArray(manifest?.patches) ? manifest.patches.map((patch: string) => join(dirname(manifestPath), patch)) : [];
  const basicOk = basicYaml.id === basicRun && basicYaml.mode === 'basic' && basicYaml.status === 'completed' && basicYaml.decision === 'pass' && Number(basicYaml.exit_code) === 0 && basicProcess?.label === 'executor' && Number(basicProcess?.exit_code) === 0 && String(basicProcess?.stdout || '').includes('Dominic Orchestration task adapter executed') && /## Decision\npass/.test(readIfExists(join(basicDir, 'review.md')));
  const multiOk = multiYaml.id === multiRun && multiYaml.mode === 'multi' && multiYaml.status === 'completed' && multiYaml.decision === 'pass' && Number(multiYaml.exit_code) === 0 && Number(multiYaml.max_workers) >= 2 && scheduler?.strategy === 'bounded-parallel' && Array.isArray(scheduler?.workers) && scheduler.workers.length >= 2 && Boolean(scheduler?.ended_at) && /Status: clear/.test(readIfExists(join(multiDir, 'conflict-report.generated.md'))) && /worker-001/.test(readIfExists(join(multiDir, 'conflict-report.generated.md'))) && /worker-002/.test(readIfExists(join(multiDir, 'conflict-report.generated.md')));
  const patchesOk = patchFiles.length >= 1 && patchFiles.every((patch: string) => existsSync(patch) && readFileSync(patch, 'utf8').trim().startsWith('diff --git '));
  const patchDigest = patchesOk ? (() => { const digest = createHash('sha256'); for (const patch of patchFiles) digest.update(readFileSync(patch)); return digest.digest('hex'); })() : '';
  const applyOk = approvalJson?.id === approval && approvalJson?.run_id === multiRun && approvalJson?.type === 'apply_proposal' && ['approved', 'applied'].includes(String(approvalJson?.status)) && manifest?.run_id === multiRun && /^[a-f0-9]{64}$/.test(String(manifest?.sha256 || '')) && manifest?.sha256 === approvalJson?.proposal_sha256 && manifest?.sha256 === patchDigest && patchesOk;
  const legacyOk = Boolean(root && basicRun && multiRun && approval && basicOk && multiOk && applyOk);
  const liveReport = jsonIfExists(join(rootDir, AGENT_DIR, 'live-integration-smoke.json'));
  const liveOk = liveReport?.status === 'PASS' && typeof liveReport?.run_id === 'string' && liveReport?.exit_code === 0 && liveReport?.decision === 'pass' && liveReport?.natural_language_ignored === true && liveReport?.ui_permission_boundary === true;
  const ok = legacyOk || liveOk;
  const reasons = [basicOk ? '' : 'basic run content invalid', multiOk ? '' : 'multi run content invalid', applyOk ? '' : 'apply proposal content invalid'].filter(Boolean).join('; ');
  return { ok, root, basicRun, multiRun, approval, evidence: legacyOk ? `resolved coherent dogfood artifacts at ${root}` : liveOk ? `resolved live web/CLI integration artifact ${join(AGENT_DIR, 'live-integration-smoke.json')}` : `missing/unresolved dogfood artifacts root=${root || 'missing'} basic=${basicRun || 'missing'} multi=${multiRun || 'missing'} approval=${approval || 'missing'} ${reasons}`.trim() };
}
function deltaRow(target: string, ok: boolean, evidence: string, passDelta: string, failDelta: string): ProductGateDelta { return { target, evidence, delta: ok ? passDelta : failDelta, status: ok ? 'PASS' : 'FAIL' }; }
export function runProductGate(cwd = process.cwd(), options: { write?: boolean } = {}): ProductGateReport {
  const root = projectRoot(cwd);
  const liveReconciliation = reconcileRuns(root);
  const prd = readIfExists(join(root, 'dominic_orchestration_PRD.md'));
  const standard = readIfExists(join(root, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'));
  const roadmap = readIfExists(join(root, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'));
  const rerun = readIfExists(join(root, 'docs', 'milestones', 'PRODUCT_GATE_RERUN_REPORT.md'));
  const dogfood = readIfExists(join(root, 'docs', 'milestones', 'DOGFOOD_REPORT.md'));
  const hardGates = readIfExists(join(root, 'docs', 'milestones', 'HARD_COMPLETION_GATES.md'));
  const packageJson = jsonIfExists(join(root, 'package.json'));
  const tests = readIfExists(join(root, 'src', 'core.test.ts'));
  const helpOk = existsSync(join(root, 'dist', 'cli.js')) && commandEvidence(root, ['dist/cli.js', '--help'], ['agent quality gate [--write]', 'agent run create|start|collect|cancel|latest', 'agent apply propose|approved']);
  const versionOk = existsSync(join(root, 'dist', 'cli.js')) && commandEvidence(root, ['dist/cli.js', '--version'], ['dominic-orchestration']);
  const requiredRows = ['Installable CLI', 'Web UI', 'Project registry', 'Durable index', 'v0 run lifecycle', 'v1 role execution', 'Executor adapter', 'Policy/approval', 'Promotion proposals', 'v2 scheduler', 'v2 worktrees', 'Conflict detection', 'Apply/merge proposal', 'Dogfood', 'Scope integrity', 'Anti-self-deception critic'];
  const reportHasDelta = hasAll(rerun, ['Result-Reality Delta', '| Original PRD / v0-v2 target | Current runnable evidence | Delta |', 'Forbidden completion claim', 'Allowed completion claim']);
  const prdScopeOk = hasAll(prd, ['로컬 웹서비스', '로컬 에이전트 작업', 'v0: Single Run + Review', 'v1: Manager + Worker + Reviewer', 'v2: Bounded Multi-Worker']);
  const acceptanceOk = hasPassingMatrixRows(roadmap, requiredRows);
  const dogfoodResolved = dogfoodEvidence(root, dogfood);
  const executionOk = dogfoodResolved.ok && (hasAll(dogfood, ['FINAL_PRODUCT_SMOKE_PASS', 'basic_run=', 'multi_run=', 'approval=']) || hasAll(dogfood, ['LIVE_INTEGRATION_SMOKE_PASS', 'live_integration_run='])) && hasAll(tests, ['executor.process.json', 'scheduler.json', 'worker-001.process.json', 'roles mode passes distinct ROLE context']);
  const evidenceOk = hasAll(tests, ['actual worktree changes not declared', 'declared files not present in worktree diff', 'multi mode detects actual worktree conflicts', 'multi mode blocks stale declared files absent from actual worktree diff']);
  const safetyOk = hasAll(tests, ['unsafe-host auth does not leak tokens', 'readonly shell allowlist rejects mutating git output flags', 'secret path detection and safeJoin reject unsafe paths', 'shell mutation approvals are bound to the exact command digest', 'applyApprovedProposal checks whole bundle before applying']);
  const regressionOk = countTests(tests) >= 49 && hasAll(tests, ['fake string-only repo cannot pass the product gate', 'product gate durable report contains report_path', 'hard completion ceiling requires independent review and reconciliation artifacts']);
  const hardRows = hardGateRows(hardGates);
  const contradictoryRuns = contradictoryRunEvidence(root);
  const hardGateDocOk = hasAll(hardGates, ['CLAIM_LOCK: FORBID_90_95_UNTIL_ALL_HARD_GATES_PASS', 'CURRENT_COMPLETION_CEILING: 60', 'Local-Web State Truth Gate', 'Real Agent Runtime Gate', 'Operator Intent Boundary Gate', 'Live Integration Gate']);
  const liveSmokeOk = existsSync(join(root, 'scripts', 'live-integration-smoke.mjs')) && commandEvidence(root, ['scripts/live-integration-smoke.mjs'], ['LIVE_INTEGRATION_SMOKE_PASS']) && jsonIfExists(join(root, AGENT_DIR, 'live-integration-smoke.json'))?.status === 'PASS';
  const forbiddenClaimsRemain = hardRows.fail > 0 && /\| .* \| .* \| PASS \|/.test(roadmap);
  const reconciliationGate = jsonIfExists(join(root, AGENT_DIR, 'reconciliation.json'));
  const reconciliationOk = liveReconciliation.repaired === 0 && reconciliationGate?.status === 'PASS' && Number(reconciliationGate?.repaired || 0) === 0;
  const reviewGate = jsonIfExists(join(root, AGENT_DIR, 'independent-review-gate.json'));
  const independentReviewOk = reviewArtifactOk(root, reviewGate);
  const hardGatesAllPass = hardGateDocOk && hardRows.total >= 7 && hardRows.fail === 0 && hardRows.pass >= 7 && contradictoryRuns.length === 0 && reconciliationOk && liveSmokeOk && independentReviewOk && !forbiddenClaimsRemain;
  const resultRealityDelta: ProductGateDelta[] = [
    deltaRow('Original PRD scope: local webservice, task/run/worker/review/promotion, v0-v2 bounded flow', prdScopeOk, 'dominic_orchestration_PRD.md required scope anchors', 'Claimed local v0-v2 scope is PRD-derived.', 'Cannot prove claimed scope from original PRD.'),
    deltaRow('Runnable operator surface: installable CLI and command help/version', Boolean(packageJson?.bin?.agent === './dist/cli.js') && helpOk && versionOk, 'package.json bin + dist/cli.js --help/--version', 'Runnable CLI evidence exists.', 'CLI/package evidence is missing or not runnable.'),
    deltaRow('Acceptance matrix: every PRD-scoped row passes without FAIL', acceptanceOk, 'docs/milestones/FULL_PRODUCT_ROADMAP.md parsed table rows', 'Matrix has all required PASS rows and no FAIL rows.', 'Acceptance matrix is incomplete or contains FAIL rows.'),
    deltaRow('Real execution: dogfood run ids plus process/scheduler/role regressions', executionOk, `${dogfoodResolved.evidence}; DOGFOOD_REPORT.md + src/core.test.ts behavioral tests`, 'Execution evidence is stronger than prose.', 'Execution evidence is missing or prose-only.'),
    deltaRow('Evidence integrity: worker output checked against actual worktree diff', evidenceOk, 'src/core.test.ts mismatch/conflict tests', 'Worker prose is not the sole truth source.', 'No deterministic mismatch/conflict regression evidence.'),
    deltaRow('Safety: command/control boundaries covered by adversarial tests', safetyOk, 'src/core.test.ts safety and approval tests', 'Policy/safety claims have adversarial tests.', 'Policy/safety claims lack adversarial tests.'),
    deltaRow('Anti-rubber-stamp regression: fake string-only repo fails', regressionOk, 'src/core.test.ts positive and negative product gate tests', 'The gate has negative tests against string-only self-certification.', 'The gate lacks negative anti-rubber-stamp tests.'),
    deltaRow('Hard completion ceiling: no 90/95 claim while live UI/runtime gates fail', hardGatesAllPass, `docs/milestones/HARD_COMPLETION_GATES.md rows=${hardRows.total} fail=${hardRows.fail}; contradictory_runs=${contradictoryRuns.length}; live_smoke=${liveSmokeOk}; reconciliation=${reconciliationOk}; independent_review=${independentReviewOk}`, 'All hard gates pass, so the completion ceiling can be lifted.', `Hard gates block completion inflation: ${hardRows.fail} declared FAIL rows; ${contradictoryRuns.length} contradictory run artifacts.`)
  ];
  const deltaOk = resultRealityDelta.every((row) => row.status === 'PASS');
  const checks: ProductGateCheck[] = [
    gateCheck('PRD Scope Integrity Gate', prdScopeOk && deltaOk, 'Original PRD scope and the Result-Reality Delta report must both exist; local-first scope must be PRD-derived, not invented after implementation.'),
    gateCheck('Anti-Self-Deception Critic Gate', hasAll(standard, ['Anti-Self-Deception Critic Gate', 'Scope Integrity Gate', 'rubber-stamp', '원 PRD', 'Result-Reality Delta']) && deltaOk && (!rerun || reportHasDelta), 'The repo must document the rubber-stamp failure mode and include an explicit PRD-vs-result delta plus allowed/forbidden completion wording.'),
    gateCheck('Product Completeness Gate', Boolean(packageJson?.bin?.agent === './dist/cli.js') && helpOk && versionOk && acceptanceOk, 'Package bin, built CLI help/version, and every PRD-scoped acceptance matrix row must pass without FAIL rows.'),
    gateCheck('Real Execution Gate', executionOk, 'Execution claims require dogfood run identifiers plus process/scheduler/role regression evidence.'),
    gateCheck('Evidence Integrity Gate', evidenceOk, 'Worker prose must be tested against actual worktree diff mismatches and conflicts.'),
    gateCheck('Safety and Policy Gate', safetyOk, 'Security/policy gates must be backed by adversarial tests, not just source-code strings.'),
    gateCheck('Operator UX Gate', helpOk && hasAll(rerun, ['CLI/Web controls', 'agent quality gate --write']) && hasAll(roadmap, ['UI shows worker lanes', 'Run detail UI showing all required evidence']), 'CLI help and reports must expose task/run/approval/product gate controls without manual .agent editing.'),
    gateCheck('Regression Gate', regressionOk, 'Regression tests must include positive and negative anti-rubber-stamp fixtures plus durable report-path coverage.'),
    gateCheck('Dogfood Gate', dogfoodResolved.ok && (hasAll(dogfood, ['FINAL_PRODUCT_SMOKE_PASS', 'WEB_CSRF_SMOKE_PASS', 'FINAL_POLICY_EVIDENCE_PASS']) || hasAll(dogfood, ['LIVE_INTEGRATION_SMOKE_PASS', 'natural-language command ignored'])), 'Dogfood must record real product use and policy/web smoke evidence.'),
    gateCheck('Hard Completion Ceiling Gate', hardGatesAllPass, hardGatesAllPass ? 'All hard gates pass and no contradictory run artifacts exist.' : `90/95 claims forbidden: hard gate rows fail=${hardRows.fail}, pass=${hardRows.pass}, live_smoke=${liveSmokeOk}; reconciliation=${reconciliationOk}; independent_review=${independentReviewOk}, forbidden_claims=${forbiddenClaimsRemain}, contradictory run artifacts=${contradictoryRuns.slice(0, 5).join('; ') || 'none'}`)
  ];
  const decision = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const completionCeiling = hardGatesAllPass ? 95 : 60;
  const completionLabel = hardGatesAllPass ? 'PRD-scoped completion candidate' : 'Prototype / control-plane scaffold with hard blockers; 90/95 claims forbidden';
  const report: ProductGateReport = { schema_version: 1, generated_at: nowIso(), decision, scope: 'PRD-scoped local v0-v2 product; no 90/95 claim allowed unless Hard Completion Ceiling Gate passes.', completion_ceiling: completionCeiling, completion_label: completionLabel, result_reality_delta: resultRealityDelta, checks };
  if (options.write) {
    const dir = safeJoin(root, AGENT_DIR, 'product-gates'); ensureDir(dir);
    const reportPath = join(dir, `product-gate-${nowIso().replace(/[-:TZ.]/g, '').slice(0, 14)}.json`);
    report.report_path = relative(root, reportPath);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    rebuildIndex(root);
  }
  return report;
}

export function renderHtml(cwd = process.cwd(), csrfToken = '', authToken = ''): string {
  const index = loadIndex(cwd);
  const csrf = csrfToken ? `<input type="hidden" name="csrf" value="${attr(csrfToken)}">` : '';
  const auth = authToken ? `<input type="hidden" name="auth" value="${attr(authToken)}">` : '';
  const hidden = csrf + auth;
  const requestedApprovals = index.approvals.filter((a) => a.status === 'requested');
  const openTasks = index.tasks.filter((t) => !['done', 'cancelled', 'abandoned'].includes(t.status));
  const activeStatuses = ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'];
  const waitingRuns = index.runs.filter((r) => ['created', 'awaiting_approval', 'changes_requested'].includes(String(r.status)) || String(r.decision || '') === 'changes_requested');
  const activeRuns = index.runs.filter((r) => activeStatuses.includes(String(r.status)) && !r.ended_at);
  const completedRuns = index.runs.filter((r) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(String(r.status)) || (activeStatuses.includes(String(r.status)) && Boolean(r.ended_at))).slice(-8).reverse();
  const approvalPanel = requestedApprovals.length ? requestedApprovals.map((a) => `<div class="decision-item"><div><strong>${esc(a.type)}</strong><p>${esc(a.summary)}</p>${a.command_preview ? `<small>Command waiting: ${esc(a.command_preview)}</small>` : ''}<small>${esc(a.risk)} risk · ${esc(a.id)}</small></div><div class="actions"><form method="POST" action="/api/approvals/${attr(a.id)}/approve">${hidden}<button class="primary">Approve</button></form><form method="POST" action="/api/approvals/${attr(a.id)}/reject">${hidden}<button>Reject</button></form>${a.type === 'apply_proposal' && a.status === 'approved' ? `<form method="POST" action="/api/approvals/${attr(a.id)}/apply">${hidden}<button>Apply Approved</button></form>` : ''}</div></div>`).join('') : '<p class="empty">No approval waiting for you.</p>';
  const taskPanel = openTasks.length ? openTasks.map((t) => `<div class="task-line"><div><strong>${attr(t.title)}</strong><small>${esc(t.status)} · ${esc(t.id)}</small></div><form method="POST" action="/api/runs">${hidden}<input type="hidden" name="taskId" value="${attr(t.id)}"><select name="mode"><option>basic</option><option>roles</option><option>multi</option></select><button class="primary">Create run</button></form><details><summary>Edit</summary><form method="POST" action="/api/tasks/${attr(t.id)}/update">${hidden}<input name="title" value="${attr(t.title)}"><select name="status"><option>${esc(t.status)}</option><option>ready</option><option>running</option><option>done</option><option>blocked</option><option>cancelled</option></select><button>Update Task</button></form><form method="POST" action="/api/tasks/${attr(t.id)}/archive">${hidden}<button>Archive</button></form></details></div>`).join('') : '<p class="empty">No open task. Create one above.</p>';
  const runCard = (r: RunMeta): string => { const needsApproval = requestedApprovals.some((a) => a.run_id === r.id); const awaitingCopy = needsApproval ? 'Waiting for your approval above; this is not a completed result.' : 'Not a completed result; approval may already be handled, so start with a real command, collect, or cancel.'; return `<article class="run-card"><header><a href="/run/${attr(r.id)}">${esc(r.id)}</a><span class="pill">${esc(String(r.mode))}</span><span class="pill ${esc(String(r.status))}">${esc(String(r.status))}</span></header><p>${esc(r.task_id)}</p>${r.status === 'awaiting_approval' ? `<p class="warning">${esc(awaitingCopy)}</p>` : ''}<div class="actions"><form method="POST" action="/api/runs/${attr(r.id)}/start">${hidden}<button class="primary">Start task adapter</button><details><summary>Advanced shell command</summary><input name="command" placeholder="Explicit shell only; natural-language replies are ignored"><label class="check"><input type="checkbox" name="confirmCommand" value="yes"> Run this exact shell command</label></details></form><form method="POST" action="/api/runs/${attr(r.id)}/collect">${hidden}<button>Collect</button></form><form method="POST" action="/api/runs/${attr(r.id)}/cancel">${hidden}<button>Cancel</button></form><form method="POST" action="/api/runs/${attr(r.id)}/apply-proposal">${hidden}<button>Propose Apply</button></form></div></article>`; };
  return page('Dominic Orchestration', `<header class="topbar"><div><h1>Dominic Orchestration</h1><p>Operator input on top. Agent work below.</p></div><a class="ghost" href="/">Refresh</a></header><main><section class="operator-zone"><div class="section-title"><span>01</span><div><h2>Your input / permissions</h2><p>여기는 네가 입력하거나 승인해야 진행되는 것만 둔다.</p></div></div><div class="operator-grid"><div class="panel"><h3>Tool / permission boundary</h3><p><strong>Allowed without approval:</strong> git status/diff/log/show, ls/cat safe paths, task adapter execution.</p><p><strong>Approval required:</strong> shell mutation, package install, git commit/push, apply/merge proposal, network/unsafe host.</p><p><strong>Blocked by design:</strong> secret paths, path traversal, natural-language replies as shell commands.</p></div><div class="panel"><h3>Create Task</h3><form class="stack" method="POST" action="/api/tasks">${hidden}<input name="title" placeholder="해야 할 일을 한 줄로 적어라" required><button class="primary">Create Task</button></form></div><div class="panel urgent"><h3>Approval Queue</h3>${approvalPanel}</div></div><div class="panel"><h3>Task Board — choose what should run</h3>${taskPanel}</div></section><section class="agent-zone"><div class="section-title"><span>02</span><div><h2>Agent / LLM work</h2><p>에이전트가 수행 중인 것, 다음에 수행할 것, 끝난 증거를 아래에서 본다.</p></div></div><div class="lane"><h3>Running now</h3>${activeRuns.length ? activeRuns.map(runCard).join('') : '<p class="empty">Nothing running.</p>'}</div><div class="lane"><h3>Ready / waiting to run</h3>${waitingRuns.length ? waitingRuns.map(runCard).join('') : '<p class="empty">No run waiting. Create a run from a task above.</p>'}</div><div class="lane"><h3>Recent results</h3>${completedRuns.length ? completedRuns.map(runCard).join('') : '<p class="empty">No completed runs yet.</p>'}</div></section></main>`);
}
export function renderRun(runId: string, cwd = process.cwd()): string { if (!/^run-[A-Za-z0-9가-힣-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`); const root = projectRoot(cwd); const runsDir = safeJoin(root, AGENT_DIR, 'runs'); const runDir = safeJoin(runsDir, runId); const relToRuns = relative(realpathSync(runsDir), realpathSync(runDir)).replaceAll('\\', '/'); if (relToRuns === '..' || relToRuns.startsWith('../')) throw new Error(`invalid run path: ${runId}`); const names = listFilesRecursive(runDir).filter((f) => { if (f.includes('/.git/') || isSecretPath(f)) return false; const full = join(runDir, f); const real = realpathSync(full); const rel = relative(realpathSync(runDir), real).replaceAll('\\', '/'); return !(rel === '..' || rel.startsWith('../') || isSecretPath(relative(root, real).replaceAll('\\', '/'))); }).sort(); const meta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta; const relatedApprovals = listApprovals(root).filter((a) => a.run_id === runId); const requestedApproval = relatedApprovals.some((a) => a.status === 'requested'); const processFiles = names.filter((n) => n.endsWith('.process.json')); const processSummary = processFiles.map((n) => { try { const p = JSON.parse(readFileSync(join(runDir, n), 'utf8')); return `${n}: exit ${p.exit_code}${p.stderr ? ` · ${String(p.stderr).trim().split('\n')[0]}` : ''}`; } catch { return n; } }).join('\n') || 'No process evidence yet.'; const staleActiveNotice = ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(meta.status)) && Boolean(meta.ended_at) ? '<div class="notice danger"><strong>Not running.</strong><p>This run has terminal process evidence but stale active metadata. Treat the process log, ended_at, and cancel marker as truth.</p></div>' : ''; const approvalNotice = meta.status === 'awaiting_approval' ? `<div class="notice danger"><strong>Not a result yet.</strong><p>${requestedApproval ? 'This run is waiting for operator approval. Review the approval queue before treating it as work output.' : 'This run is in an awaiting-approval state, but no requested approval remains. It is stale or already approved without a valid completed execution; start with a real command, collect failure evidence, or cancel.'}</p></div>` : ''; return page(runId, `<a href="/">← back</a><h1>${esc(runId)}</h1><section class="panel"><h2>Run status summary</h2><p>Status: <strong>${esc(String(meta.status))}</strong> · Mode: ${esc(String(meta.mode))} · Task: ${esc(String(meta.task_id))}</p><pre>${esc(processSummary)}</pre></section>${staleActiveNotice}${approvalNotice}${names.map(n=>`<h2>${esc(n)}</h2><pre>${esc(redact(readFileSync(join(runDir,n),'utf8')))}</pre>`).join('')}`); }
function page(title: string, body: string): string { return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>:root{color-scheme:light;--bg:#f6f4ef;--ink:#171511;--muted:#6f6a60;--line:#ded8cc;--panel:#fffdf8;--accent:#1f5eff;--danger:#b42318}*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--bg);color:var(--ink)}a{color:inherit}.topbar{display:flex;justify-content:space-between;align-items:flex-start;padding:28px 34px;border-bottom:1px solid var(--line);background:#fffdf8cc;position:sticky;top:0;z-index:2;backdrop-filter:blur(12px)}h1{font-size:28px;margin:0 0 4px}h2,h3{margin:0}p{color:var(--muted);margin:.35rem 0}.ghost{border:1px solid var(--line);border-radius:999px;padding:9px 14px;text-decoration:none;background:white}main{display:grid;grid-template-columns:minmax(360px,42%) 1fr;min-height:calc(100vh - 92px)}.operator-zone{padding:28px 30px;border-right:1px solid var(--line);background:#fffaf0}.agent-zone{padding:28px 30px}.section-title{display:flex;gap:14px;align-items:flex-start;margin-bottom:20px}.section-title span{font-size:12px;font-weight:800;letter-spacing:.08em;color:white;background:var(--ink);border-radius:999px;padding:6px 8px}.operator-grid{display:grid;grid-template-columns:1fr;gap:14px}.panel,.lane{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;margin-bottom:16px;box-shadow:0 1px 0 rgba(0,0,0,.03)}.urgent{border-color:#f1b8b1}.stack{display:grid;gap:10px}.decision-item,.task-line,.run-card{display:grid;gap:12px;border-top:1px solid var(--line);padding:14px 0}.decision-item:first-of-type,.task-line:first-of-type,.run-card:first-of-type{border-top:0}.task-line{grid-template-columns:1fr auto auto;align-items:center}.run-card header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.run-card p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.check{display:block;color:var(--muted);font-size:12px;margin-top:8px}input,select,button{font:inherit;border:1px solid var(--line);border-radius:10px;padding:9px 10px;background:white}button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:white;font-weight:700}.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);background:white}.pill.failed,.pill.blocked,.pill.awaiting_approval{color:var(--danger);border-color:#f1b8b1;background:#fff1ef}.warning{color:var(--danger);font-weight:700}.notice{border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0;background:white}.notice.danger{border-color:#f1b8b1;background:#fff1ef}small{display:block;color:var(--muted);font-size:12px;margin-top:3px}.empty{padding:18px;border:1px dashed var(--line);border-radius:14px;text-align:center}details summary{cursor:pointer;color:var(--muted)}pre{background:#111;color:#eee;padding:1rem;overflow:auto;white-space:pre-wrap;border-radius:14px}@media(max-width:900px){main{grid-template-columns:1fr}.operator-zone{border-right:0;border-bottom:1px solid var(--line)}.task-line{grid-template-columns:1fr}.topbar{position:static}}</style></head><body>${body}</body></html>`; }
function esc(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
function attr(s: string): string { return esc(s).replace(/[\s"']/g, (c) => ({ '"': '&quot;', "'": '&#39;', ' ': '&#32;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' }[c] || '&#32;')); }
export function cleanupWorktrees(cwd = process.cwd()): void { const root = projectRoot(cwd); const base = resolve(dirname(root), `${basename(root)}.agent-worktrees`); const failures: string[] = []; try { const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }); for (const line of list.split('\n')) { if (!line.startsWith('worktree ')) continue; const worktree = line.slice('worktree '.length).trim(); if (worktree && worktree.startsWith(base)) { try { execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err: any) { failures.push(`${worktree}: ${String(err.stderr || err.message || err).trim()}`); } } } try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err: any) { failures.push(`prune: ${String(err.stderr || err.message || err).trim()}`); } const remaining = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).split('\n').filter((line) => line.startsWith('worktree ') && line.slice('worktree '.length).trim().startsWith(base)); if (remaining.length) failures.push(`registered worktrees remain: ${remaining.join(', ')}`); } catch (err: any) { failures.push(String(err.stderr || err.message || err).trim()); } if (existsSync(base)) rmSync(base, { recursive: true, force: true }); if (existsSync(base)) failures.push(`filesystem worktree base remains: ${base}`); if (failures.length) throw new Error(`worktree cleanup failed: ${failures.join('; ')}`); }

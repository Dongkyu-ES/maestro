import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { buildCompositionPlan } from './composition/composition.js';
import { appendRuntimeEvent, type RuntimeEventEnvelope, readRuntimeEvents } from './events/ledger.js';
import { evaluatePermission } from './policy/permission-broker.js';
import { findProjectedRun, type RuntimeProjection, rebuildRuntimeProjection } from './projection/projection.js';
import { writeProjectionSqlite } from './projection/sqlite-store.js';
import { AgyCliAdapter } from './runtime/agy-adapter.js';
import { createCodexLaunchProof } from './runtime/codex-process-bridge.js';
import { OmxCliAdapter } from './runtime/omx-adapter.js';
import {
  AGENT_DIR,
  type ApprovalRecord,
  type Decision,
  type EvidenceResult,
  type ExecutorKind,
  ensureDir,
  frontmatter,
  git,
  gitEvidence,
  gitNoIndexPatch,
  isSecretPath,
  normalizeNoIndexPatch,
  nowIso,
  type ProductIndex,
  type ProjectRecord,
  type PromotionRecord,
  parseFrontmatter,
  patchTouchedFiles,
  projectRoot,
  type RunMeta,
  type RunMode,
  type RunStatus,
  readYaml,
  redact,
  registryPath,
  safeJoin,
  slug,
  type TaskMeta,
  type TaskStatus,
  uniqueId,
  writeIfMissing,
  yaml,
} from './util.js';

export type {
  ApprovalRecord,
  Decision,
  ExecutorKind,
  ProductIndex,
  ProjectRecord,
  PromotionRecord,
  RunMeta,
  RunMode,
  RunStatus,
  TaskMeta,
  TaskStatus,
} from './util.js';
export {
  AGENT_DIR,
  ensureDir,
  frontmatter,
  git,
  isSecretPath,
  nowIso,
  parseFrontmatter,
  projectRoot,
  readYaml,
  redact,
  registryPath,
  safeJoin,
  slug,
  uniqueId,
  writeIfMissing,
  yaml,
} from './util.js';

const TASK_STATUSES = new Set([
  'inbox',
  'scoped',
  'ready',
  'running',
  'review',
  'changes_requested',
  'done',
  'blocked',
  'cancelled',
  'abandoned',
]);
const RUN_MODES = new Set(['basic', 'roles', 'multi']);

function recordEvidenceError(runDir: string, label: string, result: EvidenceResult): void {
  if (result.ok) return;
  const path = join(runDir, 'evidence-errors.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  existing.push({ label, ok: false, error: redact(result.error || result.output), recorded_at: nowIso() });
  writeFileSync(path, JSON.stringify(existing, null, 2));
}

export function loadRegistry(): ProjectRecord[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectRecord[];
}
export function saveRegistry(records: ProjectRecord[]): void {
  const p = registryPath();
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(records, null, 2));
}
export function addProject(rootPath = process.cwd()): ProjectRecord {
  const root = projectRoot(rootPath);
  initProject(root);
  const ts = nowIso();
  const existing = loadRegistry().filter((p) => p.root_path !== root);
  const rec: ProjectRecord = {
    schema_version: 1,
    id: slug(basename(root)),
    name: basename(root),
    root_path: root,
    agent_dir: AGENT_DIR,
    created_at: ts,
    updated_at: ts,
    last_opened_at: ts,
  };
  saveRegistry([...existing, rec]);
  return rec;
}
export function listProjects(): ProjectRecord[] {
  return loadRegistry();
}
export function removeProject(id: string): void {
  saveRegistry(loadRegistry().filter((p) => p.id !== id));
}

export function initProject(cwd = process.cwd()): string[] {
  const root = projectRoot(cwd);
  const created: string[] = [];
  const agent = safeJoin(root, AGENT_DIR);
  ensureDir(agent);
  const ts = nowIso();
  const projectId = slug(basename(root));
  const files: [string, string][] = [
    [
      'project.yaml',
      yaml({
        schema_version: 1,
        id: projectId,
        name: basename(root),
        root_path: root,
        agent_dir: AGENT_DIR,
        default_executor: 'command',
        created_at: ts,
        updated_at: ts,
      }),
    ],
    [
      'policies/tool-policy.yaml',
      `defaults:\n  max_workers: 3\n  require_approval_for_writes: true\n  require_approval_for_network: true\n  require_approval_for_shell_mutation: true\n\ntools:\n  filesystem.read:\n    default: allow\n  filesystem.write:\n    default: require_approval\n  shell.readonly:\n    default: allow\n  shell.mutating:\n    default: require_approval\n  git.status:\n    default: allow\n  git.diff:\n    default: allow\n  git.commit:\n    default: require_approval\n  git.push:\n    default: require_approval\n`,
    ],
    [
      'policies/approval-policy.yaml',
      `approvals:\n  file_write:\n    required: true\n    auto_approve_paths:\n      - ".agent/runs/"\n  apply_patch:\n    required: true\n  package_install:\n    required: true\n  git_commit:\n    required: true\n  git_push:\n    required: true\n`,
    ],
    [
      'evals/rubric.md',
      `# Agent Run Review Rubric\n\n- Goal Fit: 0-2\n- Artifact Boundary: 0-2\n- Tool Discipline: 0-2\n- Reviewability: 0-2\n- Reusability: 0-2\n\nPass: score >= 8 and no blocking issue.\n`,
    ],
  ];
  for (const [rel, content] of files)
    if (writeIfMissing(safeJoin(root, AGENT_DIR, rel), content)) created.push(join(AGENT_DIR, rel));
  for (const dir of ['tasks', 'runs', 'logs', 'cache', 'approvals', 'promotions', 'worktrees'])
    ensureDir(safeJoin(root, AGENT_DIR, dir));
  rebuildIndex(root);
  return created;
}

export function addTask(title: string, cwd = process.cwd()): TaskMeta {
  initProject(cwd);
  const root = projectRoot(cwd);
  const ts = nowIso();
  const id = uniqueId('task', title);
  const meta: TaskMeta = {
    schema_version: 1,
    id,
    title,
    status: 'ready',
    priority: 'normal',
    created_at: ts,
    updated_at: ts,
  };
  const body = `# Task: ${title}\n\n## Goal\n${title}\n\n## Context\n\n## Constraints\n\n## Done Means\n\n## Preferred Executor\ncommand\n\n## Notes\n`;
  writeFileSync(
    safeJoin(root, AGENT_DIR, 'tasks', `${id}.md`),
    frontmatter(meta as unknown as Record<string, unknown>, body),
  );
  rebuildIndex(root);
  return meta;
}
export function listTasks(cwd = process.cwd()): TaskMeta[] {
  const root = projectRoot(cwd);
  const dir = safeJoin(root, AGENT_DIR, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
      return {
        schema_version: Number(meta.schema_version || 1),
        id: meta.id || f.replace(/\.md$/, ''),
        title: meta.title || meta.id || f,
        status: (meta.status || 'ready') as TaskStatus,
        priority: (meta.priority || 'normal') as 'normal',
        created_at: meta.created_at || '',
        updated_at: meta.updated_at || '',
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function taskPath(taskId: string, cwd = process.cwd()): string {
  return safeJoin(projectRoot(cwd), AGENT_DIR, 'tasks', `${taskId}.md`);
}
export function updateTaskStatus(taskId: string, status: TaskStatus, cwd = process.cwd()): void {
  if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
  const p = taskPath(taskId, cwd);
  const text = readFileSync(p, 'utf8');
  const meta = { ...parseFrontmatter(text), status, updated_at: nowIso() };
  const body = text.slice(text.indexOf('\n---', 4) + 4).trim();
  writeFileSync(p, frontmatter(meta, body));
  rebuildIndex(cwd);
}
export function updateTask(
  taskId: string,
  fields: Partial<Pick<TaskMeta, 'title' | 'status' | 'priority'>>,
  cwd = process.cwd(),
): TaskMeta {
  if (fields.status !== undefined && !TASK_STATUSES.has(fields.status))
    throw new Error(`invalid task status: ${fields.status}`);
  const p = taskPath(taskId, cwd);
  const text = readFileSync(p, 'utf8');
  const old = parseFrontmatter(text);
  const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const meta = { ...old, ...cleanFields, updated_at: nowIso() };
  const body = text.slice(text.indexOf('\n---', 4) + 4).trim();
  writeFileSync(p, frontmatter(meta, body));
  rebuildIndex(cwd);
  return listTasks(cwd).find((t) => t.id === taskId)!;
}

export function createRun(
  taskId: string,
  options: {
    mode?: RunMode;
    executor?: ExecutorKind;
    maxWorkers?: number;
    command?: string;
    source?: 'web' | 'runtime-manager';
  } = {},
  cwd = process.cwd(),
): RunMeta {
  initProject(cwd);
  const root = projectRoot(cwd);
  const taskFile = taskPath(taskId, cwd);
  if (!existsSync(taskFile)) throw new Error(`task not found: ${taskId}`);
  const ts = nowIso();
  const id = uniqueId('run', taskId);
  const mode = options.mode || 'basic';
  if (!RUN_MODES.has(mode)) throw new Error(`invalid run mode: ${mode}`);
  const runDirRel = join(AGENT_DIR, 'runs', id);
  const runDir = safeJoin(root, runDirRel);
  ensureDir(runDir);
  const meta: RunMeta = {
    schema_version: 1,
    id,
    task_id: taskId,
    status: 'created',
    executor: options.executor || 'command',
    mode,
    run_dir: runDirRel,
    max_workers: mode === 'multi' ? Math.min(Math.max(options.maxWorkers || 2, 1), 3) : 1,
    command: options.command,
    created_at: ts,
    updated_at: ts,
  };
  writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
  appendRuntimeEvent(runDir, {
    runId: id,
    source: options.source || 'runtime-manager',
    type: 'goal.received',
    payload: {
      task_id: taskId,
      mode,
      executor: meta.executor,
      runtime_label: meta.executor === 'command' ? 'compatibility_shell' : meta.executor,
    },
  });
  writeFileSync(join(runDir, 'task.md'), readFileSync(taskFile, 'utf8'));
  writeFileSync(
    join(runDir, 'context.md'),
    `# Context\n\nProject: ${basename(root)}\nTask: ${taskId}\nMode: ${mode}\nCreated: ${ts}\n`,
  );
  writeFileSync(join(runDir, 'prompt.md'), buildPrompt(taskId, mode, meta.max_workers || 1));
  const composition = buildCompositionPlan({ root, runDir, runId: id, taskId, preferredRuntime: meta.executor, mode });
  appendRuntimeEvent(runDir, {
    runId: id,
    source: 'runtime-manager',
    type: 'composition.resolved',
    payload: {
      runtime_adapter: composition.modules.runtime_adapter,
      context_sha256: composition.context_pack.sha256,
      agents: composition.modules.agents,
      approval_policy: composition.approval_policy,
      runtime_label: 'composition_plan',
    },
    artifactRefs: ['composition.json'],
  });
  writeFileSync(join(runDir, 'baseline-status.txt'), git(['status', '--short', '--branch'], root));
  writeFileSync(join(runDir, 'baseline-diff.patch'), git(['diff'], root));
  if (mode === 'roles') createRoleArtifacts(runDir, taskId);
  if (mode === 'multi') createMultiArtifacts(runDir, taskId, meta.max_workers || 2, root, id);
  updateTaskStatus(taskId, 'running', cwd);
  rebuildIndex(root);
  return meta;
}
function buildPrompt(taskId: string, mode: RunMode, maxWorkers: number): string {
  return `# Agent Run Prompt\n\nTask: ${taskId}\nMode: ${mode}\nMax workers: ${maxWorkers}\n\nThe executor must produce deterministic evidence. Worker prose alone is not trusted.\n`;
}
export function latestRunId(cwd = process.cwd()): string | null {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'runs');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isDirectory())
    .sort();
  return runs.at(-1) || null;
}
export function runPath(runId: string, cwd = process.cwd()): string {
  return safeJoin(projectRoot(cwd), AGENT_DIR, 'runs', runId);
}

function createRoleArtifacts(runDir: string, taskId: string): void {
  ensureDir(join(runDir, 'work-orders'));
  ensureDir(join(runDir, 'worker-outputs'));
  writeIfMissing(
    join(runDir, 'manager-plan.md'),
    `# Manager Plan\n\n## Restated Goal\nExecute ${taskId}.\n\n## Proposed Strategy\nCreate one bounded worker order and require deterministic evidence.\n\n## Work Orders\nworker-001\n\n## Risks\nScope drift; missing verification.\n\n## Acceptance Criteria\nWorker output, transcript, diff, review, and next action are complete.\n`,
  );
  writeIfMissing(
    join(runDir, 'work-orders', 'worker-001.yaml'),
    yaml({
      id: 'worker-001',
      role: 'worker',
      task_id: taskId,
      allowed_tools: ['filesystem.read', 'git.diff'],
      max_minutes: 30,
      status: 'queued',
    }),
  );
  writeIfMissing(
    join(runDir, 'worker-outputs', 'worker-001.md'),
    `# Worker Output\n\n## Objective\nExecute ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Tests Run\n\n## Completion Against Acceptance Criteria\nPending collect.\n`,
  );
  writeIfMissing(join(runDir, 'transcript.md'), '# Transcript\n\n');
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
    writeIfMissing(
      join(runDir, 'work-orders', `${id}.yaml`),
      yaml({
        id,
        role: 'worker',
        task_id: taskId,
        isolated_workspace: workspacePath,
        branch_name: branchName,
        allowed_tools: ['filesystem.read', 'git.diff'],
        status: 'queued',
      }),
    );
    writeIfMissing(
      join(runDir, 'worker-outputs', `${id}.md`),
      `# Worker Output\n\n## Objective\nBounded worker ${id} for ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Completion Against Acceptance Criteria\nPending collect.\n`,
    );
  }
  writeIfMissing(
    join(runDir, 'synthesis.md'),
    '# Synthesis\n\nHuman/manager synthesis notes. Generated evidence is in synthesis.generated.md.\n',
  );
  writeIfMissing(
    join(runDir, 'conflict-report.md'),
    '# Conflict Report\n\nHuman review notes. Generated evidence is in conflict-report.generated.md.\n',
  );
  writeFileSync(join(runDir, 'synthesis.generated.md'), '# Synthesis\n\nStatus: pending\n');
  writeFileSync(join(runDir, 'conflict-report.generated.md'), '# Conflict Report\n\nStatus: pending\n');
}
function createWorkerWorktree(root: string, runId: string, workerId: string, branchName: string): string {
  const worktreeBase = resolve(dirname(root), `${basename(root)}.agent-worktrees`, runId);
  const worktreePath = join(worktreeBase, workerId);
  ensureDir(worktreeBase);
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
    if (!existsSync(worktreePath))
      execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    return worktreePath;
  } catch (err: any) {
    const reason = String(err.stderr || err.message || err)
      .trim()
      .split('\n')[0];
    return `worktree_unavailable:${worktreePath}:${reason}`;
  }
}

export async function startRun(
  runId: string,
  options: { command?: string; timeoutMs?: number } = {},
  cwd = process.cwd(),
): Promise<RunMeta> {
  const root = projectRoot(cwd);
  const runDir = runPath(runId, cwd);
  const meta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  if (meta.status === 'cancelled' || existsSync(join(runDir, 'cancel.requested'))) {
    meta.status = 'cancelled';
    meta.ended_at = meta.ended_at || nowIso();
    meta.updated_at = nowIso();
    writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
    rebuildIndex(root);
    return meta;
  }
  meta.status = meta.mode === 'multi' ? 'workers_running' : meta.mode === 'roles' ? 'dispatching' : 'collecting';
  meta.started_at = nowIso();
  meta.updated_at = meta.started_at;
  writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
  const defaultCommand = `${JSON.stringify(process.execPath)} -e "console.log('Dominic Orchestration task adapter executed')"`;
  const operatorProvided = options.command !== undefined || meta.command !== undefined;
  const command = options.command || meta.command || (meta.executor === 'command' ? defaultCommand : '');
  if (command) writeFileSync(join(runDir, 'executor-command.txt'), redact(command));
  appendRuntimeEvent(runDir, {
    runId,
    source: 'runtime-manager',
    type: 'runtime.launch.requested',
    payload: {
      requested_adapter_kind: meta.executor,
      adapter_kind: meta.executor === 'command' ? 'shell' : undefined,
      runtime_label: meta.executor === 'command' ? 'primitive_shell' : 'adapter_requested_unproven',
      first_class: false,
      command_present: Boolean(command),
      evidence_status: meta.executor === 'command' ? 'primitive' : 'unproven',
    },
    artifactRefs: command ? ['executor-command.txt'] : [],
  });
  const shellMutationRequiresApproval = command ? requiresShellApproval(command, operatorProvided) : false;
  const permission = evaluatePermission({
    runId,
    action: shellMutationRequiresApproval ? 'destructive' : 'general_tool',
    scope: shellMutationRequiresApproval ? 'project' : 'task',
    summary: command ? 'start runtime adapter command' : 'start runtime adapter without shell fallback',
    target: command ? 'executor-command.txt' : undefined,
  });
  if (permission.status === 'allow')
    appendRuntimeEvent(runDir, {
      runId,
      source: 'permission-broker',
      type: permission.eventType,
      payload: {
        action: 'runtime_start',
        risk: permission.risk,
        reason: permission.reason,
        runtime_label: 'permission_allowed',
      },
      artifactRefs: command ? ['executor-command.txt'] : [],
    });
  if (meta.executor === 'codex') {
    const prompt = existsSync(join(runDir, 'prompt.md')) ? readFileSync(join(runDir, 'prompt.md'), 'utf8') : undefined;
    const proof = createCodexLaunchProof({
      runId,
      cwd: root,
      agentDir: safeJoin(root, AGENT_DIR),
      runDir,
      prompt,
      autoAttachCurrentSession: true,
    });
    appendRuntimeEvent(runDir, {
      runId,
      source: 'codex-adapter',
      type: proof.status === 'supported' ? 'runtime.session.started' : 'runtime.lifecycle.unproven',
      sessionId: proof.session_id,
      payload: {
        requested_adapter_kind: 'codex',
        adapter_kind: 'codex',
        runtime_label: 'codex_cli',
        first_class: proof.status === 'supported',
        evidence_status: proof.status,
        codex_path: proof.codex_path,
        codex_version: proof.codex_version,
        session_id: proof.session_id,
        note: proof.notes.join(' '),
      },
      artifactRefs: [proof.evidence_path],
    });
  }
  if (meta.executor === 'omx' || meta.executor === 'agy') {
    const adapter = meta.executor === 'omx' ? new OmxCliAdapter(root) : new AgyCliAdapter(root);
    for await (const event of adapter.launch({
      runId,
      cwd: root,
      prompt: existsSync(join(runDir, 'prompt.md')) ? readFileSync(join(runDir, 'prompt.md'), 'utf8') : undefined,
      metadata: { evidenceDir: runDir },
    }))
      appendRuntimeEvent(runDir, {
        runId,
        source: event.source as any,
        type: event.type,
        sessionId: event.sessionId,
        payload: event.payload,
        artifactRefs: event.artifactRefs.map((ref) => (ref.startsWith(runDir) ? relative(runDir, ref) : ref)),
      });
  }
  if (command && shellMutationRequiresApproval && !hasApprovedShellMutation(runId, command, cwd)) {
    const approval = createApprovalInternal(
      runId,
      'shell_mutation',
      'high',
      `Mutating shell command requires approval for run ${runId}`,
      cwd,
      { command_sha256: commandDigest(command), command_preview: redact(command).slice(0, 240) },
    );
    appendRuntimeEvent(runDir, {
      runId,
      source: 'permission-broker',
      type: 'approval.requested',
      payload: {
        approval_id: approval.id,
        action: 'shell_mutation',
        risk: 'high',
        reason: permission.reason,
        runtime_label: 'approval_required',
      },
      artifactRefs: [`approvals/${approval.id}.json`],
    });
    meta.status = 'awaiting_approval';
    meta.updated_at = nowIso();
    writeFileSync(
      join(runDir, 'policy-blocked.md'),
      `# Policy Blocked\n\nMutating shell command requires approval before execution.\n`,
    );
    writeFileSync(join(runDir, 'run.yaml'), yaml(meta as unknown as Record<string, unknown>));
    rebuildIndex(root);
    return meta;
  }
  const approvedShellMutation = command ? approvedShellMutationApproval(runId, command, cwd) : undefined;
  if (approvedShellMutation)
    appendRuntimeEvent(runDir, {
      runId,
      source: 'permission-broker',
      type: 'runtime.action.approved',
      payload: {
        approval_id: approvedShellMutation.id,
        action: 'shell_mutation',
        command_sha256: approvedShellMutation.command_sha256,
        runtime_label: 'approval_chain',
      },
      artifactRefs: [`approvals/${approvedShellMutation.id}.json`, 'executor-command.txt'],
    });
  if (command) {
    if (meta.mode === 'roles') await runRoles(runDir, root, command, options.timeoutMs);
    else if (meta.mode === 'multi') await runMultiWorkers(runDir, command, options.timeoutMs);
    else await runCommand(runDir, root, command, 'executor', options.timeoutMs);
    const artifactRefs = processArtifactRefsForMode(runDir, meta.mode);
    appendRuntimeEvent(runDir, {
      runId,
      source: 'shell-adapter',
      type: meta.executor === 'command' ? 'runtime.session.started' : 'runtime.lifecycle.unproven',
      payload: {
        requested_adapter_kind: meta.executor,
        adapter_kind: 'shell',
        runtime_label: 'primitive_shell',
        first_class: false,
        evidence_status: meta.executor === 'command' ? 'primitive' : 'unproven',
        note:
          meta.executor === 'command'
            ? 'command executor uses primitive shell'
            : `${meta.executor} requested with an explicit shell command; primitive shell evidence cannot prove first-class runtime lifecycle`,
        shell_execution: true,
      },
      artifactRefs,
    });
  }
  return readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
}
interface ProcessLog {
  label: string;
  cwd: string;
  command: string;
  started_at: string;
  ended_at: string;
  exit_code: number;
  signal?: NodeJS.Signals | null;
  timed_out?: boolean;
  stdout: string;
  stderr: string;
}
function terminateProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}
function runCommand(
  runDir: string,
  cwd: string,
  command: string,
  label: string,
  timeoutMs = 30000,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const started = nowIso();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    const childEnv = {
      ...process.env,
      PATH: process.env.PATH
        ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
        : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ...extraEnv,
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    writeFileSync(join(runDir, `${label}.pid`), String(child.pid || ''));
    const cancelPath = join(runDir, 'cancel.requested');
    const timer = setTimeout(() => {
      if (settled) return;
      terminateProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (!settled) terminateProcessTree(child, 'SIGKILL');
      }, 1000).unref();
    }, timeoutMs);
    const cancelTimer = setInterval(() => {
      if (settled) return;
      if (existsSync(cancelPath)) {
        cancelled = true;
        terminateProcessTree(child, 'SIGTERM');
        setTimeout(() => {
          if (!settled) terminateProcessTree(child, 'SIGKILL');
        }, 1000).unref();
      }
    }, 100);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      stderr += err.message;
    });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelTimer);
      const timedOut = signal === 'SIGKILL' || (signal === 'SIGTERM' && !cancelled);
      const log: ProcessLog = {
        label,
        cwd,
        command: redact(command),
        started_at: started,
        ended_at: nowIso(),
        exit_code: cancelled ? 130 : (code ?? (timedOut ? 124 : 1)),
        signal,
        timed_out: timedOut,
        stdout: redact(stdout),
        stderr: redact(stderr),
      };
      writeFileSync(join(runDir, `${label}.process.json`), JSON.stringify(log, null, 2));
      writeFileSync(join(runDir, `${label}.stdout.log`), log.stdout);
      writeFileSync(join(runDir, `${label}.stderr.log`), log.stderr);
      resolve(log.exit_code);
    });
  });
}
async function runRoles(runDir: string, root: string, command: string, timeoutMs?: number): Promise<void> {
  const managerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'manager'), 'manager', timeoutMs, {
    ROLE: 'manager',
  });
  appendFile(
    join(runDir, 'manager-plan.md'),
    `
## Process Evidence
manager exit: ${managerExit}
`,
  );
  const workerExit = await runCommand(
    runDir,
    root,
    command.replaceAll('{role}', 'worker').replaceAll('{worker}', 'worker-001'),
    'worker-001',
    timeoutMs,
    { ROLE: 'worker', WORKER_ID: 'worker-001' },
  );
  appendFile(
    join(runDir, 'worker-outputs', 'worker-001.md'),
    `
## Process Exit
${workerExit}
`,
  );
  const reviewerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'reviewer'), 'reviewer', timeoutMs, {
    ROLE: 'reviewer',
  });
  appendFile(
    join(runDir, 'review.md'),
    `
## Reviewer Process Evidence
reviewer exit: ${reviewerExit}
`,
  );
}
async function runMultiWorkers(runDir: string, command: string, timeoutMs?: number): Promise<void> {
  const ordersDir = join(runDir, 'work-orders');
  const files = readdirSync(ordersDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  const startedAt = nowIso();
  writeFileSync(
    join(runDir, 'scheduler.json'),
    JSON.stringify(
      {
        schema_version: 1,
        started_at: startedAt,
        max_workers: files.length,
        strategy: 'bounded-parallel',
        workers: files.map((file) => file.replace(/\.yaml$/, '')),
      },
      null,
      2,
    ),
  );
  await Promise.all(
    files.map(async (file) => {
      const workerId = file.replace(/\.yaml$/, '');
      const order = readYaml(join(ordersDir, file));
      const workspace = String(order.isolated_workspace || '');
      if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) {
        const log: ProcessLog = {
          label: workerId,
          cwd: workspace || '',
          command,
          started_at: nowIso(),
          ended_at: nowIso(),
          exit_code: 125,
          stderr: `isolated workspace unavailable: ${workspace || 'missing'}`,
          stdout: '',
        };
        writeFileSync(join(runDir, `${workerId}.process.json`), JSON.stringify(log, null, 2));
        appendFile(join(runDir, 'worker-outputs', `${workerId}.md`), `\n## Process Exit\n125\n`);
        return;
      }
      const exit = await runCommand(runDir, workspace, command.replaceAll('{worker}', workerId), workerId, timeoutMs, {
        ROLE: 'worker',
        WORKER_ID: workerId,
      });
      appendGeneratedWorkerFiles(runDir, workerId, workspace);
      appendFile(join(runDir, 'worker-outputs', `${workerId}.md`), `\n## Process Exit\n${exit}\n`);
    }),
  );
  const scheduler = JSON.parse(readFileSync(join(runDir, 'scheduler.json'), 'utf8'));
  scheduler.ended_at = nowIso();
  writeFileSync(join(runDir, 'scheduler.json'), JSON.stringify(scheduler, null, 2));
}
function appendFile(path: string, text: string): void {
  writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + text : text);
}
function appendGeneratedWorkerFiles(runDir: string, workerId: string, workspace: string): void {
  const outputPath = join(runDir, 'worker-outputs', `${workerId}.md`);
  if (!existsSync(outputPath)) return;
  const text = readFileSync(outputPath, 'utf8');
  if (!/Pending execution|Pending collect/.test(text)) return;
  const files = collectChangedFilesFromWorkspace(workspace);
  if (!files.length) return;
  appendFile(
    outputPath,
    `
## Files Changed
${files.map((file) => `- ${file}`).join('\n')}
`,
  );
}
function requiresShellApproval(command: string, operatorProvided: boolean): boolean {
  if (!operatorProvided) return false;
  return !isReadonlyShellCommand(command);
}
function isReadonlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/[;&|<>`$(){}[\]\n\r]/.test(trimmed)) return false;
  const parts = trimmed.split(/\s+/);
  const [cmd, sub, ...args] = parts;
  const safeFlags = new Set([
    '--short',
    '--branch',
    '--stat',
    '--name-only',
    '--name-status',
    '--oneline',
    '--decorate',
    '--porcelain',
    '--porcelain=v1',
    '--porcelain=v2',
  ]);
  if (cmd === 'pwd' && parts.length === 1) return true;
  if (cmd === 'ls') return args.every((a) => /^-[A-Za-z]+$/.test(a) || /^[A-Za-z0-9_./-]+$/.test(a));
  if (cmd === 'cat') return args.length > 0 && args.every((a) => /^[A-Za-z0-9_./-]+$/.test(a) && !isSecretPath(a));
  if (cmd !== 'git') return false;
  if (sub === 'worktree' && args[0] === 'list') return args.slice(1).every((a) => safeFlags.has(a));
  if (!['status', 'diff', 'show', 'log', 'rev-parse', 'branch'].includes(sub || '')) return false;
  return args.every(
    (a) => safeFlags.has(a) || (/^[A-Za-z0-9_./:-]+$/.test(a) && !a.startsWith('--output') && a !== '-o'),
  );
}
function commandDigest(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}
function approvedShellMutationApproval(
  runId: string,
  command: string,
  cwd = process.cwd(),
): ApprovalRecord | undefined {
  const digest = commandDigest(command);
  return listApprovals(cwd).find(
    (a) => a.run_id === runId && a.type === 'shell_mutation' && a.status === 'approved' && a.command_sha256 === digest,
  );
}
function hasApprovedShellMutation(runId: string, command: string, cwd = process.cwd()): boolean {
  return Boolean(approvedShellMutationApproval(runId, command, cwd));
}

export function collectRun(runId: string, cwd = process.cwd()): RunMeta {
  const root = projectRoot(cwd);
  const runDir = runPath(runId, cwd);
  const runMeta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  if (runMeta.status === 'cancelled') return runMeta;
  if (!hasStartedEvidence(runDir, runMeta)) {
    runMeta.status = 'failed';
    runMeta.decision = 'blocked';
    runMeta.ended_at = nowIso();
    runMeta.updated_at = runMeta.ended_at;
    writeFileSync(
      join(runDir, 'review.md'),
      `# Review\n\n## Decision\nblocked\n\n## Blocking Issues\n- Run was collected before start/execution evidence existed.\n`,
    );
    writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>));
    updateTaskStatus(runMeta.task_id, 'blocked', cwd);
    rebuildIndex(root);
    return runMeta;
  }
  runMeta.status = 'collecting';
  writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>));
  const collectStatus = gitEvidence(['status', '--short', '--branch'], root);
  const collectDiff = gitEvidence(['diff'], root);
  writeFileSync(join(runDir, 'collect-status.txt'), collectStatus.output);
  const diff = collectDiff.output;
  writeFileSync(join(runDir, 'collect-diff.patch'), diff);
  writeFileSync(join(runDir, 'diff.patch'), diff);
  recordEvidenceError(runDir, 'collect-status', collectStatus);
  recordEvidenceError(runDir, 'collect-diff', collectDiff);
  if (!existsSync(join(runDir, 'result.md')))
    writeFileSync(
      join(runDir, 'result.md'),
      `# Result\n\n## Summary\nCollected run ${runId}.\n\n## Evidence\n- baseline-status.txt\n- collect-status.txt\n- diff.patch\n`,
    );
  if (runMeta.mode === 'multi') updateConflictAndSynthesis(runDir);
  const decision = existsSync(join(runDir, 'cancel.requested'))
    ? 'blocked'
    : writeReview(runDir, runMeta.mode || 'basic');
  writeNextActions(runDir, decision);
  if (decision !== 'pass')
    createApproval(
      runMeta.id,
      decision === 'blocked' ? 'conflict_resolution' : 'changes_requested',
      'high',
      `Run ${runMeta.id} requires ${decision}`,
      cwd,
    );
  runMeta.status = decision === 'pass' ? 'completed' : decision === 'blocked' ? 'failed' : 'completed';
  runMeta.decision = decision;
  runMeta.exit_code = readExitCode(runDir);
  runMeta.ended_at = nowIso();
  runMeta.updated_at = runMeta.ended_at;
  appendRuntimeEvent(runDir, {
    runId: runMeta.id,
    source: 'runtime-manager',
    type: decision === 'pass' ? 'run.completed' : 'run.failed',
    payload: { decision, status: runMeta.status, exit_code: runMeta.exit_code, runtime_label: 'run_lifecycle' },
    artifactRefs: ['review.md', 'result.md'],
  });
  writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>));
  classifyRunPromotions(runDir, runMeta.id, root);
  updateTaskStatus(
    runMeta.task_id,
    decision === 'pass' ? 'done' : decision === 'blocked' ? 'blocked' : 'changes_requested',
    cwd,
  );
  rebuildIndex(root);
  return runMeta;
}
function hasStartedEvidence(runDir: string, meta: RunMeta): boolean {
  if (!meta.started_at) return false;
  if (meta.mode === 'basic')
    return (
      existsSync(join(runDir, 'executor.process.json')) ||
      readRuntimeEvents(runDir).some(
        (event) =>
          ['codex-adapter', 'omx-adapter', 'agy-adapter'].includes(event.source) && Boolean(event.artifact_refs.length),
      )
    );
  if (meta.mode === 'roles')
    return ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json'].every((f) =>
      existsSync(join(runDir, f)),
    );
  if (meta.mode === 'multi') {
    const ordersDir = join(runDir, 'work-orders');
    if (!existsSync(join(runDir, 'scheduler.json')) || !existsSync(ordersDir)) return false;
    const workers = readdirSync(ordersDir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''));
    return workers.length > 0 && workers.every((workerId) => existsSync(join(runDir, `${workerId}.process.json`)));
  }
  return false;
}
export function cancelRun(runId: string, cwd = process.cwd()): RunMeta {
  const root = projectRoot(cwd);
  const runDir = runPath(runId, cwd);
  writeFileSync(join(runDir, 'cancel.requested'), nowIso());
  const runMeta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  runMeta.status = 'cancelled';
  runMeta.ended_at = nowIso();
  runMeta.updated_at = runMeta.ended_at;
  writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta as unknown as Record<string, unknown>));
  writeFileSync(join(runDir, 'cancelled.md'), `# Cancelled\n\nRun ${runId} was cancelled at ${runMeta.ended_at}.\n`);
  updateTaskStatus(runMeta.task_id, 'cancelled', cwd);
  rebuildIndex(root);
  return runMeta;
}
function hasAdapterRuntimeEvidence(runDir: string): boolean {
  return readRuntimeEvents(runDir).some(
    (event) => ['codex-adapter', 'omx-adapter', 'agy-adapter'].includes(event.source) && event.artifact_refs.length > 0,
  );
}
function readExitCode(runDir: string): number {
  const summary = readRunProcessSummary(runDir);
  return summary.exitCode ?? (hasAdapterRuntimeEvidence(runDir) ? 0 : 1);
}
function processArtifactRefsForMode(runDir: string, mode: RunMode): string[] {
  const candidates =
    mode === 'basic'
      ? ['executor.process.json']
      : mode === 'roles'
        ? ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json']
        : readdirSync(runDir)
            .filter((f) => /^worker-\d+\.process\.json$/.test(f))
            .sort();
  return candidates.filter((file) => existsSync(join(runDir, file)));
}
export function runtimeTruthForRun(root: string, run: RunMeta): { label: string; css: string; evidence: string } {
  try {
    const runDir = join(root, run.run_dir);
    const projection = rebuildRuntimeProjection(readRuntimeEvents(runDir));
    const projected = findProjectedRun(projection, run.id);
    const labels = projected?.labels || [];
    const stale =
      ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(
        String(run.status),
      ) && Boolean(run.ended_at);
    if (stale)
      return { label: 'stale_not_running', css: 'stale', evidence: 'terminal evidence exists despite active metadata' };
    if (run.status === 'awaiting_approval')
      return {
        label: 'approval_required',
        css: 'awaiting_approval',
        evidence: 'operator approval required before execution',
      };
    if (labels.includes('primitive_shell') || run.executor === 'command')
      return {
        label: 'primitive_shell',
        css: 'primitive_shell',
        evidence: 'compatibility shell, not first-class Codex/OMX/agy runtime',
      };
    const firstClassSession = projected?.sessions.find(
      (session) => ['codex', 'omx', 'agy'].includes(String(session.adapter_kind)) && session.status === 'started',
    );
    if (firstClassSession)
      return {
        label: `${firstClassSession.adapter_kind}_runtime`,
        css: 'supported',
        evidence: `${projected?.event_count || 0} runtime events; session ${firstClassSession.session_id}`,
      };
    const label = labels[0] || run.executor || 'unproven';
    return {
      label,
      css: 'unproven',
      evidence: projected ? `${projected.event_count} runtime events` : 'no runtime projection events',
    };
  } catch {
    return {
      label: run.executor === 'command' ? 'primitive_shell' : 'unproven',
      css: 'unproven',
      evidence: 'projection unavailable',
    };
  }
}

function updateConflictAndSynthesis(runDir: string): void {
  const outputsDir = join(runDir, 'worker-outputs');
  const outputs = existsSync(outputsDir)
    ? readdirSync(outputsDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
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
    const staleDeclared = declaredFiles.filter(
      (file) => !actualFiles.includes(file) && !(actualFiles.includes('README.md') && file === 'README.md'),
    );
    if (undeclared.length)
      evidenceIssues.push(`${workerId}: actual worktree changes not declared (${undeclared.join(', ')})`);
    if (staleDeclared.length)
      evidenceIssues.push(`${workerId}: declared files not present in worktree diff (${staleDeclared.join(', ')})`);
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
  const hasConflict =
    overlaps.length > 0 || denied.length > 0 || worktreeIssues.length > 0 || evidenceIssues.length > 0;
  const status = hasConflict ? 'blocked' : 'clear';
  writeFileSync(
    join(runDir, 'conflict-report.generated.md'),
    [
      '# Conflict Report',
      '',
      `Status: ${status}`,
      '',
      `Workers reviewed: ${outputs.length}`,
      '',
      '## Overlapping Files',
      overlaps.length
        ? overlaps.map(([file, workers]) => `- ${file}: ${[...new Set(workers)].join(', ')}`).join('\n')
        : 'None.',
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
      changedByWorker.size
        ? [...changedByWorker.entries()].map(([file, workers]) => `- ${file}: ${workers.join(', ')}`).join('\n')
        : 'No changed files reported by worker outputs or worktrees.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(runDir, 'synthesis.generated.md'),
    `# Synthesis\n\n## Accepted Outputs\n${outputs.map((o) => `- ${o}`).join('\n')}\n\n## Rejected Outputs\n${hasConflict ? '- Conflicting, denied, non-isolated, or mismatched worker evidence requires review before apply.' : 'None.'}\n\n## Conflicts\n${hasConflict ? 'Blocking conflicts, denied paths, worktree issues, or evidence mismatches found. See conflict-report.generated.md.' : 'No blocking conflicts detected from worker-reported changed files and actual worktree diffs.'}\n\n## Recommendation\n${hasConflict ? 'Do not apply automatically; resolve blockers first.' : 'Proceed to review.'}\n`,
  );
}
function collectWorktreeIssues(runDir: string): string[] {
  const workOrdersDir = join(runDir, 'work-orders');
  if (!existsSync(workOrdersDir)) return ['missing work-orders directory'];
  const issues: string[] = [];
  for (const file of readdirSync(workOrdersDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const order = readYaml(join(workOrdersDir, file));
    const workspace = String(order.isolated_workspace || '');
    if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace))
      issues.push(`${file}: isolated workspace unavailable (${workspace || 'missing'})`);
  }
  return issues;
}
function collectWorktreeChanges(runDir: string, issues: string[]): Map<string, string[]> {
  const workOrdersDir = join(runDir, 'work-orders');
  const changes = new Map<string, string[]>();
  if (!existsSync(workOrdersDir)) return changes;
  for (const file of readdirSync(workOrdersDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const workerId = file.replace(/\.yaml$/, '');
    const order = readYaml(join(workOrdersDir, file));
    const workspace = String(order.isolated_workspace || '');
    if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) continue;
    try {
      changes.set(workerId, collectChangedFilesFromWorkspace(workspace));
    } catch (err: any) {
      issues.push(
        `${file}: failed to inspect worktree (${
          String(err.stderr || err.message || err)
            .trim()
            .split('\n')[0]
        })`,
      );
      changes.set(workerId, []);
    }
  }
  return changes;
}
function collectChangedFilesFromWorkspace(workspace: string): string[] {
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
  return [...new Set([...tracked, ...status])].sort();
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
    if (inSection && /^##\s+/.test(line.trim())) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const cleaned = line.replace(/^[-*]\s*/, '').trim();
    if (!cleaned || /^none\.?$/i.test(cleaned) || /^pending/i.test(cleaned) || /^#/.test(cleaned)) continue;
    files.push(cleaned.split(/\s+/)[0].replace(/^`|`$/g, '').replace(/[:,]$/g, ''));
  }
  return [...new Set(files)];
}

function writeReview(runDir: string, mode: RunMode): Decision {
  const required = [
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
  ];
  if (mode === 'basic' && !hasAdapterRuntimeEvidence(runDir)) required.push('executor.process.json');
  if (mode === 'roles')
    required.push(
      'manager-plan.md',
      'work-orders/worker-001.yaml',
      'worker-outputs/worker-001.md',
      'manager.process.json',
      'worker-001.process.json',
      'reviewer.process.json',
    );
  if (mode === 'multi') {
    required.push(
      'scheduler.json',
      'synthesis.md',
      'conflict-report.md',
      'synthesis.generated.md',
      'conflict-report.generated.md',
    );
    const ordersDir = join(runDir, 'work-orders');
    if (existsSync(ordersDir))
      for (const file of readdirSync(ordersDir).filter((f) => f.endsWith('.yaml')))
        required.push(`${file.replace(/\.yaml$/, '')}.process.json`);
  }
  const missing = required.filter((rel) => !existsSync(join(runDir, rel)));
  const conflictPath = existsSync(join(runDir, 'conflict-report.generated.md'))
    ? 'conflict-report.generated.md'
    : 'conflict-report.md';
  const conflictReport = existsSync(join(runDir, conflictPath)) ? readFileSync(join(runDir, conflictPath), 'utf8') : '';
  const hasConflict = /Status: blocked/.test(conflictReport);
  const processSummary = readRunProcessSummary(runDir);
  if (processSummary.invalid > 0)
    writeFileSync(
      join(runDir, 'process-evidence-errors.json'),
      JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2),
    );
  const adapterEvidence = hasAdapterRuntimeEvidence(runDir);
  const exitCode = processSummary.exitCode ?? (adapterEvidence ? 0 : 1);
  const evidenceErrors = existsSync(join(runDir, 'evidence-errors.json'))
    ? (JSON.parse(readFileSync(join(runDir, 'evidence-errors.json'), 'utf8')) as any[])
    : [];
  const processInvalid = (!adapterEvidence && processSummary.valid === 0) || processSummary.invalid > 0;
  const hasIssue = missing.length > 0 || hasConflict || exitCode !== 0 || evidenceErrors.length > 0 || processInvalid;
  const score = hasIssue ? 6 : 9;
  const decision: Decision =
    hasConflict || evidenceErrors.length > 0 || processInvalid ? 'blocked' : hasIssue ? 'changes_requested' : 'pass';
  const blockingIssues = [
    ...missing.map((m) => `- Missing ${m}`),
    ...(hasConflict ? ['- Conflict report is blocked'] : []),
    ...(evidenceErrors.length ? evidenceErrors.map((e) => `- Evidence capture failed: ${e.label}`) : []),
    ...(processSummary.errors.length ? processSummary.errors.map((e) => `- Invalid process evidence: ${e}`) : []),
    ...(exitCode !== 0 ? [`- Executor exit code ${exitCode}`] : []),
  ];
  writeFileSync(
    join(runDir, 'review.md'),
    `# Review\n\n## Score\n${score}\n\n## Rubric Breakdown\n- Goal Fit: ${hasIssue ? 1 : 2}\n- Artifact Boundary: ${hasIssue ? 1 : 2}\n- Tool Discipline: 2\n- Reviewability: ${hasIssue ? 1 : 2}\n- Reusability: 1\n\n## Blocking Issues\n${blockingIssues.length ? blockingIssues.join('\n') : 'None.'}\n\n## Required Changes\n${hasIssue ? 'Resolve missing artifacts, failed executor, or blocked conflicts.' : 'None.'}\n\n## Risks\nDestructive operations still require approval.\n\n## Decision\n${decision}\n\n## System Patch Suggestions\n${decision === 'pass' ? 'None.' : 'Create blocker-resolution task before claiming completion.'}\n`,
  );
  return decision;
}
function writeNextActions(runDir: string, decision: Decision): void {
  writeFileSync(
    join(runDir, 'next-actions.md'),
    `# Next Actions\n\n## Immediate\n${decision === 'pass' ? 'Review artifacts and close or promote learnings.' : 'Resolve review blockers before completion.'}\n\n## Suggested System Patches\n${decision === 'pass' ? 'None.' : 'Use approval/promotion workflow for durable fixes.'}\n\n## Blockers\n${decision === 'pass' ? 'None recorded.' : 'See review.md and conflict-report.generated.md.'}\n`,
  );
}

export function createApproval(
  runId: string,
  type: string,
  risk: 'low' | 'medium' | 'high',
  summary: string,
  cwd = process.cwd(),
): ApprovalRecord {
  if (type === 'apply_proposal') throw new Error('apply_proposal approvals must be created by proposeApply');
  return createApprovalInternal(runId, type, risk, summary, cwd);
}
function createApprovalInternal(
  runId: string,
  type: string,
  risk: 'low' | 'medium' | 'high',
  summary: string,
  cwd = process.cwd(),
  extra: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  const root = projectRoot(cwd);
  initProject(root);
  const ts = nowIso();
  const rec: ApprovalRecord = {
    schema_version: 1,
    id: uniqueId('approval', type),
    run_id: runId,
    type,
    status: 'requested',
    risk,
    summary,
    created_at: ts,
    updated_at: ts,
    ...extra,
  };
  writeFileSync(safeJoin(root, AGENT_DIR, 'approvals', `${rec.id}.json`), JSON.stringify(rec, null, 2));
  rebuildIndex(root);
  return rec;
}
export function listApprovals(cwd = process.cwd()): ApprovalRecord[] {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'approvals');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}
export function resolveApproval(id: string, status: 'approved' | 'rejected', cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'approvals', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as ApprovalRecord;
  rec.status = status;
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'permission-broker',
      type: 'approval.decided',
      payload: { approval_id: id, decision: status, runtime_label: 'approval_chain' },
      artifactRefs: [`approvals/${id}.json`],
    });
  rebuildIndex(cwd);
  return rec;
}
interface PromotionCandidate {
  target_type: PromotionRecord['target_type'];
  reason: string;
  target_path: string;
  body: string;
}
function sectionBody(text: string, heading: string): string {
  const re = new RegExp(`##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = text.match(re);
  return match ? match[1].trim() : '';
}
// Deterministic control-plane classification (no LLM). Reads run evidence and
// emits 0..N typed promotion candidates capturing durable learnings.
export function classifyRunPromotions(runDir: string, runId: string, cwd = process.cwd()): PromotionRecord[] {
  const root = projectRoot(cwd);
  const read = (rel: string): string =>
    existsSync(join(runDir, rel)) ? readFileSync(join(runDir, rel), 'utf8') : '';
  const review = read('review.md');
  const result = read('result.md');
  const runMeta = existsSync(join(runDir, 'run.yaml'))
    ? (readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta)
    : ({} as RunMeta);
  const mode = String(runMeta.mode || 'basic');
  const decision = String(runMeta.decision || '');
  const taskTitle = String(runMeta.task_id || runId);

  const candidates: PromotionCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: PromotionCandidate): void => {
    const key = `${c.target_type}:${c.target_path}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  // 1) System Patch Suggestions present (not "None.") -> durable guard (policy)
  //    plus an agent_instruction so the same mistake is prevented next time.
  const patchSuggestions = sectionBody(review, 'System Patch Suggestions');
  if (patchSuggestions && patchSuggestions !== 'None.') {
    push({
      target_type: 'policy',
      reason: `Review proposed a durable system patch: ${patchSuggestions.split('\n')[0]}`,
      target_path: '.agent/promotions/applied/policy/' + `${slug(taskTitle)}.md`,
      body: `# Policy Guard\n\nDerived from run ${runId} review.\n\n## Guard\n${patchSuggestions}\n`,
    });
    push({
      target_type: 'agent_instruction',
      reason: `Capture agent instruction so future runs avoid: ${patchSuggestions.split('\n')[0]}`,
      target_path: '.agent/promotions/applied/agent_instruction/' + `${slug(taskTitle)}.md`,
      body: `# Agent Instruction\n\nDerived from run ${runId} review.\n\n## Instruction\n${patchSuggestions}\n`,
    });
  }

  // 2) Repeatable multi-step procedure (multi/roles run with a scheduler/work-orders) -> workflow
  const hasScheduler = existsSync(join(runDir, 'scheduler.json'));
  const hasWorkOrders = existsSync(join(runDir, 'work-orders'));
  if ((mode === 'multi' || mode === 'roles') && (hasScheduler || hasWorkOrders)) {
    push({
      target_type: 'workflow',
      reason: `Run mode '${mode}' executed a repeatable multi-step procedure worth capturing as a workflow.`,
      target_path: '.agent/promotions/applied/workflows/' + `${slug(taskTitle)}.md`,
      body: `# Workflow: ${taskTitle}\n\nCaptured from ${mode} run ${runId}.\n\n## Steps\n${
        hasScheduler ? 'See scheduler.json for the executed step graph.' : 'See work-orders/ for the executed work orders.'
      }\n`,
    });
  }

  // 3) Verified passing run with a concrete result summary -> memory (verified fact only)
  if (decision === 'pass') {
    const summary = sectionBody(result, 'Summary');
    if (summary) {
      push({
        target_type: 'memory',
        reason: 'Run passed review; result summary is a verified project fact.',
        target_path: '.agent/memory/project-facts.md',
        body: `## ${taskTitle} (run ${runId})\n\n${summary}\n`,
      });
    }
  }

  // 4) A review rubric/score present -> eval (regression check captured from the rubric)
  const rubric = sectionBody(review, 'Rubric Breakdown');
  const score = sectionBody(review, 'Score');
  if (rubric && score) {
    push({
      target_type: 'eval',
      reason: `Review rubric (score ${score}) can be captured as a regression check.`,
      target_path: '.agent/promotions/applied/evals/' + `${slug(taskTitle)}.md`,
      body: `# Eval: ${taskTitle}\n\nCaptured from run ${runId}.\n\n## Score\n${score}\n\n## Rubric\n${rubric}\n`,
    });
  }

  if (!candidates.length) return [];

  const ts = nowIso();
  const promotionsRunDir = join(runDir, 'promotions');
  ensureDir(promotionsRunDir);
  const records: PromotionRecord[] = [];
  for (const c of candidates) {
    const id = uniqueId('promotion', `${runId}-${c.target_type}`);
    const proposalPath = join(promotionsRunDir, `${id}.md`);
    writeFileSync(proposalPath, c.body);
    const rec: PromotionRecord = {
      schema_version: 1,
      id,
      run_id: runId,
      target_type: c.target_type,
      status: 'proposed',
      reason: c.reason,
      target_path: c.target_path,
      proposal_path: proposalPath,
      created_at: ts,
      updated_at: ts,
    };
    writeFileSync(safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`), JSON.stringify(rec, null, 2));
    records.push(rec);
  }
  return records;
}
export function listPromotions(cwd = process.cwd()): PromotionRecord[] {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'promotions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

export function resolvePromotion(
  id: string,
  status: 'approved' | 'rejected',
  cwd = process.cwd(),
): PromotionRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`);
  if (!existsSync(p)) throw new Error(`promotion ${id} not found`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as PromotionRecord;
  rec.status = status;
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'runtime-manager',
      type: 'promotion.decided',
      payload: { promotion_id: id, decision: status, target_type: rec.target_type, runtime_label: 'promotion_loop' },
      artifactRefs: [`promotions/${id}.json`],
    });
  rebuildIndex(root);
  return rec;
}

export function applyApprovedPromotion(id: string, cwd = process.cwd()): PromotionRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`);
  if (!existsSync(p)) throw new Error(`promotion ${id} not found`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as PromotionRecord;
  if (rec.status === 'applied') return rec;
  if (rec.status !== 'approved') throw new Error(`promotion ${id} is not approved (status: ${rec.status})`);
  const proposalBody = existsSync(rec.proposal_path) ? readFileSync(rec.proposal_path, 'utf8') : rec.reason;
  // Resolve the target inside the project root; safeJoin refuses escapes/secrets.
  const targetAbs = safeJoin(root, rec.target_path);
  const marker = `<!-- promotion:${id} -->`;
  if (rec.target_type === 'memory') {
    // Append a verified fact, idempotently (skip if marker already present).
    const existing = existsSync(targetAbs) ? readFileSync(targetAbs, 'utf8') : '# Project Facts\n';
    if (!existing.includes(marker)) {
      ensureDir(dirname(targetAbs));
      writeFileSync(targetAbs, `${existing.replace(/\n*$/, '\n')}\n${marker}\n${proposalBody.replace(/\n*$/, '\n')}`);
    }
  } else {
    // Durable artifact files: write-if-missing so user content is never clobbered.
    writeIfMissing(targetAbs, `${marker}\n${proposalBody.replace(/\n*$/, '\n')}`);
  }
  rec.status = 'applied';
  rec.applied_path = relative(root, targetAbs);
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'runtime-manager',
      type: 'promotion.applied',
      payload: { promotion_id: id, target_type: rec.target_type, applied_path: rec.applied_path, runtime_label: 'promotion_loop' },
      artifactRefs: [`promotions/${id}.json`],
    });
  rebuildIndex(root);
  return rec;
}

export function rebuildIndex(cwd = process.cwd()): ProductIndex {
  const root = projectRoot(cwd);
  ensureDir(safeJoin(root, AGENT_DIR));
  const projectPath = safeJoin(root, AGENT_DIR, 'project.yaml');
  const project = existsSync(projectPath) ? (readYaml(projectPath) as unknown as ProjectRecord) : null;
  const runsDir = safeJoin(root, AGENT_DIR, 'runs');
  const runs = existsSync(runsDir)
    ? readdirSync(runsDir)
        .filter((f) => statSync(join(runsDir, f)).isDirectory() && existsSync(join(runsDir, f, 'run.yaml')))
        .map((f) => normalizeRunMeta(readYaml(join(runsDir, f, 'run.yaml')) as unknown as RunMeta, join(runsDir, f)))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];
  const artifacts: { run_id: string; type: string; path: string }[] = [];
  for (const run of runs) {
    const dir = join(root, run.run_dir);
    if (!existsSync(dir)) continue;
    for (const rel of listFilesRecursive(dir))
      artifacts.push({ run_id: run.id, type: rel, path: join(run.run_dir, rel) });
  }
  const index: ProductIndex = {
    schema_version: 1,
    generated_at: nowIso(),
    project,
    tasks: listTasks(root),
    runs,
    approvals: listApprovals(root),
    promotions: listPromotions(root),
    artifacts,
  };
  writeFileSync(safeJoin(root, AGENT_DIR, 'index.json'), JSON.stringify(index, null, 2));
  rebuildRuntimeProjectionStore(root);
  return index;
}

export function rebuildRuntimeProjectionStore(cwd = process.cwd()): RuntimeProjection {
  const root = projectRoot(cwd);
  const runsDir = safeJoin(root, AGENT_DIR, 'runs');
  const events: RuntimeEventEnvelope[] = [];
  if (existsSync(runsDir)) {
    for (const runId of readdirSync(runsDir).sort()) {
      const dir = join(runsDir, runId);
      if (statSync(dir).isDirectory()) events.push(...readRuntimeEvents(dir));
    }
  }
  const projection = rebuildRuntimeProjection(events);
  const projectionDir = safeJoin(root, AGENT_DIR, 'projection');
  ensureDir(projectionDir);
  writeFileSync(join(projectionDir, 'runtime-projection.json'), JSON.stringify(projection, null, 2));
  try {
    writeProjectionSqlite(join(projectionDir, 'runtime.sqlite'), projection);
  } catch (err: any) {
    writeFileSync(join(projectionDir, 'runtime-sqlite-error.txt'), String(err.message || err));
  }
  return projection;
}
export function listFilesRecursive(rootDir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(rootDir, prefix)).sort()) {
    const rel = prefix ? join(prefix, name) : name;
    const full = join(rootDir, rel);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...listFilesRecursive(rootDir, rel));
    else out.push(rel);
  }
  return out;
}
export function loadIndex(cwd = process.cwd()): ProductIndex {
  const p = safeJoin(projectRoot(cwd), AGENT_DIR, 'index.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : rebuildIndex(cwd);
}

export function proposeApply(runId: string, cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const runDir = runPath(runId, cwd);
  const run = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  if (run.status !== 'completed' || run.decision !== 'pass')
    throw new Error(`run ${runId} is not eligible for apply proposal; collect a passing run first`);
  if (run.mode === 'multi') {
    const conflictPath = join(runDir, 'conflict-report.generated.md');
    if (!existsSync(conflictPath) || !/Status: clear/.test(readFileSync(conflictPath, 'utf8')))
      throw new Error(`run ${runId} has no clear multi-worker conflict report`);
  }
  const proposalDir = join(runDir, 'apply-proposal');
  ensureDir(proposalDir);
  const patches: string[] = [];
  if (run.mode === 'multi') {
    const workOrdersDir = join(runDir, 'work-orders');
    for (const file of readdirSync(workOrdersDir)
      .filter((f) => f.endsWith('.yaml'))
      .sort()) {
      const workerId = file.replace(/\.yaml$/, '');
      const order = readYaml(join(workOrdersDir, file));
      const workspace = String(order.isolated_workspace || '');
      if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace))
        throw new Error(`cannot create apply proposal: ${workerId} isolated workspace unavailable`);
      const files = collectChangedFilesFromWorkspace(workspace);
      const denied = files.filter(isSecretPath);
      if (denied.length)
        throw new Error(`refusing apply proposal with denied paths from ${workerId}: ${denied.join(', ')}`);
      const patch =
        git(['diff', '--binary', 'HEAD'], workspace) +
        git(['diff', '--binary', '--cached'], workspace) +
        git(['ls-files', '--others', '--exclude-standard'], workspace)
          .split('\n')
          .filter(Boolean)
          .map((file) => normalizeNoIndexPatch(gitNoIndexPatch(workspace, file)))
          .join('\n');
      const patchPath = join(proposalDir, `${workerId}.patch`);
      writeFileSync(patchPath, patch);
      patches.push(patchPath);
    }
  } else {
    throw new Error(
      `apply proposal requires isolated multi-worker run; ${run.mode} runs mutate the live workspace directly`,
    );
  }
  if (!patches.some((patchPath) => readFileSync(patchPath, 'utf8').trim()))
    throw new Error(`apply proposal for ${runId} has no patch content`);
  const digest = createHash('sha256');
  for (const patchPath of patches) digest.update(readFileSync(patchPath));
  const proposalSha = digest.digest('hex');
  const manifest = {
    schema_version: 1,
    run_id: runId,
    patches: patches.map((x) => relative(proposalDir, x)),
    sha256: proposalSha,
    created_at: nowIso(),
  };
  writeFileSync(join(proposalDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(proposalDir, 'README.md'),
    `# Apply Proposal\n\nRun: ${runId}\n\nThis proposal is approval-gated. Review patch files before applying.\n\nPatches:\n${patches.map((x) => `- ${x}`).join('\n')}\n`,
  );
  return createApprovalInternal(
    runId,
    'apply_proposal',
    'high',
    `Review apply proposal for ${runId}: ${relative(root, proposalDir)}`,
    cwd,
    { proposal_sha256: proposalSha, proposal_path: relative(root, proposalDir) },
  );
}

export function applyApprovedProposal(approvalId: string, cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const approvalPath = safeJoin(root, AGENT_DIR, 'approvals', `${approvalId}.json`);
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8')) as ApprovalRecord;
  if (approval.status !== 'approved') throw new Error(`approval ${approvalId} is not approved`);
  if (approval.type !== 'apply_proposal') throw new Error(`approval ${approvalId} is not an apply_proposal`);
  const runDir = runPath(approval.run_id, cwd);
  const run = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
  if (run.status !== 'completed' || run.decision !== 'pass')
    throw new Error(`run ${approval.run_id} is not eligible for apply`);
  const proposalDir = join(runDir, 'apply-proposal');
  if (!existsSync(proposalDir)) throw new Error(`missing apply proposal for ${approval.run_id}`);
  const manifestPath = join(proposalDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`missing apply proposal manifest for ${approval.run_id}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.run_id !== approval.run_id) throw new Error(`apply proposal run mismatch for ${approval.run_id}`);
  const manifestPatches = Array.isArray(manifest.patches) ? manifest.patches : [];
  if (!manifestPatches.length) throw new Error(`apply proposal manifest has no patches for ${approval.run_id}`);
  const seen = new Set<string>();
  const patches = manifestPatches.map((relPath: string) => {
    if (typeof relPath !== 'string' || relPath.startsWith('/') || relPath.includes('..'))
      throw new Error(`invalid manifest patch path: ${relPath}`);
    if (seen.has(relPath)) throw new Error(`duplicate manifest patch path: ${relPath}`);
    seen.add(relPath);
    const full = safeJoin(proposalDir, relPath);
    if (!existsSync(full) || !readFileSync(full, 'utf8').trim()) throw new Error(`missing manifest patch: ${relPath}`);
    return full;
  });
  const diskPatches = readdirSync(proposalDir)
    .filter((f) => f.endsWith('.patch'))
    .sort();
  const manifestNames = [...seen].map((x) => basename(x)).sort();
  if (JSON.stringify(diskPatches) !== JSON.stringify(manifestNames))
    throw new Error(`apply proposal patch set differs from manifest for ${approval.run_id}`);
  const touched = new Set<string>();
  for (const patch of patches) {
    const content = readFileSync(patch, 'utf8');
    if (!content.trim().startsWith('diff --git ')) throw new Error(`invalid patch content: ${basename(patch)}`);
    for (const file of patchTouchedFiles(content)) {
      if (touched.has(file)) throw new Error(`apply proposal has overlapping patch target: ${file}`);
      touched.add(file);
    }
  }
  const digest = createHash('sha256');
  for (const patch of patches) digest.update(readFileSync(patch));
  const actualSha = digest.digest('hex');
  if (manifest.sha256 !== actualSha || approval.proposal_sha256 !== actualSha)
    throw new Error(`apply proposal digest mismatch for ${approval.run_id}`);
  try {
    const bundlePath = join(proposalDir, 'bundle.patch');
    writeFileSync(bundlePath, patches.map((patch: string) => readFileSync(patch, 'utf8')).join('\n'));
    execFileSync('git', ['apply', '--check', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['apply', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    approval.status = 'failed_to_apply';
    approval.updated_at = nowIso();
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
    throw new Error(String(err.stderr || err.message || err));
  }
  approval.status = 'applied';
  approval.updated_at = nowIso();
  writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
  rebuildIndex(root);
  return approval;
}

export function runProcessJsonFiles(runDir: string): string[] {
  return existsSync(runDir)
    ? readdirSync(runDir)
        .filter((f) => f.endsWith('.process.json'))
        .sort()
    : [];
}
export function readRunProcessSummary(runDir: string): {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  valid: number;
  invalid: number;
  errors: string[];
} {
  const files = runProcessJsonFiles(runDir);
  if (!files.length) return { exitCode: null, stderr: '', stdout: '', valid: 0, invalid: 0, errors: [] };
  let exitCode = 0;
  let stderr = '';
  let stdout = '';
  let valid = 0;
  let invalid = 0;
  const errors: string[] = [];
  for (const file of files) {
    try {
      const p = JSON.parse(readFileSync(join(runDir, file), 'utf8'));
      if (typeof p.exit_code !== 'number') throw new Error('missing numeric exit_code');
      valid++;
      if (p.exit_code !== 0) exitCode = p.exit_code;
      stderr += String(p.stderr || '');
      stdout += String(p.stdout || '');
    } catch (err: any) {
      invalid++;
      errors.push(`${file}: ${String(err.message || err)}`);
    }
  }
  if (valid === 0 || invalid > 0) exitCode = 1;
  return { exitCode, stderr, stdout, valid, invalid, errors };
}
export function normalizeRunMeta(meta: RunMeta, runDir: string): RunMeta {
  const out = { ...meta };
  const hasCancel = existsSync(join(runDir, 'cancel.requested'));
  const hasEnded = Boolean(out.ended_at);
  const processSummary = readRunProcessSummary(runDir);
  const hasReview = existsSync(join(runDir, 'review.md')) && Boolean(out.decision);
  const processOk = processSummary.valid > 0 && processSummary.invalid === 0 && processSummary.exitCode === 0;
  if (processSummary.invalid > 0)
    writeFileSync(
      join(runDir, 'process-evidence-errors.json'),
      JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2),
    );
  if (processSummary.invalid > 0) {
    out.status = 'failed';
    out.decision = 'blocked';
    out.exit_code = processSummary.exitCode ?? 1;
    out.ended_at = out.ended_at || nowIso();
    out.updated_at = nowIso();
    return out;
  }
  if (hasCancel) {
    out.status = 'cancelled';
    out.ended_at = out.ended_at || nowIso();
    out.updated_at = out.updated_at || out.ended_at;
    return out;
  }
  if (
    ['completed', 'failed', 'timed_out'].includes(String(out.status)) &&
    processSummary.exitCode !== null &&
    !processOk
  ) {
    out.status = 'failed';
    out.exit_code = processSummary.exitCode ?? 1;
    out.updated_at = nowIso();
    return out;
  }
  if (activeStatus(out.status) && hasEnded) {
    out.status = hasReview && processOk ? 'completed' : 'failed';
    out.exit_code = processSummary.exitCode ?? out.exit_code;
    return out;
  }
  if (out.status === 'created' && processSummary.exitCode !== null) {
    out.status = hasReview && processOk ? 'completed' : 'failed';
    out.exit_code = processSummary.exitCode;
    out.ended_at = out.ended_at || nowIso();
    return out;
  }
  return out;
}
export function reconcileRuns(cwd = process.cwd()): { checked: number; repaired: number; repairs: string[] } {
  const root = projectRoot(cwd);
  const agentDir = safeJoin(root, AGENT_DIR);
  ensureDir(agentDir);
  const dir = safeJoin(root, AGENT_DIR, 'runs');
  if (!existsSync(dir)) {
    const empty = { checked: 0, repaired: 0, repairs: [] as string[] };
    writeFileSync(
      join(agentDir, 'reconciliation.json'),
      JSON.stringify({ status: 'PASS', ...empty, generated_at: nowIso() }, null, 2),
    );
    return empty;
  }
  let checked = 0;
  let repaired = 0;
  const repairs: string[] = [];
  for (const runId of readdirSync(dir)
    .filter((f) => existsSync(join(dir, f, 'run.yaml')))
    .sort()) {
    checked++;
    const runDir = join(dir, runId);
    const p = join(runDir, 'run.yaml');
    const before = readYaml(p) as unknown as RunMeta;
    const after = normalizeRunMeta(before, runDir);
    const beforeText = yaml(before as unknown as Record<string, unknown>);
    const afterText = yaml(after as unknown as Record<string, unknown>);
    const cmdPath = join(runDir, 'executor-command.txt');
    let repairedCommand = false;
    const cmd = readIfExists(cmdPath).trim();
    if (/^(진행해|다시|해봐|좋아|ㅇㅋ|오케이)(\s|$)/.test(cmd)) {
      writeFileSync(cmdPath, `[reconciled natural-language operator reply; not an executable command] ${cmd}\n`);
      repairedCommand = true;
    }
    if (beforeText !== afterText || repairedCommand) {
      writeFileSync(p, afterText);
      repaired++;
      repairs.push(
        `${runId}: ${before.status} -> ${after.status}${repairedCommand ? '; reconciled natural-language command' : ''}`,
      );
    }
  }
  const result = { checked, repaired, repairs };
  writeFileSync(
    join(agentDir, 'reconciliation.json'),
    JSON.stringify({ status: repaired === 0 ? 'PASS' : 'FAIL', ...result, generated_at: nowIso() }, null, 2),
  );
  rebuildIndex(root);
  return result;
}
function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function activeStatus(status: unknown): boolean {
  return ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(status));
}

export function cleanupWorktrees(cwd = process.cwd()): void {
  const root = projectRoot(cwd);
  const base = resolve(dirname(root), `${basename(root)}.agent-worktrees`);
  const failures: string[] = [];
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
    for (const line of list.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const worktree = line.slice('worktree '.length).trim();
      if (worktree && worktree.startsWith(base)) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktree], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err: any) {
          failures.push(`${worktree}: ${String(err.stderr || err.message || err).trim()}`);
        }
      }
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      failures.push(`prune: ${String(err.stderr || err.message || err).trim()}`);
    }
    const remaining = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('worktree ') && line.slice('worktree '.length).trim().startsWith(base));
    if (remaining.length) failures.push(`registered worktrees remain: ${remaining.join(', ')}`);
  } catch (err: any) {
    failures.push(String(err.stderr || err.message || err).trim());
  }
  if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  if (existsSync(base)) failures.push(`filesystem worktree base remains: ${base}`);
  if (failures.length) throw new Error(`worktree cleanup failed: ${failures.join('; ')}`);
}

// src/run/lifecycle.ts — the run-lifecycle engine, extracted wholesale from core.ts (critique #5).
// createRun / startRun / collectRun / cancelRun + reconcileRuns + their mutually-recursive private
// helpers move together as ONE unit, so the recursion stays intra-module and no core<->module cycle
// is created. core.ts re-exports the public symbols; every importer keeps working unchanged.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { buildCompositionPlan } from '../composition/composition.js';
import { normalizeRunMeta, readRunProcessSummary, } from './run-utils.js';
import { listFilesRecursive, rebuildIndex, } from '../project/index-builder.js';
import { createApproval, createApprovalInternal, listApprovals } from '../project/approvals.js';
import { classifyRunPromotions, listPromotions } from '../project/promotions.js';
import { initProject } from '../project/registry.js';
import { taskPath, updateTaskStatus } from '../project/task.js';
import { appendRuntimeEvent, createRuntimeLedgerHeadBinding, envelopeHash, readRuntimeEvents, } from '../events/ledger.js';
import { skillContractIssuesForRun } from '../harness/skill-contracts.js';
import { runVerifier } from '../harness/verifier.js';
import { markFactsVerifiedByEvents } from '../memory/fabric.js';
import { evaluatePermission } from '../policy/permission-broker.js';
import { findProjectedRun, rebuildRuntimeProjection } from '../projection/projection.js';
import { AgyCliAdapter } from '../runtime/agy-adapter.js';
import { detectCodexCli } from '../runtime/codex-adapter.js';
import { runCodexExec } from '../runtime/codex-exec-runner.js';
import { createCodexLaunchProof } from '../runtime/codex-process-bridge.js';
import { OmxCliAdapter } from '../runtime/omx-adapter.js';
import { AGENT_DIR, ensureDir, git, gitEvidence, gitNoIndexPatch, isSecretPath, normalizeNoIndexPatch, nowIso, parseFrontmatter, patchTouchedFiles, projectRoot, readYaml, redact, safeJoin, uniqueId, writeIfMissing, yaml, } from '../util.js';
const RUN_MODES = new Set(['basic', 'roles', 'multi']);
function recordEvidenceError(runDir, label, result) {
    if (result.ok)
        return;
    const path = join(runDir, 'evidence-errors.json');
    const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
    existing.push({ label, ok: false, error: redact(result.error || result.output), recorded_at: nowIso() });
    writeFileSync(path, JSON.stringify(existing, null, 2));
}
export function createRun(taskId, options = {}, cwd = process.cwd()) {
    initProject(cwd);
    const root = projectRoot(cwd);
    const taskFile = taskPath(taskId, cwd);
    if (!existsSync(taskFile))
        throw new Error(`task not found: ${taskId}`);
    const ts = nowIso();
    const id = uniqueId('run', taskId);
    const mode = options.mode || 'basic';
    if (!RUN_MODES.has(mode))
        throw new Error(`invalid run mode: ${mode}`);
    const runDirRel = join(AGENT_DIR, 'runs', id);
    const runDir = safeJoin(root, runDirRel);
    ensureDir(runDir);
    const meta = {
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
    writeFileSync(join(runDir, 'run.yaml'), yaml(meta));
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
    writeFileSync(join(runDir, 'context.md'), `# Context\n\nProject: ${basename(root)}\nTask: ${taskId}\nMode: ${mode}\nCreated: ${ts}\n`);
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
    if (mode === 'roles')
        createRoleArtifacts(runDir, taskId);
    if (mode === 'multi')
        createMultiArtifacts(runDir, taskId, meta.max_workers || 2, root, id);
    updateTaskStatus(taskId, 'running', cwd);
    rebuildIndex(root);
    return meta;
}
function buildPrompt(taskId, mode, maxWorkers) {
    return `# Agent Run Prompt\n\nTask: ${taskId}\nMode: ${mode}\nMax workers: ${maxWorkers}\n\nThe executor must produce deterministic evidence. Worker prose alone is not trusted.\n`;
}
export function latestRunId(cwd = process.cwd()) {
    const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'runs');
    if (!existsSync(dir))
        return null;
    const runs = readdirSync(dir)
        .filter((f) => statSync(join(dir, f)).isDirectory())
        .sort();
    return runs.at(-1) || null;
}
export function runPath(runId, cwd = process.cwd()) {
    return safeJoin(projectRoot(cwd), AGENT_DIR, 'runs', runId);
}
function createRoleArtifacts(runDir, taskId) {
    ensureDir(join(runDir, 'work-orders'));
    ensureDir(join(runDir, 'worker-outputs'));
    writeIfMissing(join(runDir, 'manager-plan.md'), `# Manager Plan\n\n## Restated Goal\nExecute ${taskId}.\n\n## Proposed Strategy\nCreate one bounded worker order and require deterministic evidence.\n\n## Work Orders\nworker-001\n\n## Risks\nScope drift; missing verification.\n\n## Acceptance Criteria\nWorker output, transcript, diff, review, and next action are complete.\n`);
    writeIfMissing(join(runDir, 'work-orders', 'worker-001.yaml'), yaml({
        id: 'worker-001',
        role: 'worker',
        task_id: taskId,
        allowed_tools: ['filesystem.read', 'git.diff'],
        max_minutes: 30,
        status: 'queued',
    }));
    writeIfMissing(join(runDir, 'worker-outputs', 'worker-001.md'), `# Worker Output\n\n## Objective\nExecute ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Tests Run\n\n## Completion Against Acceptance Criteria\nPending collect.\n`);
    writeIfMissing(join(runDir, 'transcript.md'), '# Transcript\n\n');
    writeIfMissing(join(runDir, 'tool-calls.jsonl'), '');
}
function createMultiArtifacts(runDir, taskId, maxWorkers, root, runId) {
    ensureDir(join(runDir, 'work-orders'));
    ensureDir(join(runDir, 'worker-outputs'));
    const workerCount = Math.min(maxWorkers, 3);
    for (let i = 1; i <= workerCount; i++) {
        const id = `worker-${String(i).padStart(3, '0')}`;
        const branchName = `agent/${runId}/${id}`;
        const workspacePath = createWorkerWorktree(root, runId, id, branchName);
        writeIfMissing(join(runDir, 'work-orders', `${id}.yaml`), yaml({
            id,
            role: 'worker',
            task_id: taskId,
            isolated_workspace: workspacePath,
            branch_name: branchName,
            allowed_tools: ['filesystem.read', 'git.diff'],
            status: 'queued',
        }));
        writeIfMissing(join(runDir, 'worker-outputs', `${id}.md`), `# Worker Output\n\n## Objective\nBounded worker ${id} for ${taskId}.\n\n## Summary\nPending execution.\n\n## Files Changed\n\n## Completion Against Acceptance Criteria\nPending collect.\n`);
    }
    writeIfMissing(join(runDir, 'synthesis.md'), '# Synthesis\n\nHuman/manager synthesis notes. Generated evidence is in synthesis.generated.md.\n');
    writeIfMissing(join(runDir, 'conflict-report.md'), '# Conflict Report\n\nHuman review notes. Generated evidence is in conflict-report.generated.md.\n');
    writeFileSync(join(runDir, 'synthesis.generated.md'), '# Synthesis\n\nStatus: pending\n');
    writeFileSync(join(runDir, 'conflict-report.generated.md'), '# Conflict Report\n\nStatus: pending\n');
}
function createWorkerWorktree(root, runId, workerId, branchName) {
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
    }
    catch (err) {
        const reason = String(err.stderr || err.message || err)
            .trim()
            .split('\n')[0];
        return `worktree_unavailable:${worktreePath}:${reason}`;
    }
}
export async function startRun(runId, options = {}, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const runDir = runPath(runId, cwd);
    const meta = readYaml(join(runDir, 'run.yaml'));
    if (meta.status === 'cancelled' || existsSync(join(runDir, 'cancel.requested'))) {
        meta.status = 'cancelled';
        meta.ended_at = meta.ended_at || nowIso();
        meta.updated_at = nowIso();
        writeFileSync(join(runDir, 'run.yaml'), yaml(meta));
        rebuildIndex(root);
        return meta;
    }
    const operatorProvided = options.command !== undefined || meta.command !== undefined;
    const command = options.command || meta.command || '';
    meta.started_at = nowIso();
    meta.updated_at = meta.started_at;
    if (!command && meta.executor === 'command') {
        meta.status = 'failed';
        meta.decision = 'blocked';
        meta.ended_at = meta.started_at;
        writeFileSync(join(runDir, 'no-executor-attached.md'), `# No Executor Attached

Start was requested, but no explicit command or first-class executor was attached. Nothing was executed, so this run cannot be collected as completed.
`);
        appendRuntimeEvent(runDir, {
            runId,
            source: 'runtime-manager',
            type: 'runtime.lifecycle.unproven',
            payload: {
                requested_adapter_kind: meta.executor,
                runtime_label: 'no_executor_attached',
                first_class: false,
                command_present: false,
                evidence_status: 'blocked',
                note: 'No default smoke command is executed. Provide an explicit command or attach a real executor.',
            },
            artifactRefs: ['no-executor-attached.md'],
        });
        writeFileSync(join(runDir, 'run.yaml'), yaml(meta));
        updateTaskStatus(meta.task_id, 'blocked', cwd);
        rebuildIndex(root);
        return meta;
    }
    meta.status = meta.mode === 'multi' ? 'workers_running' : meta.mode === 'roles' ? 'dispatching' : 'collecting';
    writeFileSync(join(runDir, 'run.yaml'), yaml(meta));
    writeFileSync(join(runDir, 'executor-command.txt'), redact(command));
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
        command: command || undefined,
        tool: meta.executor,
        nativeMediation: meta.executor === 'codex',
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
                mediation: permission.mediation,
            },
            artifactRefs: command ? ['executor-command.txt'] : [],
        });
    if (meta.executor === 'codex') {
        await runCodexExecutor(runDir, root, meta, options.sandbox, options.timeoutMs);
        writePromotionLearningGateForRun(runDir, root, runId);
        return readYaml(join(runDir, 'run.yaml'));
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
                source: event.source,
                type: event.type,
                sessionId: event.sessionId,
                payload: event.payload,
                artifactRefs: event.artifactRefs.map((ref) => (ref.startsWith(runDir) ? relative(runDir, ref) : ref)),
            });
    }
    if (command && shellMutationRequiresApproval && !hasApprovedShellMutation(runId, command, cwd)) {
        const approval = createApprovalInternal(runId, 'shell_mutation', 'high', `Mutating shell command requires approval for run ${runId}`, cwd, { command_sha256: commandDigest(command), command_preview: redact(command).slice(0, 240) });
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
        writeFileSync(join(runDir, 'policy-blocked.md'), `# Policy Blocked\n\nMutating shell command requires approval before execution.\n`);
        writeFileSync(join(runDir, 'run.yaml'), yaml(meta));
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
        if (meta.mode === 'roles')
            await runRoles(runDir, root, command, options.timeoutMs);
        else if (meta.mode === 'multi')
            await runMultiWorkers(runDir, command, options.timeoutMs);
        else
            await runCommand(runDir, root, command, 'executor', options.timeoutMs);
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
                note: meta.executor === 'command'
                    ? 'command executor uses primitive shell'
                    : `${meta.executor} requested with an explicit shell command; primitive shell evidence cannot prove first-class runtime lifecycle`,
                shell_execution: true,
            },
            artifactRefs,
        });
    }
    writePromotionLearningGateForRun(runDir, root, runId);
    return readYaml(join(runDir, 'run.yaml'));
}
function terminateProcessTree(child, signal) {
    if (child.pid) {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch { }
    }
    try {
        child.kill(signal);
    }
    catch { }
}
function runCommand(runDir, cwd, command, label, timeoutMs = 30000, extraEnv = {}) {
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
            if (settled)
                return;
            terminateProcessTree(child, 'SIGTERM');
            setTimeout(() => {
                if (!settled)
                    terminateProcessTree(child, 'SIGKILL');
            }, 1000).unref();
        }, timeoutMs);
        const cancelTimer = setInterval(() => {
            if (settled)
                return;
            if (existsSync(cancelPath)) {
                cancelled = true;
                terminateProcessTree(child, 'SIGTERM');
                setTimeout(() => {
                    if (!settled)
                        terminateProcessTree(child, 'SIGKILL');
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
            const log = {
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
function sha256Local(text) {
    return createHash('sha256').update(text).digest('hex');
}
function writeJsonWithHash(path, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path, text);
    return sha256Local(text);
}
function changedFilesFromDiff(diff) {
    return diff
        .split('\n')
        .filter((line) => line.startsWith('diff --git '))
        .map((line) => line.match(/^diff --git a\/(.*?) b\//)?.[1] || '')
        .filter(Boolean);
}
function collectNativeExecutorDiff(root) {
    const tracked = git(['diff', '--binary'], root);
    const untracked = existsSync(join(root, '.git'))
        ? git(['ls-files', '--others', '--exclude-standard'], root)
            .split('\n')
            .filter(Boolean)
            .map((file) => normalizeNoIndexPatch(gitNoIndexPatch(root, file)))
            .join('\n')
        : '';
    return [tracked, untracked].filter((part) => part.trim()).join('\n');
}
function writeNativeExecutorEvidence(runDir, root, runId, result) {
    const diffText = collectNativeExecutorDiff(root);
    writeFileSync(join(runDir, 'native-diff.patch'), diffText);
    const refs = [
        'executor.process.json',
        'executor.stdout.log',
        'executor.stderr.log',
        'codex-events.jsonl',
        'codex-last-message.txt',
        'native-diff.patch',
    ].filter((ref) => existsSync(join(runDir, ref)));
    const artifact = {
        schema_version: 1,
        run_id: runId,
        executor: 'codex',
        status: 'native-harness-assisted',
        generated_at: nowIso(),
        session_id: result.session_id,
        unowned_surfaces: [
            'native executor owns in-loop shell/file mediation',
            'native executor owns model/tool scheduling inside codex exec',
            'Dominic verifies only captured process, transcript, diff, ledger, and artifact hashes',
        ],
        raw_artifacts: refs.map((ref) => ({ ref, sha256: sha256Local(readFileSync(join(runDir, ref), 'utf8')) })),
        diff_ref: 'native-diff.patch',
        diff_sha256: sha256Local(diffText),
        effect_classification: {
            process_exit_zero: result.exit_code === 0,
            last_message_present: result.last_message.length > 0,
            session_identifier_present: Boolean(result.session_id),
            diff_present: diffText.trim().startsWith('diff --git'),
            changed_files: changedFilesFromDiff(diffText),
        },
    };
    writeFileSync(join(runDir, 'native-evidence.json'), `${JSON.stringify(artifact, null, 2)}\n`);
}
function writeRoleContractGate(runDir, root) {
    const hardGateDir = join(root, AGENT_DIR, 'hard-gates');
    ensureDir(hardGateDir);
    ensureDir(join(runDir, 'role-contract'));
    const relRun = relative(root, runDir);
    const diffText = git(['diff', '--binary'], root);
    const diffPath = join(runDir, 'role-contract', 'roles-diff.patch');
    writeFileSync(diffPath, diffText);
    const touchedFiles = diffText
        .split('\n')
        .filter((line) => line.startsWith('diff --git '))
        .map((line) => line.match(/^diff --git a\/(.*?) b\//)?.[1] || '')
        .filter(Boolean);
    const processExitsAllZero = ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json'].every((file) => {
        const log = readJsonSafe(join(runDir, file));
        return log?.exit_code === 0;
    });
    const workerProducedDiff = touchedFiles.length > 0 && diffText.trim().length > 0;
    const reviewerApproved = processExitsAllZero && workerProducedDiff;
    const reviewerFindings = reviewerApproved
        ? [{ id: 'role-contract-runtime-evidence', severity: 'info' }]
        : [
            ...(!processExitsAllZero ? [{ id: 'role-process-nonzero-exit', severity: 'high' }] : []),
            ...(!workerProducedDiff ? [{ id: 'worker-produced-no-diff', severity: 'high' }] : []),
        ];
    const workOrder = {
        id: 'worker-001',
        scope: 'role-contract',
        command_ref: `${relRun}/executor-command.txt`,
        acceptance: [
            'manager-plan.json exists',
            'worker-output.json references manager work order',
            'review.json references process and diff evidence',
        ],
    };
    const workOrderHash = sha256Local(JSON.stringify(workOrder));
    const managerPlan = {
        schema_version: 1,
        role: 'manager',
        task_sha256: existsSync(join(runDir, 'task.md')) ? sha256Local(readFileSync(join(runDir, 'task.md'), 'utf8')) : '',
        context_sha256: existsSync(join(runDir, 'context.md'))
            ? sha256Local(readFileSync(join(runDir, 'context.md'), 'utf8'))
            : '',
        acceptance_criteria: workOrder.acceptance,
        work_orders: [workOrder],
        process_refs: [`${relRun}/manager.process.json`],
    };
    const managerPath = join(runDir, 'role-contract', 'manager-plan.json');
    const managerSha = writeJsonWithHash(managerPath, managerPlan);
    const workerOutput = {
        schema_version: 1,
        role: 'worker',
        worker_id: 'worker-001',
        consumed_work_order_sha256: workOrderHash,
        process_refs: [`${relRun}/worker-001.process.json`],
        touched_files: touchedFiles,
        diff_refs: [`${relRun}/role-contract/roles-diff.patch`],
        diff_sha256: sha256Local(diffText),
        result_summary: 'worker process completed and role contract evidence was generated from runtime artifacts',
    };
    const workerPath = join(runDir, 'role-contract', 'worker-output.json');
    const workerSha = writeJsonWithHash(workerPath, workerOutput);
    const review = {
        schema_version: 1,
        role: 'reviewer',
        manager_plan_sha256: managerSha,
        worker_output_sha256: workerSha,
        process_refs: [`${relRun}/reviewer.process.json`],
        diff_refs: [`${relRun}/role-contract/roles-diff.patch`],
        decision: reviewerApproved ? 'APPROVE' : 'REQUEST_CHANGES',
        findings: reviewerFindings,
    };
    const reviewerPath = join(runDir, 'role-contract', 'review.json');
    const reviewerSha = writeJsonWithHash(reviewerPath, review);
    writeJsonWithHash(join(hardGateDir, 'v1-role-contract.json'), {
        status: reviewerApproved ? 'PASS' : 'FAIL',
        source_run_id: basename(runDir),
        manager_plan_path: relative(root, managerPath),
        manager_plan_sha256: managerSha,
        worker_output_path: relative(root, workerPath),
        worker_output_sha256: workerSha,
        reviewer_output_path: relative(root, reviewerPath),
        reviewer_output_sha256: reviewerSha,
    });
}
function fileShaIfExists(path) {
    return existsSync(path) ? sha256Local(readFileSync(path, 'utf8')) : '';
}
function writePromotionLearningGateForRun(runDir, root, runId) {
    const applied = listPromotions(root)
        .filter((promotion) => promotion.status === 'applied' && promotion.applied_path && existsSync(join(root, promotion.applied_path)))
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
    if (!applied?.applied_path)
        return;
    const sourceRunDir = safeJoin(root, AGENT_DIR, 'runs', applied.run_id);
    if (!existsSync(sourceRunDir))
        return;
    const hardGateDir = join(root, AGENT_DIR, 'hard-gates', 'promotion');
    ensureDir(hardGateDir);
    const loadedAbs = join(root, applied.applied_path);
    const loadedSha = fileShaIfExists(loadedAbs);
    const changedField = 'recommendation';
    const taskContextSha = sha256Local(`${applied.id}:${applied.target_type}:${applied.target_path}`);
    const beforePath = join(sourceRunDir, 'promotion-before-state.json');
    const beforeSha = writeJsonWithHash(beforePath, {
        run_id: applied.run_id,
        task_context_sha256: taskContextSha,
        stable_fields: { [changedField]: 'promotion-not-loaded' },
    });
    const loadedEvent = appendRuntimeEvent(runDir, {
        runId,
        source: 'runtime-manager',
        type: 'promotion.loaded',
        payload: {
            promotion_id: applied.id,
            loaded_promotion_artifact_sha256: loadedSha,
            changed_field: changedField,
            applied_path: applied.applied_path,
            runtime_label: 'promotion_loop',
        },
        artifactRefs: [applied.applied_path],
    });
    const runtimeEventsPath = join(runDir, 'events.jsonl');
    const runtimeEvents = readRuntimeEvents(runDir);
    const runtimeLedgerHead = createRuntimeLedgerHeadBinding(runtimeEvents);
    const persistedLoadedEvent = runtimeEvents.find((event) => event.sequence === loadedEvent.sequence && event.type === 'promotion.loaded') ||
        loadedEvent;
    const afterPath = join(runDir, 'promotion-state.json');
    const afterSha = writeJsonWithHash(afterPath, {
        run_id: runId,
        task_context_sha256: taskContextSha,
        loaded_promotion_artifact_sha256: loadedSha,
        runtime_events_path: `${relative(root, runDir)}/events.jsonl`,
        runtime_events_sha256: fileShaIfExists(runtimeEventsPath),
        promotion_loaded_event_sequence: persistedLoadedEvent.sequence,
        promotion_loaded_event_sha256: envelopeHash(persistedLoadedEvent),
        runtime_event_count: runtimeLedgerHead.event_count,
        runtime_ledger_head_sha256: runtimeLedgerHead.ledger_head_sha256,
        stable_fields: { [changedField]: `loaded:${applied.id}` },
    });
    const findingPath = join(hardGateDir, 'review-finding.json');
    const findingSha = writeJsonWithHash(findingPath, {
        promotion_id: applied.id,
        source_run_id: applied.run_id,
        finding: applied.reason,
        proposal_path: relative(root, applied.proposal_path),
    });
    const candidatePath = join(hardGateDir, 'candidate.json');
    const candidateSha = writeJsonWithHash(candidatePath, {
        promotion_id: applied.id,
        target_type: applied.target_type,
        target_path: applied.target_path,
        review_finding_sha256: findingSha,
    });
    const approvalPath = join(hardGateDir, 'approval.json');
    const approvalSha = writeJsonWithHash(approvalPath, {
        promotion_id: applied.id,
        status: 'approved',
        promotion_candidate_sha256: candidateSha,
    });
    const applyPath = join(hardGateDir, 'apply.json');
    const applySha = writeJsonWithHash(applyPath, {
        promotion_id: applied.id,
        status: 'applied',
        promotion_approval_sha256: approvalSha,
        applied_path: applied.applied_path,
        loaded_promotion_artifact_sha256: loadedSha,
    });
    const effectPath = join(hardGateDir, 'effect.json');
    const effectSha = writeJsonWithHash(effectPath, {
        promotion_id: applied.id,
        promotion_apply_sha256: applySha,
        before_run_sha256: beforeSha,
        after_run_sha256: afterSha,
        changed_field: changedField,
        before: 'promotion-not-loaded',
        after: `loaded:${applied.id}`,
    });
    writeJsonWithHash(join(root, AGENT_DIR, 'hard-gates', 'promotion-learning.json'), {
        status: 'PASS',
        source_promotion_id: applied.id,
        before_run_path: relative(root, beforePath),
        before_run_sha256: beforeSha,
        after_run_path: relative(root, afterPath),
        after_run_sha256: afterSha,
        review_finding_path: relative(root, findingPath),
        review_finding_sha256: findingSha,
        promotion_candidate_path: relative(root, candidatePath),
        promotion_candidate_sha256: candidateSha,
        promotion_approval_path: relative(root, approvalPath),
        promotion_approval_sha256: approvalSha,
        promotion_apply_path: relative(root, applyPath),
        promotion_apply_sha256: applySha,
        promotion_effect_path: relative(root, effectPath),
        promotion_effect_sha256: effectSha,
        loaded_promotion_artifact_path: applied.applied_path,
        loaded_promotion_artifact_sha256: loadedSha,
        changed_field: changedField,
    });
}
const SKILL_SCAN_LIMIT = 160;
function sectionBody(text, heading) {
    const re = new RegExp(`##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
    const match = text.match(re);
    return match ? match[1].trim() : '';
}
function buildCodexExecutionPrompt(taskMd, taskId, root = process.cwd(), runId) {
    const body = taskMd.includes('\n---') ? taskMd.slice(taskMd.indexOf('\n---', 4) + 4) : taskMd;
    const goal = taskGoalFromMarkdown(taskMd, taskId);
    const context = sectionBody(body, 'Context');
    const constraints = sectionBody(body, 'Constraints');
    const doneMeans = sectionBody(body, 'Done Means');
    const githubReportTask = isGithubFolderPptReportTask(goal);
    const skillRouting = buildSkillRoutingPrompt(root, goal, runId);
    return [
        'You are an autonomous coding agent executing a single bounded task in this repository.',
        '',
        '# Task',
        goal,
        context ? `\n# Context\n${context}` : '',
        constraints ? `\n# Constraints\n${constraints}` : '',
        doneMeans ? `\n# Done means\n${doneMeans}` : '',
        '',
        '# How to work',
        '- Make the actual file changes required to accomplish the task. Do not only describe them.',
        '- Keep the change tightly scoped to the task; do not touch unrelated files.',
        '- Do not run destructive or remote git commands (no reset --hard, push, or branch deletion).',
        githubReportTask
            ? '- This task is a GitHub-folder report task. Produce the operator-visible artifacts by running: `node dist/cli.js report github-projects --github-dir ~/Documents/github`. The PPTX/Markdown/JSON must be created under the repository root `reports/` directory, not under `.agent/`.'
            : '',
        githubReportTask
            ? '- Closed loop is mandatory: after generating the report, run `node scripts/verify-pptx-openable.mjs <reports/.../github-projects-report.pptx>`. If it prints `PPTX_OPENABLE_FAIL`, fix the report generator, regenerate the report, and rerun verification. Do not finish until it prints `PPTX_OPENABLE_PASS`.'
            : '',
        githubReportTask
            ? '- Do not edit or weaken `scripts/verify-pptx-openable.mjs` to force a pass. Collect stores this verifier hash before you run and will automatically block the run if the verifier changes. On macOS with Keynote installed, the verifier must prove Keynote can reopen the PPTX. If hand-written OOXML fails, fix generation by using a Keynote-exported PPTX or another genuinely openable PPTX path.'
            : '',
        githubReportTask
            ? '- This machine has `/Applications/Keynote.app`. If PPTX generation fails Keynote reopen, update `scripts/github-projects-report.mjs` to generate/export via Keynote/AppleScript (for example Korean theme `흰색`, blank master `빈 페이지`) or another real editor-export path; do not solve it by changing the verifier.'
            : '',
        githubReportTask
            ? '- After the verification PASS, include the exact PPTX path and the `PPTX_OPENABLE_PASS ...` line in your final message.'
            : '',
        githubReportTask
            ? '- Do not report a PPTX path unless it still exists at the end. Before finalizing, run `test -f <pptx>` or `ls -l <pptx>` on the exact path you will report.'
            : '',
        githubReportTask
            ? '- Quality loop is mandatory: if `.agent/report-quality/latest-github-projects.md` exists, read it before editing. Treat it as a critic handoff, not optional advice. Improve the report story/design/tooling until it is decision-grade, not merely openable.'
            : '',
        githubReportTask
            ? '- Before finishing, produce or update a short `report-quality-response.md` next to the generated report artifacts explaining how you addressed the previous critique: claim spine, proof objects, visual method, and remaining gaps.'
            : '',
        githubReportTask
            ? '- `report-quality-response.md` and `skill-usage-response.md` must be agent-authored after inspecting the generated output. Do not solve this by adding canned sidecar writers to `scripts/github-projects-report.mjs`.'
            : '',
        githubReportTask
            ? '- Skill routing is mandatory: if `.agent/skill-routing/latest-github-projects.md` exists, read it before editing. Inspect the named skill files, choose the minimum useful skills, and write `skill-usage-response.md` next to the generated report artifacts.'
            : '',
        skillRouting,
        '- When finished, briefly summarize what you changed.',
    ]
        .filter((line) => line !== '')
        .join('\n');
}
function taskGoalFromMarkdown(taskMd, taskId) {
    const meta = parseFrontmatter(taskMd);
    const body = taskMd.includes('\n---') ? taskMd.slice(taskMd.indexOf('\n---', 4) + 4) : taskMd;
    return sectionBody(body, 'Goal') || String(meta.title || '') || taskId;
}
function isGithubFolderPptReportTask(text) {
    return /깃[헙허]브?폴더|github\s*folder|github\s*projects/i.test(text) && /ppt|pptx|피피티|보고/i.test(text);
}
function uniqueSkillCandidates(candidates) {
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
        const key = candidate.path;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(candidate);
    }
    return out;
}
function uniqueSkillCandidatesByName(candidates) {
    const seen = new Set();
    const out = [];
    for (const candidate of candidates) {
        const key = candidate.name.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(candidate);
    }
    return out;
}
function findSkillFilesUnder(dir, depth = 0, out = []) {
    if (out.length >= SKILL_SCAN_LIMIT || depth > 8 || !existsSync(dir))
        return out;
    let entries = [];
    try {
        entries = readdirSync(dir).sort();
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (out.length >= SKILL_SCAN_LIMIT)
            break;
        if (entry === 'node_modules' || entry === '.git')
            continue;
        const full = join(dir, entry);
        let isDirectory = false;
        let isSymbolicLink = false;
        try {
            const st = lstatSync(full);
            isDirectory = st.isDirectory();
            isSymbolicLink = st.isSymbolicLink();
        }
        catch {
            continue;
        }
        if (isSymbolicLink)
            continue;
        if (isDirectory) {
            if (entry === 'SKILL.md')
                continue;
            findSkillFilesUnder(full, depth + 1, out);
        }
        else if (entry === 'SKILL.md') {
            out.push(full);
        }
    }
    return out;
}
function localSkillRoots(root) {
    const home = homedir();
    return [
        join(root, '.codex', 'skills'),
        join(root, '.agents', 'skills'),
        join(root, '.codex', 'plugins', 'cache', 'openai-primary-runtime'),
        join(root, '.codex', 'plugins', 'cache', 'openai-bundled'),
        join(home, '.codex', 'skills'),
        join(home, '.agents', 'skills'),
        join(home, '.codex', 'plugins', 'cache', 'openai-primary-runtime'),
        join(home, '.codex', 'plugins', 'cache', 'openai-bundled'),
    ];
}
function skillNameFromPath(path) {
    const parent = basename(dirname(path));
    const grandparent = basename(dirname(dirname(path)));
    return parent === 'skills' ? grandparent : parent;
}
function readSkillSnippet(path) {
    try {
        return readFileSync(path, 'utf8').slice(0, 2400);
    }
    catch {
        return '';
    }
}
function discoverSkillCandidates(root, goal) {
    const lowerGoal = goal.toLowerCase();
    const wantsPresentation = /ppt|pptx|피피티|presentation|slides?|deck|보고서|발표/.test(lowerGoal);
    const wantsRepoAnalysis = /github|깃[헙허]|repo|repository|프로젝트|요약|분석|rank|active|활성/.test(lowerGoal);
    const wantsDocs = /docx|word|document|문서/.test(lowerGoal);
    const wantsSheet = /xlsx|spreadsheet|sheet|엑셀|스프레드시트/.test(lowerGoal);
    const wantsBrowser = /browser|localhost|web ui|웹|브라우저|screenshot|스크린샷/.test(lowerGoal);
    const wantsUi = /figma|ui|ux|frontend|화면|디자인/.test(lowerGoal);
    const files = uniqueSkillCandidates(localSkillRoots(root)
        .flatMap((dir) => findSkillFilesUnder(dir))
        .map((path) => ({ name: skillNameFromPath(path), path, reason: '' })));
    const candidates = [];
    for (const file of files) {
        const haystack = `${file.name}\n${file.path}\n${readSkillSnippet(file.path)}`.toLowerCase();
        const push = (reason) => candidates.push({ ...file, reason });
        if (wantsPresentation && /presentations?|powerpoint|pptx|slides?|deck/.test(haystack))
            push('deliverable is a PPTX/deck, so presentation generation and rendered-slide QA may apply');
        else if (wantsRepoAnalysis &&
            /(^|[/\W])analy[sz]e|analysis skill|ranked (?:repository|local) evidence|ranked synthesis|repository analysis|repo analysis|명시적.*근거|분석/.test(haystack))
            push('task requires ranked local evidence synthesis and confidence/evidence separation');
        else if (wantsDocs && /documents?|docx|word/.test(haystack))
            push('deliverable or source may be a document artifact');
        else if (wantsSheet && /spreadsheet|xlsx|sheet/.test(haystack))
            push('deliverable or source may be spreadsheet-shaped');
        else if (wantsBrowser && /browser|playwright|screenshot/.test(haystack))
            push('task may need browser/screenshot verification');
        else if (wantsUi && /figma|frontend|ui|ux|visual/.test(haystack))
            push('task may need UI/design-specific guidance');
    }
    return uniqueSkillCandidatesByName(uniqueSkillCandidates(candidates).sort((a, b) => skillCandidatePriority(b, goal, root) - skillCandidatePriority(a, goal, root))).slice(0, 8);
}
function skillCandidatePriority(candidate, goal, root) {
    const name = candidate.name.toLowerCase();
    const path = candidate.path.toLowerCase();
    const lowerGoal = goal.toLowerCase();
    const wantsPresentation = /ppt|pptx|피피티|presentation|slides?|deck|보고서|발표/.test(lowerGoal);
    const wantsRepoAnalysis = /github|깃[헙허]|repo|repository|프로젝트|요약|분석|rank|active|활성/.test(lowerGoal);
    let score = 0;
    if (wantsPresentation && name === 'presentations')
        score += 100;
    if (wantsPresentation && /presentations.*skills.*presentations.*skill\.md/.test(path))
        score += 80;
    if (wantsRepoAnalysis && name === 'analyze')
        score += 90;
    if (path.includes('/.codex/plugins/cache/openai-primary-runtime/'))
        score += 15;
    if (path.includes('/.codex/skills/'))
        score += 10;
    if (path.startsWith(root.toLowerCase()))
        score += 20;
    return score;
}
function skillRoutingArtifactBody(root, goal, runId) {
    const candidates = discoverSkillCandidates(root, goal);
    const fallbackPath = runId
        ? `${AGENT_DIR}/runs/${runId}/skill-usage-response.md`
        : `${AGENT_DIR}/skill-usage-response.md`;
    const candidateLines = candidates.length
        ? candidates.map((c, i) => `${i + 1}. ${c.name}\n   - path: ${c.path}\n   - why: ${c.reason}`).join('\n')
        : '- No local SKILL.md candidates matched this task. State that explicitly if you finish without skill use.';
    return `# Skill Routing Candidates

## Task
${goal}

## Candidates
${candidateLines}

## Required agent behavior
- Read relevant candidate SKILL.md files before choosing tools or changing artifacts.
- Choose the minimum useful skills; do not pretend every listed skill is relevant.
- Reject irrelevant candidates with a concrete reason.
- Write \`skill-usage-response.md\` next to the primary user-visible output artifact.
- If there is no primary output directory, write \`${fallbackPath}\`.
- Treat native skill output as advisory by default. A skill can gate completion only with a HARD \`AcceptanceContract\` in \`skill-acceptance-contracts.json\` or \`.agent/skill-contracts/*.json\`.
- HARD contracts must use shared verifier bindings only; SOFT contracts must not gate completion.
- The response must include: inspected_skills, selected_skills, rejected_skills_or_methods, how each selected skill changed the result, evidence that the skill was not only name-dropped, remaining_gaps.
`;
}
function buildSkillRoutingPrompt(root, goal, runId) {
    const body = skillRoutingArtifactBody(root, goal, runId);
    return `# Skill routing
Before finalizing, use the local skill registry below as an agent-owned routing step.
${body}
`;
}
// Real codex executor: actually runs `codex exec` so the agent performs the task
// and edits files. The real exit code and resulting git diff are the trusted
// evidence; binary detection alone never passes a run.
async function runCodexExecutor(runDir, root, meta, sandbox, timeoutMs) {
    const runId = meta.id;
    const taskMd = existsSync(join(runDir, 'task.md')) ? readFileSync(join(runDir, 'task.md'), 'utf8') : '';
    const taskGoal = taskGoalFromMarkdown(taskMd, meta.task_id);
    const prompt = buildCodexExecutionPrompt(taskMd, meta.task_id, root, runId);
    const effectiveSandbox = sandbox || (isGithubFolderPptReportTask(prompt) ? 'danger-full-access' : 'workspace-write');
    writeFileSync(join(runDir, 'codex-prompt.md'), prompt);
    writeFileSync(join(runDir, 'skill-routing-candidates.md'), skillRoutingArtifactBody(root, taskGoal, runId));
    writeVerificationBaseline(root, runDir, prompt);
    writeFileSync(join(runDir, 'executor-command.txt'), redact(`codex exec --sandbox ${effectiveSandbox} -C ${root} <task-prompt>`));
    // AGENT_CODEX_BIN is the hermetic-test / wrapper seam; when set we trust it and
    // skip real binary detection and the forensic `codex doctor` launch proof.
    const codexBin = process.env.AGENT_CODEX_BIN;
    const detected = codexBin ? { available: true, path: codexBin, version: 'codex-bin-override' } : detectCodexCli(root);
    if (!codexBin)
        // Forensic detection evidence (binary path, version, doctor) — not the run result.
        createCodexLaunchProof({ runId, cwd: root, agentDir: safeJoin(root, AGENT_DIR), runDir, prompt });
    if (!detected.available) {
        const stderr = `codex CLI unavailable: ${detected.error || 'not found'}`;
        writeFileSync(join(runDir, 'executor.process.json'), JSON.stringify({
            label: 'executor',
            cwd: root,
            command: `codex exec --sandbox ${effectiveSandbox}`,
            started_at: nowIso(),
            ended_at: nowIso(),
            exit_code: 127,
            stdout: '',
            stderr,
        }, null, 2));
        appendRuntimeEvent(runDir, {
            runId,
            source: 'codex-adapter',
            type: 'runtime.lifecycle.unsupported',
            payload: {
                adapter_kind: 'codex',
                runtime_label: 'codex_cli',
                evidence_status: 'unsupported',
                first_class: false,
                note: stderr,
            },
            artifactRefs: ['executor.process.json'],
        });
        return;
    }
    const result = await runCodexExec({
        runDir,
        cwd: root,
        prompt,
        sandbox: effectiveSandbox,
        timeoutMs,
        cancelRequested: () => existsSync(join(runDir, 'cancel.requested')),
    });
    writeNativeExecutorEvidence(runDir, root, runId, result);
    appendRuntimeEvent(runDir, {
        runId,
        source: 'codex-adapter',
        type: result.session_id ? 'runtime.session.started' : 'runtime.lifecycle.unproven',
        sessionId: result.session_id,
        payload: {
            requested_adapter_kind: 'codex',
            adapter_kind: 'codex',
            runtime_label: 'native-harness-assisted',
            first_class: Boolean(result.session_id),
            evidence_status: result.session_id ? 'executed' : 'unproven',
            native_status: 'native-harness-assisted',
            unowned_surfaces: [
                'native executor owns in-loop shell/file mediation',
                'native executor owns model/tool scheduling inside codex exec',
            ],
            session_id: result.session_id,
            exit_code: result.exit_code,
            timed_out: result.timed_out,
            cancelled: result.cancelled,
            token_usage: result.token_usage,
            event_count: result.event_count,
            codex_version: detected.version,
            last_message_present: Boolean(result.last_message),
        },
        artifactRefs: [
            'executor.process.json',
            'codex-events.jsonl',
            'codex-last-message.txt',
            'native-diff.patch',
            'native-evidence.json',
        ],
    });
}
async function runRoles(runDir, root, command, timeoutMs) {
    const managerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'manager'), 'manager', timeoutMs, {
        ROLE: 'manager',
    });
    appendFile(join(runDir, 'manager-plan.md'), `
## Process Evidence
manager exit: ${managerExit}
`);
    const workerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'worker').replaceAll('{worker}', 'worker-001'), 'worker-001', timeoutMs, { ROLE: 'worker', WORKER_ID: 'worker-001' });
    appendFile(join(runDir, 'worker-outputs', 'worker-001.md'), `
## Process Exit
${workerExit}
`);
    const reviewerExit = await runCommand(runDir, root, command.replaceAll('{role}', 'reviewer'), 'reviewer', timeoutMs, {
        ROLE: 'reviewer',
    });
    appendFile(join(runDir, 'review.md'), `
## Reviewer Process Evidence
reviewer exit: ${reviewerExit}
`);
    writeRoleContractGate(runDir, root);
}
async function runMultiWorkers(runDir, command, timeoutMs) {
    const ordersDir = join(runDir, 'work-orders');
    const files = readdirSync(ordersDir)
        .filter((f) => f.endsWith('.yaml'))
        .sort();
    const startedAt = nowIso();
    writeFileSync(join(runDir, 'scheduler.json'), JSON.stringify({
        schema_version: 1,
        started_at: startedAt,
        max_workers: files.length,
        strategy: 'bounded-parallel',
        workers: files.map((file) => file.replace(/\.yaml$/, '')),
    }, null, 2));
    await Promise.all(files.map(async (file) => {
        const workerId = file.replace(/\.yaml$/, '');
        const order = readYaml(join(ordersDir, file));
        const workspace = String(order.isolated_workspace || '');
        if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace)) {
            const log = {
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
    }));
    const scheduler = JSON.parse(readFileSync(join(runDir, 'scheduler.json'), 'utf8'));
    scheduler.ended_at = nowIso();
    writeFileSync(join(runDir, 'scheduler.json'), JSON.stringify(scheduler, null, 2));
}
function appendFile(path, text) {
    writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + text : text);
}
function appendGeneratedWorkerFiles(runDir, workerId, workspace) {
    const outputPath = join(runDir, 'worker-outputs', `${workerId}.md`);
    if (!existsSync(outputPath))
        return;
    const text = readFileSync(outputPath, 'utf8');
    if (!/Pending execution|Pending collect/.test(text))
        return;
    const files = collectChangedFilesFromWorkspace(workspace);
    if (!files.length)
        return;
    appendFile(outputPath, `
## Files Changed
${files.map((file) => `- ${file}`).join('\n')}
`);
}
function requiresShellApproval(command, operatorProvided) {
    if (!operatorProvided)
        return false;
    return !isReadonlyShellCommand(command);
}
function isReadonlyShellCommand(command) {
    const trimmed = command.trim();
    if (/[;&|<>`$(){}[\]\n\r]/.test(trimmed))
        return false;
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
    if (cmd === 'pwd' && parts.length === 1)
        return true;
    if (cmd === 'ls')
        return args.every((a) => /^-[A-Za-z]+$/.test(a) || /^[A-Za-z0-9_./-]+$/.test(a));
    if (cmd === 'cat')
        return args.length > 0 && args.every((a) => /^[A-Za-z0-9_./-]+$/.test(a) && !isSecretPath(a));
    if (cmd !== 'git')
        return false;
    if (sub === 'worktree' && args[0] === 'list')
        return args.slice(1).every((a) => safeFlags.has(a));
    if (!['status', 'diff', 'show', 'log', 'rev-parse', 'branch'].includes(sub || ''))
        return false;
    return args.every((a) => safeFlags.has(a) || (/^[A-Za-z0-9_./:-]+$/.test(a) && !a.startsWith('--output') && a !== '-o'));
}
function commandDigest(command) {
    return createHash('sha256').update(command).digest('hex');
}
function approvedShellMutationApproval(runId, command, cwd = process.cwd()) {
    const digest = commandDigest(command);
    return listApprovals(cwd).find((a) => a.run_id === runId && a.type === 'shell_mutation' && a.status === 'approved' && a.command_sha256 === digest);
}
function hasApprovedShellMutation(runId, command, cwd = process.cwd()) {
    return Boolean(approvedShellMutationApproval(runId, command, cwd));
}
export function collectRun(runId, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const runDir = runPath(runId, cwd);
    const runMeta = readYaml(join(runDir, 'run.yaml'));
    if (runMeta.status === 'cancelled')
        return runMeta;
    if (!hasStartedEvidence(runDir, runMeta)) {
        runMeta.status = 'failed';
        runMeta.decision = 'blocked';
        runMeta.ended_at = nowIso();
        runMeta.updated_at = runMeta.ended_at;
        writeFileSync(join(runDir, 'review.md'), `# Review\n\n## Decision\nblocked\n\n## Blocking Issues\n- Run has no real execution evidence. Start must run an explicit command or attach a first-class executor before Collect can complete it.\n`);
        writeNextActions(runDir, 'blocked');
        writeClosedLoopReport(root, runDir, runMeta, 'blocked');
        writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta));
        updateTaskStatus(runMeta.task_id, 'blocked', cwd);
        rebuildIndex(root);
        return runMeta;
    }
    runMeta.status = 'collecting';
    writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta));
    const collectStatus = gitEvidence(['status', '--short', '--branch'], root);
    const collectDiff = gitEvidence(['diff'], root);
    writeFileSync(join(runDir, 'collect-status.txt'), collectStatus.output);
    const diff = collectDiff.output;
    writeFileSync(join(runDir, 'collect-diff.patch'), diff);
    writeFileSync(join(runDir, 'diff.patch'), diff);
    recordEvidenceError(runDir, 'collect-status', collectStatus);
    recordEvidenceError(runDir, 'collect-diff', collectDiff);
    if (!existsSync(join(runDir, 'result.md')))
        writeFileSync(join(runDir, 'result.md'), `# Result\n\n## Summary\nCollected run ${runId}.\n\n## Evidence\n- baseline-status.txt\n- collect-status.txt\n- diff.patch\n`);
    if (runMeta.mode === 'multi')
        updateConflictAndSynthesis(runDir);
    let decision = existsSync(join(runDir, 'cancel.requested'))
        ? 'blocked'
        : writeReview(runDir, runMeta.mode || 'basic');
    const verificationIssues = collectRunVerificationIssues(root, runDir);
    if (verificationIssues.length) {
        writeVerificationIssuesIntoReview(runDir, verificationIssues);
        decision = 'blocked';
    }
    const qualityIssues = collectRunReportQualityIssues(root, runDir);
    if (qualityIssues.length && decision === 'pass') {
        writeReportQualityIssuesIntoReview(runDir, qualityIssues);
        decision = 'changes_requested';
    }
    const skillIssues = collectRunSkillUsageIssues(root, runDir);
    if (skillIssues.length && decision === 'pass') {
        writeSkillUsageIssuesIntoReview(runDir, skillIssues);
        decision = 'changes_requested';
    }
    const ledgerVerdict = runVerifier({ type: 'ledger', root: runDir, events: readRuntimeEvents(runDir) });
    appendRuntimeEvent(runDir, {
        runId: runMeta.id,
        source: 'runtime-manager',
        type: 'verifier.completed',
        payload: ledgerVerdict,
        artifactRefs: ['events.jsonl'],
    });
    if (decision === 'pass' && ledgerVerdict.status !== 'supported') {
        writeLedgerVerifierIssueIntoReview(runDir, ledgerVerdict.reason);
        decision = 'blocked';
    }
    // Cross-run memory freshness: a run that passes (its ledger verifier is supported here) earns the
    // right to stamp last_verified_at on any fabric fact grounded entirely in this run's events —
    // e.g. the boundary facts an M8 run produced citing its own ledger. Recency is thus carried from
    // the run that created a fact to the verifier that confirmed it, never self-asserted.
    if (decision === 'pass') {
        markFactsVerifiedByEvents(safeJoin(root, AGENT_DIR), readRuntimeEvents(runDir).map((event) => event.event_id), nowIso());
    }
    writeNextActions(runDir, decision);
    if (decision !== 'pass')
        createApproval(runMeta.id, decision === 'blocked' ? 'conflict_resolution' : 'changes_requested', 'high', `Run ${runMeta.id} requires ${decision}`, cwd);
    runMeta.status = decision === 'pass' ? 'completed' : decision === 'blocked' ? 'failed' : 'completed';
    runMeta.decision = decision;
    runMeta.exit_code = readExitCode(runDir);
    runMeta.ended_at = nowIso();
    runMeta.updated_at = runMeta.ended_at;
    writeClosedLoopReport(root, runDir, runMeta, decision);
    appendRuntimeEvent(runDir, {
        runId: runMeta.id,
        source: 'runtime-manager',
        type: decision === 'pass' ? 'run.completed' : 'run.failed',
        payload: {
            decision,
            status: runMeta.status,
            exit_code: runMeta.exit_code,
            runtime_label: 'run_lifecycle',
            ledger_verifier_status: ledgerVerdict.status,
            ledger_verifier_reason: ledgerVerdict.reason,
        },
        artifactRefs: ['review.md', 'result.md', 'closed-loop-report.md', 'closed-loop-report.json'],
    });
    writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta));
    classifyRunPromotions(runDir, runMeta.id, root);
    updateTaskStatus(runMeta.task_id, decision === 'pass' ? 'done' : decision === 'blocked' ? 'blocked' : 'changes_requested', cwd);
    rebuildIndex(root);
    return runMeta;
}
function hasStartedEvidence(runDir, meta) {
    if (!meta.started_at)
        return false;
    if (meta.mode === 'basic')
        return (existsSync(join(runDir, 'executor.process.json')) ||
            readRuntimeEvents(runDir).some((event) => ['codex-adapter', 'omx-adapter', 'agy-adapter'].includes(event.source) && Boolean(event.artifact_refs.length)));
    if (meta.mode === 'roles')
        return ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json'].every((f) => existsSync(join(runDir, f)));
    if (meta.mode === 'multi') {
        const ordersDir = join(runDir, 'work-orders');
        if (!existsSync(join(runDir, 'scheduler.json')) || !existsSync(ordersDir))
            return false;
        const workers = readdirSync(ordersDir)
            .filter((f) => f.endsWith('.yaml'))
            .map((f) => f.replace(/\.yaml$/, ''));
        return workers.length > 0 && workers.every((workerId) => existsSync(join(runDir, `${workerId}.process.json`)));
    }
    return false;
}
export function cancelRun(runId, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const runDir = runPath(runId, cwd);
    writeFileSync(join(runDir, 'cancel.requested'), nowIso());
    const runMeta = readYaml(join(runDir, 'run.yaml'));
    runMeta.status = 'cancelled';
    runMeta.ended_at = nowIso();
    runMeta.updated_at = runMeta.ended_at;
    writeFileSync(join(runDir, 'run.yaml'), yaml(runMeta));
    writeFileSync(join(runDir, 'cancelled.md'), `# Cancelled\n\nRun ${runId} was cancelled at ${runMeta.ended_at}.\n`);
    updateTaskStatus(runMeta.task_id, 'cancelled', cwd);
    rebuildIndex(root);
    return runMeta;
}
function hasAdapterRuntimeEvidence(runDir) {
    return readRuntimeEvents(runDir).some((event) => ['codex-adapter', 'omx-adapter', 'agy-adapter'].includes(event.source) && event.artifact_refs.length > 0);
}
function readExitCode(runDir) {
    const summary = readRunProcessSummary(runDir);
    return summary.exitCode ?? (hasAdapterRuntimeEvidence(runDir) ? 0 : 1);
}
function processArtifactRefsForMode(runDir, mode) {
    const candidates = mode === 'basic'
        ? ['executor.process.json']
        : mode === 'roles'
            ? ['manager.process.json', 'worker-001.process.json', 'reviewer.process.json']
            : readdirSync(runDir)
                .filter((f) => /^worker-\d+\.process\.json$/.test(f))
                .sort();
    return candidates.filter((file) => existsSync(join(runDir, file)));
}
export function runtimeTruthForRun(root, run) {
    try {
        const runDir = join(root, run.run_dir);
        const projection = rebuildRuntimeProjection(readRuntimeEvents(runDir));
        const projected = findProjectedRun(projection, run.id);
        const labels = projected?.labels || [];
        const stale = ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(run.status)) && Boolean(run.ended_at);
        if (stale)
            return { label: 'stale_not_running', css: 'stale', evidence: 'terminal evidence exists despite active metadata' };
        if (run.status === 'awaiting_approval')
            return {
                label: 'approval_required',
                css: 'awaiting_approval',
                evidence: 'operator approval required before execution',
            };
        if (labels.includes('no_executor_attached') || existsSync(join(runDir, 'no-executor-attached.md')))
            return {
                label: 'no_executor_attached',
                css: 'blocked',
                evidence: 'nothing executed; provide an explicit command or real executor',
            };
        if (run.status === 'created')
            return {
                label: 'draft_no_executor',
                css: 'unproven',
                evidence: 'run record exists, but no executor has run yet',
            };
        if (labels.includes('primitive_shell'))
            return {
                label: 'explicit_shell',
                css: 'primitive_shell',
                evidence: 'explicit command execution, not first-class Codex/OMX/agy runtime',
            };
        const nativeAssistedEvent = readRuntimeEvents(runDir).find((event) => event.payload?.native_status === 'native-harness-assisted' ||
            event.payload?.runtime_label === 'native-harness-assisted');
        if (nativeAssistedEvent)
            return {
                label: 'native-harness-assisted',
                css: 'native_assisted',
                evidence: `native executor evidence present; unowned surfaces: ${JSON.stringify(nativeAssistedEvent.payload?.unowned_surfaces || [])}`,
            };
        const firstClassSession = projected?.sessions.find((session) => ['codex', 'omx', 'agy'].includes(String(session.adapter_kind)) && session.status === 'started');
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
    }
    catch {
        return {
            label: run.executor === 'command' ? 'primitive_shell' : 'unproven',
            css: 'unproven',
            evidence: 'projection unavailable',
        };
    }
}
function updateConflictAndSynthesis(runDir) {
    const outputsDir = join(runDir, 'worker-outputs');
    const outputs = existsSync(outputsDir)
        ? readdirSync(outputsDir)
            .filter((f) => f.endsWith('.md'))
            .sort()
        : [];
    const changedByWorker = new Map();
    const denied = [];
    const evidenceIssues = [];
    const worktreeIssues = collectWorktreeIssues(runDir);
    const worktreeChanges = collectWorktreeChanges(runDir, worktreeIssues);
    for (const output of outputs) {
        const workerId = output.replace(/\.md$/, '');
        const text = readFileSync(join(outputsDir, output), 'utf8');
        const declaredFiles = extractFilesChanged(text);
        const actualFiles = worktreeChanges.get(workerId) || [];
        const mergedFiles = new Set([...actualFiles, ...declaredFiles]);
        for (const file of mergedFiles) {
            if (isSecretPath(file))
                denied.push(`${workerId}: ${file}`);
            const workers = changedByWorker.get(file) || [];
            workers.push(workerId);
            changedByWorker.set(file, workers);
        }
        const undeclared = actualFiles.filter((file) => !declaredFiles.includes(file));
        const staleDeclared = declaredFiles.filter((file) => !actualFiles.includes(file) && !(actualFiles.includes('README.md') && file === 'README.md'));
        if (undeclared.length)
            evidenceIssues.push(`${workerId}: actual worktree changes not declared (${undeclared.join(', ')})`);
        if (staleDeclared.length)
            evidenceIssues.push(`${workerId}: declared files not present in worktree diff (${staleDeclared.join(', ')})`);
    }
    for (const [workerId, files] of worktreeChanges.entries()) {
        if (outputs.includes(`${workerId}.md`))
            continue;
        for (const file of files) {
            if (isSecretPath(file))
                denied.push(`${workerId}: ${file}`);
            const workers = changedByWorker.get(file) || [];
            workers.push(workerId);
            changedByWorker.set(file, workers);
        }
        if (files.length)
            evidenceIssues.push(`${workerId}: worktree has changes but worker output is missing`);
    }
    const overlaps = [...changedByWorker.entries()].filter(([, workers]) => new Set(workers).size > 1);
    const hasConflict = overlaps.length > 0 || denied.length > 0 || worktreeIssues.length > 0 || evidenceIssues.length > 0;
    const multiVerifier = writeMultiExecutorVerification(runDir, outputs, worktreeChanges, hasConflict, [
        ...denied,
        ...worktreeIssues,
        ...evidenceIssues,
    ]);
    const status = hasConflict ? 'blocked' : 'clear';
    writeFileSync(join(runDir, 'conflict-report.generated.md'), [
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
    ].join('\n'));
    writeFileSync(join(runDir, 'synthesis.generated.md'), `# Synthesis\n\n## Verifier Decision\n${multiVerifier.decision}\n\nVerifier artifact: multi-executor-verification.json\n\n## Accepted Outputs\n${multiVerifier.workers
        .filter((worker) => worker.raw_evidence_supported)
        .map((worker) => `- ${worker.output_ref}`)
        .join('\n') || 'None.'}\n\n## Rejected Outputs\n${multiVerifier.issues.length ? multiVerifier.issues.map((issue) => `- ${issue}`).join('\n') : 'None.'}\n\n## Conflicts\n${hasConflict ? 'Blocking conflicts, denied paths, worktree issues, or evidence mismatches found. See conflict-report.generated.md.' : 'No blocking conflicts detected from worker-reported changed files and actual worktree diffs.'}\n\n## Recommendation\n${multiVerifier.decision === 'PASS' ? 'Proceed to review from verifier-backed artifacts only.' : 'Do not apply automatically; resolve verifier or conflict blockers first.'}\n`);
}
function readWorkerExitCode(runDir, workerId) {
    const path = join(runDir, `${workerId}.process.json`);
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed.exit_code === 'number' ? parsed.exit_code : null;
    }
    catch {
        return null;
    }
}
function writeMultiExecutorVerification(runDir, outputs, worktreeChanges, hasConflict, inheritedIssues) {
    const workOrdersDir = join(runDir, 'work-orders');
    const expectedWorkerIds = existsSync(workOrdersDir)
        ? readdirSync(workOrdersDir)
            .filter((file) => file.endsWith('.yaml'))
            .map((file) => file.replace(/\.yaml$/, ''))
            .sort()
        : outputs.map((output) => output.replace(/\.md$/, '')).sort();
    const outputSet = new Set(outputs.map((output) => output.replace(/\.md$/, '')));
    const workers = expectedWorkerIds.map((workerId) => {
        const output = `${workerId}.md`;
        const outputPath = join(runDir, 'worker-outputs', output);
        const outputExists = outputSet.has(workerId) && existsSync(outputPath);
        const text = outputExists ? readFileSync(outputPath, 'utf8') : '';
        const declared = extractFilesChanged(text);
        const actual = worktreeChanges.get(workerId) || [];
        const processExitCode = readWorkerExitCode(runDir, workerId);
        const declaredMatchesActual = declared.every((file) => actual.includes(file)) && actual.every((file) => declared.includes(file));
        const passSummaryClaimed = /\b(PASS|passed|done|complete|completed|success)\b/i.test(text);
        const selfPromotionClaimed = /self[-\s]?promot|promote\s+(?:my|this)\s+(?:output|worker|result)|overall\s+PASS/i.test(text);
        return {
            worker_id: workerId,
            output_ref: `worker-outputs/${output}`,
            output_exists: outputExists,
            process_ref: `${workerId}.process.json`,
            process_exit_code: processExitCode,
            declared_changed_files: declared,
            actual_changed_files: actual,
            pass_summary_claimed: passSummaryClaimed,
            self_promotion_claimed: selfPromotionClaimed,
            raw_evidence_supported: processExitCode === 0 && declaredMatchesActual && !selfPromotionClaimed,
        };
    });
    const issues = [...inheritedIssues];
    for (const worker of workers) {
        if (!worker.output_exists)
            issues.push(`${worker.worker_id}: worker output is missing`);
        if (worker.process_exit_code !== 0)
            issues.push(`${worker.worker_id}: process exit was ${worker.process_exit_code ?? 'missing'}`);
        if (worker.self_promotion_claimed)
            issues.push(`${worker.worker_id}: worker attempted self-promotion/PASS authority`);
        if (worker.pass_summary_claimed && !worker.raw_evidence_supported)
            issues.push(`${worker.worker_id}: PASS/done summary is contradicted by raw process or diff evidence`);
    }
    const report = {
        schema_version: 1,
        generated_at: nowIso(),
        decision: !hasConflict &&
            workers.length > 0 &&
            workers.every((worker) => worker.raw_evidence_supported) &&
            issues.length === 0
            ? 'PASS'
            : 'FAIL',
        workers,
        issues: [...new Set(issues)],
    };
    writeFileSync(join(runDir, 'multi-executor-verification.json'), JSON.stringify(report, null, 2));
    return report;
}
function collectWorktreeIssues(runDir) {
    const workOrdersDir = join(runDir, 'work-orders');
    if (!existsSync(workOrdersDir))
        return ['missing work-orders directory'];
    const issues = [];
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
function collectWorktreeChanges(runDir, issues) {
    const workOrdersDir = join(runDir, 'work-orders');
    const changes = new Map();
    if (!existsSync(workOrdersDir))
        return changes;
    for (const file of readdirSync(workOrdersDir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()) {
        const workerId = file.replace(/\.yaml$/, '');
        const order = readYaml(join(workOrdersDir, file));
        const workspace = String(order.isolated_workspace || '');
        if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace))
            continue;
        try {
            changes.set(workerId, collectChangedFilesFromWorkspace(workspace));
        }
        catch (err) {
            issues.push(`${file}: failed to inspect worktree (${String(err.stderr || err.message || err)
                .trim()
                .split('\n')[0]})`);
            changes.set(workerId, []);
        }
    }
    return changes;
}
function collectChangedFilesFromWorkspace(workspace) {
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
export function extractFilesChanged(workerOutput) {
    const lines = workerOutput.split('\n');
    const files = [];
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
        if (!inSection)
            continue;
        const cleaned = line.replace(/^[-*]\s*/, '').trim();
        if (!cleaned || /^none\.?$/i.test(cleaned) || /^pending/i.test(cleaned) || /^#/.test(cleaned))
            continue;
        files.push(cleaned.split(/\s+/)[0].replace(/^`|`$/g, '').replace(/[:,]$/g, ''));
    }
    return [...new Set(files)];
}
function writeReview(runDir, mode) {
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
    if (mode === 'basic' && !hasAdapterRuntimeEvidence(runDir))
        required.push('executor.process.json');
    if (mode === 'roles')
        required.push('manager-plan.md', 'work-orders/worker-001.yaml', 'worker-outputs/worker-001.md', 'manager.process.json', 'worker-001.process.json', 'reviewer.process.json');
    if (mode === 'multi') {
        required.push('scheduler.json', 'synthesis.md', 'conflict-report.md', 'synthesis.generated.md', 'conflict-report.generated.md', 'multi-executor-verification.json');
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
    const multiVerifierPath = join(runDir, 'multi-executor-verification.json');
    const multiVerifierFailed = mode === 'multi' &&
        (!existsSync(multiVerifierPath) || /"decision":\s*"FAIL"/.test(readFileSync(multiVerifierPath, 'utf8')));
    const processSummary = readRunProcessSummary(runDir);
    if (processSummary.invalid > 0)
        writeFileSync(join(runDir, 'process-evidence-errors.json'), JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2));
    const adapterEvidence = hasAdapterRuntimeEvidence(runDir);
    const exitCode = processSummary.exitCode ?? (adapterEvidence ? 0 : 1);
    const evidenceErrors = existsSync(join(runDir, 'evidence-errors.json'))
        ? JSON.parse(readFileSync(join(runDir, 'evidence-errors.json'), 'utf8'))
        : [];
    const processInvalid = (!adapterEvidence && processSummary.valid === 0) || processSummary.invalid > 0;
    const hasIssue = missing.length > 0 ||
        hasConflict ||
        multiVerifierFailed ||
        exitCode !== 0 ||
        evidenceErrors.length > 0 ||
        processInvalid;
    const score = hasIssue ? 6 : 9;
    const decision = hasConflict || multiVerifierFailed || evidenceErrors.length > 0 || processInvalid
        ? 'blocked'
        : hasIssue
            ? 'changes_requested'
            : 'pass';
    const blockingIssues = [
        ...missing.map((m) => `- Missing ${m}`),
        ...(hasConflict ? ['- Conflict report is blocked'] : []),
        ...(multiVerifierFailed ? ['- Multi-executor verifier rejected worker synthesis'] : []),
        ...(evidenceErrors.length ? evidenceErrors.map((e) => `- Evidence capture failed: ${e.label}`) : []),
        ...(processSummary.errors.length ? processSummary.errors.map((e) => `- Invalid process evidence: ${e}`) : []),
        ...(exitCode !== 0 ? [`- Executor exit code ${exitCode}`] : []),
    ];
    writeFileSync(join(runDir, 'review.md'), `# Review\n\n## Score\n${score}\n\n## Rubric Breakdown\n- Goal Fit: ${hasIssue ? 1 : 2}\n- Artifact Boundary: ${hasIssue ? 1 : 2}\n- Tool Discipline: 2\n- Reviewability: ${hasIssue ? 1 : 2}\n- Reusability: 1\n\n## Blocking Issues\n${blockingIssues.length ? blockingIssues.join('\n') : 'None.'}\n\n## Required Changes\n${hasIssue ? 'Resolve missing artifacts, failed executor, or blocked conflicts.' : 'None.'}\n\n## Risks\nDestructive operations still require approval.\n\n## Decision\n${decision}\n\n## System Patch Suggestions\n${decision === 'pass' ? 'None.' : 'Create blocker-resolution task before claiming completion.'}\n`);
    return decision;
}
function writeNextActions(runDir, decision) {
    writeFileSync(join(runDir, 'next-actions.md'), `# Next Actions\n\n## Immediate\n${decision === 'pass' ? 'Review artifacts and close or promote learnings.' : 'Resolve review blockers before completion.'}\n\n## Suggested System Patches\n${decision === 'pass' ? 'None.' : 'Use approval/promotion workflow for durable fixes.'}\n\n## Blockers\n${decision === 'pass' ? 'None recorded.' : 'See review.md and conflict-report.generated.md.'}\n`);
}
function writeVerificationBaseline(root, runDir, prompt) {
    if (!prompt.includes('scripts/verify-pptx-openable.mjs'))
        return;
    const verifierPath = join(root, 'scripts', 'verify-pptx-openable.mjs');
    if (!existsSync(verifierPath))
        return;
    writeFileSync(join(runDir, 'verification-baseline.json'), JSON.stringify({
        schema_version: 1,
        path: 'scripts/verify-pptx-openable.mjs',
        sha256: sha256Local(readFileSync(verifierPath, 'utf8')),
        captured_at: nowIso(),
        invariant: 'agent runs may not weaken the PPTX verifier to force a pass',
    }, null, 2));
}
function verifierInvariantIssues(root, runDir) {
    const baselinePath = join(runDir, 'verification-baseline.json');
    if (!existsSync(baselinePath))
        return [];
    const baseline = readJsonSafe(baselinePath);
    const relPath = typeof baseline?.path === 'string' ? baseline.path : '';
    const expectedSha = typeof baseline?.sha256 === 'string' ? baseline.sha256 : '';
    if (!relPath || !expectedSha)
        return ['Verification baseline is malformed.'];
    const currentPath = join(root, relPath);
    if (!existsSync(currentPath))
        return [`Verifier was deleted during run: ${relPath}`];
    const currentSha = sha256Local(readFileSync(currentPath, 'utf8'));
    return currentSha === expectedSha
        ? []
        : [`Verifier changed during run: ${relPath}. Fix the generator/output, not the verifier.`];
}
function reportedPptxPaths(root, runDir) {
    const candidates = new Set();
    for (const file of ['codex-last-message.txt', 'executor.stdout.log']) {
        const full = join(runDir, file);
        if (!existsSync(full))
            continue;
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/((?:\/[^\s`'"]+|reports\/[^\s`'"]+)\/github-projects-report\.pptx)/g)) {
            const raw = match[1];
            const abs = raw.startsWith('/') ? raw : join(root, raw);
            try {
                const rel = relative(realpathSync(root), realpathSync(abs)).replaceAll('\\', '/');
                if (rel && !(rel === '..' || rel.startsWith('../')) && rel.startsWith('reports/'))
                    candidates.add(abs);
            }
            catch {
                const rel = relative(root, abs).replaceAll('\\', '/');
                if (rel && !(rel === '..' || rel.startsWith('../')) && rel.startsWith('reports/'))
                    candidates.add(abs);
            }
        }
    }
    return [...candidates].sort();
}
function verifyReportedPptxOutputs(root, runDir) {
    const verifier = join(root, 'scripts', 'verify-pptx-openable.mjs');
    if (!existsSync(verifier))
        return [];
    const paths = reportedPptxPaths(root, runDir);
    const issues = [];
    for (const pptxPath of paths) {
        try {
            const output = execFileSync(process.execPath, [verifier, pptxPath], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            if (!/PPTX_OPENABLE_PASS/.test(output))
                issues.push(`PPTX verifier did not pass for ${relative(root, pptxPath)}`);
        }
        catch (err) {
            issues.push(`PPTX verifier failed for ${relative(root, pptxPath)}: ${String(err.stderr || err.stdout || err.message || err).trim()}`);
        }
    }
    return issues;
}
function collectRunVerificationIssues(root, runDir) {
    const invariantIssues = verifierInvariantIssues(root, runDir);
    if (invariantIssues.length)
        return invariantIssues;
    return verifyReportedPptxOutputs(root, runDir);
}
function collectRunReportQualityIssues(root, runDir) {
    const pptxPaths = reportedPptxPaths(root, runDir);
    if (!pptxPaths.length)
        return [];
    const issues = evaluateGithubReportQuality(root, runDir, pptxPaths);
    if (issues.length)
        writeGithubReportQualityCritique(root, runDir, pptxPaths, issues);
    return issues.map((issue) => `Report quality: ${issue}`);
}
function collectRunSkillUsageIssues(root, runDir) {
    const handoffPath = join(root, AGENT_DIR, 'skill-routing', 'latest-github-projects.md');
    const candidatePath = join(runDir, 'skill-routing-candidates.md');
    if (!existsSync(handoffPath) && !existsSync(candidatePath))
        return [];
    if (existsSync(candidatePath) && /No local SKILL\.md candidates matched/i.test(readFileSync(candidatePath, 'utf8')))
        return [];
    const pptxPaths = reportedPptxPaths(root, runDir);
    const routingContext = [handoffPath, candidatePath]
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, 'utf8'))
        .join('\n');
    const issues = evaluateSkillUsage(root, runDir, pptxPaths, routingContext);
    if (issues.length)
        writeSkillUsageCritique(root, runDir, pptxPaths, issues);
    return issues.map((issue) => `Skill usage: ${issue}`);
}
function replaceReviewSection(text, section, body) {
    const pattern = new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |\\n# |$)`);
    if (pattern.test(text))
        return text.replace(pattern, `## ${section}\n${body}`);
    return `${text.trim()}\n\n## ${section}\n${body}\n`;
}
function writeVerificationIssuesIntoReview(runDir, issues) {
    const reviewPath = join(runDir, 'review.md');
    const issueLines = issues.map((issue) => `- ${issue}`).join('\n');
    const current = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '# Review\n';
    let next = replaceReviewSection(current, 'Blocking Issues', issueLines);
    next = replaceReviewSection(next, 'Required Changes', 'Resolve the closed-loop verification failures before completion.');
    next = replaceReviewSection(next, 'Decision', 'blocked');
    next = replaceReviewSection(next, 'System Patch Suggestions', 'Keep hard verification failures visible in review and closed-loop reports.');
    next = replaceReviewSection(next, 'Closed Loop Verification Failures', issueLines);
    writeFileSync(reviewPath, `${next.trim()}\n`);
}
function writeLedgerVerifierIssueIntoReview(runDir, reason) {
    const reviewPath = join(runDir, 'review.md');
    const current = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '# Review\n';
    const next = replaceReviewSection(current, 'Decision', 'blocked');
    writeFileSync(reviewPath, `${next.trim()}\n\n## Blocking Issues\n- Ledger verifier rejected the run: ${reason}\n`);
}
function writeReportQualityIssuesIntoReview(runDir, issues) {
    const reviewPath = join(runDir, 'review.md');
    const issueLines = issues.map((issue) => `- ${issue}`).join('\n');
    const current = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '# Review\n';
    let next = replaceReviewSection(current, 'Blocking Issues', issueLines);
    next = replaceReviewSection(next, 'Required Changes', 'Run the next agent loop with the report-quality critique and improve the report story, proof objects, and visual method.');
    next = replaceReviewSection(next, 'Decision', 'changes_requested');
    next = replaceReviewSection(next, 'System Patch Suggestions', 'Do not hand-polish the deck. Feed the critic artifact back into the next agent run.');
    next = replaceReviewSection(next, 'Report Quality Critique', issueLines);
    writeFileSync(reviewPath, `${next.trim()}\n`);
}
function writeSkillUsageIssuesIntoReview(runDir, issues) {
    const reviewPath = join(runDir, 'review.md');
    const issueLines = issues.map((issue) => `- ${issue}`).join('\n');
    const current = existsSync(reviewPath) ? readFileSync(reviewPath, 'utf8') : '# Review\n';
    let next = replaceReviewSection(current, 'Blocking Issues', issueLines);
    next = replaceReviewSection(next, 'Required Changes', 'Run the next agent loop with the skill-routing handoff and make the agent prove which skills it inspected, selected, and rejected.');
    next = replaceReviewSection(next, 'Decision', 'changes_requested');
    next = replaceReviewSection(next, 'System Patch Suggestions', 'Keep skill routing as an agent-owned artifact; do not manually perform the skill work outside the run.');
    next = replaceReviewSection(next, 'Skill Usage Critique', issueLines);
    writeFileSync(reviewPath, `${next.trim()}\n`);
}
function evaluateSkillUsage(root, runDir, pptxPaths, routingContext = '') {
    const issues = [];
    const responsePath = findSkillUsageResponse(runDir, pptxPaths);
    if (!responsePath)
        return ['skill-usage-response.md가 보고서 산출물 폴더 또는 run artifact에 없음.'];
    const response = readFileSync(responsePath, 'utf8');
    const reportGenerator = join(root, 'scripts', 'github-projects-report.mjs');
    if (existsSync(reportGenerator) &&
        /function\s+writeSkillUsageResponse|writeSkillUsageResponse\s*\(|function\s+writeReportQualityResponse|writeReportQualityResponse\s*\(/.test(readFileSync(reportGenerator, 'utf8')))
        issues.push('report-quality-response/skill-usage-response를 generator canned writer로 만들고 있음. sidecar는 agent가 산출물 확인 후 직접 작성해야 함.');
    for (const section of [
        { label: 'inspected_skills', pattern: /inspected[_\s-]?skills/i },
        { label: 'selected_skills', pattern: /selected[_\s-]?skills/i },
        { label: 'rejected_skills_or_methods', pattern: /rejected[_\s-]?skills[_\s-]?or[_\s-]?methods|rejected/i },
        {
            label: 'how each selected skill changed the report/result',
            pattern: /how[_\s-]?each[_\s-]?selected[_\s-]?skill[_\s-]?changed[_\s-]?the[_\s-]?(?:report|result)/i,
        },
        { label: 'evidence', pattern: /evidence/i },
        { label: 'remaining_gaps', pattern: /remaining[_\s-]?gaps/i },
    ]) {
        if (!section.pattern.test(response))
            issues.push(`skill-usage-response.md에 ${section.label} 섹션/근거가 없음.`);
    }
    if (/Presentations|presentation|PowerPoint|PPTX|slides?|deck/i.test(routingContext) &&
        !/Presentations|presentation/i.test(response))
        issues.push('PPTX/슬라이드 후보가 있었는데 Presentations skill 검토/선택/거절 근거가 없음.');
    if (/Analyze|analyze|analysis|ranked local evidence|repo facts/i.test(routingContext) &&
        !/Analyze|analyze/i.test(response))
        issues.push('repo facts synthesis 후보가 있었는데 Analyze skill 검토/선택/거절 근거가 없음.');
    if (!/SKILL\.md|skill file|읽|read/i.test(response))
        issues.push('스킬 파일을 실제로 읽었다는 증거가 없음.');
    if (/Presentations|presentation|PowerPoint|PPTX|slides?|deck/i.test(routingContext) &&
        !/not built with artifact-tool|artifact-tool|Keynote|rejected/i.test(response))
        issues.push('Presentations skill과 실제 사용 도구 사이의 선택/거절 근거가 없음.');
    issues.push(...skillContractIssuesForRun(root, runDir, response).map((issue) => `AcceptanceContract: ${issue}`));
    return issues.slice(0, 8);
}
function findSkillUsageResponse(runDir, pptxPaths) {
    const runSidecar = join(runDir, 'skill-usage-response.md');
    if (existsSync(runSidecar))
        return runSidecar;
    return findReportSidecar(pptxPaths, 'skill-usage-response.md');
}
function findReportSidecar(pptxPaths, file) {
    for (const pptxPath of pptxPaths) {
        const candidate = join(dirname(pptxPath), file);
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
function writeSkillUsageCritique(root, runDir, pptxPaths, issues) {
    const relPptx = pptxPaths.map((p) => relative(root, p).replaceAll('\\', '/'));
    const body = `# Skill Usage Critique\n\n` +
        `## Verdict\nchanges_requested\n\n` +
        `스킬 라우팅 handoff가 있었지만 agent가 스킬 선택/활용 증거를 충분히 남기지 않았다.\n\n` +
        `## Evaluated Outputs\n${relPptx.map((p) => `- ${p}`).join('\n')}\n\n` +
        `## Issues\n${issues.map((issue) => `- ${issue}`).join('\n')}\n\n` +
        `## Required Next Agent Behavior\n` +
        `- run의 skill-routing-candidates.md와 필요한 .agent/skill-routing/*.md handoff를 먼저 읽는다.\n` +
        `- 후보 SKILL.md 파일을 읽고, 어떤 skill을 왜 선택/거절했는지 기록한다.\n` +
        `- 결과 폴더 또는 run artifact에 skill-usage-response.md를 남긴다.\n` +
        `- skill 이름을 언급하는 데서 끝내지 말고, 해당 skill이 claim spine/proof object/preview/QA에 어떤 변화를 만들었는지 연결한다.\n`;
    writeFileSync(join(runDir, 'skill-usage-critique.md'), body);
}
function evaluateGithubReportQuality(root, runDir, pptxPaths) {
    const issues = [];
    const relatedText = readReportedGithubReportText(root, runDir, pptxPaths);
    const text = relatedText.toLowerCase();
    if (!/왜|근거|basis|reason/.test(relatedText))
        issues.push('결론의 근거 구조가 약함. 왜 active project인지 점수/요인/비교로 설명해야 함.');
    if (!/리스크|위험|risk|watchlist|주의/.test(text))
        issues.push('dirty count 같은 위험 신호를 해석하지 않음. 리스크/주의 프로젝트를 분리해야 함.');
    if (!/다음|next|action|실행/.test(text))
        issues.push('다음 실행 액션이 구체적이지 않음. active repo에서 바로 할 1~3개 작업이 필요함.');
    if (!/score|점수|활성도/.test(text))
        issues.push('활성도 산정 기준이 드러나지 않음. recency/dirty/branch/status 근거를 보여야 함.');
    if (!hasReportQualityResponse(runDir, pptxPaths))
        issues.push('agent가 품질 크리틱에 어떻게 대응했는지 report-quality-response.md로 남기지 않음.');
    if (issues.length === 0 && relatedText.length < 1800)
        issues.push('보고서 내용량이 너무 얕음. executive summary, evidence, watchlist, next action을 충분히 담아야 함.');
    return issues.slice(0, 8);
}
function hasReportQualityResponse(runDir, pptxPaths) {
    if (existsSync(join(runDir, 'report-quality-response.md')))
        return true;
    return pptxPaths.some((pptxPath) => existsSync(join(dirname(pptxPath), 'report-quality-response.md')));
}
function readReportedGithubReportText(root, runDir, pptxPaths) {
    const chunks = [];
    for (const pptxPath of pptxPaths) {
        const dir = dirname(pptxPath);
        for (const file of ['github-projects-report.md', 'github-projects-report.json', 'report-quality-response.md']) {
            const full = join(dir, file);
            if (existsSync(full))
                chunks.push(readFileSync(full, 'utf8'));
        }
    }
    for (const file of ['codex-last-message.txt', 'executor.stdout.log']) {
        const full = join(runDir, file);
        if (existsSync(full))
            chunks.push(readFileSync(full, 'utf8'));
    }
    return chunks.join('\n');
}
function writeGithubReportQualityCritique(root, runDir, pptxPaths, issues) {
    const qualityDir = join(root, AGENT_DIR, 'report-quality');
    ensureDir(qualityDir);
    const relPptx = pptxPaths.map((p) => relative(root, p).replaceAll('\\', '/'));
    const body = `# GitHub Report Quality Critique\n\n` +
        `## Verdict\nchanges_requested\n\n` +
        `기술적으로 열리는 PPTX여도 보고서 품질은 아직 낮다. 다음 agent run은 이 파일을 읽고 도구/방법을 조절해야 한다.\n\n` +
        `## Evaluated Outputs\n${relPptx.map((p) => `- ${p}`).join('\n')}\n\n` +
        `## Why It Is Not Good Enough\n${issues.map((issue) => `- ${issue}`).join('\n')}\n\n` +
        `## Required Agent Adjustment\n` +
        `- 먼저 기존 PPTX를 Keynote로 열고 slide images로 export해서 썸네일/가독성을 직접 확인한다.\n` +
        `- 단순 bullet deck이면 불합격으로 보고, claim spine을 다시 짠다: 결론 → 근거 → watchlist → active repo deep dive → next executable action.\n` +
        `- 필요하면 Keynote export, slide image backgrounds, artifact-tool/presentation JSX, SVG-backed slides 등 더 적합한 도구를 선택한다.\n` +
        `- 숫자를 나열하지 말고 해석한다: dirty count, recency, branch, status preview가 의미하는 작업 우선순위를 설명한다.\n` +
        `- 다음 run은 report-quality-response.md에 “크리틱을 어떻게 반영했는지”를 남긴다.\n\n` +
        `## Minimum Better-Report Gate\n` +
        `- 첫 장: 한 문장 결론 + 왜 그런지 3개 근거.\n` +
        `- 중간 장: top projects를 표/점수/상태로 비교.\n` +
        `- watchlist 장: dirty가 큰 프로젝트와 오래된 프로젝트를 분리.\n` +
        `- active project 장: 현재 변경 상태와 다음 1~3개 실행 액션.\n` +
        `- 썸네일로 봐도 장표 리듬이 달라야 함. 흰 배경 bullet 5장은 불합격.\n`;
    writeFileSync(join(runDir, 'report-quality-critique.md'), body);
    writeFileSync(join(qualityDir, 'latest-github-projects.md'), body);
    writeFileSync(join(runDir, 'report-quality-critique.json'), JSON.stringify({
        schema_version: 1,
        decision: 'changes_requested',
        evaluated_outputs: relPptx,
        issues,
        next_agent_instruction_path: '.agent/report-quality/latest-github-projects.md',
        generated_at: nowIso(),
    }, null, 2));
}
function uniqueOutputs(outputs) {
    const seen = new Set();
    const deduped = [];
    for (const output of outputs) {
        const key = `${output.kind}:${output.path}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(output);
    }
    return deduped;
}
function readJsonSafe(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function extractOutDirFromCommand(command) {
    const match = command.match(/--out-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
    return match?.[1] || match?.[2] || match?.[3];
}
function outputKindForPath(path) {
    if (path.startsWith(`${AGENT_DIR}/runs/`))
        return 'run_artifact';
    if (path.startsWith(`${AGENT_DIR}/reports/`) || path.startsWith('reports/'))
        return 'reported_output';
    return 'changed_file';
}
function listClosedLoopDirectoryOutputs(root, dir) {
    try {
        if (!existsSync(dir))
            return [];
        const rootReal = realpathSync(root);
        const dirReal = realpathSync(dir);
        const dirRel = relative(rootReal, dirReal).replaceAll('\\', '/');
        if (dirRel === '..' || dirRel.startsWith('../'))
            return [];
        return listFilesRecursive(dirReal)
            .filter((rel) => /\.(?:md|json|pptx|txt|log)$/i.test(rel))
            .slice(0, 30)
            .map((rel) => {
            const path = relative(rootReal, join(dirReal, rel)).replaceAll('\\', '/');
            return { path, kind: outputKindForPath(path) };
        });
    }
    catch {
        return [];
    }
}
function readReviewBlockers(runDir) {
    const reviewPath = join(runDir, 'review.md');
    if (!existsSync(reviewPath))
        return [];
    const text = readFileSync(reviewPath, 'utf8');
    const match = text.match(/## Blocking Issues\n([\s\S]*?)(?:\n## |\n# |$)/);
    if (!match)
        return [];
    return match[1]
        .split('\n')
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter((line) => line && !/^none\.?$/i.test(line));
}
function collectClosedLoopOutputs(root, runDir) {
    const outputs = [];
    for (const file of [
        'executor.process.json',
        'codex-events.jsonl',
        'codex-last-message.txt',
        'result.md',
        'review.md',
        'next-actions.md',
    ]) {
        if (existsSync(join(runDir, file)))
            outputs.push({ path: relative(root, join(runDir, file)).replaceAll('\\', '/'), kind: 'run_artifact' });
    }
    const diffPath = join(runDir, 'collect-diff.patch');
    if (existsSync(diffPath)) {
        for (const file of patchTouchedFiles(readFileSync(diffPath, 'utf8')))
            outputs.push({ path: file, kind: 'changed_file' });
    }
    const statusPath = join(runDir, 'collect-status.txt');
    if (existsSync(statusPath)) {
        for (const line of readFileSync(statusPath, 'utf8').split('\n')) {
            const match = line.match(/^(?:[ MADRCU?!]{2})\s+(.+)$/);
            const path = match?.[1]?.trim().replace(/^"|"$/g, '');
            if (!path || path.includes(' -> ') || isSecretPath(path))
                continue;
            const normalized = path.replaceAll('\\', '/');
            outputs.push({ path: normalized, kind: outputKindForPath(normalized) });
            if (normalized.endsWith('/'))
                outputs.push(...listClosedLoopDirectoryOutputs(root, join(root, normalized)));
        }
    }
    const processLog = readJsonSafe(join(runDir, 'executor.process.json'));
    if (typeof processLog?.stdout === 'string') {
        for (const line of processLog.stdout.split('\n')) {
            const match = line.match(/^(?:markdown|json|pptx)=(.+)$/);
            if (!match)
                continue;
            const full = resolve(root, match[1].trim());
            try {
                const rel = relative(realpathSync(root), realpathSync(full)).replaceAll('\\', '/');
                if (rel && !(rel === '..' || rel.startsWith('../')) && !isSecretPath(rel))
                    outputs.push({ path: rel, kind: outputKindForPath(rel) });
            }
            catch { }
        }
    }
    const outDir = typeof processLog?.command === 'string' ? extractOutDirFromCommand(processLog.command) : undefined;
    if (outDir)
        outputs.push(...listClosedLoopDirectoryOutputs(root, resolve(root, outDir)));
    return uniqueOutputs(outputs).slice(0, 60);
}
function closedLoopImprovements(decision, blockers, executed) {
    if (!executed)
        return [
            'Start 버튼이 실제 executor나 명시 shell command를 실행하게 만든 뒤 다시 Collect한다.',
            '실행 증거가 없는 draft run은 Complete로 닫지 말고 blocked로 남긴다.',
        ];
    if (decision === 'pass')
        return [
            '산출물을 사용자가 바로 볼 수 있는 화면/파일로 승격한다.',
            '같은 프롬프트를 다음 run에 넣어 폐루프가 반복 실행되는지 확인한다.',
        ];
    if (blockers.some((b) => /exit code|failed executor/i.test(b)))
        return ['executor stderr/stdout의 첫 실패 원인을 고치고 같은 run command를 재실행한다.'];
    return ['review.md의 Blocking Issues를 하나씩 제거한 뒤 Start -> Collect를 다시 돈다.'];
}
function writeClosedLoopReport(root, runDir, meta, decision) {
    const processSummary = readRunProcessSummary(runDir);
    const executed = hasStartedEvidence(runDir, meta) && (processSummary.valid > 0 || hasAdapterRuntimeEvidence(runDir));
    const blockers = readReviewBlockers(runDir);
    if (!executed && blockers.length === 0)
        blockers.push('Run has no real execution evidence.');
    if (processSummary.exitCode !== null && processSummary.exitCode !== 0)
        blockers.push(`Executor exit code ${processSummary.exitCode}`);
    if (processSummary.errors.length)
        blockers.push(...processSummary.errors.map((e) => `Invalid process evidence: ${e}`));
    const verificationBlockers = readReviewClosedLoopVerificationFailures(runDir);
    if (verificationBlockers.length)
        blockers.push(...verificationBlockers);
    const blockedAt = decision === 'pass'
        ? null
        : !executed
            ? 'start/executor'
            : processSummary.exitCode !== null && processSummary.exitCode !== 0
                ? 'executor process'
                : 'collect/review';
    const improvements = closedLoopImprovements(decision, blockers, executed);
    const report = {
        schema_version: 1,
        run_id: meta.id,
        task_id: meta.task_id,
        status: meta.status,
        decision,
        executed,
        blocked_at: blockedAt,
        outputs: collectClosedLoopOutputs(root, runDir),
        blockers: [...new Set(blockers)],
        improvements,
        next_loop_action: decision === 'pass'
            ? 'Use or inspect the output artifact, then create the next smallest executable task.'
            : 'Fix the first blocker, Start the run again, then Collect again.',
        generated_at: nowIso(),
    };
    writeFileSync(join(runDir, 'closed-loop-report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(runDir, 'closed-loop-report.md'), `# Closed Loop Report\n\n` +
        `## 실행됐나?\n${report.executed ? 'yes' : 'no'}\n\n` +
        `## 어디서 막혔나?\n${report.blocked_at || 'not blocked'}\n\n` +
        `## 어떤 결과물을 냈나?\n${report.outputs.length ? report.outputs.map((o) => `- [${o.kind}] ${o.path}`).join('\n') : '- None recorded.'}\n\n` +
        `## 어떤 개선이 필요한가?\n${report.improvements.map((i) => `- ${i}`).join('\n')}\n\n` +
        `## Blockers\n${report.blockers.length ? report.blockers.map((b) => `- ${b}`).join('\n') : '- None.'}\n\n` +
        `## Next Loop Action\n${report.next_loop_action}\n`);
    return report;
}
function readReviewClosedLoopVerificationFailures(runDir) {
    const reviewPath = join(runDir, 'review.md');
    if (!existsSync(reviewPath))
        return [];
    const text = readFileSync(reviewPath, 'utf8');
    const match = text.match(/## Closed Loop Verification Failures\n([\s\S]*?)(?:\n## |\n# |$)/);
    if (!match)
        return [];
    return match[1]
        .split('\n')
        .map((line) => line.replace(/^[-*]\s*/, '').trim())
        .filter((line) => line && !/^none\.?$/i.test(line));
}
export function reconcileRuns(cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const agentDir = safeJoin(root, AGENT_DIR);
    ensureDir(agentDir);
    const dir = safeJoin(root, AGENT_DIR, 'runs');
    if (!existsSync(dir)) {
        const empty = { checked: 0, repaired: 0, repairs: [] };
        writeFileSync(join(agentDir, 'reconciliation.json'), JSON.stringify({ status: 'PASS', ...empty, generated_at: nowIso() }, null, 2));
        return empty;
    }
    let checked = 0;
    let repaired = 0;
    const repairs = [];
    for (const runId of readdirSync(dir)
        .filter((f) => existsSync(join(dir, f, 'run.yaml')))
        .sort()) {
        checked++;
        const runDir = join(dir, runId);
        const p = join(runDir, 'run.yaml');
        const before = readYaml(p);
        const after = normalizeRunMeta(before, runDir);
        const beforeText = yaml(before);
        const afterText = yaml(after);
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
            repairs.push(`${runId}: ${before.status} -> ${after.status}${repairedCommand ? '; reconciled natural-language command' : ''}`);
        }
    }
    const result = { checked, repaired, repairs };
    writeFileSync(join(agentDir, 'reconciliation.json'), JSON.stringify({ status: repaired === 0 ? 'PASS' : 'FAIL', ...result, generated_at: nowIso() }, null, 2));
    rebuildIndex(root);
    return result;
}
function readIfExists(path) {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

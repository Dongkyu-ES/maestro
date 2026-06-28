import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendRuntimeEvent, createRuntimeLedgerHeadBinding, readRuntimeEvents, } from '../events/ledger.js';
import { runCommandAcceptance } from './command-acceptance.js';
import { materializeEvidenceInto } from './evidence-store.js';
import { runHarnessSlice } from './harness-run.js';
import { runVerifier } from './verifier.js';
// M11 orchestrator: fan a task out to parallel workers, each isolated in its own git
// worktree (so concurrent writers never collide — s18). Workers return evidence REFS
// (path + sha256), never raw output (s06 / refs-not-raw). The parent records spawn/join
// on the hash-chained ledger and reports per-worker VERIFIER verdicts — it never declares
// overall "done" from a worker self-claim; acceptance is a later verifier/coordinator step.
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}
function worktreePathFor(root, workerId) {
    return join(root, '.agent', 'worktrees', workerId);
}
// Create a fresh worktree on a per-worker branch off HEAD (s18 pattern). Serialized by
// callers to avoid git's index-lock contention during concurrent `worktree add`.
export function createWorktree(root, workerId) {
    if (!WORKER_ID_RE.test(workerId))
        throw new Error(`invalid workerId: ${workerId}`);
    const branch = `wt/${workerId}`;
    const worktreePath = worktreePathFor(root, workerId);
    mkdirSync(join(root, '.agent', 'worktrees'), { recursive: true });
    git(root, ['worktree', 'add', worktreePath, '-b', branch, 'HEAD']);
    return { branch, worktreePath };
}
// Refuse to remove a worktree that has uncommitted changes unless forced (s18).
export function removeWorktree(root, workerId, options = {}) {
    const worktreePath = worktreePathFor(root, workerId);
    if (!existsSync(worktreePath))
        return;
    const status = git(worktreePath, ['status', '--porcelain']).trim();
    if (status && !options.force)
        throw new Error(`worktree ${workerId} has uncommitted changes; pass force to remove`);
    git(root, ['worktree', 'remove', ...(options.force ? ['--force'] : []), worktreePath]);
}
// Remove a worker's worktree AND delete its `wt/<workerId>` branch, so a re-run that
// reuses the same workerId does not collide on an existing dir/branch. Best-effort on the
// branch (it may already be gone). The worktree removal still honors the uncommitted-changes
// guard unless forced.
export function removeWorktreeAndBranch(root, workerId, options = {}) {
    removeWorktree(root, workerId, options);
    try {
        git(root, ['branch', '-D', `wt/${workerId}`]);
    }
    catch {
        // branch already deleted or never created — nothing to do
    }
}
function readDiffSha(worktreePath, sliceRunDir) {
    const path = join(worktreePath, sliceRunDir, 'tool-execution-evidence.json');
    if (!existsSync(path))
        return { diffSha256: null };
    try {
        const evidence = JSON.parse(readFileSync(path, 'utf8'));
        return { diffSha256: typeof evidence.diff_sha256 === 'string' ? evidence.diff_sha256 : null };
    }
    catch {
        return { diffSha256: null };
    }
}
// Run one worker's slice inside an already-created worktree. Never throws — a failure
// becomes a `failed` WorkerResult so a fan-out barrier survives it.
async function runWorkerSlice(options) {
    const base = {
        workerId: options.workerId,
        branch: options.branch,
        worktreePath: options.worktreePath,
    };
    try {
        for (const ref of options.inputRefs ?? [])
            materializeEvidenceInto(ref, options.worktreePath);
        options.beforeExecute?.(options.worktreePath);
        const slice = await runHarnessSlice({
            root: options.worktreePath,
            goal: options.goal,
            executor: options.executor,
            executorLabel: options.executorLabel,
            timeoutMs: options.timeoutMs,
            // Read the project fabric (absolute) into context, but never stamp it from a worktree-local
            // verification — only the owning run (collectRun / harness run) earns memory freshness.
            fabricAgentDir: options.fabricAgentDir,
        });
        const { diffSha256 } = readDiffSha(options.worktreePath, slice.runDir);
        return {
            ...base,
            runDir: slice.runDir,
            state: slice.state,
            verifierStatus: slice.verifier.status,
            diffRef: 'tool-git-diff.patch',
            diffSha256,
            outputRef: diffSha256 ? `agent://${options.workerId}+${diffSha256}` : null,
        };
    }
    catch (error) {
        return {
            ...base,
            runDir: null,
            state: 'failed',
            verifierStatus: null,
            diffRef: null,
            diffSha256: null,
            outputRef: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
// Standalone: create a worktree and run a single isolated worker in it.
export async function runIsolatedWorker(options) {
    const root = resolve(options.root);
    const { branch, worktreePath } = createWorktree(root, options.workerId);
    return runWorkerSlice({
        worktreePath,
        branch,
        workerId: options.workerId,
        goal: options.goal,
        executor: options.executor,
        executorLabel: options.executorLabel,
        timeoutMs: options.timeoutMs,
        inputRefs: options.inputRefs,
        fabricAgentDir: join(root, '.agent'),
        beforeExecute: options.beforeExecute,
    });
}
async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const cap = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: cap }, async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
// Lean fan-out: create worktrees SERIALLY (git index lock), then run their slices CONCURRENTLY.
// No parent run dir / events — callers that want ledgered orchestration use runParallelWorkers;
// callers that just need N isolated results in parallel (e.g. the skill execute fan-out) use this.
export async function runWorkersConcurrently(options) {
    const root = resolve(options.root);
    const prepared = options.workers.map((spec) => ({ spec, ...createWorktree(root, spec.workerId) }));
    return mapWithConcurrency(prepared, options.concurrency ?? 4, ({ spec, branch, worktreePath }) => runWorkerSlice({
        worktreePath,
        branch,
        workerId: spec.workerId,
        goal: spec.goal,
        executor: spec.executor,
        executorLabel: spec.executorLabel,
        inputRefs: spec.inputRefs,
        fabricAgentDir: join(root, '.agent'),
    }));
}
// M11.2: fan a task out to parallel isolated workers. Worktrees are created serially
// (avoids git index-lock contention), slices run concurrently. The parent ledger records
// spawned/joined with output REFS + verifier verdicts only.
export async function runParallelWorkers(options) {
    const root = resolve(options.root);
    const parentRunId = `orchestrator-${randomUUID()}`;
    const parentRunDir = join(root, '.agent', 'runs', parentRunId);
    mkdirSync(parentRunDir, { recursive: true });
    appendRuntimeEvent(parentRunDir, {
        runId: parentRunId,
        source: 'harness',
        type: 'orchestration.started',
        payload: { goal: options.goal, worker_count: options.workers.length, concurrency: options.concurrency ?? 4 },
    });
    // Serial worktree creation (git index lock); record spawn intent per worker.
    const prepared = options.workers.map((spec) => {
        const { branch, worktreePath } = createWorktree(root, spec.workerId);
        appendRuntimeEvent(parentRunDir, {
            runId: parentRunId,
            source: 'harness',
            type: 'orchestration.spawned',
            payload: { worker_id: spec.workerId, branch, goal: spec.goal },
        });
        return { spec, branch, worktreePath };
    });
    const workers = await mapWithConcurrency(prepared, options.concurrency ?? 4, async ({ spec, branch, worktreePath }) => {
        const result = await runWorkerSlice({
            worktreePath,
            branch,
            workerId: spec.workerId,
            goal: spec.goal,
            executor: spec.executor,
            fabricAgentDir: join(root, '.agent'),
        });
        appendRuntimeEvent(parentRunDir, {
            runId: parentRunId,
            source: 'harness',
            type: 'orchestration.joined',
            payload: {
                worker_id: result.workerId,
                state: result.state,
                verifier_status: result.verifierStatus,
                output_ref: result.outputRef, // ref, not raw
            },
            artifactRefs: result.runDir ? [join(result.worktreePath, result.runDir, 'harness-run-report.json')] : [],
        });
        return result;
    });
    const supportedCount = workers.filter((w) => w.state === 'completed' && w.verifierStatus === 'supported').length;
    appendRuntimeEvent(parentRunDir, {
        runId: parentRunId,
        source: 'harness',
        type: 'orchestration.fanin', // fan-in done — NOT a completion verdict (verifier owns that)
        payload: { worker_count: workers.length, supported_count: supportedCount },
    });
    const report = {
        schema_version: 1,
        parentRunId,
        parentRunDir,
        goal: options.goal,
        workers,
        supportedCount,
        ledgerHead: createRuntimeLedgerHeadBinding(readRuntimeEvents(parentRunDir)),
    };
    writeFileSync(join(parentRunDir, 'orchestration-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
function tryGit(root, args) {
    try {
        return {
            ok: true,
            output: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        };
    }
    catch (err) {
        const e = err;
        return { ok: false, output: String(e.stdout || '') + String(e.stderr || e.message || '') };
    }
}
// Merge each supported worker's REAL changes (from its worktree branch — not the redacted
// evidence patch) into a fresh reconciliation worktree, in dependency order. A worker that
// CONFLICTS is quarantined (never force-merged). The verify command is a FINAL whole-set
// gate over the merged tree — not per-merge — because a cross-file invariant (e.g. fileA
// needs fileB) can never be satisfied by the first worker alone. verifyPassed is the gate
// verdict; completion remains owned by the verifier, never declared by the merge itself.
export function reconcileWorkers(options) {
    const root = resolve(options.root);
    if (!WORKER_ID_RE.test(options.reconId))
        throw new Error(`invalid reconId: ${options.reconId}`);
    const branch = `wt/${options.reconId}`;
    const reconWorktree = worktreePathFor(root, options.reconId);
    const quarantined = [];
    const emit = (type, payload) => {
        if (options.parentRunDir)
            appendRuntimeEvent(options.parentRunDir, { runId: options.reconId, source: 'harness', type, payload });
    };
    // Commit each worker's REAL changes onto its branch once (excluding the .agent evidence
    // dir) so it is mergeable; drop workers with no changes.
    const mergeable = [];
    for (const w of options.order) {
        git(w.worktreePath, ['add', '-A', '--', '.', ':(exclude).agent']);
        if (tryGit(w.worktreePath, ['commit', '-m', `worker ${w.workerId}`]).ok) {
            mergeable.push({ workerId: w.workerId, branch: w.branch });
        }
        else {
            quarantined.push({ workerId: w.workerId, reason: 'no changes to merge' });
            emit('orchestration.conflict.quarantined', { worker_id: w.workerId, reason: 'no changes' });
        }
    }
    // Build a fresh worktree merging a subset (in order); conflicting branches are skipped.
    const buildMerge = (id, subset) => {
        const wp = worktreePathFor(root, id);
        tryGit(root, ['worktree', 'remove', '--force', wp]);
        tryGit(root, ['branch', '-D', `wt/${id}`]);
        git(root, ['worktree', 'add', wp, '-b', `wt/${id}`, 'HEAD']);
        const merged = [];
        const conflicts = [];
        for (const w of subset) {
            if (tryGit(wp, ['merge', '--no-edit', w.branch]).ok)
                merged.push(w.workerId);
            else {
                tryGit(wp, ['merge', '--abort']);
                conflicts.push(w.workerId);
            }
        }
        return { worktreePath: wp, merged, conflicts };
    };
    const verifyTree = (wp) => {
        const r = spawnSync('/bin/sh', ['-c', options.verifyCmd], { cwd: wp, encoding: 'utf8', timeout: 120000 });
        return (r.status ?? 1) === 0;
    };
    const full = buildMerge(options.reconId, mergeable);
    for (const c of full.conflicts) {
        quarantined.push({ workerId: c, reason: 'merge conflict' });
        emit('orchestration.conflict.quarantined', { worker_id: c, reason: 'merge conflict' });
    }
    let kept = full.merged;
    for (const id of kept)
        emit('orchestration.merged', { worker_id: id });
    let verifyPassed = null;
    if (options.verifyCmd) {
        verifyPassed = verifyTree(reconWorktree);
        emit('orchestration.reconcile.verified', { verify_passed: verifyPassed, merged: kept });
        if (!verifyPassed && options.bisect !== false && kept.length > 0) {
            // Greedy leave-one-out: find a worker whose removal makes the set verify; quarantine
            // it as the regression culprit. Repeat for multi-culprit until it passes or empties.
            const trialId = `${options.reconId}-t`;
            let guard = 0;
            while (kept.length > 0 && guard < mergeable.length + 1) {
                guard += 1;
                let culprit = null;
                for (const w of [...kept].reverse()) {
                    const subset = mergeable.filter((m) => kept.includes(m.workerId) && m.workerId !== w);
                    buildMerge(trialId, subset);
                    if (verifyTree(worktreePathFor(root, trialId))) {
                        culprit = w;
                        break;
                    }
                }
                tryGit(root, ['worktree', 'remove', '--force', worktreePathFor(root, trialId)]);
                tryGit(root, ['branch', '-D', `wt/${trialId}`]);
                const drop = culprit ?? kept[kept.length - 1]; // if no single removal fixes it, shed the most recent
                quarantined.push({ workerId: drop, reason: 'verify regression' });
                emit('orchestration.reconcile.bisected', { quarantined: drop, single_fix: culprit !== null });
                kept = kept.filter((id) => id !== drop);
                buildMerge(options.reconId, mergeable.filter((m) => kept.includes(m.workerId)));
                verifyPassed = verifyTree(reconWorktree);
                if (verifyPassed)
                    break;
            }
        }
    }
    return { reconId: options.reconId, reconWorktree, branch, merged: kept, quarantined, verifyPassed };
}
// Reject cycles and dangling deps before spawning anything (deterministic, no LLM).
function validateGraph(nodes, maxNodes) {
    if (nodes.length > maxNodes)
        throw new Error(`graph exceeds maxNodes (${nodes.length} > ${maxNodes})`);
    const ids = new Set();
    for (const n of nodes) {
        if (!WORKER_ID_RE.test(n.id))
            throw new Error(`invalid node id: ${n.id}`);
        if (ids.has(n.id))
            throw new Error(`duplicate node id: ${n.id}`);
        ids.add(n.id);
    }
    for (const n of nodes)
        for (const d of n.deps ?? [])
            if (!ids.has(d))
                throw new Error(`node ${n.id} depends on unknown node ${d}`);
    // Kahn's algorithm: if any node remains, there is a cycle.
    const indeg = new Map(nodes.map((n) => [n.id, (n.deps ?? []).length]));
    const queue = nodes.filter((n) => (n.deps ?? []).length === 0).map((n) => n.id);
    let seen = 0;
    while (queue.length) {
        const id = queue.shift();
        seen += 1;
        for (const n of nodes)
            if ((n.deps ?? []).includes(id)) {
                indeg.set(n.id, indeg.get(n.id) - 1);
                if (indeg.get(n.id) === 0)
                    queue.push(n.id);
            }
    }
    if (seen !== nodes.length)
        throw new Error('graph has a cycle');
}
// Run a dependency DAG: a node starts only once every dep is verifier-`supported` (the
// DH-hardened s12 `can_start` — gated on the verifier verdict, not a self-report status).
// Nodes whose deps did not reach `supported` are skipped, never silently run.
export async function runTaskGraph(options) {
    const root = resolve(options.root);
    const maxNodes = options.maxNodes ?? 32;
    validateGraph(options.nodes, maxNodes);
    const parentRunId = options.runId ?? `graph-${randomUUID()}`;
    const parentRunDir = join(root, '.agent', 'runs', parentRunId);
    mkdirSync(parentRunDir, { recursive: true });
    appendRuntimeEvent(parentRunDir, {
        runId: parentRunId,
        source: 'harness',
        type: 'orchestration.started',
        payload: { goal: options.goal, node_count: options.nodes.length, kind: 'dag' },
    });
    const runTok = parentRunId
        .replace(/^graph-/, '')
        .replace(/-/g, '')
        .slice(0, 8);
    const wtKey = (id) => `${id}-${runTok}`;
    const state = new Map(options.nodes.map((n) => [n.id, 'pending']));
    const results = new Map();
    let waves = 0;
    const isSupported = (id) => state.get(id) === 'supported';
    const depsResolved = (n) => (n.deps ?? []).every((d) => state.get(d) !== 'pending');
    for (;;) {
        // Skip nodes whose deps are all resolved but not all supported (upstream failed).
        for (const n of options.nodes) {
            if (state.get(n.id) !== 'pending')
                continue;
            if (depsResolved(n) && !(n.deps ?? []).every(isSupported)) {
                const bad = (n.deps ?? []).filter((d) => !isSupported(d));
                state.set(n.id, 'skipped');
                const skipped = {
                    workerId: n.id,
                    branch: `wt/${wtKey(n.id)}`,
                    worktreePath: worktreePathFor(root, wtKey(n.id)),
                    runDir: null,
                    state: 'failed',
                    verifierStatus: null,
                    diffRef: null,
                    diffSha256: null,
                    outputRef: null,
                    deps: n.deps ?? [],
                    nodeState: 'skipped',
                    acceptance: null,
                    skippedReason: `unsupported deps: ${bad.join(', ')}`,
                };
                results.set(n.id, skipped);
                appendRuntimeEvent(parentRunDir, {
                    runId: parentRunId,
                    source: 'harness',
                    type: 'orchestration.skipped',
                    payload: { node_id: n.id, reason: skipped.skippedReason },
                });
            }
        }
        const ready = options.nodes.filter((n) => state.get(n.id) === 'pending' && (n.deps ?? []).every(isSupported));
        if (ready.length === 0)
            break;
        waves += 1;
        appendRuntimeEvent(parentRunDir, {
            runId: parentRunId,
            source: 'harness',
            type: 'orchestration.stage.advanced',
            payload: { wave: waves, node_ids: ready.map((n) => n.id) },
        });
        // Serial worktree create (git index lock), then concurrent slices for this wave.
        const prepared = ready.map((n) => ({ node: n, ...createWorktree(root, wtKey(n.id)) }));
        for (const { node } of prepared) {
            appendRuntimeEvent(parentRunDir, {
                runId: parentRunId,
                source: 'harness',
                type: 'orchestration.spawned',
                payload: { node_id: node.id, deps: node.deps ?? [], goal: node.goal },
            });
        }
        const waveResults = await mapWithConcurrency(prepared, options.concurrency ?? 4, async ({ node, branch, worktreePath }) => {
            const r = await runWorkerSlice({
                worktreePath,
                branch,
                workerId: node.id,
                goal: node.goal,
                executor: node.executor,
                fabricAgentDir: join(root, '.agent'),
            });
            const acceptance = node.accept
                ? (() => {
                    const accept = node.accept;
                    let status;
                    let reason;
                    let target;
                    if ('command' in accept) {
                        // Task-correctness: the node is supported only if the command passes over a clean
                        // checkout of its diff — "a diff exists" is not enough.
                        const acc = runCommandAcceptance({ worktreePath, acceptance: accept });
                        status = acc.passed ? 'supported' : 'unproven';
                        reason = acc.reason;
                        target = `cmd:${accept.command.join(' ')}`;
                    }
                    else {
                        const acc = runVerifier({
                            type: 'artifact',
                            root: worktreePath,
                            artifactRef: accept.artifactPath,
                            expectedSha256: accept.sha256,
                        });
                        status = acc.status;
                        reason = acc.reason;
                        target = accept.artifactPath;
                    }
                    const recorded = { status, reason, artifactPath: target };
                    appendRuntimeEvent(parentRunDir, {
                        runId: parentRunId,
                        source: 'harness',
                        type: 'orchestration.acceptance',
                        payload: { node_id: node.id, status, artifact_path: target, reason },
                    });
                    return recorded;
                })()
                : null;
            const nodeState = r.state === 'completed' &&
                r.verifierStatus === 'supported' &&
                (!node.accept || acceptance?.status === 'supported')
                ? 'supported'
                : r.state === 'failed'
                    ? 'failed'
                    : 'blocked';
            const nr = { ...r, deps: node.deps ?? [], nodeState, acceptance };
            appendRuntimeEvent(parentRunDir, {
                runId: parentRunId,
                source: 'harness',
                type: 'orchestration.joined',
                payload: {
                    node_id: node.id,
                    node_state: nodeState,
                    verifier_status: r.verifierStatus,
                    output_ref: r.outputRef,
                },
                artifactRefs: r.runDir ? [join(r.worktreePath, r.runDir, 'harness-run-report.json')] : [],
            });
            return nr;
        });
        for (const nr of waveResults) {
            state.set(nr.workerId, nr.nodeState);
            results.set(nr.workerId, nr);
        }
    }
    const ordered = options.nodes.map((n) => results.get(n.id)).filter(Boolean);
    const supportedCount = ordered.filter((r) => r.nodeState === 'supported').length;
    appendRuntimeEvent(parentRunDir, {
        runId: parentRunId,
        source: 'harness',
        type: 'orchestration.fanin',
        payload: { node_count: ordered.length, supported_count: supportedCount, waves },
    });
    const report = {
        schema_version: 1,
        parentRunId,
        parentRunDir,
        goal: options.goal,
        nodes: ordered,
        supportedCount,
        waves,
        ledgerHead: createRuntimeLedgerHeadBinding(readRuntimeEvents(parentRunDir)),
    };
    writeFileSync(join(parentRunDir, 'graph-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

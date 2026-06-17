import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  appendRuntimeEvent,
  createRuntimeLedgerHeadBinding,
  readRuntimeEvents,
  type RuntimeLedgerHeadBinding,
} from '../events/ledger.js';
import { type HarnessExecutor, runHarnessSlice } from './harness-run.js';

// M11 orchestrator: fan a task out to parallel workers, each isolated in its own git
// worktree (so concurrent writers never collide — s18). Workers return evidence REFS
// (path + sha256), never raw output (s06 / refs-not-raw). The parent records spawn/join
// on the hash-chained ledger and reports per-worker VERIFIER verdicts — it never declares
// overall "done" from a worker self-claim; acceptance is a later verifier/coordinator step.

const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface WorkerSpec {
  workerId: string;
  goal: string;
  executor?: HarnessExecutor;
}

export interface WorkerResult {
  workerId: string;
  branch: string;
  worktreePath: string;
  runDir: string | null;
  state: 'completed' | 'blocked' | 'failed';
  verifierStatus: string | null;
  diffRef: string | null;
  diffSha256: string | null;
  outputRef: string | null; // agent://<workerId>+<diffSha256> — the durable evidence handle
  error?: string;
}

export interface OrchestrationReport {
  schema_version: 1;
  parentRunId: string;
  parentRunDir: string;
  goal?: string;
  workers: WorkerResult[];
  // descriptive fan-in summary — NOT a completion verdict (verifier owns that).
  supportedCount: number;
  ledgerHead: RuntimeLedgerHeadBinding;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function worktreePathFor(root: string, workerId: string): string {
  return join(root, '.agent', 'worktrees', workerId);
}

// Create a fresh worktree on a per-worker branch off HEAD (s18 pattern). Serialized by
// callers to avoid git's index-lock contention during concurrent `worktree add`.
export function createWorktree(root: string, workerId: string): { branch: string; worktreePath: string } {
  if (!WORKER_ID_RE.test(workerId)) throw new Error(`invalid workerId: ${workerId}`);
  const branch = `wt/${workerId}`;
  const worktreePath = worktreePathFor(root, workerId);
  mkdirSync(join(root, '.agent', 'worktrees'), { recursive: true });
  git(root, ['worktree', 'add', worktreePath, '-b', branch, 'HEAD']);
  return { branch, worktreePath };
}

// Refuse to remove a worktree that has uncommitted changes unless forced (s18).
export function removeWorktree(root: string, workerId: string, options: { force?: boolean } = {}): void {
  const worktreePath = worktreePathFor(root, workerId);
  if (!existsSync(worktreePath)) return;
  const status = git(worktreePath, ['status', '--porcelain']).trim();
  if (status && !options.force) throw new Error(`worktree ${workerId} has uncommitted changes; pass force to remove`);
  git(root, ['worktree', 'remove', ...(options.force ? ['--force'] : []), worktreePath]);
}

function readDiffSha(worktreePath: string, sliceRunDir: string): { diffSha256: string | null } {
  const path = join(worktreePath, sliceRunDir, 'tool-execution-evidence.json');
  if (!existsSync(path)) return { diffSha256: null };
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf8')) as { diff_sha256?: unknown };
    return { diffSha256: typeof evidence.diff_sha256 === 'string' ? evidence.diff_sha256 : null };
  } catch {
    return { diffSha256: null };
  }
}

// Run one worker's slice inside an already-created worktree. Never throws — a failure
// becomes a `failed` WorkerResult so a fan-out barrier survives it.
async function runWorkerSlice(options: {
  worktreePath: string;
  branch: string;
  workerId: string;
  goal: string;
  executor?: HarnessExecutor;
  timeoutMs?: number;
}): Promise<WorkerResult> {
  const base = {
    workerId: options.workerId,
    branch: options.branch,
    worktreePath: options.worktreePath,
  };
  try {
    const slice = await runHarnessSlice({
      root: options.worktreePath,
      goal: options.goal,
      executor: options.executor,
      timeoutMs: options.timeoutMs,
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
  } catch (error) {
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
export async function runIsolatedWorker(options: {
  root: string;
  workerId: string;
  goal: string;
  executor?: HarnessExecutor;
  timeoutMs?: number;
}): Promise<WorkerResult> {
  const root = resolve(options.root);
  const { branch, worktreePath } = createWorktree(root, options.workerId);
  return runWorkerSlice({ worktreePath, branch, workerId: options.workerId, goal: options.goal, executor: options.executor, timeoutMs: options.timeoutMs });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const cap = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: cap }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// M11.2: fan a task out to parallel isolated workers. Worktrees are created serially
// (avoids git index-lock contention), slices run concurrently. The parent ledger records
// spawned/joined with output REFS + verifier verdicts only.
export async function runParallelWorkers(options: {
  root: string;
  goal?: string;
  workers: WorkerSpec[];
  concurrency?: number;
}): Promise<OrchestrationReport> {
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
    const result = await runWorkerSlice({ worktreePath, branch, workerId: spec.workerId, goal: spec.goal, executor: spec.executor });
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

  const report: OrchestrationReport = {
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

// ---- M11.4: verifier-reconciled merge ----

export interface ReconcileResult {
  reconId: string;
  reconWorktree: string;
  branch: string;
  merged: string[];
  quarantined: Array<{ workerId: string; reason: string }>;
}

function tryGit(root: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: String(e.stdout || '') + String(e.stderr || e.message || '') };
  }
}

// Merge each supported worker's REAL changes (from its worktree branch — not the redacted
// evidence patch) into a fresh reconciliation worktree, in dependency order. A worker that
// conflicts, or whose merge breaks the verify command, is QUARANTINED (reverted) rather
// than force-merged. Conservative by design: any verifier regression → quarantine.
export function reconcileWorkers(options: {
  root: string;
  reconId: string;
  order: Array<{ workerId: string; branch: string; worktreePath: string }>;
  verifyCmd?: string;
  parentRunDir?: string;
}): ReconcileResult {
  const root = resolve(options.root);
  if (!WORKER_ID_RE.test(options.reconId)) throw new Error(`invalid reconId: ${options.reconId}`);
  const branch = `wt/${options.reconId}`;
  const reconWorktree = worktreePathFor(root, options.reconId);
  git(root, ['worktree', 'add', reconWorktree, '-b', branch, 'HEAD']);

  const merged: string[] = [];
  const quarantined: Array<{ workerId: string; reason: string }> = [];
  const emit = (type: string, payload: Record<string, unknown>) => {
    if (options.parentRunDir) appendRuntimeEvent(options.parentRunDir, { runId: options.reconId, source: 'harness', type, payload });
  };

  for (const w of options.order) {
    // Commit the worker's REAL changes onto its branch so it is mergeable. Exclude the
    // .agent evidence dir so reconciliation merges work product, not run ledgers.
    git(w.worktreePath, ['add', '-A', '--', '.', ':(exclude).agent']);
    const committed = tryGit(w.worktreePath, ['commit', '-m', `worker ${w.workerId}`]);
    if (!committed.ok) {
      quarantined.push({ workerId: w.workerId, reason: 'no changes to merge' });
      emit('orchestration.conflict.quarantined', { worker_id: w.workerId, reason: 'no changes' });
      continue;
    }
    const preSha = git(reconWorktree, ['rev-parse', 'HEAD']).trim();
    const mergeRes = tryGit(reconWorktree, ['merge', '--no-edit', w.branch]);
    if (!mergeRes.ok) {
      tryGit(reconWorktree, ['merge', '--abort']);
      quarantined.push({ workerId: w.workerId, reason: 'merge conflict' });
      emit('orchestration.conflict.quarantined', { worker_id: w.workerId, reason: 'merge conflict' });
      continue;
    }
    if (options.verifyCmd) {
      const r = spawnSync('/bin/sh', ['-c', options.verifyCmd], { cwd: reconWorktree, encoding: 'utf8', timeout: 120000 });
      if ((r.status ?? 1) !== 0) {
        git(reconWorktree, ['reset', '--hard', preSha]); // undo this worker's merge
        quarantined.push({ workerId: w.workerId, reason: `verify failed (exit ${r.status ?? 'null'})` });
        emit('orchestration.conflict.quarantined', { worker_id: w.workerId, reason: 'verify failed' });
        continue;
      }
    }
    merged.push(w.workerId);
    emit('orchestration.merged', { worker_id: w.workerId });
  }
  return { reconId: options.reconId, reconWorktree, branch, merged, quarantined };
}

// ---- M11.3: dependency DAG (verifier-gated) + M11.5 spawn caps ----

export interface GraphNode {
  id: string;
  goal: string;
  deps?: string[];
  executor?: HarnessExecutor;
}

export type NodeState = 'supported' | 'blocked' | 'failed' | 'skipped';

export interface GraphNodeResult extends WorkerResult {
  deps: string[];
  nodeState: NodeState;
  skippedReason?: string;
}

export interface GraphReport {
  schema_version: 1;
  parentRunId: string;
  parentRunDir: string;
  goal?: string;
  nodes: GraphNodeResult[];
  supportedCount: number;
  waves: number;
  ledgerHead: RuntimeLedgerHeadBinding;
}

// Reject cycles and dangling deps before spawning anything (deterministic, no LLM).
function validateGraph(nodes: GraphNode[], maxNodes: number): void {
  if (nodes.length > maxNodes) throw new Error(`graph exceeds maxNodes (${nodes.length} > ${maxNodes})`);
  const ids = new Set<string>();
  for (const n of nodes) {
    if (!WORKER_ID_RE.test(n.id)) throw new Error(`invalid node id: ${n.id}`);
    if (ids.has(n.id)) throw new Error(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) for (const d of n.deps ?? []) if (!ids.has(d)) throw new Error(`node ${n.id} depends on unknown node ${d}`);
  // Kahn's algorithm: if any node remains, there is a cycle.
  const indeg = new Map(nodes.map((n) => [n.id, (n.deps ?? []).length]));
  const queue = nodes.filter((n) => (n.deps ?? []).length === 0).map((n) => n.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift() as string;
    seen += 1;
    for (const n of nodes) if ((n.deps ?? []).includes(id)) {
      indeg.set(n.id, (indeg.get(n.id) as number) - 1);
      if (indeg.get(n.id) === 0) queue.push(n.id);
    }
  }
  if (seen !== nodes.length) throw new Error('graph has a cycle');
}

// Run a dependency DAG: a node starts only once every dep is verifier-`supported` (the
// DH-hardened s12 `can_start` — gated on the verifier verdict, not a self-report status).
// Nodes whose deps did not reach `supported` are skipped, never silently run.
export async function runTaskGraph(options: {
  root: string;
  goal?: string;
  nodes: GraphNode[];
  concurrency?: number;
  maxNodes?: number;
}): Promise<GraphReport> {
  const root = resolve(options.root);
  const maxNodes = options.maxNodes ?? 32;
  validateGraph(options.nodes, maxNodes);

  const parentRunId = `graph-${randomUUID()}`;
  const parentRunDir = join(root, '.agent', 'runs', parentRunId);
  mkdirSync(parentRunDir, { recursive: true });
  appendRuntimeEvent(parentRunDir, {
    runId: parentRunId,
    source: 'harness',
    type: 'orchestration.started',
    payload: { goal: options.goal, node_count: options.nodes.length, kind: 'dag' },
  });

  const state = new Map<string, NodeState | 'pending'>(options.nodes.map((n) => [n.id, 'pending']));
  const results = new Map<string, GraphNodeResult>();
  let waves = 0;

  const isSupported = (id: string) => state.get(id) === 'supported';
  const depsResolved = (n: GraphNode) => (n.deps ?? []).every((d) => state.get(d) !== 'pending');

  for (;;) {
    // Skip nodes whose deps are all resolved but not all supported (upstream failed).
    for (const n of options.nodes) {
      if (state.get(n.id) !== 'pending') continue;
      if (depsResolved(n) && !(n.deps ?? []).every(isSupported)) {
        const bad = (n.deps ?? []).filter((d) => !isSupported(d));
        state.set(n.id, 'skipped');
        const skipped: GraphNodeResult = {
          workerId: n.id, branch: `wt/${n.id}`, worktreePath: worktreePathFor(root, n.id), runDir: null,
          state: 'failed', verifierStatus: null, diffRef: null, diffSha256: null, outputRef: null,
          deps: n.deps ?? [], nodeState: 'skipped', skippedReason: `unsupported deps: ${bad.join(', ')}`,
        };
        results.set(n.id, skipped);
        appendRuntimeEvent(parentRunDir, {
          runId: parentRunId, source: 'harness', type: 'orchestration.skipped',
          payload: { node_id: n.id, reason: skipped.skippedReason },
        });
      }
    }

    const ready = options.nodes.filter((n) => state.get(n.id) === 'pending' && (n.deps ?? []).every(isSupported));
    if (ready.length === 0) break;
    waves += 1;
    appendRuntimeEvent(parentRunDir, {
      runId: parentRunId, source: 'harness', type: 'orchestration.stage.advanced',
      payload: { wave: waves, node_ids: ready.map((n) => n.id) },
    });

    // Serial worktree create (git index lock), then concurrent slices for this wave.
    const prepared = ready.map((n) => ({ node: n, ...createWorktree(root, n.id) }));
    for (const { node } of prepared) {
      appendRuntimeEvent(parentRunDir, {
        runId: parentRunId, source: 'harness', type: 'orchestration.spawned',
        payload: { node_id: node.id, deps: node.deps ?? [], goal: node.goal },
      });
    }
    const waveResults = await mapWithConcurrency(prepared, options.concurrency ?? 4, async ({ node, branch, worktreePath }) => {
      const r = await runWorkerSlice({ worktreePath, branch, workerId: node.id, goal: node.goal, executor: node.executor });
      const nodeState: NodeState = r.state === 'completed' && r.verifierStatus === 'supported' ? 'supported' : r.state === 'failed' ? 'failed' : 'blocked';
      const nr: GraphNodeResult = { ...r, deps: node.deps ?? [], nodeState };
      appendRuntimeEvent(parentRunDir, {
        runId: parentRunId, source: 'harness', type: 'orchestration.joined',
        payload: { node_id: node.id, node_state: nodeState, verifier_status: r.verifierStatus, output_ref: r.outputRef },
        artifactRefs: r.runDir ? [join(r.worktreePath, r.runDir, 'harness-run-report.json')] : [],
      });
      return nr;
    });
    for (const nr of waveResults) {
      state.set(nr.workerId, nr.nodeState);
      results.set(nr.workerId, nr);
    }
  }

  const ordered = options.nodes.map((n) => results.get(n.id) as GraphNodeResult).filter(Boolean);
  const supportedCount = ordered.filter((r) => r.nodeState === 'supported').length;
  appendRuntimeEvent(parentRunDir, {
    runId: parentRunId, source: 'harness', type: 'orchestration.fanin',
    payload: { node_count: ordered.length, supported_count: supportedCount, waves },
  });
  const report: GraphReport = {
    schema_version: 1, parentRunId, parentRunDir, goal: options.goal,
    nodes: ordered, supportedCount, waves,
    ledgerHead: createRuntimeLedgerHeadBinding(readRuntimeEvents(parentRunDir)),
  };
  writeFileSync(join(parentRunDir, 'graph-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

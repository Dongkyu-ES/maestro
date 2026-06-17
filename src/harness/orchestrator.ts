import { execFileSync } from 'node:child_process';
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

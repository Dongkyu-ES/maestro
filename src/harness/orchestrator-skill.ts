import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendRuntimeEvent,
  type RuntimeLedgerHeadBinding,
  readRuntimeEvents,
  runtimeLedgerHeadHash,
  validateRuntimeLedger,
} from '../events/ledger.js';
import type { HarnessExecutor } from './harness-run.js';

export {
  type EvidenceRef,
  materializeEvidenceInto,
  type PhaseId,
  resolveEvidenceArtifact,
  storePhaseArtifact,
} from './evidence-store.js';

import type { PhaseId } from './evidence-store.js';
import { type EvidenceRef, materializeEvidenceInto, storePhaseArtifact } from './evidence-store.js';
import {
  type GraphNode,
  type NodeState,
  removeWorktreeAndBranch,
  runIsolatedWorker,
  runWorkersConcurrently,
  type WorkerResult,
} from './orchestrator.js';
import type { CatalogModule } from '../composition/catalog.js';
import {
  type InjectionAdapter,
  type InjectionManifest,
  type InjectionVerification,
  applyCompositionToWorktree,
  verifyInjection,
} from '../composition/inject.js';
import { recordInjectionEvent } from '../composition/inject-ledger.js';

export interface PhaseSpec {
  executor?: HarnessExecutor;
  /** Executor identity for honest per-phase evidence labeling (e.g. 'codex' | 'claude' | 'agy'). */
  executorLabel?: string;
  goalTemplate: string;
  acceptArtifact?: string;
}

export interface PhaseSpecJson {
  executor: string;
  goalTemplate: string;
  acceptArtifact?: string;
}

export interface ExecuteCandidateExecutor {
  label: string;
  executor?: HarnessExecutor;
  executorLabel?: string;
}

export interface OrchestratorSkillSpec {
  id: string;
  phases: {
    research: PhaseSpec;
    execute: PhaseSpec;
    review: PhaseSpec;
  };
  acceptance?: {
    command: string[];
    testFiles?: { path: string; content: string }[];
  };
  /**
   * Optional stage-X fan-out for the execute phase: run each candidate executor in its own
   * worktree, then select the winner by RE-RUNNING `acceptance` over its evidence — never by
   * rank/order/self-claim. Requires `acceptance`. The winner's evidence becomes the canonical
   * execute evidence, so review/handoff/recompute are unchanged.
   */
  executeCandidates?: ExecuteCandidateExecutor[];
  /**
   * U1 verifier-gated refinement loop (default 1 = single-shot, byte-identical to no refinement).
   * When > 1 AND `acceptance` is declared AND `executeCandidates` is unset, the execute phase runs
   * up to N bounded iterations: iteration k+1 runs ONLY if iteration k's acceptance failed, with
   * iteration k's verifier-failure output handed in as an immutable EvidenceRef. The winner is the
   * iteration whose acceptance passes (chosen by RE-RUNNING acceptance over each iteration's
   * isolated evidence — never by rank/self-claim), promoted to the canonical execute store. The
   * loop's only continue/stop signal is `runAcceptanceCheck.passed`; no critic/model score is ever
   * consulted. See REVKA_BORROW_UPGRADE_PLAN.md §3 U1 / §6.
   */
  maxRefineIterations?: number;
  /**
   * Slice 7 (Item B) — opt-in Warden Magic injection into the EXECUTE phase. Default unset = the M12
   * hot path is byte-identical. CAPABILITY-ONLY (MCP) this slice: instruction kinds are NOT injected
   * into the completion-gated skill run (design-panel: premature before M7 + unsafe for non-test
   * acceptance). Rejected when execute fan-out / refinement is active (single-executor only). The
   * injected set is recorded as `composition.injected` in the skill-run ledger and NEVER read by
   * `recomputeCompletionFromLedger` — injection shapes the executor's tools, never the verdict.
   */
  inject?: {
    mcpModules: CatalogModule[];
    adapter: InjectionAdapter;
    approveSecrets?: boolean;
    /**
     * Slice 7 (Item A) instruction modules (CLAUDE.md/soul/AGENTS.md). Injected ONLY when
     * `approveInstructions` AND the spec's acceptance is pinned-test (has `testFiles`) — the
     * mechanical teaching-to-the-test gate. Otherwise recorded as skipped, never written.
     */
    instructionModules?: CatalogModule[];
    approveInstructions?: boolean;
  };
}

export interface SkillSpecJson {
  id: string;
  phases: {
    research: PhaseSpecJson;
    execute: PhaseSpecJson;
    review: PhaseSpecJson;
  };
  acceptance?: {
    command: string[];
    testFiles?: { path: string; content: string }[];
  };
  /** Stage-X fan-out: executor names to race for the execute phase (winner by acceptance). */
  executeCandidates?: string[];
  /** U1: bounded verifier-gated refinement iterations for the execute phase (default 1). */
  maxRefineIterations?: number;
}

/** One execute refinement attempt — recorded for observability; the verdict is never derived from it. */
export interface RefineIterationResult {
  iteration: number;
  passed: boolean;
  reason: string;
}

export interface PhaseResult {
  phase: PhaseId;
  workerId: string;
  nodeState: NodeState;
  outputRef?: string;
  skippedReason?: string;
  /** U1: per-iteration acceptance results when the execute phase ran the refinement loop. */
  iterations?: RefineIterationResult[];
}

export interface SkillRunReport {
  schema_version: 1;
  skillId: string;
  runId: string;
  what: string;
  phases: PhaseResult[];
  ledgerHead: RuntimeLedgerHeadBinding;
  acceptance?: AcceptanceResult;
  /**
   * Authoritative skill completion. When acceptance is declared, this verdict is
   * bound to the recomputable clean-checkout acceptance result.
   */
  completion: 'passed' | 'failed' | 'skipped';
  /**
   * Display-only mirror of the review node's nodeState. When acceptance is
   * declared, acceptance/completion is the authoritative recomputable gate.
   */
  completionDisplay: NodeState;
  /**
   * Slice 7 (Item B): present only when the spec opted into execute-phase Magic injection. It is
   * audit evidence (what was injected + post-exec integrity), NEVER a completion input.
   */
  injection?: { manifest: InjectionManifest; verification: InjectionVerification };
}

export interface AcceptanceResult {
  ran: boolean;
  passed: boolean;
  exitCode: number | null;
  command: string[];
  outputSha256: string;
  cleanDir: string;
  reason: string;
}

function interpolateGoal(template: string, input: { what: string }): string {
  return template.replaceAll('{what}', input.what);
}

function phaseFromJson(
  phaseId: PhaseId,
  phase: PhaseSpecJson | undefined,
  executors: Record<string, HarnessExecutor | undefined>,
): PhaseSpec {
  if (!phase) throw new Error(`missing phase: ${phaseId}`);
  if (!(phase.executor in executors)) throw new Error(`unknown executor: ${phase.executor}`);
  return {
    executor: executors[phase.executor],
    executorLabel: phase.executor,
    goalTemplate: phase.goalTemplate,
    acceptArtifact: phase.acceptArtifact,
  };
}

export function loadSkillSpecFromJson(
  json: SkillSpecJson,
  executors: Record<string, HarnessExecutor | undefined>,
): OrchestratorSkillSpec {
  if (!json.phases) throw new Error('missing phases');
  const executeCandidates = json.executeCandidates?.map((name) => {
    if (!(name in executors)) throw new Error(`unknown executor: ${name}`);
    return { label: name, executor: executors[name], executorLabel: name };
  });
  return {
    id: json.id,
    phases: {
      research: phaseFromJson('research', json.phases.research, executors),
      execute: phaseFromJson('execute', json.phases.execute, executors),
      review: phaseFromJson('review', json.phases.review, executors),
    },
    acceptance: json.acceptance,
    executeCandidates,
    maxRefineIterations: json.maxRefineIterations,
  };
}

export function compileSkillToGraphTemplate(spec: OrchestratorSkillSpec, input: { what: string }): GraphNode[] {
  return [
    {
      id: 'research',
      goal: interpolateGoal(spec.phases.research.goalTemplate, input),
      deps: [],
      executor: spec.phases.research.executor,
    },
    {
      id: 'execute',
      goal: interpolateGoal(spec.phases.execute.goalTemplate, input),
      deps: ['research'],
      executor: spec.phases.execute.executor,
    },
    {
      id: 'review',
      goal: interpolateGoal(spec.phases.review.goalTemplate, input),
      deps: ['execute'],
      executor: spec.phases.review.executor,
    },
  ];
}

const PHASE_IDS: PhaseId[] = ['research', 'execute', 'review'];

function isSupported(result: WorkerResult): boolean {
  return result.state === 'completed' && result.verifierStatus === 'supported';
}

function toPhaseResult(result: WorkerResult, phase: PhaseId): PhaseResult {
  return {
    phase,
    // Report the human-meaningful phase as the workerId; the run-namespaced worktree id is
    // an internal isolation detail, not part of the operator-facing report.
    workerId: phase,
    nodeState: isSupported(result) ? 'supported' : result.state === 'failed' ? 'failed' : 'blocked',
    outputRef: result.outputRef ?? undefined,
    skippedReason: undefined,
  };
}

// Per-run worktree id so back-to-back skill runs never collide on a fixed `wt/<phase>`
// dir/branch. Kept well within WORKER_ID_RE's 64-char / [A-Za-z0-9_-] limit.
function workerIdFor(runId: string, phase: PhaseId): string {
  return `${phase}-${sha256Hex(runId).slice(0, 12)}`;
}

function readWorkerLedgerHead(result: WorkerResult): RuntimeLedgerHeadBinding | undefined {
  if (!result.runDir) return undefined;
  const reportPath = join(result.worktreePath, result.runDir, 'harness-run-report.json');
  if (!existsSync(reportPath)) return undefined;
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { ledgerHead?: RuntimeLedgerHeadBinding };
  return report.ledgerHead;
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function completionFromReview(review: PhaseResult | undefined): 'passed' | 'failed' | 'skipped' {
  if (review?.nodeState === 'supported') return 'passed';
  if (review?.nodeState === 'skipped') return 'skipped';
  return 'failed';
}

export function runAcceptanceCheck(opts: {
  executeRefs: EvidenceRef[];
  acceptance: NonNullable<OrchestratorSkillSpec['acceptance']>;
}): AcceptanceResult {
  const cleanDir = mkdtempSync(join(tmpdir(), 'orchestrator-skill-acceptance-'));
  const command = opts.acceptance.command;

  try {
    for (const ref of opts.executeRefs) {
      materializeEvidenceInto(ref, cleanDir);
    }

    for (const testFile of opts.acceptance.testFiles ?? []) {
      const testPath = join(cleanDir, testFile.path);
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, testFile.content);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ran: false,
      passed: false,
      exitCode: null,
      command,
      outputSha256: sha256Hex(reason),
      cleanDir,
      reason,
    };
  }

  try {
    const result = spawnSync(command[0], command.slice(1), {
      cwd: cleanDir,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 10,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const reason = result.error
      ? result.error.message
      : result.status === 0
        ? 'acceptance command passed'
        : `acceptance command exited ${result.status ?? 'unknown'}`;

    return {
      ran: true,
      passed: result.status === 0,
      exitCode: result.status,
      command,
      outputSha256: sha256Hex(output),
      cleanDir,
      reason,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ran: true,
      passed: false,
      exitCode: null,
      command,
      outputSha256: sha256Hex(reason),
      cleanDir,
      reason,
    };
  }
}

export function skillRunDir(root: string, runId: string): string {
  return join(root, '.agent', 'skill-runs', runId);
}

/**
 * Read the content-addressed execute-phase evidence from the store. This is the
 * recomputable anchor for completion: bytes are re-hashed here and re-run through
 * acceptance, so the verdict never depends on a lifecycle projection event.
 */
function readExecuteRefsFromStore(root: string, runId: string): EvidenceRef[] {
  const executeDir = join(skillRunDir(root, runId), 'artifacts', 'execute');
  if (!existsSync(executeDir)) return [];
  return readdirSync(executeDir).map((file): EvidenceRef => {
    const storePath = join(executeDir, file);
    const content = readFileSync(storePath);
    return { phase: 'execute', relativePath: file, sha256: sha256Hex(content), storePath };
  });
}

export interface ExecuteCandidate {
  /** Executor identity, e.g. 'codex' | 'claude' | 'agy'. */
  label: string;
  /** That candidate's content-addressed execute evidence. */
  executeRefs: EvidenceRef[];
}

export interface CandidateSelection {
  /** Label of the first candidate whose acceptance passes, or null if none pass. */
  winner: string | null;
  results: { label: string; passed: boolean; reason: string }[];
}

/**
 * Stage X synthesis primitive: run the SAME acceptance over each candidate's execute evidence
 * in its own clean checkout, and pick the winner by the recomputable verifier verdict — never
 * by model rank, output length, or a worker's self-claim. A candidate wins only if its evidence
 * independently passes acceptance; if none pass, there is no winner (fail closed).
 */
export function selectExecuteCandidateByAcceptance(opts: {
  candidates: ExecuteCandidate[];
  acceptance: NonNullable<OrchestratorSkillSpec['acceptance']>;
}): CandidateSelection {
  const results = opts.candidates.map((candidate) => {
    const acceptance = runAcceptanceCheck({ executeRefs: candidate.executeRefs, acceptance: opts.acceptance });
    return { label: candidate.label, passed: acceptance.passed, reason: acceptance.reason };
  });
  return { winner: results.find((result) => result.passed)?.label ?? null, results };
}

export function recomputeCompletion(
  spec: OrchestratorSkillSpec,
  report: SkillRunReport,
  opts: { root: string },
): { completion: 'passed' | 'failed' | 'skipped'; matchesReport: boolean; reason: string } {
  if (!spec.acceptance) {
    return {
      completion: report.completion,
      matchesReport: true,
      reason: 'no acceptance declared; nothing to recompute',
    };
  }

  const execute = report.phases.find((phase) => phase.phase === 'execute');
  if (execute?.nodeState !== 'supported') {
    return {
      completion: 'skipped',
      matchesReport: report.completion === 'skipped',
      reason: 'execute not supported',
    };
  }

  const executeRefs = readExecuteRefsFromStore(opts.root, report.runId);
  const acceptance = runAcceptanceCheck({ executeRefs, acceptance: spec.acceptance });
  const completion = acceptance.passed ? 'passed' : 'failed';

  return {
    completion,
    matchesReport: completion === report.completion,
    reason: acceptance.reason,
  };
}

/**
 * Authoritative, ledger-grounded recompute. It validates the skill lifecycle
 * hash chain (tamper-evident) but derives the verdict ONLY from the
 * content-addressed execute evidence re-run through acceptance. The
 * `skill.completed` projection event — including any decision a forger appends to
 * it — is never consulted. This is the recomputable completion authority; the
 * SkillRunReport.completion field is display-only.
 */
export function recomputeCompletionFromLedger(
  spec: OrchestratorSkillSpec,
  opts: { root: string; runId: string },
): { completion: 'passed' | 'failed' | 'skipped'; ledgerValid: true; reason: string } {
  const events = readRuntimeEvents(skillRunDir(opts.root, opts.runId));
  // Throws on any broken hash chain / non-contiguous sequence — fail closed.
  validateRuntimeLedger(events);

  if (!spec.acceptance) {
    const reviewAdvanced = events
      .filter((event) => event.type === 'phase.advanced' && event.payload.phase === 'review')
      .at(-1);
    const reviewState = reviewAdvanced?.payload.nodeState;
    return {
      completion: reviewState === 'supported' ? 'passed' : reviewState === 'skipped' ? 'skipped' : 'failed',
      ledgerValid: true,
      reason: 'no acceptance declared; derived from review-node verifier projection',
    };
  }

  const executeRefs = readExecuteRefsFromStore(opts.root, opts.runId);
  if (!executeRefs.length) {
    return { completion: 'skipped', ledgerValid: true, reason: 'no execute evidence in store' };
  }
  const acceptance = runAcceptanceCheck({ executeRefs, acceptance: spec.acceptance });
  return {
    completion: acceptance.passed ? 'passed' : 'failed',
    ledgerValid: true,
    reason: acceptance.reason,
  };
}

/**
 * Append the skill lifecycle events as derived projections of the resolved phase
 * results. `skill.completed` carries refs only ({ finalNodeId, verifierVerdictRef,
 * ledgerHeadBeforeEvent }) and NO free-form decision/completion field, so it can
 * never become a second completion authority.
 */
function emitLifecycleProjection(opts: {
  root: string;
  runId: string;
  spec: OrchestratorSkillSpec;
  phases: PhaseResult[];
}): void {
  const dir = skillRunDir(opts.root, opts.runId);
  appendRuntimeEvent(dir, {
    runId: opts.runId,
    source: 'harness',
    type: 'skill.started',
    payload: { skillId: opts.spec.id },
  });
  for (const phase of opts.phases) {
    appendRuntimeEvent(dir, {
      runId: opts.runId,
      source: 'harness',
      type: 'phase.advanced',
      payload: {
        phase: phase.phase,
        nodeState: phase.nodeState,
        outputRef: phase.outputRef ?? null,
        skippedReason: phase.skippedReason ?? null,
      },
    });
  }
  const ledgerHeadBeforeEvent = runtimeLedgerHeadHash(readRuntimeEvents(dir));
  appendRuntimeEvent(dir, {
    runId: opts.runId,
    source: 'harness',
    type: 'skill.completed',
    payload: {
      finalNodeId: 'review',
      verifierVerdictRef: opts.spec.acceptance ? `skill-runs/${opts.runId}/artifacts/execute` : null,
      ledgerHeadBeforeEvent,
    },
  });
}

function executeCandidateWorkerId(runId: string, candidate: ExecuteCandidateExecutor): string {
  const slug = (candidate.executorLabel ?? candidate.label).replace(/[^A-Za-z0-9]+/g, '-');
  return `${workerIdFor(runId, 'execute')}-${slug}`.slice(0, 63);
}

/**
 * Stage-X execute fan-out: run each candidate executor in its own worktree, store each one's
 * artifact under a per-candidate evidence namespace, then pick the winner by re-running the
 * declared acceptance over each candidate's evidence (selectExecuteCandidateByAcceptance — by
 * verifier, never by rank). The winner is promoted to the canonical execute store path so the
 * rest of the run (review handoff, final acceptance, recompute) is identical to single-executor.
 */
async function runExecuteFanOut(opts: {
  root: string;
  runId: string;
  goal: string;
  acceptArtifact?: string;
  candidates: ExecuteCandidateExecutor[];
  acceptance: NonNullable<OrchestratorSkillSpec['acceptance']>;
  inputRefs: EvidenceRef[];
  createdWorkerIds: string[];
}): Promise<{ phaseResult: PhaseResult; winnerRef?: EvidenceRef; ledgerHead?: RuntimeLedgerHeadBinding }> {
  const candidates: ExecuteCandidate[] = [];
  const storedByLabel = new Map<string, EvidenceRef>();
  let ledgerHead: RuntimeLedgerHeadBinding | undefined;

  // Worktrees created serially, candidate slices run CONCURRENTLY. Selection stays deterministic:
  // the winner is the first candidate (in declared order) whose evidence passes acceptance,
  // independent of which executor finishes first.
  const workerSpecs = opts.candidates.map((candidate) => ({
    workerId: executeCandidateWorkerId(opts.runId, candidate),
    goal: opts.goal,
    executor: candidate.executor,
    executorLabel: candidate.executorLabel,
    inputRefs: opts.inputRefs,
  }));
  for (const spec of workerSpecs) opts.createdWorkerIds.push(spec.workerId);
  const results = await runWorkersConcurrently({ root: opts.root, workers: workerSpecs });

  for (let i = 0; i < opts.candidates.length; i++) {
    const candidate = opts.candidates[i];
    const result = results[i];
    ledgerHead = readWorkerLedgerHead(result) ?? ledgerHead;
    if (!isSupported(result) || !opts.acceptArtifact) continue;
    try {
      const ref = storePhaseArtifact({
        root: opts.root,
        skillRunId: `${opts.runId}/candidates/${candidate.label}`,
        phase: 'execute',
        sourceFile: join(result.worktreePath, opts.acceptArtifact),
      });
      storedByLabel.set(candidate.label, ref);
      candidates.push({ label: candidate.label, executeRefs: [ref] });
    } catch {
      // candidate did not produce the accepted artifact — it simply cannot win
    }
  }

  const selection = selectExecuteCandidateByAcceptance({ candidates, acceptance: opts.acceptance });
  if (!selection.winner) {
    return {
      phaseResult: {
        phase: 'execute',
        workerId: 'execute',
        nodeState: 'blocked',
        outputRef: undefined,
        skippedReason: 'no execute candidate passed acceptance',
      },
      ledgerHead,
    };
  }

  const winnerStored = storedByLabel.get(selection.winner);
  if (!winnerStored) throw new Error('winner selected without stored evidence');
  // Promote the winner to the canonical execute store path used by review/recompute.
  const winnerRef = storePhaseArtifact({
    root: opts.root,
    skillRunId: opts.runId,
    phase: 'execute',
    sourceFile: winnerStored.storePath,
  });
  return {
    phaseResult: {
      phase: 'execute',
      workerId: 'execute',
      nodeState: 'supported',
      outputRef: `agent://execute+${winnerRef.sha256}`,
      skippedReason: undefined,
    },
    winnerRef,
    ledgerHead,
  };
}

/**
 * U1 — verifier-gated refinement loop. Run the execute phase up to `maxIterations` times with ONE
 * executor. Iteration k+1 runs ONLY if iteration k's acceptance failed; it receives iteration k's
 * verifier-failure as an immutable EvidenceRef (refs-not-raw) plus a goal note. Each iteration's
 * artifact is stored under its own isolated namespace; the winner is selected by RE-RUNNING
 * acceptance over each iteration's evidence (`selectExecuteCandidateByAcceptance` — by verifier,
 * never by rank/self-claim) and promoted to the canonical execute store, so review/recompute are
 * identical to single-shot. The ONLY continue/stop signal is `runAcceptanceCheck.passed`.
 *
 * Anti-overfit (critic panel §6.1): the failure feedback is SCRUBBED — only the pinned command and
 * its exit reason are handed back, never raw stderr or test names. The graded target is the
 * operator `testFiles`, which `runAcceptanceCheck` overlays AFTER the executor evidence, so an
 * iteration cannot neuter the test it is graded by. A test-neutering iteration therefore still
 * recomputes to `failed` (proven by the forgery fixture).
 */
async function runExecuteRefinement(opts: {
  root: string;
  runId: string;
  goal: string;
  acceptArtifact?: string;
  executor?: HarnessExecutor;
  executorLabel?: string;
  acceptance: NonNullable<OrchestratorSkillSpec['acceptance']>;
  inputRefs: EvidenceRef[];
  createdWorkerIds: string[];
  maxIterations: number;
}): Promise<{ phaseResult: PhaseResult; winnerRef?: EvidenceRef; ledgerHead?: RuntimeLedgerHeadBinding }> {
  const candidates: ExecuteCandidate[] = [];
  const storedByLabel = new Map<string, EvidenceRef>();
  const iterations: RefineIterationResult[] = [];
  let ledgerHead: RuntimeLedgerHeadBinding | undefined;
  let failureContextRef: EvidenceRef | undefined;

  for (let k = 1; k <= opts.maxIterations; k++) {
    const workerId = `${workerIdFor(opts.runId, 'execute')}-iter-${k}`.slice(0, 63);
    opts.createdWorkerIds.push(workerId);
    const goal =
      k === 1
        ? opts.goal
        : `${opts.goal}\n\n## Refinement iteration ${k}\nThe previous attempt FAILED the pinned acceptance check. Fix ONLY the product code so the pinned acceptance passes. The graded test files are pinned by the operator and will be restored before grading — do NOT modify, stub, or delete them. The prior failure summary is attached as an input artifact.`;
    const iterInputRefs = failureContextRef ? [...opts.inputRefs, failureContextRef] : opts.inputRefs;
    const result = await runIsolatedWorker({
      root: opts.root,
      workerId,
      goal,
      executor: opts.executor,
      executorLabel: opts.executorLabel,
      inputRefs: iterInputRefs,
    });
    ledgerHead = readWorkerLedgerHead(result) ?? ledgerHead;

    const label = `iter-${k}`;
    if (!isSupported(result) || !opts.acceptArtifact) {
      iterations.push({ iteration: k, passed: false, reason: 'executor did not produce a supported artifact' });
      continue;
    }
    let ref: EvidenceRef;
    try {
      ref = storePhaseArtifact({
        root: opts.root,
        skillRunId: `${opts.runId}/iterations/${label}`,
        phase: 'execute',
        sourceFile: join(result.worktreePath, opts.acceptArtifact),
      });
    } catch {
      iterations.push({ iteration: k, passed: false, reason: 'expected accept artifact missing' });
      continue;
    }
    storedByLabel.set(label, ref);
    candidates.push({ label, executeRefs: [ref] });

    // The ONLY loop signal: re-run the recomputable acceptance over THIS iteration's evidence.
    const acc = runAcceptanceCheck({ executeRefs: [ref], acceptance: opts.acceptance });
    iterations.push({ iteration: k, passed: acc.passed, reason: acc.reason });
    if (acc.passed) break;

    // Scrubbed failure feedback: command + exit reason only (no raw stderr / test names).
    const failDir = mkdtempSync(join(tmpdir(), 'orchestrator-skill-refine-fail-'));
    const failFile = join(failDir, 'acceptance-failure.md');
    writeFileSync(
      failFile,
      `# Acceptance failed (iteration ${k})\n\nCommand: \`${opts.acceptance.command.join(' ')}\`\nResult: ${acc.reason}\n\nFix the product code so this command exits 0. Do not modify the graded test files.\n`,
    );
    failureContextRef = storePhaseArtifact({
      root: opts.root,
      skillRunId: `${opts.runId}/iterations/${label}-failure`,
      phase: 'execute',
      sourceFile: failFile,
    });
  }

  // Winner by RE-RUN over the isolated iteration evidence — never by rank/order/self-claim.
  // On exhaustion (no iteration passed) the LAST attempt that produced evidence becomes canonical,
  // so downstream acceptance/recompute re-run over real evidence and return an honest `failed`
  // (never a `skipped` that hides the executor's failing output). Only a run where NO iteration
  // produced any gradeable artifact is `blocked`.
  const selection = selectExecuteCandidateByAcceptance({ candidates, acceptance: opts.acceptance });
  const chosenLabel = selection.winner ?? (candidates.length ? candidates[candidates.length - 1].label : null);
  if (!chosenLabel) {
    return {
      phaseResult: {
        phase: 'execute',
        workerId: 'execute',
        nodeState: 'blocked',
        outputRef: undefined,
        skippedReason: `no execute iteration produced gradeable evidence after ${opts.maxIterations} attempt(s)`,
        iterations,
      },
      ledgerHead,
    };
  }

  const chosenStored = storedByLabel.get(chosenLabel);
  if (!chosenStored) throw new Error('refinement winner selected without stored evidence');
  // Promote the chosen iteration to the canonical execute store path read by review/recompute.
  const winnerRef = storePhaseArtifact({
    root: opts.root,
    skillRunId: opts.runId,
    phase: 'execute',
    sourceFile: chosenStored.storePath,
  });
  return {
    phaseResult: {
      phase: 'execute',
      workerId: 'execute',
      // The executor produced gradeable evidence; acceptance (re-run downstream and by recompute) is
      // the authoritative gate. A non-passing exhaustion promotes the last attempt and recomputes to
      // `failed`, identical in meaning to a single-shot acceptance failure.
      nodeState: 'supported',
      outputRef: `agent://execute+${winnerRef.sha256}`,
      skippedReason: undefined,
      iterations,
    },
    winnerRef,
    ledgerHead,
  };
}

export async function runOrchestratorSkill(
  spec: OrchestratorSkillSpec,
  input: { what: string; root: string; runId?: string },
): Promise<SkillRunReport> {
  const runId = input.runId ?? `skill-${randomUUID()}`;
  // Slice 7 (Item B): injection is single-executor only — refuse it alongside fan-out / refinement
  // so the public shape can't silently grow fan-out semantics (design-panel codex #4).
  if (spec.inject && (spec.executeCandidates?.length || (spec.maxRefineIterations ?? 1) > 1)) {
    throw new Error('orchestrator-skill inject is single-executor only: not supported with execute fan-out or refinement');
  }
  const nodes = compileSkillToGraphTemplate(spec, { what: input.what });
  const goalsByPhase = new Map(nodes.map((node) => [node.id, node.goal]));
  const phases: PhaseResult[] = [];
  const inputRefs: EvidenceRef[] = [];
  const executeRefs: EvidenceRef[] = [];
  let ledgerHead: RuntimeLedgerHeadBinding | undefined;
  let skillInjection: { manifest: InjectionManifest; verification: InjectionVerification } | undefined;
  const createdWorkerIds: string[] = [];
  const cleanupSkillWorktrees = () => {
    for (const id of createdWorkerIds) {
      try {
        removeWorktreeAndBranch(input.root, id, { force: true });
      } catch {
        // best-effort: a leftover worktree must not fail the run or hide the verdict
      }
    }
  };

  for (const phase of PHASE_IDS) {
    const priorUnsupported = phases.find((result) => result.nodeState !== 'supported');
    if (priorUnsupported) {
      phases.push({
        phase,
        workerId: phase,
        nodeState: 'skipped',
        outputRef: undefined,
        skippedReason: `unsupported deps: ${priorUnsupported.phase}`,
      });
      continue;
    }

    if (phase === 'execute' && spec.executeCandidates?.length && spec.acceptance) {
      const fan = await runExecuteFanOut({
        root: input.root,
        runId,
        goal: goalsByPhase.get('execute') ?? spec.phases.execute.goalTemplate,
        acceptArtifact: spec.phases.execute.acceptArtifact,
        candidates: spec.executeCandidates,
        acceptance: spec.acceptance,
        inputRefs,
        createdWorkerIds,
      });
      ledgerHead = fan.ledgerHead ?? ledgerHead;
      phases.push(fan.phaseResult);
      if (fan.winnerRef) {
        inputRefs.push(fan.winnerRef);
        executeRefs.push(fan.winnerRef);
      }
      continue;
    }

    if (
      phase === 'execute' &&
      (spec.maxRefineIterations ?? 1) > 1 &&
      spec.acceptance &&
      !spec.executeCandidates?.length
    ) {
      const refined = await runExecuteRefinement({
        root: input.root,
        runId,
        goal: goalsByPhase.get('execute') ?? spec.phases.execute.goalTemplate,
        acceptArtifact: spec.phases.execute.acceptArtifact,
        executor: spec.phases.execute.executor,
        executorLabel: spec.phases.execute.executorLabel,
        acceptance: spec.acceptance,
        inputRefs,
        createdWorkerIds,
        maxIterations: spec.maxRefineIterations ?? 1,
      });
      ledgerHead = refined.ledgerHead ?? ledgerHead;
      phases.push(refined.phaseResult);
      if (refined.winnerRef) {
        inputRefs.push(refined.winnerRef);
        executeRefs.push(refined.winnerRef);
      }
      continue;
    }

    const workerId = workerIdFor(runId, phase);
    createdWorkerIds.push(workerId);
    let injectionManifest: InjectionManifest | undefined;
    const result = await runIsolatedWorker({
      root: input.root,
      workerId,
      goal: goalsByPhase.get(phase) ?? spec.phases[phase].goalTemplate,
      executor: spec.phases[phase].executor,
      executorLabel: spec.phases[phase].executorLabel,
      inputRefs,
      // Slice 7 (Item B): inject capability (MCP) into the EXECUTE worktree before the executor runs.
      beforeExecute:
        phase === 'execute' && spec.inject
          ? ((injectSpec, pinnedTest) => (worktreePath: string) => {
              injectionManifest = applyCompositionToWorktree({
                worktree: worktreePath,
                mcpModules: injectSpec.mcpModules,
                adapter: injectSpec.adapter,
                approveSecrets: injectSpec.approveSecrets,
                instructionModules: injectSpec.instructionModules,
                approveInstructions: injectSpec.approveInstructions,
                // Mechanical teaching-to-the-test gate: instruction injection only with a pinned test.
                acceptanceIsPinnedTest: pinnedTest,
              });
            })(spec.inject, Boolean(spec.acceptance?.testFiles?.length))
          : undefined,
    });
    // Post-exec verify + ledger composition.injected (evidence only — NEVER a completion input; the
    // event is appended to the same chain recompute validates but is ignored by the verdict path).
    if (phase === 'execute' && spec.inject && injectionManifest) {
      const verification = verifyInjection(result.worktreePath, injectionManifest, { adapter: spec.inject.adapter });
      const dir = skillRunDir(input.root, runId);
      mkdirSync(dir, { recursive: true });
      recordInjectionEvent(dir, runId, injectionManifest, { phase: 'execute', executor: 'primary', fanout: false });
      skillInjection = { manifest: injectionManifest, verification };
    }
    ledgerHead = readWorkerLedgerHead(result) ?? ledgerHead;

    const phaseResult = toPhaseResult(result, phase);
    phases.push(phaseResult);
    if (phaseResult.nodeState !== 'supported' || !spec.phases[phase].acceptArtifact) continue;

    try {
      const ref = storePhaseArtifact({
        root: input.root,
        skillRunId: runId,
        phase,
        sourceFile: join(result.worktreePath, spec.phases[phase].acceptArtifact),
      });
      inputRefs.push(ref);
      if (phase === 'execute') executeRefs.push(ref);
    } catch {
      phaseResult.nodeState = 'blocked';
    }
  }

  // Artifacts are already content-addressed into the evidence store; the per-phase worktrees
  // are no longer needed. Remove them (and their wt/<id> branches) so re-runs don't collide.
  cleanupSkillWorktrees();

  if (!ledgerHead) throw new Error('runOrchestratorSkill could not bind a worker ledger head');
  const review = phases.find((phase) => phase.phase === 'review');
  const execute = phases.find((phase) => phase.phase === 'execute');
  const acceptance =
    spec.acceptance && execute?.nodeState === 'supported'
      ? runAcceptanceCheck({ executeRefs, acceptance: spec.acceptance })
      : undefined;
  const completion = spec.acceptance
    ? acceptance
      ? acceptance.passed
        ? 'passed'
        : 'failed'
      : 'skipped'
    : completionFromReview(review);

  const report: SkillRunReport = {
    schema_version: 1,
    skillId: spec.id,
    runId,
    what: input.what,
    phases,
    ledgerHead,
    acceptance,
    completion,
    completionDisplay: review?.nodeState ?? 'failed',
    injection: skillInjection,
  };

  // Lifecycle events are derived projections appended AFTER the verdict is fixed;
  // they describe the run, they never decide it.
  emitLifecycleProjection({ root: input.root, runId, spec, phases });
  const dir = skillRunDir(input.root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill-run-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  // Persist the serializable spec (executors dropped — they are functions) so an operator
  // projection can later RECOMPUTE completion from disk, not trust the stored report field.
  writeFileSync(join(dir, 'skill-spec.json'), `${JSON.stringify(toSerializableSpec(spec), null, 2)}\n`);

  return report;
}

interface SerializableSkillSpec {
  id: string;
  acceptance?: OrchestratorSkillSpec['acceptance'];
  phases: Record<PhaseId, { goalTemplate: string; acceptArtifact?: string }>;
  maxRefineIterations?: number;
}

function toSerializableSpec(spec: OrchestratorSkillSpec): SerializableSkillSpec {
  const phase = (id: PhaseId) => ({
    goalTemplate: spec.phases[id].goalTemplate,
    acceptArtifact: spec.phases[id].acceptArtifact,
  });
  return {
    id: spec.id,
    acceptance: spec.acceptance,
    phases: { research: phase('research'), execute: phase('execute'), review: phase('review') },
    maxRefineIterations: spec.maxRefineIterations,
  };
}

/**
 * Operator-supplied launch input for an async skill run started from the UI. This records the
 * operator's request (which spec, what goal) and the spawned child pid — it is NOT a completion
 * claim and carries no verdict. The authoritative verdict only ever comes from the ledger
 * recompute once the child writes its report.
 */
export interface SkillLaunchMarker {
  runId: string;
  skillId: string;
  what: string;
  startedAt: string;
  pid: number;
}

const SKILL_LAUNCH_MARKER = 'skill-launch.json';

export function writeSkillLaunchMarker(root: string, marker: SkillLaunchMarker): void {
  const dir = skillRunDir(root, marker.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SKILL_LAUNCH_MARKER), JSON.stringify(marker, null, 2));
}

export function readSkillLaunchMarker(root: string, runId: string): SkillLaunchMarker | null {
  const file = join(skillRunDir(root, runId), SKILL_LAUNCH_MARKER);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SkillLaunchMarker;
  } catch {
    return null;
  }
}

/**
 * Lifecycle status of a skill run, derived from on-disk facts only:
 *  - `final`: the child wrote `skill-run-report.json`; trust the ledger recompute on the detail page.
 *  - `running`: a launch marker exists, no report yet, and the recorded pid is still alive.
 *  - `exited-without-verdict`: a launch marker exists, no report, and the pid is gone — the child
 *    died before producing evidence. This is an honest stuck state, never a green.
 * A directory with neither a report nor a marker is treated as `final` (CLI-launched legacy runs).
 */
export type SkillRunStatus = 'final' | 'running' | 'exited-without-verdict';

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function skillRunStatus(root: string, runId: string): SkillRunStatus {
  const dir = skillRunDir(root, runId);
  if (existsSync(join(dir, 'skill-run-report.json'))) return 'final';
  const marker = readSkillLaunchMarker(root, runId);
  if (!marker) return 'final';
  return pidAlive(marker.pid) ? 'running' : 'exited-without-verdict';
}

export interface SkillRunSummary {
  runId: string;
  skillId: string;
  status: SkillRunStatus;
}

/**
 * Cheap discovery list for the operator home. It surfaces both completed runs (with a stored
 * report) and in-flight launches (marker but no report) so the operator can watch a run they
 * just started — but it deliberately asserts NO completion verdict. A home list must never show
 * an unverified green; the authoritative verdict is recomputed on the /skill/<runId> detail page.
 */
export function listSkillRunSummaries(root: string): SkillRunSummary[] {
  const base = join(root, '.agent', 'skill-runs');
  if (!existsSync(base)) return [];
  const summaries: SkillRunSummary[] = [];
  for (const runId of readdirSync(base)) {
    const reportPath = join(base, runId, 'skill-run-report.json');
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8')) as SkillRunReport;
        summaries.push({ runId: report.runId ?? runId, skillId: report.skillId ?? 'unknown', status: 'final' });
      } catch {
        // unreadable report — skip rather than crash the home page
      }
      continue;
    }
    const marker = readSkillLaunchMarker(root, runId);
    if (marker) {
      summaries.push({
        runId: marker.runId ?? runId,
        skillId: marker.skillId ?? 'unknown',
        status: skillRunStatus(root, runId),
      });
    }
  }
  return summaries.sort((a, b) => b.runId.localeCompare(a.runId));
}

export interface SkillRunProjection {
  runId: string;
  skillId: string;
  ledgerValid: boolean;
  phases: { phase: PhaseId; nodeState: NodeState; label: string }[];
  /** Display-only mirror of the review node state (what the run reported for show). */
  displayCompletion: NodeState;
  /** The display-only completion field as stored in the report. */
  reportCompletion: 'passed' | 'failed' | 'skipped';
  /** The authoritative verdict, recomputed from the ledger + execute evidence on disk. */
  authoritativeCompletion: 'passed' | 'failed' | 'skipped';
  /** True when the stored/display fields disagree with the authoritative recompute. */
  contradiction: boolean;
  reason: string;
}

/**
 * Operator projection (stage U): render a skill run's truth WITHOUT trusting the stored
 * report. It recomputes completion from the persisted spec + ledger + execute evidence and
 * flags any contradiction — so the UI can never show green when the gate is red.
 */
export function projectSkillRun(opts: { root: string; runId: string }): SkillRunProjection {
  const dir = skillRunDir(opts.root, opts.runId);
  const report = JSON.parse(readFileSync(join(dir, 'skill-run-report.json'), 'utf8')) as SkillRunReport;
  const specJson = JSON.parse(readFileSync(join(dir, 'skill-spec.json'), 'utf8')) as SerializableSkillSpec;
  const spec: OrchestratorSkillSpec = {
    id: specJson.id,
    acceptance: specJson.acceptance,
    phases: {
      research: {
        goalTemplate: specJson.phases.research.goalTemplate,
        acceptArtifact: specJson.phases.research.acceptArtifact,
      },
      execute: {
        goalTemplate: specJson.phases.execute.goalTemplate,
        acceptArtifact: specJson.phases.execute.acceptArtifact,
      },
      review: {
        goalTemplate: specJson.phases.review.goalTemplate,
        acceptArtifact: specJson.phases.review.acceptArtifact,
      },
    },
  };

  let ledgerValid = true;
  let authoritativeCompletion: 'passed' | 'failed' | 'skipped' = 'failed';
  let reason: string;
  try {
    const recomputed = recomputeCompletionFromLedger(spec, opts);
    authoritativeCompletion = recomputed.completion;
    reason = recomputed.reason;
  } catch (error) {
    ledgerValid = false;
    reason = error instanceof Error ? error.message : String(error);
  }

  // completionDisplay mirrors the review NODE state (supported = review ran), which is NOT a
  // green claim — a legitimately failed acceptance still has a supported review node. The only
  // completion claim is the display-only report.completion field; contradiction is when that
  // (or an invalid ledger) disagrees with the authoritative recompute.
  const contradiction = !ledgerValid || report.completion !== authoritativeCompletion;

  return {
    runId: report.runId,
    skillId: report.skillId,
    ledgerValid,
    phases: report.phases.map((phase) => ({ phase: phase.phase, nodeState: phase.nodeState, label: phase.nodeState })),
    displayCompletion: report.completionDisplay,
    reportCompletion: report.completion,
    authoritativeCompletion,
    contradiction,
    reason,
  };
}

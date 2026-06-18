import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendRuntimeEvent,
  readRuntimeEvents,
  type RuntimeLedgerHeadBinding,
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
  type WorkerResult,
} from './orchestrator.js';

export interface PhaseSpec {
  executor?: HarnessExecutor;
  goalTemplate: string;
  acceptArtifact?: string;
}

export interface PhaseSpecJson {
  executor: string;
  goalTemplate: string;
  acceptArtifact?: string;
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
}

export interface PhaseResult {
  phase: PhaseId;
  workerId: string;
  nodeState: NodeState;
  outputRef?: string;
  skippedReason?: string;
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
    goalTemplate: phase.goalTemplate,
    acceptArtifact: phase.acceptArtifact,
  };
}

export function loadSkillSpecFromJson(
  json: SkillSpecJson,
  executors: Record<string, HarnessExecutor | undefined>,
): OrchestratorSkillSpec {
  if (!json.phases) throw new Error('missing phases');
  return {
    id: json.id,
    phases: {
      research: phaseFromJson('research', json.phases.research, executors),
      execute: phaseFromJson('execute', json.phases.execute, executors),
      review: phaseFromJson('review', json.phases.review, executors),
    },
    acceptance: json.acceptance,
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

function skillRunDir(root: string, runId: string): string {
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

export async function runOrchestratorSkill(
  spec: OrchestratorSkillSpec,
  input: { what: string; root: string; runId?: string },
): Promise<SkillRunReport> {
  const runId = input.runId ?? `skill-${randomUUID()}`;
  const nodes = compileSkillToGraphTemplate(spec, { what: input.what });
  const goalsByPhase = new Map(nodes.map((node) => [node.id, node.goal]));
  const phases: PhaseResult[] = [];
  const inputRefs: EvidenceRef[] = [];
  const executeRefs: EvidenceRef[] = [];
  let ledgerHead: RuntimeLedgerHeadBinding | undefined;
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

    const workerId = workerIdFor(runId, phase);
    createdWorkerIds.push(workerId);
    const result = await runIsolatedWorker({
      root: input.root,
      workerId,
      goal: goalsByPhase.get(phase) ?? spec.phases[phase].goalTemplate,
      executor: spec.phases[phase].executor,
      inputRefs,
    });
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
  };
}

export interface SkillRunSummary {
  runId: string;
  skillId: string;
}

/**
 * Cheap discovery list for the operator home: runId + skillId only, read from each stored
 * report. It deliberately asserts NO completion verdict — a home list must not show an
 * unverified green. The authoritative verdict is recomputed on the /skill/<runId> detail page.
 */
export function listSkillRunSummaries(root: string): SkillRunSummary[] {
  const base = join(root, '.agent', 'skill-runs');
  if (!existsSync(base)) return [];
  const summaries: SkillRunSummary[] = [];
  for (const runId of readdirSync(base)) {
    const reportPath = join(base, runId, 'skill-run-report.json');
    if (!existsSync(reportPath)) continue;
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as SkillRunReport;
      summaries.push({ runId: report.runId ?? runId, skillId: report.skillId ?? 'unknown' });
    } catch {
      // unreadable report — skip rather than crash the home page
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
      research: { goalTemplate: specJson.phases.research.goalTemplate, acceptArtifact: specJson.phases.research.acceptArtifact },
      execute: { goalTemplate: specJson.phases.execute.goalTemplate, acceptArtifact: specJson.phases.execute.acceptArtifact },
      review: { goalTemplate: specJson.phases.review.goalTemplate, acceptArtifact: specJson.phases.review.acceptArtifact },
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

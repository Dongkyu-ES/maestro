import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  appendRuntimeEvent,
  createRuntimeLedgerHeadBinding,
  readRuntimeEvents,
  runtimeLedgerHeadHash,
  stableJson,
  validateRuntimeLedger,
  type RuntimeLedgerHeadBinding,
} from '../events/ledger.js';
import { runCodexExec, type CodexExecResult } from '../runtime/codex-exec-runner.js';
import { writeContextProvenanceBundle, type ContextProvenanceBundle } from './context-provenance.js';
import { runHooks, type HookHandler, type HookOutcome, type LifecycleEvent } from './hooks.js';
import type { NativeArtifactHash } from './native-evidence.js';
import { runVerifier, type VerifierResult } from './verifier.js';

export type HarnessSliceState = 'completed' | 'blocked';

export interface HarnessRunOptions {
  root: string;
  goal: string;
  executorBin?: string;
  runId?: string;
  timeoutMs?: number;
  hooks?: HookHandler[];
}

export interface ContextBundle {
  schema_version: 1;
  run_id: string;
  goal: string;
  included_goal_sha256: string;
  included_context_refs: string[];
  included_provenance: ContextProvenanceBundle;
  native_harness_assisted: true;
  unowned_surfaces: string[];
}

export interface ToolExecutionEvidence {
  schema_version: 1;
  run_id: string;
  executor: 'codex';
  evidence_kind: 'tool_execution';
  status: 'native-harness-assisted';
  generated_at: string;
  diff_ref: string;
  diff_sha256: string;
  status_ref: string;
  status_sha256: string;
  file_hashes: NativeArtifactHash[];
  changed_files: string[];
  executor_exit_code: number;
  unowned_surfaces: string[];
}

export interface HarnessRunReport {
  schema_version: 1;
  runId: string;
  runDir: string;
  state: HarnessSliceState;
  contextSha256: string;
  verifier: VerifierResult;
  ledgerHead: RuntimeLedgerHeadBinding;
  nativeHarnessAssisted: true;
  unownedSurfaces: string[];
}

const UNOWNED_SURFACES = [
  'codex exec process lifecycle',
  'codex JSONL stream schema',
  'codex model/tool policy internals',
  'local git binary',
];

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runDirFor(root: string, runId: string): string {
  return join(root, '.agent', 'runs', runId);
}

function writeJson(path: string, value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return sha256(text);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function changedFilesFromStatus(statusText: string): string[] {
  return statusText
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => (file.includes(' -> ') ? file.split(' -> ').at(-1) || file : file))
    .filter(Boolean);
}

function fileHashes(root: string, changedFiles: string[]): NativeArtifactHash[] {
  return changedFiles
    .filter((ref) => existsSync(join(root, ref)))
    .map((ref) => ({ ref, sha256: sha256(readFileSync(join(root, ref))) }));
}

function buildContextBundle(options: {
  runDir: string;
  root: string;
  runId: string;
  goal: string;
  provenance: ContextProvenanceBundle;
}): { bundle: ContextBundle; sha256: string } {
  const bundle: ContextBundle = {
    schema_version: 1,
    run_id: options.runId,
    goal: options.goal,
    included_goal_sha256: sha256(options.goal),
    included_context_refs: options.provenance.context_files.map((item) => item.ref),
    included_provenance: options.provenance,
    native_harness_assisted: true,
    unowned_surfaces: UNOWNED_SURFACES,
  };
  const bundleSha256 = sha256(stableJson(bundle));
  writeFileSync(join(options.runDir, 'context-bundle.json'), `${JSON.stringify({ ...bundle, sha256: bundleSha256 }, null, 2)}\n`);
  return { bundle, sha256: bundleSha256 };
}

async function withExecutorBin<T>(executorBin: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENT_CODEX_BIN;
  if (executorBin) process.env.AGENT_CODEX_BIN = executorBin;
  try {
    return await fn();
  } finally {
    if (executorBin) {
      if (previous === undefined) delete process.env.AGENT_CODEX_BIN;
      else process.env.AGENT_CODEX_BIN = previous;
    }
  }
}

function captureToolEvidence(options: { root: string; runDir: string; runId: string; executor: CodexExecResult }): ToolExecutionEvidence {
  const runDirRef = relative(options.root, options.runDir).replaceAll('\\', '/');
  const excludeRunDir = `:(exclude)${runDirRef}`;
  const diffText = git(options.root, ['diff', '--binary', '--', '.', excludeRunDir]);
  const statusText = git(options.root, ['status', '--porcelain', '--', '.', excludeRunDir]);
  writeFileSync(join(options.runDir, 'tool-git-diff.patch'), diffText);
  writeFileSync(join(options.runDir, 'tool-git-status.txt'), statusText);
  const changedFiles = changedFilesFromStatus(statusText);
  const evidence: ToolExecutionEvidence = {
    schema_version: 1,
    run_id: options.runId,
    executor: 'codex',
    evidence_kind: 'tool_execution',
    status: 'native-harness-assisted',
    generated_at: new Date().toISOString(),
    diff_ref: 'tool-git-diff.patch',
    diff_sha256: sha256(diffText),
    status_ref: 'tool-git-status.txt',
    status_sha256: sha256(statusText),
    file_hashes: fileHashes(options.root, changedFiles),
    changed_files: changedFiles,
    executor_exit_code: options.executor.exit_code,
    unowned_surfaces: UNOWNED_SURFACES,
  };
  writeJson(join(options.runDir, 'tool-execution-evidence.json'), evidence);
  return evidence;
}

function hookBlockVerifier(event: LifecycleEvent, outcome: HookOutcome): VerifierResult {
  return {
    type: 'ledger',
    status: 'blocked',
    evidenceInputs: ['events'],
    reason: `${event} hook ${outcome.hookId} ${outcome.decision}${outcome.reason ? `: ${outcome.reason}` : ''}`,
  };
}

function appendHookBlockedTransition(options: {
  runDir: string;
  runId: string;
  event: LifecycleEvent;
  outcome: HookOutcome;
}): HarnessSliceState {
  const state: HarnessSliceState = 'blocked';
  appendRuntimeEvent(options.runDir, {
    runId: options.runId,
    source: 'harness',
    type: 'hook.completed',
    payload: {
      event: options.event,
      decision: options.outcome.decision,
      hook_id: options.outcome.hookId,
      reason: options.outcome.reason,
    },
  });
  appendRuntimeEvent(options.runDir, {
    runId: options.runId,
    source: 'harness',
    type: 'state.transitioned',
    payload: {
      state,
      authority: `hook:${options.outcome.hookId}`,
      hook_event: options.event,
      hook_decision: options.outcome.decision,
      reason: options.outcome.reason,
    },
  });
  appendRuntimeEvent(options.runDir, {
    runId: options.runId,
    source: 'harness',
    type: 'run.blocked',
    payload: {
      state,
      authority: `hook:${options.outcome.hookId}`,
      hook_event: options.event,
      hook_decision: options.outcome.decision,
      reason: options.outcome.reason,
      native_harness_assisted: true,
      unowned_surfaces: UNOWNED_SURFACES,
    },
  });
  return state;
}

function finalizeReport(options: {
  root: string;
  runDir: string;
  runId: string;
  state: HarnessSliceState;
  contextSha256: string;
  verifier: VerifierResult;
}): HarnessRunReport {
  const events = readRuntimeEvents(options.runDir);
  validateRuntimeLedger(events);
  const report: HarnessRunReport = {
    schema_version: 1,
    runId: options.runId,
    runDir: relative(options.root, options.runDir).replaceAll('\\', '/'),
    state: options.state,
    contextSha256: options.contextSha256,
    verifier: options.verifier,
    ledgerHead: createRuntimeLedgerHeadBinding(events),
    nativeHarnessAssisted: true,
    unownedSurfaces: UNOWNED_SURFACES,
  };
  writeFileSync(join(options.runDir, 'harness-run-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const finalEvents = readRuntimeEvents(options.runDir);
  report.ledgerHead = {
    run_id: options.runId,
    event_count: finalEvents.length,
    ledger_head_sha256: runtimeLedgerHeadHash(finalEvents),
  };
  writeFileSync(join(options.runDir, 'harness-run-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function runHarnessSlice(options: HarnessRunOptions): Promise<HarnessRunReport> {
  const root = options.root;
  const runId = options.runId || `harness-${randomUUID()}`;
  const hooks = options.hooks || [];
  const runDir = runDirFor(root, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'task.md'), `${options.goal}\n`);
  writeFileSync(join(runDir, 'context.md'), `Goal:\n${options.goal}\n`);

  appendRuntimeEvent(runDir, {
    runId,
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { goal: options.goal },
    artifactRefs: ['task.md'],
  });
  const provenance = writeContextProvenanceBundle({ root, agentDir: '.agent', runId });
  const context = buildContextBundle({ runDir, root, runId, goal: options.goal, provenance });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'context.built',
    payload: {
      context_sha256: context.sha256,
      included_context_refs: context.bundle.included_context_refs,
      provenance_ref: 'context-provenance.json',
    },
    artifactRefs: ['context-bundle.json', 'context-provenance.json'],
  });

  const executor = await withExecutorBin(options.executorBin, () =>
    runCodexExec({
      runDir,
      cwd: root,
      prompt: options.goal,
      timeoutMs: options.timeoutMs,
      label: 'executor',
    }),
  );
  appendRuntimeEvent(runDir, {
    runId,
    source: 'codex-adapter',
    type: 'executor.output.received',
    payload: {
      exit_code: executor.exit_code,
      event_count: executor.event_count,
      session_id: executor.session_id,
      last_message_present: executor.last_message.length > 0,
    },
    artifactRefs: ['executor.process.json', 'executor.stdout.log', 'executor.stderr.log', 'codex-events.jsonl'],
  });

  const beforeTool = runHooks('BeforeToolExecution', hooks, {
    runId,
    runDir: relative(root, runDir).replaceAll('\\', '/'),
    root,
    goal: options.goal,
    contextSha256: context.sha256,
    executor: {
      exit_code: executor.exit_code,
      event_count: executor.event_count,
      session_id: executor.session_id,
      last_message_present: executor.last_message.length > 0,
    },
  });
  if (beforeTool.decision !== 'continue') {
    const verifier = hookBlockVerifier('BeforeToolExecution', beforeTool);
    const state = appendHookBlockedTransition({ runDir, runId, event: 'BeforeToolExecution', outcome: beforeTool });
    return finalizeReport({ root, runDir, runId, state, contextSha256: context.sha256, verifier });
  }

  const evidence = captureToolEvidence({ root, runDir, runId, executor });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'tool.execution.completed',
    payload: {
      evidence_ref: 'tool-execution-evidence.json',
      diff_sha256: evidence.diff_sha256,
      status_sha256: evidence.status_sha256,
      changed_files: evidence.changed_files,
    },
    artifactRefs: ['tool-execution-evidence.json', 'tool-git-diff.patch', 'tool-git-status.txt'],
  });

  const verifier =
    evidence.changed_files.length === 0
      ? ({
          type: 'diff',
          status: 'unproven',
          evidenceInputs: ['tool-git-status.txt'],
          reason: 'no tool-effect git diff evidence was captured',
        } satisfies VerifierResult)
      : runVerifier({
          type: 'diff',
          root: runDir,
          diffStatusArtifactRef: 'tool-git-status.txt',
          diffStatusExpectedSha256: evidence.status_sha256,
        });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'verifier.completed',
    payload: verifier as unknown as Record<string, unknown>,
    artifactRefs: ['tool-execution-evidence.json', 'tool-git-status.txt'],
  });

  let state: HarnessSliceState = verifier.status === 'supported' ? 'completed' : 'blocked';
  const beforeState = runHooks('BeforeStateTransition', hooks, {
    runId,
    runDir: relative(root, runDir).replaceAll('\\', '/'),
    root,
    goal: options.goal,
    contextSha256: context.sha256,
    verifier,
    proposedState: state,
    authority: 'verifier.completed',
  });
  if (beforeState.decision !== 'continue') {
    state = appendHookBlockedTransition({ runDir, runId, event: 'BeforeStateTransition', outcome: beforeState });
    return finalizeReport({ root, runDir, runId, state, contextSha256: context.sha256, verifier });
  }

  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'state.transitioned',
    payload: {
      state,
      authority: 'verifier.completed',
      verifier_status: verifier.status,
    },
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: state === 'completed' ? 'run.completed' : 'run.blocked',
    payload: { state, native_harness_assisted: true, unowned_surfaces: UNOWNED_SURFACES },
  });

  return finalizeReport({ root, runDir, runId, state, contextSha256: context.sha256, verifier });
}

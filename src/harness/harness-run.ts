import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
import { compileBaseRules, type BaseRuleSet } from './base-rules.js';
import {
  buildContextBundle as buildCanonicalContextBundle,
  type ContextBundle as CanonicalContextBundle,
  type ContextSection,
} from './context-bundle.js';
import { writeContextProvenanceBundle, type ContextProvenanceBundle } from './context-provenance.js';
import { runHooks, type HookHandler, type HookOutcome, type LifecycleEvent } from './hooks.js';
import { buildMemoryContextSections, type MemoryEntry } from './memory-gating.js';
import { assertLabelMatchesObservation, deriveNativeHarnessAssisted, type RunObservation } from './native-surface-detector.js';
import type { NativeArtifactHash } from './native-evidence.js';
import { runVerifier, type VerifierResult } from './verifier.js';

export type HarnessSliceState = 'completed' | 'blocked';

export interface HarnessRunOptions {
  root: string;
  goal: string;
  contextExtras?: string;
  executorBin?: string;
  runId?: string;
  timeoutMs?: number;
  hooks?: HookHandler[];
  baseRules?: BaseRuleSet;
  memory?: MemoryEntry[];
  providerProfile?: string;
  freshnessWindowMs?: number;
}

export interface ContextBundle {
  schema_version: 1;
  run_id: string;
  goal: string;
  context_extras?: string;
  included_goal_sha256: string;
  included_context_extras_sha256?: string;
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
  nativeHarnessAssisted: boolean;
  unownedSurfaces: string[];
  includedRuleIds?: string[];
  includedMemoryIds?: string[];
  excludedStaleMemoryIds?: string[];
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
    .filter((ref) => statSync(join(root, ref)).isFile())
    .map((ref) => ({ ref, sha256: sha256(readFileSync(join(root, ref))) }));
}

function buildContextBundle(options: {
  runDir: string;
  root: string;
  runId: string;
  goal: string;
  contextExtras?: string;
  provenance: ContextProvenanceBundle;
}): { bundle: ContextBundle; sha256: string } {
  const bundle: ContextBundle = {
    schema_version: 1,
    run_id: options.runId,
    goal: options.goal,
    context_extras: options.contextExtras,
    included_goal_sha256: sha256(options.goal),
    included_context_extras_sha256: options.contextExtras === undefined ? undefined : sha256(options.contextExtras),
    included_context_refs: options.provenance.context_files.map((item) => item.ref),
    included_provenance: options.provenance,
    native_harness_assisted: true,
    unowned_surfaces: UNOWNED_SURFACES,
  };
  const bundleSha256 = sha256(
    stableJson({
      schema_version: 1,
      goal: options.goal,
      context_extras: options.contextExtras,
      included_goal_sha256: bundle.included_goal_sha256,
      included_context_extras_sha256: bundle.included_context_extras_sha256,
    }),
  );
  writeFileSync(join(options.runDir, 'context-bundle.json'), `${JSON.stringify({ ...bundle, sha256: bundleSha256 }, null, 2)}\n`);
  return { bundle, sha256: bundleSha256 };
}

function canonicalContextText(bundle: CanonicalContextBundle): string {
  return bundle.sections.map((section) => `${section.kind.toUpperCase()} ${section.id}\n${section.text}`).join('\n\n');
}

function buildComposedContextBundle(options: {
  root: string;
  runDir: string;
  goal: string;
  baseRules?: BaseRuleSet;
  memory?: MemoryEntry[];
  providerProfile?: string;
  freshnessWindowMs?: number;
}): { bundle: CanonicalContextBundle; text: string; excludedStaleMemoryIds: string[] } {
  const providerProfile = options.providerProfile ?? 'codex-native';
  const sections: ContextSection[] = [
    {
      id: 'goal.primary',
      kind: 'goal',
      text: options.goal,
      sourceRef: 'harness-run:goal',
    },
  ];
  const compiledRules = options.baseRules ? compileBaseRules(options.baseRules, providerProfile) : undefined;
  if (compiledRules && compiledRules.promptSegment.length > 0) {
    sections.push({
      id: `rules.${options.baseRules?.id ?? 'base'}`,
      kind: 'rule',
      text: compiledRules.promptSegment,
      sourceRef: `base-rules:${options.baseRules?.id ?? 'base'}`,
    });
  }

  const memoryContext = buildMemoryContextSections(options.memory ?? [], {
    now: new Date().toISOString(),
    freshnessWindowMs: options.freshnessWindowMs ?? 7 * 24 * 60 * 60 * 1000,
  });
  for (const section of memoryContext.sections) {
    if (section.label === 'excluded') continue;
    sections.push({
      id: `memory.${section.id}`,
      kind: 'memory',
      text: section.text,
      sourceRef: `memory:${section.id}`,
    });
  }

  const bundle = buildCanonicalContextBundle({
    role: 'worker',
    providerProfile,
    sections,
    includedRuleIds: compiledRules?.includedRuleIds ?? [],
    includedMemoryIds: memoryContext.injectedFactIds,
    toolPolicyId: 'tool-policy.harness-run.default',
    acceptanceContractId: 'acceptance.harness-run.context-bundle',
  });
  const excludedStaleMemoryIds = memoryContext.sections
    .filter((section) => section.label === 'stale')
    .map((section) => section.id)
    .sort();

  writeFileSync(join(options.runDir, 'context-bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  return { bundle, text: canonicalContextText(bundle), excludedStaleMemoryIds };
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

function captureToolEvidence(options: {
  root: string;
  runDir: string;
  runId: string;
  executor: CodexExecResult;
  unownedSurfaces: string[];
}): ToolExecutionEvidence {
  const runDirRef = relative(options.root, options.runDir).replaceAll('\\', '/');
  const excludeRunDir = `:(exclude)${runDirRef}`;
  // Make untracked NEW files visible to `git diff`: a run that creates files (the
  // common case) otherwise produces an empty diff, so the critic sees no evidence of
  // real work. --intent-to-add stages new paths for diff without committing them.
  try {
    git(options.root, ['add', '--intent-to-add', '--', '.', excludeRunDir]);
  } catch {
    /* nothing to stage */
  }
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
    unowned_surfaces: options.unownedSurfaces,
  };
  writeJson(join(options.runDir, 'tool-execution-evidence.json'), evidence);
  return evidence;
}

function existingInstructionPaths(root: string, runDir: string): string[] {
  return [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md'), join(runDir, 'AGENTS.md'), join(runDir, 'CLAUDE.md')].filter((path) => existsSync(path));
}

function buildRunObservation(options: { root: string; runDir: string; executorBin?: string; executor: CodexExecResult }): RunObservation {
  return {
    adapter: 'codex_cli',
    readPaths: [
      options.executorBin ?? 'codex',
      options.executor.cwd,
      join(options.runDir, 'context.md'),
      join(options.runDir, 'executor.process.json'),
      ...existingInstructionPaths(options.root, options.runDir),
    ],
    transcript: [options.executor.stdout, options.executor.stderr, options.executor.last_message].filter((text) => text.length > 0).join('\n'),
    sessionIds: options.executor.session_id ? [options.executor.session_id] : [],
  };
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
  nativeHarnessAssisted: boolean;
  unownedSurfaces: string[];
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
      native_harness_assisted: options.nativeHarnessAssisted,
      unowned_surfaces: options.unownedSurfaces,
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
  includedRuleIds?: string[];
  includedMemoryIds?: string[];
  excludedStaleMemoryIds?: string[];
  nativeHarnessAssisted: boolean;
  unownedSurfaces: string[];
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
    nativeHarnessAssisted: options.nativeHarnessAssisted,
    unownedSurfaces: options.unownedSurfaces,
    includedRuleIds: options.includedRuleIds,
    includedMemoryIds: options.includedMemoryIds,
    excludedStaleMemoryIds: options.excludedStaleMemoryIds,
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
  const useComposedContext = options.baseRules !== undefined || options.memory !== undefined;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'task.md'), `${options.goal}\n`);

  appendRuntimeEvent(runDir, {
    runId,
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { goal: options.goal },
    artifactRefs: ['task.md'],
  });
  const composedContext = useComposedContext
    ? buildComposedContextBundle({
        root,
        runDir,
        goal: options.goal,
        baseRules: options.baseRules,
        memory: options.memory,
        providerProfile: options.providerProfile,
        freshnessWindowMs: options.freshnessWindowMs,
      })
    : undefined;
  writeFileSync(
    join(runDir, 'context.md'),
    composedContext?.text ??
      (options.contextExtras === undefined ? `Goal:\n${options.goal}\n` : `Goal:\n${options.goal}\n\nContext extras:\n${options.contextExtras}\n`),
  );
  const provenance = writeContextProvenanceBundle({ root, agentDir: '.agent', runId });
  const legacyContext =
    useComposedContext ? undefined : buildContextBundle({ runDir, root, runId, goal: options.goal, contextExtras: options.contextExtras, provenance });
  const contextSha256 = composedContext?.bundle.sha256 ?? legacyContext?.sha256;
  if (!contextSha256) throw new Error('context bundle was not built');
  const executorPrompt =
    composedContext?.text ??
    (options.contextExtras === undefined ? options.goal : `${options.goal}\n\nContext extras:\n${options.contextExtras}\n`);
  appendRuntimeEvent(runDir, {
    runId,
    source: 'harness',
    type: 'context.built',
    payload: {
      context_sha256: contextSha256,
      included_context_refs: legacyContext?.bundle.included_context_refs ?? [],
      provenance_ref: 'context-provenance.json',
      included_rule_ids: composedContext?.bundle.includedRuleIds,
      included_memory_ids: composedContext?.bundle.includedMemoryIds,
      excluded_stale_memory_ids: composedContext?.excludedStaleMemoryIds,
    },
    artifactRefs: ['context-bundle.json', 'context-provenance.json'],
  });

  const executor = await withExecutorBin(options.executorBin, () =>
    runCodexExec({
      runDir,
      cwd: root,
      prompt: executorPrompt,
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
  const observation = buildRunObservation({ root, runDir, executorBin: options.executorBin, executor });
  const nativeLabel = deriveNativeHarnessAssisted(observation);
  assertLabelMatchesObservation(nativeLabel.nativeHarnessAssisted, observation);

  const beforeTool = runHooks('BeforeToolExecution', hooks, {
    runId,
    runDir: relative(root, runDir).replaceAll('\\', '/'),
    root,
    goal: options.goal,
    contextSha256,
    executor: {
      exit_code: executor.exit_code,
      event_count: executor.event_count,
      session_id: executor.session_id,
      last_message_present: executor.last_message.length > 0,
    },
  });
  if (beforeTool.decision !== 'continue') {
    const verifier = hookBlockVerifier('BeforeToolExecution', beforeTool);
    const state = appendHookBlockedTransition({
      runDir,
      runId,
      event: 'BeforeToolExecution',
      outcome: beforeTool,
      nativeHarnessAssisted: nativeLabel.nativeHarnessAssisted,
      unownedSurfaces: nativeLabel.surfaces,
    });
    return finalizeReport({
      root,
      runDir,
      runId,
      state,
      contextSha256,
      verifier,
      nativeHarnessAssisted: nativeLabel.nativeHarnessAssisted,
      unownedSurfaces: nativeLabel.surfaces,
      includedRuleIds: composedContext?.bundle.includedRuleIds,
      includedMemoryIds: composedContext?.bundle.includedMemoryIds,
      excludedStaleMemoryIds: composedContext?.excludedStaleMemoryIds,
    });
  }

  const evidence = captureToolEvidence({ root, runDir, runId, executor, unownedSurfaces: nativeLabel.surfaces });
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
    contextSha256,
    verifier,
    proposedState: state,
    authority: 'verifier.completed',
  });
  if (beforeState.decision !== 'continue') {
    state = appendHookBlockedTransition({
      runDir,
      runId,
      event: 'BeforeStateTransition',
      outcome: beforeState,
      nativeHarnessAssisted: nativeLabel.nativeHarnessAssisted,
      unownedSurfaces: nativeLabel.surfaces,
    });
    return finalizeReport({
      root,
      runDir,
      runId,
      state,
      contextSha256,
      verifier,
      nativeHarnessAssisted: nativeLabel.nativeHarnessAssisted,
      unownedSurfaces: nativeLabel.surfaces,
      includedRuleIds: composedContext?.bundle.includedRuleIds,
      includedMemoryIds: composedContext?.bundle.includedMemoryIds,
      excludedStaleMemoryIds: composedContext?.excludedStaleMemoryIds,
    });
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
    payload: { state, native_harness_assisted: nativeLabel.nativeHarnessAssisted, unowned_surfaces: nativeLabel.surfaces },
  });

  return finalizeReport({
    root,
    runDir,
    runId,
    state,
    contextSha256,
    verifier,
    nativeHarnessAssisted: nativeLabel.nativeHarnessAssisted,
    unownedSurfaces: nativeLabel.surfaces,
    includedRuleIds: composedContext?.bundle.includedRuleIds,
    includedMemoryIds: composedContext?.bundle.includedMemoryIds,
    excludedStaleMemoryIds: composedContext?.excludedStaleMemoryIds,
  });
}

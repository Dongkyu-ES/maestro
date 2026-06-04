import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addTask, collectRun, createRun, runPath, startRun } from '../core.js';
import { createRuntimeLedgerHeadBinding, readRuntimeEvents, validateRuntimeLedger } from '../events/ledger.js';
import type { CodexSandboxMode } from '../runtime/codex-exec-runner.js';

export interface NativeArtifactHash {
  ref: string;
  sha256: string;
}

export interface NativeEvidenceArtifact {
  schema_version: 1;
  run_id: string;
  executor: 'codex';
  status: 'native-harness-assisted';
  generated_at: string;
  session_id?: string;
  unowned_surfaces: string[];
  raw_artifacts: NativeArtifactHash[];
  diff_ref: string;
  diff_sha256: string;
  effect_classification: {
    process_exit_zero: boolean;
    last_message_present: boolean;
    session_identifier_present: boolean;
    diff_present: boolean;
    changed_files: string[];
  };
}

export interface NativeEvidenceVerificationReport {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  decision: 'PASS' | 'FAIL';
  checks: Record<string, boolean>;
  ledger_head_sha256: string;
  ledger_event_count: number;
}

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function artifactHash(runDir: string, ref: string): NativeArtifactHash {
  return { ref, sha256: sha256Buffer(readFileSync(join(runDir, ref))) };
}

function safeReadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function changedFilesFromDiff(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.match(/^diff --git a\/(.*?) b\//)?.[1] || '')
    .filter(Boolean);
}

export function verifyNativeEvidenceRun(options: { root: string; agentDir?: string; runId: string }): NativeEvidenceVerificationReport {
  const agentDir = options.agentDir || '.agent';
  const runDir = join(options.root, agentDir, 'runs', options.runId);
  const artifact = safeReadJson(join(runDir, 'native-evidence.json')) as NativeEvidenceArtifact | undefined;
  const events = readRuntimeEvents(runDir);
  let ledgerValid = true;
  try {
    validateRuntimeLedger(events);
  } catch {
    ledgerValid = false;
  }
  const ledgerHead = ledgerValid
    ? createRuntimeLedgerHeadBinding(events)
    : { run_id: options.runId, event_count: 0, ledger_head_sha256: '' };
  const artifactHashesMatch = Boolean(
    artifact?.raw_artifacts?.length &&
      artifact.raw_artifacts.every((item) => existsSync(join(runDir, item.ref)) && artifactHash(runDir, item.ref).sha256 === item.sha256),
  );
  const diff = artifact?.diff_ref && existsSync(join(runDir, artifact.diff_ref)) ? readFileSync(join(runDir, artifact.diff_ref), 'utf8') : '';
  const processLog = safeReadJson(join(runDir, 'executor.process.json')) as { exit_code?: unknown; last_message?: unknown; session_id?: unknown } | undefined;
  const codexEventText = existsSync(join(runDir, 'codex-events.jsonl')) ? readFileSync(join(runDir, 'codex-events.jsonl'), 'utf8') : '';
  const checks = {
    ledger_valid: ledgerValid,
    native_label_visible: artifact?.status === 'native-harness-assisted' && Array.isArray(artifact.unowned_surfaces) && artifact.unowned_surfaces.length > 0,
    run_id_matches: artifact?.run_id === options.runId,
    raw_artifact_hashes_match: artifactHashesMatch,
    process_exit_zero: processLog?.exit_code === 0,
    session_identifier_present: typeof processLog?.session_id === 'string' && codexEventText.includes(processLog.session_id),
    stdout_stderr_captured: existsSync(join(runDir, 'executor.stdout.log')) && existsSync(join(runDir, 'executor.stderr.log')),
    diff_matches_effect: Boolean(
      artifact?.diff_sha256 === sha256Buffer(diff) &&
        diff.trim().startsWith('diff --git') &&
        artifact.effect_classification.diff_present &&
        artifact.effect_classification.changed_files.length > 0,
    ),
    ledger_refs_native_evidence: events.some(
      (event) => event.source === 'codex-adapter' && event.artifact_refs.includes('native-evidence.json') && event.artifact_refs.includes('native-diff.patch'),
    ),
  };
  const report: NativeEvidenceVerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    ledger_head_sha256: ledgerHead.ledger_head_sha256,
    ledger_event_count: ledgerHead.event_count,
  };
  writeFileSync(join(runDir, 'native-evidence-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function runNativeEvidenceSmoke(options: {
  root: string;
  task: string;
  sandbox?: CodexSandboxMode;
  timeoutMs?: number;
}): Promise<{ runId: string; status: string; decision?: string; verification: NativeEvidenceVerificationReport }> {
  const task = addTask(options.task, options.root);
  const run = createRun(task.id, { executor: 'codex', source: 'web' }, options.root);
  await startRun(run.id, { sandbox: options.sandbox, timeoutMs: options.timeoutMs }, options.root);
  const collected = collectRun(run.id, options.root);
  const verification = verifyNativeEvidenceRun({ root: options.root, runId: run.id });
  return { runId: run.id, status: collected.status, decision: collected.decision, verification };
}

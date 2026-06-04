import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendRuntimeEvent,
  assertEvidenceBoundToLedgerHead,
  createRuntimeLedgerHeadBinding,
  readRuntimeEvents,
  type RuntimeLedgerHeadBinding,
} from '../events/ledger.js';
import { FULL_TARGET_REQUIREMENTS, type FullTargetGateArtifact } from './full-target-gate.js';

export interface FullTargetVerificationReport {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  decision: 'PASS' | 'FAIL';
  artifact_sha256: string;
  ledger_head_sha256: string;
  ledger_event_count: number;
  checks: Record<string, boolean>;
}

export function verifyFullTargetGateArtifact(options: {
  agentDir: string;
  runId: string;
  appendVerifiedEvent?: boolean;
}): FullTargetVerificationReport {
  const runDir = join(options.agentDir, 'runs', options.runId);
  const artifactRef = 'full-target-gate.json';
  const artifactPath = join(runDir, artifactRef);
  const raw = readFileSync(artifactPath);
  const artifact = JSON.parse(raw.toString('utf8')) as FullTargetGateArtifact;
  const artifactSha = createHash('sha256').update(raw).digest('hex');
  const events = readRuntimeEvents(runDir);
  const names = artifact.requirements.map((item) => item.name);
  const artifactBinding = {
    run_id: artifact.run_id,
    event_count: Number(artifact.ledger_event_count),
    ledger_head_sha256: String(artifact.ledger_head_sha256 || ''),
  } satisfies RuntimeLedgerHeadBinding;
  let ledgerHeadBound = true;
  try {
    assertEvidenceBoundToLedgerHead(artifactBinding, events);
  } catch {
    try {
      const prefix = events.slice(0, artifactBinding.event_count);
      assertEvidenceBoundToLedgerHead(artifactBinding, prefix);
      const laterEvents = events.slice(artifactBinding.event_count);
      ledgerHeadBound =
        laterEvents.length === 1 &&
        laterEvents.every(
          (event) =>
            event.source === 'harness' &&
            event.type === 'gate.full_target.passed' &&
            event.artifact_refs.includes(artifactRef) &&
            event.payload.artifact_sha256 === artifactSha,
        );
    } catch {
      ledgerHeadBound = false;
    }
  }
  const verifierLedgerHead = createRuntimeLedgerHeadBinding(events);
  const checks = {
    run_id_matches: artifact.run_id === options.runId,
    decision_pass: artifact.decision === 'PASS',
    requirement_names_match: names.join('\n') === FULL_TARGET_REQUIREMENTS.join('\n'),
    all_requirements_pass: artifact.requirements.every((item) => item.status === 'PASS'),
    source_events_present: Array.isArray(artifact.source_event_ids) && artifact.source_event_ids.length > 0,
    projection_completed: artifact.projection_status === 'completed',
    ledger_head_bound: ledgerHeadBound,
  };
  const report: FullTargetVerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    artifact_sha256: artifactSha,
    ledger_head_sha256: verifierLedgerHead.ledger_head_sha256,
    ledger_event_count: verifierLedgerHead.event_count,
    checks,
  };
  writeFileSync(join(runDir, 'full-target-verification.json'), JSON.stringify(report, null, 2));
  if (report.decision === 'PASS' && options.appendVerifiedEvent) {
    appendRuntimeEvent(runDir, {
      runId: options.runId,
      source: 'harness',
      type: 'gate.full_target.verified',
      payload: {
        artifact_sha256: artifactSha,
        ledger_head_sha256: report.ledger_head_sha256,
        ledger_event_count: report.ledger_event_count,
        runtime_label: 'full_target_verifier',
      },
      artifactRefs: [artifactRef, 'full-target-verification.json'],
    });
  }
  return report;
}

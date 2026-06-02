import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRuntimeEvent } from '../events/ledger.js';
import { FULL_TARGET_REQUIREMENTS, type FullTargetGateArtifact } from './full-target-gate.js';

export interface FullTargetVerificationReport {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  decision: 'PASS' | 'FAIL';
  artifact_sha256: string;
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
  const names = artifact.requirements.map((item) => item.name);
  const checks = {
    run_id_matches: artifact.run_id === options.runId,
    decision_pass: artifact.decision === 'PASS',
    requirement_names_match: names.join('\n') === FULL_TARGET_REQUIREMENTS.join('\n'),
    all_requirements_pass: artifact.requirements.every((item) => item.status === 'PASS'),
    source_events_present: Array.isArray(artifact.source_event_ids) && artifact.source_event_ids.length > 0,
    projection_completed: artifact.projection_status === 'completed',
  };
  const report: FullTargetVerificationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    artifact_sha256: artifactSha,
    checks,
  };
  writeFileSync(join(runDir, 'full-target-verification.json'), JSON.stringify(report, null, 2));
  if (report.decision === 'PASS' && options.appendVerifiedEvent) {
    appendRuntimeEvent(runDir, {
      runId: options.runId,
      source: 'harness',
      type: 'gate.full_target.verified',
      payload: { artifact_sha256: artifactSha, runtime_label: 'full_target_verifier' },
      artifactRefs: [artifactRef, 'full-target-verification.json'],
    });
  }
  return report;
}

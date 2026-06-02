import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRun } from '../view.js';

export interface UiAgreementSmokeReport {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  status: 'PASS' | 'FAIL';
  checks: Record<string, boolean>;
}

export function writeUiAgreementSmoke(options: {
  root: string;
  agentDir: string;
  runId: string;
}): UiAgreementSmokeReport {
  const html = renderRun(options.runId, options.root);
  const checks = {
    run_id_visible: html.includes(options.runId),
    event_stream_link_visible: html.includes(`/api/runs/${options.runId}/events`),
    events_ledger_visible: html.includes('events.jsonl'),
    lifecycle_supported_visible: html.includes('runtime.lifecycle.supported'),
    full_target_gate_visible: html.includes('full-target-gate.json'),
  };
  const report: UiAgreementSmokeReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
  };
  writeFileSync(join(options.agentDir, 'runs', options.runId, 'ui-render-smoke.json'), JSON.stringify(report, null, 2));
  return report;
}

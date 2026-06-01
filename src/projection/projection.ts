import { RuntimeEventEnvelope, validateRuntimeLedger } from '../events/ledger.js';

export interface RuntimeSessionProjection { session_id: string; adapter_kind?: string; status: string; last_event_sequence: number; evidence: string[]; }
export interface RuntimeRunProjection { run_id: string; status: string; event_count: number; sessions: RuntimeSessionProjection[]; approvals: { approval_id: string; status: string; sequence: number }[]; artifacts: string[]; labels: string[]; }
export interface RuntimeProjection { schema_version: 1; rebuilt_at: string; runs: RuntimeRunProjection[]; }

export function rebuildRuntimeProjection(events: RuntimeEventEnvelope[]): RuntimeProjection {
  const eventsByRun = new Map<string, RuntimeEventEnvelope[]>();
  for (const event of events) eventsByRun.set(event.run_id, [...(eventsByRun.get(event.run_id) || []), event]);
  for (const runEvents of eventsByRun.values()) validateRuntimeLedger(runEvents);
  const runs = new Map<string, RuntimeRunProjection>();
  for (const event of events) {
    const run = runs.get(event.run_id) || { run_id: event.run_id, status: 'observed', event_count: 0, sessions: [], approvals: [], artifacts: [], labels: [] };
    run.event_count += 1;
    run.artifacts = [...new Set([...run.artifacts, ...event.artifact_refs])].sort();
    const label = typeof event.payload.runtime_label === 'string' ? event.payload.runtime_label : typeof event.payload.adapter_kind === 'string' ? event.payload.adapter_kind : undefined;
    if (label) run.labels = [...new Set([...run.labels, label])].sort();
    if (event.type === 'runtime.session.started') {
      const sessionId = event.session_id || String(event.payload.session_id || event.run_id);
      const existing = run.sessions.find((s) => s.session_id === sessionId);
      const session = existing || { session_id: sessionId, status: 'started', last_event_sequence: event.sequence, evidence: [] };
      session.adapter_kind = String(event.payload.adapter_kind || session.adapter_kind || event.source.replace('-adapter', ''));
      session.status = 'started';
      session.last_event_sequence = event.sequence;
      session.evidence = [...new Set([...session.evidence, ...event.artifact_refs])].sort();
      if (!existing) run.sessions.push(session);
      run.status = 'running_or_started';
    } else if (event.type === 'runtime.launch.requested') {
      run.status = run.status === 'observed' ? 'launch_requested' : run.status;
    }
    if (event.type === 'approval.requested') run.approvals.push({ approval_id: String(event.payload.approval_id || event.event_id), status: 'requested', sequence: event.sequence });
    if (event.type === 'approval.decided') {
      const approvalId = String(event.payload.approval_id || 'unknown');
      const prior = run.approvals.find((a) => a.approval_id === approvalId);
      if (prior) { prior.status = String(event.payload.decision || 'decided'); prior.sequence = event.sequence; }
      else run.approvals.push({ approval_id: approvalId, status: String(event.payload.decision || 'decided'), sequence: event.sequence });
    }
    if (event.type === 'run.completed') run.status = 'completed';
    if (event.type === 'run.failed') run.status = 'failed';
    runs.set(event.run_id, run);
  }
  return { schema_version: 1, rebuilt_at: new Date().toISOString(), runs: [...runs.values()].sort((a, b) => a.run_id.localeCompare(b.run_id)) };
}

export function findProjectedRun(projection: RuntimeProjection, runId: string): RuntimeRunProjection | undefined {
  return projection.runs.find((run) => run.run_id === runId);
}

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRuntimeEvent, readRuntimeEvents, validateRuntimeLedger, type RuntimeEventEnvelope } from '../events/ledger.js';
import { rebuildRuntimeProjection, findProjectedRun } from '../projection/projection.js';
import { readMemoryFabric } from '../memory/fabric.js';
import { runRuntimeHardGate } from './runtime-gate.js';
import { ShellPrimitiveAdapter } from '../runtime/shell-adapter.js';
import { CodexCliAdapter } from '../runtime/codex-adapter.js';

export interface FullTargetRequirement { name: string; status: 'PASS' | 'FAIL'; evidence: string; }
export interface FullTargetGateArtifact {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  decision: 'PASS' | 'FAIL';
  requirements: FullTargetRequirement[];
  source_event_ids: string[];
  projection_status?: string;
}

export const FULL_TARGET_REQUIREMENTS = [
  'web goal input',
  'sandbox context',
  'composition',
  'codex launch attach stream',
  'approval top lane',
  'interrupt',
  'resume',
  'fork',
  'parallel blackboard',
  'sequential handoff',
  'hard gate',
  'learning memory',
  'review boundary',
  'commit approval boundary',
  'push deploy approval boundary',
  'ledger projection UI render agreement',
] as const;

function hasArtifact(runDir: string, rel: string): boolean {
  return Boolean(rel && !rel.startsWith('/') && !rel.includes('..') && existsSync(join(runDir, rel)));
}

function req(name: string, ok: boolean, evidence: string): FullTargetRequirement {
  return { name, status: ok ? 'PASS' : 'FAIL', evidence };
}

function eventWith(events: RuntimeEventEnvelope[], type: string, predicate: (event: RuntimeEventEnvelope) => boolean = () => true): RuntimeEventEnvelope | undefined {
  return events.find((event) => event.type === type && predicate(event));
}

function approvedApprovalArtifact(runDir: string, event: RuntimeEventEnvelope): boolean {
  const approvalId = String(event.payload.approval_id || '');
  if (!approvalId || event.payload.decision !== 'approved') return false;
  return event.artifact_refs.some((ref) => {
    if (!hasArtifact(runDir, ref)) return false;
    try {
      const artifact = JSON.parse(readFileSync(join(runDir, ref), 'utf8')) as { id?: unknown; run_id?: unknown; status?: unknown };
      return artifact.id === approvalId && artifact.run_id === event.run_id && artifact.status === 'approved';
    } catch {
      return false;
    }
  });
}

function approvedBoundary(events: RuntimeEventEnvelope[], runDir: string, action: string): { approvalId: string; requestSequence: number; decisionSequence: number } | undefined {
  for (const requested of events) {
    if (requested.type !== 'approval.requested' || requested.payload.action !== action || !requested.artifact_refs.every((ref) => hasArtifact(runDir, ref))) continue;
    const approvalId = String(requested.payload.approval_id || '');
    const decided = events.find((event) => event.sequence > requested.sequence && event.type === 'approval.decided' && event.payload.approval_id === approvalId && approvedApprovalArtifact(runDir, event));
    if (decided) return { approvalId, requestSequence: requested.sequence, decisionSequence: decided.sequence };
  }
  return undefined;
}

function approvedRuntimeAction(events: RuntimeEventEnvelope[], runDir: string, boundary: { approvalId: string; decisionSequence: number } | undefined, action: string): boolean {
  if (!boundary) return false;
  return Boolean(events.find((event) =>
    event.sequence > boundary.decisionSequence &&
    event.type === 'runtime.action.approved' &&
    event.payload.approval_id === boundary.approvalId &&
    event.payload.action === action &&
    event.artifact_refs.every((ref) => hasArtifact(runDir, ref))
  ));
}

function uiSmokePasses(runDir: string, runId: string): boolean {
  if (!hasArtifact(runDir, 'ui-render-smoke.json')) return false;
  try {
    const artifact = JSON.parse(readFileSync(join(runDir, 'ui-render-smoke.json'), 'utf8')) as { status?: unknown; run_id?: unknown; checks?: Record<string, unknown> };
    return artifact.status === 'PASS' && artifact.run_id === runId && Object.values(artifact.checks || {}).every(Boolean);
  } catch {
    return false;
  }
}

export function writeFullTargetGateArtifact(options: { root: string; agentDir: string; runId: string; appendPassEvent?: boolean }): FullTargetGateArtifact {
  const runDir = join(options.agentDir, 'runs', options.runId);
  const events = readRuntimeEvents(runDir);
  let ledgerValid = true;
  try { validateRuntimeLedger(events); } catch { ledgerValid = false; }
  const projection = ledgerValid ? rebuildRuntimeProjection(events) : { schema_version: 1 as const, rebuilt_at: new Date().toISOString(), runs: [] };
  const projected = findProjectedRun(projection, options.runId);
  const codexSession = eventWith(events, 'runtime.session.started', (event) => event.source === 'codex-adapter' && event.payload.evidence_status === 'supported' && event.artifact_refs.every((ref) => hasArtifact(runDir, ref)));
  const hardGate = runRuntimeHardGate({ events, capabilities: [new ShellPrimitiveAdapter().capabilities(), new CodexCliAdapter(options.root).capabilities()], milestoneClaim: 'capability slice', artifactRoot: runDir });
  const memory = readMemoryFabric(options.agentDir).facts;
  const shellMutationApproval = approvedBoundary(events, runDir, 'shell_mutation');
  const requirements: FullTargetRequirement[] = [
    req('web goal input', Boolean(eventWith(events, 'goal.received', (event) => event.source === 'web')), 'goal.received must originate from the web control surface'),
    req('sandbox context', hasArtifact(runDir, 'context.md') && hasArtifact(runDir, 'prompt.md'), 'context.md and prompt.md exist in the run sandbox'),
    req('composition', Boolean(eventWith(events, 'composition.resolved', (event) => event.artifact_refs.includes('composition.json'))) && hasArtifact(runDir, 'composition.json'), 'composition.resolved references composition.json'),
    req('codex launch attach stream', Boolean(codexSession), 'supported Codex runtime.session.started with durable transcript-backed artifact'),
    req('approval top lane', approvedRuntimeAction(events, runDir, shellMutationApproval, 'shell_mutation'), 'approval.requested, approved approval.decided, and runtime.action.approved are ordered and bound to the same persisted approval artifact'),
    req('interrupt', Boolean(eventWith(events, 'runtime.lifecycle.supported', (event) => event.payload.verb === 'interrupt' && event.payload.evidence_status === 'supported')), 'operation-specific interrupt proof must be supported'),
    req('resume', Boolean(eventWith(events, 'runtime.lifecycle.supported', (event) => event.payload.verb === 'resume' && event.payload.evidence_status === 'supported')), 'operation-specific resume proof must be supported'),
    req('fork', Boolean(eventWith(events, 'runtime.lifecycle.supported', (event) => event.payload.verb === 'fork' && event.payload.evidence_status === 'supported')), 'operation-specific fork proof must be supported'),
    req('parallel blackboard', memory.some((fact) => fact.layer === 'blackboard' && fact.run_id === options.runId && (fact.source_event_ids.length || fact.artifact_refs.length)), 'blackboard memory fact with provenance for this run'),
    req('sequential handoff', memory.some((fact) => fact.layer === 'sequential_handoff' && fact.run_id === options.runId && (fact.source_event_ids.length || fact.artifact_refs.length)), 'sequential handoff memory fact with provenance for this run'),
    req('hard gate', ledgerValid && hardGate.decision === 'PASS', 'runtime hard gate passes for this run as a capability slice before final full-target claim'),
    req('learning memory', memory.some((fact) => fact.layer === 'module_learning' && fact.run_id === options.runId && (fact.source_event_ids.length || fact.artifact_refs.length)), 'module learning memory fact with outcome/provenance for this run'),
    req('review boundary', projected?.status === 'completed' && hasArtifact(runDir, 'review.md'), 'run projection is completed and review.md exists'),
    req('commit approval boundary', Boolean(approvedBoundary(events, runDir, 'commit')), 'commit approval request and approved decision are represented with persisted approval artifact'),
    req('push deploy approval boundary', Boolean(approvedBoundary(events, runDir, 'push_deploy')), 'push/deploy approval request and approved decision are represented with persisted approval artifact'),
    req('ledger projection UI render agreement', ledgerValid && Boolean(projected) && hasArtifact(runDir, 'events.jsonl') && uiSmokePasses(runDir, options.runId), 'ledger validates, projection contains this run, and server-rendered UI smoke confirms the same run/events are visible'),
  ];
  if (requirements.map((item) => item.name).join('\n') !== FULL_TARGET_REQUIREMENTS.join('\n')) throw new Error('full target requirement drift');
  const artifact: FullTargetGateArtifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    decision: requirements.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    requirements,
    source_event_ids: events.map((event) => event.event_id),
    projection_status: projected?.status,
  };
  writeFileSync(join(runDir, 'full-target-gate.json'), JSON.stringify(artifact, null, 2));
  const artifactSha = createHash('sha256').update(readFileSync(join(runDir, 'full-target-gate.json'))).digest('hex');
  if (artifact.decision === 'PASS' && options.appendPassEvent) {
    appendRuntimeEvent(runDir, { runId: options.runId, source: 'harness', type: 'gate.full_target.passed', payload: { artifact_sha256: artifactSha, runtime_label: 'full_target_gate' }, artifactRefs: ['full-target-gate.json'] });
  }
  return artifact;
}

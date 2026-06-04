import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeLedgerHeadBinding, readRuntimeEvents, type RuntimeLedgerHeadBinding, validateRuntimeLedger } from '../events/ledger.js';
import { readMemoryFabric } from '../memory/fabric.js';
import { findProjectedRun, rebuildRuntimeProjection } from '../projection/projection.js';

export interface ContextMemoryRef {
  id: string;
  layer: string;
  source_event_ids: string[];
  artifact_refs: string[];
}
export interface ContextProvenanceBundle {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  context_files: { ref: string; sha256: string }[];
  memory_refs: ContextMemoryRef[];
  ledger_head: RuntimeLedgerHeadBinding;
  projection: { status: string; event_count: number };
}
export interface ContextProvenanceReport {
  schema_version: 1;
  generated_at: string;
  run_id: string;
  decision: 'PASS' | 'FAIL';
  checks: Record<string, boolean>;
  ledger_head_sha256: string;
  ledger_event_count: number;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function fileHash(root: string, ref: string): string {
  return sha256(readFileSync(join(root, ref)));
}

function runDir(root: string, agentDir: string, runId: string): string {
  return join(root, agentDir, 'runs', runId);
}

function existingContextRefs(root: string, agentDir: string, runId: string): string[] {
  const dir = runDir(root, agentDir, runId);
  return ['task.md', 'context.md', 'prompt.md', 'composition.json']
    .map((ref) => `${agentDir}/runs/${runId}/${ref}`)
    .filter((ref) => existsSync(join(root, ref)));
}

export function writeContextProvenanceBundle(options: { root: string; agentDir?: string; runId: string }): ContextProvenanceBundle {
  const agentDir = options.agentDir || '.agent';
  const dir = runDir(options.root, agentDir, options.runId);
  const events = readRuntimeEvents(dir);
  validateRuntimeLedger(events);
  const projection = rebuildRuntimeProjection(events);
  const projected = findProjectedRun(projection, options.runId);
  const memoryRefs = readMemoryFabric(join(options.root, agentDir)).facts
    .filter((fact) => fact.run_id === options.runId)
    .map((fact) => ({
      id: fact.id,
      layer: fact.layer,
      source_event_ids: fact.source_event_ids,
      artifact_refs: fact.artifact_refs,
    }));
  const contextFiles = existingContextRefs(options.root, agentDir, options.runId).map((ref) => ({ ref, sha256: fileHash(options.root, ref) }));
  const bundle: ContextProvenanceBundle = {
    schema_version: 1,
    run_id: options.runId,
    generated_at: new Date().toISOString(),
    context_files: contextFiles,
    memory_refs: memoryRefs,
    ledger_head: createRuntimeLedgerHeadBinding(events),
    projection: { status: projected?.status || 'missing', event_count: projected?.event_count || 0 },
  };
  writeFileSync(join(dir, 'context-provenance.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

export function verifyContextProvenance(options: {
  root: string;
  agentDir?: string;
  runId: string;
  writeIfMissing?: boolean;
}): ContextProvenanceReport {
  const agentDir = options.agentDir || '.agent';
  const dir = runDir(options.root, agentDir, options.runId);
  const bundlePath = join(dir, 'context-provenance.json');
  const bundle = options.writeIfMissing || !existsSync(bundlePath)
    ? writeContextProvenanceBundle({ root: options.root, agentDir, runId: options.runId })
    : (JSON.parse(readFileSync(bundlePath, 'utf8')) as ContextProvenanceBundle);
  const events = readRuntimeEvents(dir);
  let ledgerValid = true;
  try {
    validateRuntimeLedger(events);
  } catch {
    ledgerValid = false;
  }
  const currentHead = ledgerValid
    ? createRuntimeLedgerHeadBinding(events)
    : { run_id: options.runId, event_count: 0, ledger_head_sha256: '' };
  const eventIds = new Set(events.map((event) => event.event_id));
  const fabric = readMemoryFabric(join(options.root, agentDir));
  const factsById = new Map(fabric.facts.map((fact) => [fact.id, fact]));
  const projection = ledgerValid ? rebuildRuntimeProjection(events) : { schema_version: 1 as const, rebuilt_at: new Date().toISOString(), runs: [] };
  const projected = findProjectedRun(projection, options.runId);
  const checks = {
    ledger_valid: ledgerValid,
    bundle_bound_to_current_head:
      bundle.ledger_head.run_id === currentHead.run_id &&
      bundle.ledger_head.event_count === currentHead.event_count &&
      bundle.ledger_head.ledger_head_sha256 === currentHead.ledger_head_sha256,
    context_files_recompute: bundle.context_files.length > 0 && bundle.context_files.every((item) => existsSync(join(options.root, item.ref)) && fileHash(options.root, item.ref) === item.sha256),
    memory_refs_exist: bundle.memory_refs.every((ref) => Boolean(factsById.get(ref.id))),
    memory_source_events_current: bundle.memory_refs.every((ref) => ref.source_event_ids.length > 0 && ref.source_event_ids.every((id) => eventIds.has(id))),
    projection_matches_ledger: Boolean(projected && projected.event_count === events.length && projected.status === bundle.projection.status),
  };
  const report: ContextProvenanceReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    run_id: options.runId,
    decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    ledger_head_sha256: currentHead.ledger_head_sha256,
    ledger_event_count: currentHead.event_count,
  };
  writeFileSync(join(dir, 'context-provenance-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

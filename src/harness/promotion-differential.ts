import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRuntimeLedgerHeadBinding,
  envelopeHash,
  GENESIS_EVENT_HASH,
  type RuntimeEventEnvelope,
  payloadHash,
  validateRuntimeLedger,
} from '../events/ledger.js';

export interface PromotionDifferentialReport {
  schema_version: 1;
  generated_at: string;
  decision: 'PASS' | 'FAIL';
  checks: Record<string, boolean>;
  source_promotion_id?: string;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function readJson(root: string, rel: unknown): any {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..')) return undefined;
  const full = join(root, rel);
  if (!existsSync(full)) return undefined;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return undefined;
  }
}

function digestMatches(root: string, rel: unknown, expected: unknown): boolean {
  if (typeof rel !== 'string' || typeof expected !== 'string' || rel.startsWith('/') || rel.includes('..')) return false;
  const full = join(root, rel);
  return existsSync(full) && sha256(readFileSync(full)) === expected;
}


function normalizeLegacyRuntimeEventsForPromotion(events: RuntimeEventEnvelope[]): { events: RuntimeEventEnvelope[]; migrated: number } {
  const normalized: RuntimeEventEnvelope[] = [];
  let migrated = 0;
  for (const event of events as Array<RuntimeEventEnvelope & { prev_event_sha256?: string }>) {
    const previous = normalized.at(-1);
    if (typeof event.prev_event_sha256 === 'string') {
      normalized.push(event as RuntimeEventEnvelope);
      continue;
    }
    if (
      event.schema_version !== 1 ||
      !event.event_id ||
      !event.run_id ||
      !event.correlation_id ||
      !event.timestamp ||
      !event.source ||
      !event.type
    )
      throw new Error('legacy runtime event is missing non-migratable envelope fields');
    if (!Number.isInteger(event.sequence) || event.sequence !== (previous ? previous.sequence + 1 : 1))
      throw new Error('legacy runtime event has invalid sequence');
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
      throw new Error('legacy runtime event has invalid payload');
    if (!Array.isArray(event.artifact_refs)) throw new Error('legacy runtime event has invalid artifact_refs');
    if (event.payload_sha256 !== payloadHash(event.payload)) throw new Error('legacy runtime event payload hash mismatch');
    normalized.push({
      ...event,
      prev_event_sha256: previous ? envelopeHash(previous) : GENESIS_EVENT_HASH,
    } as RuntimeEventEnvelope);
    migrated++;
  }
  return { events: normalized, migrated };
}

function readCanonicalPromotionLoadedEvent(
  root: string,
  rel: unknown,
  gate: Record<string, any> | undefined,
  after: Record<string, any> | undefined,
  changedField: string,
): boolean {
  if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..')) return false;
  const full = join(root, rel);
  if (!existsSync(full)) return false;
  try {
    const rawEventText = readFileSync(full, 'utf8');
    const normalized = normalizeLegacyRuntimeEventsForPromotion(
      rawEventText
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line)) as RuntimeEventEnvelope[],
    );
    const events = normalized.events;
    validateRuntimeLedger(events);
    const binding = createRuntimeLedgerHeadBinding(events);
    if (
      normalized.migrated > 0 &&
      (after?.runtime_ledger_compatibility !== 'projection_legacy_prev_hash_backfill' ||
        after?.runtime_ledger_migrated_events !== normalized.migrated)
    )
      return false;
    if (normalized.migrated === 0 && after?.runtime_ledger_compatibility === 'projection_legacy_prev_hash_backfill')
      return false;
    if (
      typeof after?.runtime_events_sha256 !== 'string' ||
      sha256(rawEventText) !== after.runtime_events_sha256 ||
      typeof after?.promotion_loaded_event_sequence !== 'number' ||
      typeof after?.promotion_loaded_event_sha256 !== 'string' ||
      after?.runtime_event_count !== binding.event_count ||
      after?.runtime_ledger_head_sha256 !== binding.ledger_head_sha256 ||
      (after?.run_id && after.run_id !== binding.run_id)
    )
      return false;
    return events.some((event) => {
      const payload = event.payload as Record<string, unknown>;
      return (
        event.type === 'promotion.loaded' &&
        event.sequence === after.promotion_loaded_event_sequence &&
        envelopeHash(event) === after.promotion_loaded_event_sha256 &&
        payload.loaded_promotion_artifact_sha256 === gate?.loaded_promotion_artifact_sha256 &&
        payload.changed_field === changedField &&
        (!gate?.source_promotion_id || payload.promotion_id === gate.source_promotion_id)
      );
    });
  } catch {
    return false;
  }
}


export function verifyPromotionDifferential(options: { root: string; agentDir?: string }): PromotionDifferentialReport {
  const agentDir = options.agentDir || '.agent';
  const gateRel = `${agentDir}/hard-gates/promotion-learning.json`;
  const gate = readJson(options.root, gateRel) as Record<string, any> | undefined;
  const before = readJson(options.root, gate?.before_run_path);
  const after = readJson(options.root, gate?.after_run_path);
  const effect = readJson(options.root, gate?.promotion_effect_path);
  const apply = readJson(options.root, gate?.promotion_apply_path);
  const approval = readJson(options.root, gate?.promotion_approval_path);
  const candidate = readJson(options.root, gate?.promotion_candidate_path);
  const finding = readJson(options.root, gate?.review_finding_path);
  const loadedPath = typeof gate?.loaded_promotion_artifact_path === 'string' ? gate.loaded_promotion_artifact_path : '';
  const eventPath = typeof after?.runtime_events_path === 'string' ? after.runtime_events_path : '';
  const changedField = String(gate?.changed_field || '');
  const beforeValue = changedField ? before?.stable_fields?.[changedField] : undefined;
  const afterValue = changedField ? after?.stable_fields?.[changedField] : undefined;
  const checks = {
    gate_declares_pass: gate?.status === 'PASS',
    all_hashes_match:
      digestMatches(options.root, gate?.review_finding_path, gate?.review_finding_sha256) &&
      digestMatches(options.root, gate?.promotion_candidate_path, gate?.promotion_candidate_sha256) &&
      digestMatches(options.root, gate?.promotion_approval_path, gate?.promotion_approval_sha256) &&
      digestMatches(options.root, gate?.promotion_apply_path, gate?.promotion_apply_sha256) &&
      digestMatches(options.root, gate?.promotion_effect_path, gate?.promotion_effect_sha256) &&
      digestMatches(options.root, gate?.before_run_path, gate?.before_run_sha256) &&
      digestMatches(options.root, gate?.after_run_path, gate?.after_run_sha256) &&
      digestMatches(options.root, loadedPath, gate?.loaded_promotion_artifact_sha256),
    chain_links:
      Boolean(
        finding &&
          candidate?.review_finding_sha256 === gate?.review_finding_sha256 &&
          approval?.promotion_candidate_sha256 === gate?.promotion_candidate_sha256 &&
          apply?.promotion_approval_sha256 === gate?.promotion_approval_sha256 &&
          effect?.promotion_apply_sha256 === gate?.promotion_apply_sha256,
      ),
    deterministic_before_after:
      Boolean(
        before &&
          after &&
          before.task_context_sha256 === after.task_context_sha256 &&
          changedField &&
          beforeValue !== undefined &&
          afterValue !== undefined &&
          beforeValue !== afterValue &&
          effect?.changed_field === changedField &&
          effect?.before === beforeValue &&
          effect?.after === afterValue &&
          effect?.before_run_sha256 === gate?.before_run_sha256 &&
          effect?.after_run_sha256 === gate?.after_run_sha256,
      ),
    loaded_artifact_proves_after:
      Boolean(
        after?.loaded_promotion_artifact_sha256 === gate?.loaded_promotion_artifact_sha256 &&
          readCanonicalPromotionLoadedEvent(options.root, eventPath, gate, after, changedField),
      ),
  };
  const report: PromotionDifferentialReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    source_promotion_id: typeof gate?.source_promotion_id === 'string' ? gate.source_promotion_id : undefined,
  };
  mkdirSync(join(options.root, agentDir, 'hard-gates'), { recursive: true });
  writeFileSync(join(options.root, agentDir, 'hard-gates', 'promotion-differential-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeLedgerHeadBinding, envelopeHash, type RuntimeEventEnvelope, validateRuntimeLedger } from '../events/ledger.js';

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
    const events = readFileSync(full, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)) as RuntimeEventEnvelope[];
    validateRuntimeLedger(events);
    const binding = createRuntimeLedgerHeadBinding(events);
    if (
      typeof after?.runtime_events_sha256 !== 'string' ||
      sha256(readFileSync(full, 'utf8')) !== after.runtime_events_sha256 ||
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

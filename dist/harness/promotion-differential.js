import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeLedgerHeadBinding, envelopeHash, GENESIS_EVENT_HASH, payloadHash, validateRuntimeLedger, } from '../events/ledger.js';
function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
function readJson(root, rel) {
    if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..'))
        return undefined;
    const full = join(root, rel);
    if (!existsSync(full))
        return undefined;
    try {
        return JSON.parse(readFileSync(full, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function digestMatches(root, rel, expected) {
    if (typeof rel !== 'string' || typeof expected !== 'string' || rel.startsWith('/') || rel.includes('..'))
        return false;
    const full = join(root, rel);
    return existsSync(full) && sha256(readFileSync(full)) === expected;
}
function normalizeLegacyRuntimeEventsForPromotion(events) {
    const normalized = [];
    let migrated = 0;
    for (const event of events) {
        const previous = normalized.at(-1);
        if (typeof event.prev_event_sha256 === 'string') {
            normalized.push(event);
            continue;
        }
        if (event.schema_version !== 1 ||
            !event.event_id ||
            !event.run_id ||
            !event.correlation_id ||
            !event.timestamp ||
            !event.source ||
            !event.type)
            throw new Error('legacy runtime event is missing non-migratable envelope fields');
        if (!Number.isInteger(event.sequence) || event.sequence !== (previous ? previous.sequence + 1 : 1))
            throw new Error('legacy runtime event has invalid sequence');
        if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
            throw new Error('legacy runtime event has invalid payload');
        if (!Array.isArray(event.artifact_refs))
            throw new Error('legacy runtime event has invalid artifact_refs');
        if (event.payload_sha256 !== payloadHash(event.payload))
            throw new Error('legacy runtime event payload hash mismatch');
        normalized.push({
            ...event,
            prev_event_sha256: previous ? envelopeHash(previous) : GENESIS_EVENT_HASH,
        });
        migrated++;
    }
    return { events: normalized, migrated };
}
function readCanonicalPromotionLoadedEvent(root, rel, gate, after, changedField) {
    if (typeof rel !== 'string' || rel.startsWith('/') || rel.includes('..'))
        return false;
    const full = join(root, rel);
    if (!existsSync(full))
        return false;
    try {
        const rawEventText = readFileSync(full, 'utf8');
        const normalized = normalizeLegacyRuntimeEventsForPromotion(rawEventText
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line)));
        const events = normalized.events;
        validateRuntimeLedger(events);
        const binding = createRuntimeLedgerHeadBinding(events);
        if (normalized.migrated > 0 &&
            (after?.runtime_ledger_compatibility !== 'projection_legacy_prev_hash_backfill' ||
                after?.runtime_ledger_migrated_events !== normalized.migrated))
            return false;
        if (normalized.migrated === 0 && after?.runtime_ledger_compatibility === 'projection_legacy_prev_hash_backfill')
            return false;
        if (typeof after?.runtime_events_sha256 !== 'string' ||
            sha256(rawEventText) !== after.runtime_events_sha256 ||
            typeof after?.promotion_loaded_event_sequence !== 'number' ||
            typeof after?.promotion_loaded_event_sha256 !== 'string' ||
            after?.runtime_event_count !== binding.event_count ||
            after?.runtime_ledger_head_sha256 !== binding.ledger_head_sha256 ||
            (after?.run_id && after.run_id !== binding.run_id))
            return false;
        return events.some((event) => {
            const payload = event.payload;
            return (event.type === 'promotion.loaded' &&
                event.sequence === after.promotion_loaded_event_sequence &&
                envelopeHash(event) === after.promotion_loaded_event_sha256 &&
                payload.loaded_promotion_artifact_sha256 === gate?.loaded_promotion_artifact_sha256 &&
                payload.changed_field === changedField &&
                (!gate?.source_promotion_id || payload.promotion_id === gate.source_promotion_id));
        });
    }
    catch {
        return false;
    }
}
/**
 * Ledger-back the baseline's "no promotion" claim: the baseline must carry its own chained runtime
 * ledger, bound to its recorded head, that contains NO `promotion.loaded` event. Field-absence alone
 * is forgeable (drop the field); a hash-chained ledger that simply never loaded a promotion is not.
 */
function baselineLedgerProvesNoPromotion(root, baseline) {
    if (!baseline)
        return false;
    const rel = typeof baseline.runtime_events_path === 'string' ? baseline.runtime_events_path : '';
    if (!rel || rel.startsWith('/') || rel.includes('..'))
        return false;
    const full = join(root, rel);
    if (!existsSync(full))
        return false;
    try {
        const rawText = readFileSync(full, 'utf8');
        const events = rawText
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
        validateRuntimeLedger(events);
        const binding = createRuntimeLedgerHeadBinding(events);
        if (sha256(rawText) !== baseline.runtime_events_sha256 ||
            binding.event_count !== baseline.runtime_event_count ||
            binding.ledger_head_sha256 !== baseline.runtime_ledger_head_sha256)
            return false;
        return !events.some((event) => event.type === 'promotion.loaded');
    }
    catch {
        return false;
    }
}
export function verifyPromotionDifferential(options) {
    const agentDir = options.agentDir || '.agent';
    const gateRel = `${agentDir}/hard-gates/promotion-learning.json`;
    const gate = readJson(options.root, gateRel);
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
    // Third run (A/A/B): a baseline with the same conditions as `before` and no promotion loaded. If
    // its changed-field value equals `before`'s, the field is deterministic absent the delta, so
    // `after`'s change is attributable to the promotion rather than run-to-run variance.
    const baselineDeclared = typeof gate?.baseline_run_path === 'string';
    const baseline = baselineDeclared ? readJson(options.root, gate?.baseline_run_path) : undefined;
    const baselineValue = changedField ? baseline?.stable_fields?.[changedField] : undefined;
    const baselineStable = Boolean(baseline &&
        // Distinct from `before` — a re-pointed `before` is one run counted twice, not a third run.
        gate?.baseline_run_path !== gate?.before_run_path &&
        gate?.baseline_run_sha256 !== gate?.before_run_sha256 &&
        digestMatches(options.root, gate?.baseline_run_path, gate?.baseline_run_sha256) &&
        baseline.task_context_sha256 === before?.task_context_sha256 &&
        // No-promotion is ledger-backed, not merely field-absent (which is forgeable).
        baselineLedgerProvesNoPromotion(options.root, baseline) &&
        baselineValue !== undefined &&
        baselineValue === beforeValue);
    const checks = {
        gate_declares_pass: gate?.status === 'PASS',
        all_hashes_match: digestMatches(options.root, gate?.review_finding_path, gate?.review_finding_sha256) &&
            digestMatches(options.root, gate?.promotion_candidate_path, gate?.promotion_candidate_sha256) &&
            digestMatches(options.root, gate?.promotion_approval_path, gate?.promotion_approval_sha256) &&
            digestMatches(options.root, gate?.promotion_apply_path, gate?.promotion_apply_sha256) &&
            digestMatches(options.root, gate?.promotion_effect_path, gate?.promotion_effect_sha256) &&
            digestMatches(options.root, gate?.before_run_path, gate?.before_run_sha256) &&
            digestMatches(options.root, gate?.after_run_path, gate?.after_run_sha256) &&
            digestMatches(options.root, loadedPath, gate?.loaded_promotion_artifact_sha256),
        chain_links: Boolean(finding &&
            candidate?.review_finding_sha256 === gate?.review_finding_sha256 &&
            approval?.promotion_candidate_sha256 === gate?.promotion_candidate_sha256 &&
            apply?.promotion_approval_sha256 === gate?.promotion_approval_sha256 &&
            effect?.promotion_apply_sha256 === gate?.promotion_apply_sha256),
        deterministic_before_after: Boolean(before &&
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
            effect?.after_run_sha256 === gate?.after_run_sha256),
        loaded_artifact_proves_after: Boolean(after?.loaded_promotion_artifact_sha256 === gate?.loaded_promotion_artifact_sha256 &&
            readCanonicalPromotionLoadedEvent(options.root, eventPath, gate, after, changedField)),
        // Claiming three runs requires a real, stable baseline; a declared-but-unstable (or forged)
        // baseline is a red flag and fails. Omitting a baseline is allowed but honestly recorded as the
        // weaker `two-run-single-delta` mode below — it does not silently pass as three-run.
        baseline_stability_when_declared: !baselineDeclared || baselineStable,
    };
    const determinismMode = baselineDeclared && baselineStable ? 'three-run-controlled-single-delta' : 'two-run-single-delta';
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        decision: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
        checks,
        determinism_mode: determinismMode,
        causal_claim: 'correlation-under-controlled-single-delta',
        source_promotion_id: typeof gate?.source_promotion_id === 'string' ? gate.source_promotion_id : undefined,
    };
    mkdirSync(join(options.root, agentDir, 'hard-gates'), { recursive: true });
    writeFileSync(join(options.root, agentDir, 'hard-gates', 'promotion-differential-verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

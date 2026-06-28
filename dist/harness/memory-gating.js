import { readMemoryFabric } from '../memory/fabric.js';
/**
 * Project the canonical stored `MemoryFact` into the gate-#4 view, proving the gate consumes the
 * one provenance model rather than a parallel vocabulary. Lifecycle outcomes that are not durable
 * facts (a `blocked`/`failure` outcome) project as `hypothesis` so they are never confirmed.
 */
export function gatingViewFromFact(fact) {
    const category = fact.outcome === 'success' || fact.outcome === undefined ? 'project_fact' : 'hypothesis';
    return {
        id: fact.id,
        category,
        claim: `${fact.key}: ${typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)}`,
        scope: fact.layer,
        source: fact.run_id ? `run:${fact.run_id}` : 'fabric',
        confidence: 'medium',
        createdAt: fact.created_at,
        sourceEventIds: fact.source_event_ids,
        lastVerifiedAt: fact.last_verified_at,
    };
}
// Bound how many facts a single run injects into context. The freshest facts (append order = end of
// the store) are the most relevant to gate #4; keeping the most recent N caps context cost as the
// store grows, without touching the full-fidelity stored fabric.
const MAX_FABRIC_FACTS_INJECTED = 2000;
/**
 * Load stored facts from the canonical fabric and project them into the gate-#4 view. This is the
 * production read path that feeds the fabric into a run's context: the caller passes the result as
 * `memory`, and gate #4 then admits only the facts with provenance + recent verification. Capped to
 * the most recent facts to bound context cost — a consumption bound, never a storage truncation.
 */
export function loadGatedMemoryFromFabric(agentDir) {
    const facts = readMemoryFabric(agentDir).facts;
    const recent = facts.length > MAX_FABRIC_FACTS_INJECTED ? facts.slice(-MAX_FABRIC_FACTS_INJECTED) : facts;
    return recent.map(gatingViewFromFact);
}
function millisecondsSinceVerification(entry, now) {
    if (!entry.lastVerifiedAt) {
        return undefined;
    }
    return new Date(now).getTime() - new Date(entry.lastVerifiedAt).getTime();
}
export function classifyMemoryForInjection(entry, opts) {
    if (entry.category === 'rejected') {
        return 'excluded';
    }
    if (entry.category === 'hypothesis') {
        return 'unverified';
    }
    // Provenance is the first half of gate #4: a fact with no ledger/artifact provenance is
    // ungrounded and can never be a confirmed fact, no matter how recently it claims verification.
    if (entry.sourceEventIds.length === 0) {
        return 'unverified';
    }
    // Verification recency is the second half.
    const verifiedAgeMs = millisecondsSinceVerification(entry, opts.now);
    if (verifiedAgeMs === undefined) {
        return 'unverified';
    }
    if (Number.isFinite(verifiedAgeMs) && verifiedAgeMs <= opts.freshnessWindowMs) {
        return 'confirmed_fact';
    }
    return 'stale';
}
function formatMemorySection(entry, label) {
    return `[${label}] ${entry.claim} (scope: ${entry.scope}; source: ${entry.source}; confidence: ${entry.confidence})`;
}
export function buildMemoryContextSections(entries, opts) {
    const sections = [...entries]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((entry) => {
        const label = classifyMemoryForInjection(entry, opts);
        return {
            id: entry.id,
            text: formatMemorySection(entry, label),
            label,
        };
    });
    return {
        sections,
        injectedFactIds: sections.filter((section) => section.label === 'confirmed_fact').map((section) => section.id),
    };
}
export function assertNoStaleAsFact(entries, opts) {
    const labelsById = new Map(entries.map((entry) => [entry.id, classifyMemoryForInjection(entry, opts)]));
    for (const id of opts.injectedFactIds ?? []) {
        const label = labelsById.get(id);
        if (label !== 'confirmed_fact') {
            throw new Error(`memory entry ${id} cannot be injected as confirmed_fact; classified as ${label ?? 'missing'}`);
        }
    }
}

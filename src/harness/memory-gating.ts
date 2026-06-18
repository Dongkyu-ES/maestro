import { type MemoryFact, readMemoryFabric } from '../memory/fabric.js';

/**
 * Gate #4 ("no stale/ungrounded memory injected as fact") operates on a projection of the single
 * canonical `MemoryFact`. The classification is keyed on TWO grounded signals — provenance
 * (`sourceEventIds`) and verification recency (`lastVerifiedAt`) — and deliberately carries no
 * `driftRisk`: drift was an ungrounded guess that lived in no stored record, so the gate could
 * never run on it. A fact reaches `confirmed_fact` only when it has ledger provenance AND was
 * verified within the freshness window. Build a projection from a stored fact with
 * `gatingViewFromFact`.
 */
export interface MemoryEntry {
  id: string;
  category: 'preference' | 'project_fact' | 'runtime_fact' | 'prior_result' | 'hypothesis' | 'rejected';
  claim: string;
  scope: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
  /** Ledger/artifact provenance. Empty = ungrounded → can never be injected as a confirmed fact. */
  sourceEventIds: string[];
  lastVerifiedAt?: string;
}

/**
 * Project the canonical stored `MemoryFact` into the gate-#4 view, proving the gate consumes the
 * one provenance model rather than a parallel vocabulary. Lifecycle outcomes that are not durable
 * facts (a `blocked`/`failure` outcome) project as `hypothesis` so they are never confirmed.
 */
export function gatingViewFromFact(fact: MemoryFact): MemoryEntry {
  const category: MemoryEntry['category'] =
    fact.outcome === 'success' || fact.outcome === undefined ? 'project_fact' : 'hypothesis';
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
export function loadGatedMemoryFromFabric(agentDir: string): MemoryEntry[] {
  const facts = readMemoryFabric(agentDir).facts;
  const recent = facts.length > MAX_FABRIC_FACTS_INJECTED ? facts.slice(-MAX_FABRIC_FACTS_INJECTED) : facts;
  return recent.map(gatingViewFromFact);
}

export type InjectionLabel = 'confirmed_fact' | 'unverified' | 'stale' | 'excluded';

export interface MemoryInjectionOptions {
  now: string;
  freshnessWindowMs: number;
}

export interface MemoryAssertionOptions extends MemoryInjectionOptions {
  injectedFactIds?: string[];
}

export interface MemoryContextSection {
  id: string;
  text: string;
  label: InjectionLabel;
}

function millisecondsSinceVerification(entry: MemoryEntry, now: string): number | undefined {
  if (!entry.lastVerifiedAt) {
    return undefined;
  }
  return new Date(now).getTime() - new Date(entry.lastVerifiedAt).getTime();
}

export function classifyMemoryForInjection(entry: MemoryEntry, opts: MemoryInjectionOptions): InjectionLabel {
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

function formatMemorySection(entry: MemoryEntry, label: InjectionLabel): string {
  return `[${label}] ${entry.claim} (scope: ${entry.scope}; source: ${entry.source}; confidence: ${entry.confidence})`;
}

export function buildMemoryContextSections(
  entries: MemoryEntry[],
  opts: MemoryInjectionOptions,
): { sections: MemoryContextSection[]; injectedFactIds: string[] } {
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

export function assertNoStaleAsFact(entries: MemoryEntry[], opts: MemoryAssertionOptions): void {
  const labelsById = new Map(entries.map((entry) => [entry.id, classifyMemoryForInjection(entry, opts)]));

  for (const id of opts.injectedFactIds ?? []) {
    const label = labelsById.get(id);
    if (label !== 'confirmed_fact') {
      throw new Error(`memory entry ${id} cannot be injected as confirmed_fact; classified as ${label ?? 'missing'}`);
    }
  }
}

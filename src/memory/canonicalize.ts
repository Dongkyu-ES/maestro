import { stableJson } from '../events/ledger.js';
import { type MemoryFact, readMemoryFabric, writeMemoryFabric } from './fabric.js';

/**
 * Memory canonicalization — the MetaOntology identity/canonicalize pattern (propose-duplicate ->
 * merge-by-tombstone -> resolve-canonical) applied to the memory fabric.
 *
 * `appendMemoryFact` has no dedup, so re-recording the same fact (same layer + key + value) across
 * runs accumulates redundant entries. Naive de-dup would be unsafe here: each duplicate carries its
 * own `source_event_ids` provenance, and gate #4 keys on provenance + verification recency. So the
 * merge is provenance-preserving — it UNIONs the duplicates' `source_event_ids` / `artifact_refs`
 * into the survivor and keeps the freshest `last_verified_at`, then records the absorbed ids as a
 * tombstone trail (`merged_alias_ids`) so an old id still resolves to its canonical survivor.
 *
 * Only EXACT duplicates (identical layer + key + serialized value) are auto-merged; value-drift
 * collisions (same layer + key, different value) are surfaced as proposals for an operator decision,
 * never silently merged.
 */

export type DuplicateMethod = 'exact_layer_key_value' | 'layer_key_value_drift';

export interface DuplicateFactCandidate {
  /** The survivor: earliest `created_at`, ties broken by id, so selection is deterministic. */
  canonical_id: string;
  /** The duplicate that would be merged into / aliased onto the canonical. */
  alias_id: string;
  /** 1.0 for an exact duplicate; <1 for a same-key value-drift collision. */
  similarity: number;
  method: DuplicateMethod;
}

function identityKey(fact: MemoryFact): string {
  return stableJson([fact.layer, fact.key, fact.value]);
}

/** Deterministic ordering: oldest first, then by id — the first in a group is the canonical survivor. */
function ordered(facts: MemoryFact[]): MemoryFact[] {
  return [...facts].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/**
 * Find duplicate candidates without mutating anything. Exact duplicates (same layer + key + value)
 * are reported at similarity 1.0; same layer + key with a different value is reported at 0.6 as a
 * drift collision (proposal only).
 */
export function findDuplicateFactCandidates(facts: MemoryFact[]): DuplicateFactCandidate[] {
  const sorted = ordered(facts);
  const exactGroups = new Map<string, MemoryFact[]>();
  const layerKeyGroups = new Map<string, MemoryFact[]>();
  for (const fact of sorted) {
    const ik = identityKey(fact);
    const lk = stableJson([fact.layer, fact.key]);
    exactGroups.set(ik, [...(exactGroups.get(ik) || []), fact]);
    layerKeyGroups.set(lk, [...(layerKeyGroups.get(lk) || []), fact]);
  }

  const candidates: DuplicateFactCandidate[] = [];
  const exactPairs = new Set<string>();
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    for (const alias of group.slice(1)) {
      candidates.push({
        canonical_id: canonical.id,
        alias_id: alias.id,
        similarity: 1,
        method: 'exact_layer_key_value',
      });
      exactPairs.add(`${canonical.id}|${alias.id}`);
    }
  }
  for (const group of layerKeyGroups.values()) {
    if (group.length < 2) continue;
    const canonical = group[0];
    for (const alias of group.slice(1)) {
      // Skip pairs already reported as exact duplicates; only report genuine value drift.
      if (exactPairs.has(`${canonical.id}|${alias.id}`)) continue;
      if (stableJson(canonical.value) === stableJson(alias.value)) continue;
      candidates.push({
        canonical_id: canonical.id,
        alias_id: alias.id,
        similarity: 0.6,
        method: 'layer_key_value_drift',
      });
    }
  }
  return candidates;
}

function unionSorted(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function freshestVerifiedAt(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Merge `alias` into `canonical` (tombstone pattern): the canonical survives with the UNION of both
 * facts' provenance and the freshest verification stamp; the alias id is recorded in the canonical's
 * `merged_alias_ids`. Pure — returns a new fact, mutates nothing.
 */
export function mergeFactInto(canonical: MemoryFact, alias: MemoryFact): MemoryFact {
  return {
    ...canonical,
    source_event_ids: unionSorted(canonical.source_event_ids, alias.source_event_ids),
    artifact_refs: unionSorted(canonical.artifact_refs, alias.artifact_refs),
    last_verified_at: freshestVerifiedAt(canonical.last_verified_at, alias.last_verified_at),
    merged_alias_ids: unionSorted(canonical.merged_alias_ids ?? [], [
      alias.id,
      ...(alias.merged_alias_ids ?? []),
    ]),
  };
}

export interface CanonicalizeResult {
  facts: MemoryFact[];
  merges: DuplicateFactCandidate[];
}

/**
 * Collapse exact duplicates in a fact list, preserving provenance. Value-drift collisions are left
 * untouched (use `findDuplicateFactCandidates` to surface those for review). Deterministic.
 */
export function canonicalizeExactDuplicates(facts: MemoryFact[]): CanonicalizeResult {
  const sorted = ordered(facts);
  const survivorByIdentity = new Map<string, MemoryFact>();
  const merges: DuplicateFactCandidate[] = [];
  for (const fact of sorted) {
    const key = identityKey(fact);
    const existing = survivorByIdentity.get(key);
    if (!existing) {
      survivorByIdentity.set(key, fact);
      continue;
    }
    survivorByIdentity.set(key, mergeFactInto(existing, fact));
    merges.push({
      canonical_id: existing.id,
      alias_id: fact.id,
      similarity: 1,
      method: 'exact_layer_key_value',
    });
  }
  // Preserve original survivor order (by created_at/id) for a stable fabric.
  const survivors = [...survivorByIdentity.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return { facts: survivors, merges };
}

/**
 * Resolve a fact id to its canonical survivor id by following the tombstone trail. Returns the input
 * id unchanged if it is already canonical or unknown.
 */
export function resolveCanonicalFactId(facts: MemoryFact[], id: string): string {
  const direct = facts.find((f) => f.id === id);
  if (direct) return direct.id;
  const survivor = facts.find((f) => f.merged_alias_ids?.includes(id));
  return survivor ? survivor.id : id;
}

/**
 * Read the fabric, collapse exact duplicates provenance-preservingly, and write it back only if
 * anything changed. Returns how many facts were merged away, the merge records, AND the surviving
 * value-drift candidates (same layer+key, different value) — these are deliberately NOT merged and
 * remain in the store for an operator to resolve, so the caller is told about them rather than them
 * silently persisting unseen.
 */
export function canonicalizeFabric(agentDir: string): {
  merged: number;
  merges: DuplicateFactCandidate[];
  driftCandidates: DuplicateFactCandidate[];
} {
  const store = readMemoryFabric(agentDir);
  const driftCandidates = findDuplicateFactCandidates(store.facts).filter(
    (c) => c.method === 'layer_key_value_drift',
  );
  const { facts, merges } = canonicalizeExactDuplicates(store.facts);
  if (merges.length > 0) writeMemoryFabric(agentDir, { schema_version: 1, facts });
  return { merged: merges.length, merges, driftCandidates };
}

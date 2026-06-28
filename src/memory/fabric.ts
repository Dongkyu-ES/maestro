import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type MemoryWriteRecord, validateMemoryWrite } from './records.js';

// Hard ceiling on the fabric file size. Beyond this the file is treated as corrupt/foreign and read
// fails open (returns no facts) rather than risking an OOM on JSON.parse. ~16 MB is far above any
// honest fabric (a fact is a few hundred bytes; the live fabric is ~12 KB).
const MAX_FABRIC_BYTES = 16 * 1024 * 1024;

export type MemoryLayer =
  | 'vertical_project'
  | 'blackboard'
  | 'sequential_handoff'
  | 'experiment_outcome'
  | 'module_learning';
/**
 * The single canonical stored memory fact. It is keyed by provenance (`source_event_ids` /
 * `artifact_refs`) and verification recency (`last_verified_at`) — the model declared by
 * evidence-contract's `MemoryContract`, with the ungrounded `driftRisk` label intentionally
 * absent. `records.ts` `MemoryWriteRecord` is the write-time authority/merge record that yields a
 * fact (it shares the same provenance fields); the memory-gating projection is derived from this
 * type. There is one provenance model, three roles — not three vocabularies.
 */
export interface MemoryFact {
  schema_version: 1;
  id: string;
  layer: MemoryLayer;
  key: string;
  value: unknown;
  run_id?: string;
  source_event_ids: string[];
  artifact_refs: string[];
  outcome?: 'success' | 'failure' | 'blocked';
  modules?: string[];
  created_at: string;
  /**
   * When this fact was last re-verified against reality. Verification recency (not an ungrounded
   * drift guess) is half of the gate-#4 freshness decision; the other half is provenance.
   */
  last_verified_at?: string;
  /**
   * Tombstone trail: ids of duplicate facts that were canonicalized into this one. Set by the
   * memory canonicalization pass (`canonicalize.ts`) so a merge never silently drops the merged
   * ids — `resolveCanonicalFactId` can still map an old id to its survivor. Empty/absent on facts
   * that have never absorbed a duplicate.
   */
  merged_alias_ids?: string[];
}
export interface MemoryFabricStore {
  schema_version: 1;
  facts: MemoryFact[];
}
export interface ModuleRecommendation {
  modules: string[];
  score: number;
  evidence: string[];
}

export function memoryFabricPath(agentDir: string): string {
  return join(agentDir, 'memory', 'fabric.json');
}
export function readMemoryFabric(agentDir: string): MemoryFabricStore {
  const path = memoryFabricPath(agentDir);
  if (!existsSync(path)) return { schema_version: 1, facts: [] };
  // Fail open on a malformed/foreign/oversized store: a corrupt fabric.json must not crash a run
  // that merely wants to read memory (the read path is default-on for `maestro harness run`). An
  // unreadable fabric simply contributes no facts — the safe direction.
  try {
    if (statSync(path).size > MAX_FABRIC_BYTES) return { schema_version: 1, facts: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryFabricStore>;
    if (!parsed || !Array.isArray(parsed.facts)) return { schema_version: 1, facts: [] };
    // Full fidelity: this is the storage read, used by read-modify-write callers (appendMemoryFact,
    // markFactsVerifiedByEvents). Bounding the fact COUNT here would silently truncate the store on
    // every write — the consumption cap lives in loadGatedMemoryFromFabric instead.
    return { schema_version: 1, facts: parsed.facts };
  } catch {
    return { schema_version: 1, facts: [] };
  }
}
export function writeMemoryFabric(agentDir: string, store: MemoryFabricStore): void {
  const path = memoryFabricPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic publish: write a temp file then rename over the target, so a crash or a concurrent reader
  // never observes a half-written fabric (rename is atomic within a filesystem). The pid suffix
  // keeps two processes from colliding on the same temp path.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}
export function appendMemoryFact(
  agentDir: string,
  fact: Omit<MemoryFact, 'schema_version' | 'id' | 'created_at'> & { id?: string },
): MemoryFact {
  if (!fact.source_event_ids.length && !fact.artifact_refs.length)
    throw new Error('memory fact requires source event or artifact provenance');
  const store = readMemoryFabric(agentDir);
  const created = new Date().toISOString();
  const next: MemoryFact = {
    schema_version: 1,
    id: fact.id || `mem-${created.replace(/[-:.TZ]/g, '')}-${store.facts.length + 1}`,
    created_at: created,
    ...fact,
  };
  store.facts.push(next);
  writeMemoryFabric(agentDir, store);
  return next;
}
const SCOPE_TO_LAYER: Record<MemoryWriteRecord['scope'], MemoryLayer> = {
  global: 'vertical_project',
  project: 'vertical_project',
  goal: 'vertical_project',
  task: 'vertical_project',
  agent_scratchpad: 'vertical_project',
  blackboard: 'blackboard',
  handoff: 'sequential_handoff',
  experiment: 'experiment_outcome',
  module_learning: 'module_learning',
};

/**
 * The executable write→store binding: turn a validated `MemoryWriteRecord` (write-time authority)
 * into the canonical stored `MemoryFact` input. This is the code the §6 reconciliation previously
 * only asserted in prose — the two types are now provably one provenance model.
 *
 * Lossy by design (documented, not a bug): the five non-collaboration scopes collapse to
 * `vertical_project`, and the record's `authority` (operator_approved / system_imported, enforced at
 * write time by `validateMemoryWrite`) is NOT carried onto the fact. Gate #4 keys on provenance +
 * recency only, so this does not affect any injection decision today; if a future gate needs the
 * write-time trust signal, add an `authority` field to `MemoryFact` rather than re-deriving it.
 */
export function factFromWriteRecord(
  record: MemoryWriteRecord,
): Omit<MemoryFact, 'schema_version' | 'id' | 'created_at'> & { id: string } {
  return {
    id: record.memory_id,
    layer: SCOPE_TO_LAYER[record.scope],
    key: record.key,
    value: record.value,
    source_event_ids: record.source_event_ids,
    artifact_refs: record.artifact_refs,
  };
}

/** Validate a write record and persist it as a canonical stored fact. */
export function appendFactFromWriteRecord(agentDir: string, record: MemoryWriteRecord): MemoryFact {
  validateMemoryWrite(record);
  return appendMemoryFact(agentDir, factFromWriteRecord(record));
}

/**
 * Stamp `last_verified_at` on every stored fact whose provenance is fully covered by a set of
 * just-verified ledger events — i.e. a verifier confirmed all the events the fact cites. This is
 * the only path that makes a fact "fresh": verification recency is earned from a passing verifier,
 * never self-asserted. A fact with empty `source_event_ids` is never stamped (it has no provenance
 * to verify). Returns the ids that were stamped.
 */
export function markFactsVerifiedByEvents(agentDir: string, verifiedEventIds: string[], at: string): string[] {
  const verified = new Set(verifiedEventIds);
  const store = readMemoryFabric(agentDir);
  const stamped: string[] = [];
  for (const fact of store.facts) {
    if (fact.source_event_ids.length === 0) continue;
    if (fact.source_event_ids.every((id) => verified.has(id))) {
      fact.last_verified_at = at;
      stamped.push(fact.id);
    }
  }
  if (stamped.length) writeMemoryFabric(agentDir, store);
  return stamped;
}

export function recommendModules(agentDir: string, goalKey: string): ModuleRecommendation[] {
  const facts = readMemoryFabric(agentDir).facts.filter(
    (fact) => fact.layer === 'module_learning' && fact.modules?.length && fact.key.includes(goalKey),
  );
  const scores = new Map<string, { modules: string[]; score: number; evidence: string[] }>();
  for (const fact of facts) {
    const modules = fact.modules || [];
    const key = modules.join('+');
    const entry = scores.get(key) || { modules, score: 0, evidence: [] };
    entry.score += fact.outcome === 'success' ? 2 : fact.outcome === 'blocked' ? -1 : -2;
    entry.evidence.push(fact.id);
    scores.set(key, entry);
  }
  return [...scores.values()].sort(
    (a, b) => b.score - a.score || a.modules.join('+').localeCompare(b.modules.join('+')),
  );
}

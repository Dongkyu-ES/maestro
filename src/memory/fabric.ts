import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  return JSON.parse(readFileSync(path, 'utf8')) as MemoryFabricStore;
}
export function writeMemoryFabric(agentDir: string, store: MemoryFabricStore): void {
  const path = memoryFabricPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
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

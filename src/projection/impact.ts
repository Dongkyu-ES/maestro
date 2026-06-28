import type { OntologyProjection, OntologySpace } from './ontology-projection.js';

/**
 * Impact analysis (I1–I7) + lever simulation — the MetaOntology change-impact and lever grammar
 * applied to maestro's own change kinds.
 *
 * Both are descriptive, read-only analyses. Impact analysis answers "if I make this change, which
 * categories does it touch?"; lever simulation answers "which observed outcomes does this control
 * variable reach in the graph?". Neither mutates anything and neither is a completion authority.
 */

export type ImpactCategoryId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7';

export const IMPACT_QUESTIONS: Record<ImpactCategoryId, string> = {
  I1: 'What data values or records change?',
  I2: 'What relationships or edges in the graph are affected?',
  I3: 'Which ontology spaces are touched by this change?',
  I4: 'Which access permissions or ReBAC policies change?',
  I5: 'Which business rules or inference chains are invalidated?',
  I6: 'Which caches, indexes, or materialized views must be refreshed?',
  I7: 'Which external systems or integrations are affected?',
};

export interface ImpactFinding {
  category: ImpactCategoryId;
  question: string;
  reason: string;
}

/** A structured description of a proposed change, in terms the impact classifier reasons over. */
export interface ImpactChange {
  /** Spaces the change writes to (drives I3). */
  spaces: OntologySpace[];
  /** Whether record/data values change (I1). */
  touchesData?: boolean;
  /** Whether graph edges/relations change (I2). */
  touchesRelations?: boolean;
  /** Whether permissions/policy change (I4). */
  touchesPermissions?: boolean;
  /** Whether business rules / inference chains are invalidated (I5). */
  touchesLogic?: boolean;
  /** Whether caches/indexes/read-models must be refreshed (I6). */
  touchesCache?: boolean;
  /** Whether external systems/integrations are affected (I7). */
  touchesDownstream?: boolean;
  /** Optional free-text note appended to each finding's reason. */
  note?: string;
}

export interface ImpactReport {
  findings: ImpactFinding[];
  categories: ImpactCategoryId[];
}

export function analyzeImpact(change: ImpactChange): ImpactReport {
  const findings: ImpactFinding[] = [];
  const add = (category: ImpactCategoryId, reason: string): void => {
    findings.push({ category, question: IMPACT_QUESTIONS[category], reason: change.note ? `${reason} (${change.note})` : reason });
  };
  if (change.touchesData) add('I1', 'change writes or alters stored records');
  if (change.touchesRelations) add('I2', 'change adds or rewrites graph edges');
  if (change.spaces.length) add('I3', `spaces touched: ${[...change.spaces].sort().join(', ')}`);
  if (change.touchesPermissions) add('I4', 'change affects permissions / ReBAC policy');
  if (change.touchesLogic) add('I5', 'change invalidates a rule or inference chain');
  if (change.touchesCache) add('I6', 'derived read-models / indexes must be rebuilt');
  if (change.touchesDownstream) add('I7', 'an external system or integration is affected');
  return { findings, categories: findings.map((f) => f.category) };
}

/**
 * Pre-built impact classifiers for maestro's concrete change kinds. These encode the grounded truth
 * of what each operation actually does in the codebase (e.g. applying a promotion calls
 * `rebuildIndex`, so it always touches I6).
 */
export const WARDEN_IMPACT = {
  /** Applying a promotion writes a target artifact and rebuilds the product index. */
  promotionApply(targetType: 'agent_instruction' | 'skill' | 'workflow' | 'eval' | 'memory' | 'policy'): ImpactReport {
    const isPolicyish = targetType === 'policy' || targetType === 'agent_instruction';
    return analyzeImpact({
      spaces: targetType === 'memory' ? ['claim'] : isPolicyish ? ['policy'] : ['concept'],
      touchesData: true,
      touchesPermissions: isPolicyish,
      touchesLogic: isPolicyish || targetType === 'workflow' || targetType === 'eval' || targetType === 'skill',
      touchesCache: true, // rebuildIndex always runs
      note: `promotion target_type=${targetType}`,
    });
  },
  /** Canonicalizing memory rewrites facts (data) and their alias/provenance trail (relations). */
  memoryCanonicalize(): ImpactReport {
    return analyzeImpact({
      spaces: ['claim'],
      touchesData: true,
      touchesRelations: true,
      touchesCache: true,
      note: 'memory canonicalization merge',
    });
  },
  /** A tool-policy decision changes the policy/ReBAC view only. */
  toolPolicyDecision(): ImpactReport {
    return analyzeImpact({ spaces: ['policy', 'subject', 'resource'], touchesPermissions: true, note: 'tool-policy decision' });
  },
} as const;

export interface LeverSimulation {
  leverId: string;
  affectedOutcomes: string[];
  affectedNodes: string[];
}

/**
 * Read-only lever simulation: from a lever node, walk its outgoing control edges (raises / lowers /
 * stabilizes / optimizes -> outcomes; affects -> concepts/resources) to list what it reaches in the
 * observed graph. This does not predict magnitudes — it reports the observed control surface, never
 * a forecast presented as fact.
 */
export function simulateLever(projection: OntologyProjection, leverId: string): LeverSimulation {
  const controlRelations = new Set(['raises', 'lowers', 'stabilizes', 'optimizes', 'affects']);
  const outgoing = projection.edges.filter((e) => e.from === leverId && controlRelations.has(e.relation));
  const affectedNodes = [...new Set(outgoing.map((e) => e.to))].sort();
  const outcomeIds = new Set(projection.nodes.filter((n) => n.space === 'outcome').map((n) => n.id));
  const affectedOutcomes = affectedNodes.filter((id) => outcomeIds.has(id));
  return { leverId, affectedOutcomes, affectedNodes };
}

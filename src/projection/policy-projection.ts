import type { PolicyDecision, ToolRiskClass } from '../harness/tool-policy.js';
import type { OntologyEdge, OntologyNode, OntologySubgraph } from './ontology-projection.js';

/**
 * Policy / ReBAC overlay — renders Warden's tool-policy decisions in the MetaOntology policy grammar
 * so the same allow/ask/deny gate Warden already enforces can be *read* as a graph of subjects,
 * policies, sensitivities, and the permissions they grant over tool resources.
 *
 * THESIS GUARD (corrected after review): this produces an `OntologySubgraph`, NOT a standalone
 * `OntologyProjection`. Tool-policy decisions are computed at runtime by `tool-policy.ts`
 * (`decidePolicy`) — they are not (yet) recorded as ledger events — so this overlay is explicitly
 * a DESCRIPTIVE view, not a ledger-derived/validated read-model. It must be folded into a real
 * ledger-backed base via `composeOntologyProjections(base, overlay)`; it can never masquerade as a
 * validated projection on its own, and it never decides anything (enforcement stays in
 * `tool-policy.ts`). Provenance is only attached when the caller supplies a real `sourceEventId`;
 * absent that, nodes/edges carry empty provenance rather than a fabricated id.
 *
 * Grammar used (from the manifest):
 *  - policy -> subject : permits | denies | requires_approval   (mirrors allow | deny | ask)
 *  - policy -> resource: protects                                (the rule guards the tool)
 *  - subject -> resource: can_view | can_edit | can_execute      (the capability, only when allowed)
 *  - Sensitivity (policy space) classifies the tool by risk.
 */

/** Map a tool-policy decision to the manifest policy->subject relation. */
export function policyRelationForDecision(decision: PolicyDecision): 'permits' | 'denies' | 'requires_approval' {
  if (decision === 'allow') return 'permits';
  if (decision === 'deny') return 'denies';
  return 'requires_approval';
}

/** Map a Warden risk class to a ReBAC permission + a sensitivity level over the tool resource. */
export function rebacForRisk(risk: ToolRiskClass): {
  permission: 'view' | 'edit' | 'execute';
  capability: 'can_view' | 'can_edit' | 'can_execute';
  sensitivity: 'none' | 'moderate' | 'high';
} {
  switch (risk) {
    case 'read_only':
      return { permission: 'view', capability: 'can_view', sensitivity: 'none' };
    case 'safe':
      return { permission: 'execute', capability: 'can_execute', sensitivity: 'none' };
    case 'mutating':
      return { permission: 'edit', capability: 'can_edit', sensitivity: 'moderate' };
    case 'destructive':
      return { permission: 'edit', capability: 'can_edit', sensitivity: 'high' };
    case 'network':
      return { permission: 'execute', capability: 'can_execute', sensitivity: 'moderate' };
    case 'credentialed':
      return { permission: 'execute', capability: 'can_execute', sensitivity: 'high' };
  }
}

export interface ToolPolicyDecisionInput {
  /** The subject the decision applies to (executor agent or operator). Defaults to a generic executor. */
  subjectId?: string;
  /** Tool name, becomes a `resource:tool:<name>` node. */
  tool: string;
  decision: PolicyDecision;
  risk: ToolRiskClass;
  reason?: string;
  /** Optional provenance: the ledger event id this decision was observed in. */
  sourceEventId?: string;
}

/**
 * Project a batch of tool-policy decisions into an ontology subgraph (nodes + edges). Pure and
 * deterministic. The result is NOT a standalone projection — fold it into a ledger-backed base with
 * `composeOntologyProjections(base, subgraph)`.
 */
export function projectToolPolicyDecisions(inputs: ToolPolicyDecisionInput[]): OntologySubgraph {
  const nodes = new Map<string, OntologyNode>();
  const edges = new Map<string, OntologyEdge>();
  const upsertNode = (node: OntologyNode): void => {
    const existing = nodes.get(node.id);
    if (existing) {
      existing.source_event_ids = [...new Set([...existing.source_event_ids, ...node.source_event_ids])];
      Object.assign(existing.attrs, node.attrs);
    } else nodes.set(node.id, node);
  };
  const upsertEdge = (edge: OntologyEdge): void => {
    const key = `${edge.from}|${edge.relation}|${edge.to}`;
    const existing = edges.get(key);
    if (existing) existing.source_event_ids = [...new Set([...existing.source_event_ids, ...edge.source_event_ids])];
    else edges.set(key, edge);
  };

  // Normalize a subject id to the `<space>:<localId>` invariant: a bare id (e.g. "codex") becomes a
  // namespaced agent node, so callers cannot inject malformed node ids into the graph.
  const normalizeSubject = (id: string | undefined): string => {
    const raw = id ?? 'subject:agent:executor';
    return raw.startsWith('subject:') ? raw : `subject:agent:${raw}`;
  };

  const provenanceOf = (i: ToolPolicyDecisionInput): string[] => (i.sourceEventId ? [i.sourceEventId] : []);

  // Pass 1 — classification (CUMULATIVE, decision-independent). Risk is a property of each invocation,
  // so every observed (tool, risk) is recorded: the tool node, the level-keyed Sensitivity node, and a
  // `classifies` edge. A tool exercised at several risk levels — even by the same subject — therefore
  // accrues one `classifies` edge per level, never collapsing to just the latest.
  for (const input of inputs) {
    const toolId = `resource:tool:${input.tool}`;
    const policyId = `policy:tool-rule:${input.tool}`;
    const { sensitivity } = rebacForRisk(input.risk);
    const sensitivityId = `policy:sensitivity:${sensitivity}`;
    const provenance = provenanceOf(input);
    // The tool resource and the tool-scoped rule carry NO risk attr — risk is per-invocation, not a
    // property of the tool/rule (Warden's own classifier rates the same tool name differently by args).
    upsertNode({ id: toolId, space: 'resource', type: 'Tool', label: input.tool, source_event_ids: provenance, attrs: {} });
    upsertNode({
      id: policyId,
      space: 'policy',
      type: 'Policy',
      label: `tool-rule ${input.tool}`,
      source_event_ids: provenance,
      attrs: {},
    });
    // Sensitivity is keyed by LEVEL (id == level): a stable shared classification node that can never
    // be overwritten.
    upsertNode({
      id: sensitivityId,
      space: 'policy',
      type: 'Sensitivity',
      label: `${sensitivity} sensitivity`,
      source_event_ids: provenance,
      attrs: { level: sensitivity },
    });
    upsertEdge({ from: policyId, relation: 'protects', to: toolId, source_event_ids: provenance });
    upsertEdge({ from: sensitivityId, relation: 'classifies', to: toolId, source_event_ids: provenance });
  }

  // Pass 2 — access control (CURRENT-STATE per subject+tool). The decision dimension (allow/deny/ask)
  // resolves last-wins: a later decision supersedes an earlier one, so no stale capability edge is left
  // behind. Provenance here unions ONLY the events attesting the surviving decision.
  const groups = new Map<string, ToolPolicyDecisionInput[]>();
  for (const input of inputs) {
    const key = `${normalizeSubject(input.subjectId)}::${input.tool}`;
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }

  for (const group of groups.values()) {
    const input = group[group.length - 1]; // final, current decision
    const subjectId = normalizeSubject(input.subjectId);
    // The decision (permits/denies/requires_approval) is attested by every event sharing the surviving
    // decision, regardless of risk.
    const decisionProvenance = [
      ...new Set(group.filter((i) => i.decision === input.decision).flatMap(provenanceOf)),
    ];
    // The capability edge is risk-SPECIFIC (can_view/can_edit/can_execute derive from risk), so its
    // provenance is only the events that share BOTH the surviving decision AND its risk — never the
    // read_only history of a tool whose surviving grant is destructive.
    const capabilityProvenance = [
      ...new Set(
        group.filter((i) => i.decision === input.decision && i.risk === input.risk).flatMap(provenanceOf),
      ),
    ];
    const toolId = `resource:tool:${input.tool}`;
    const policyId = `policy:tool-rule:${input.tool}`;
    const { capability } = rebacForRisk(input.risk);
    const relation = policyRelationForDecision(input.decision);

    upsertNode({
      id: subjectId,
      space: 'subject',
      type: subjectId.startsWith('subject:user') ? 'User' : 'Agent',
      label: subjectId.replace(/^subject:(agent|user):/, ''),
      source_event_ids: [...decisionProvenance],
      attrs: {},
    });
    // policy -> subject: permits / denies / requires_approval (the surviving decision).
    upsertEdge({ from: policyId, relation, to: subjectId, source_event_ids: [...decisionProvenance] });
    // Only a surviving `allow` grants the subject an actual capability over the resource.
    if (input.decision === 'allow')
      upsertEdge({ from: subjectId, relation: capability, to: toolId, source_event_ids: [...capabilityProvenance] });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to),
    ),
  };
}

import { type RuntimeEventEnvelope, validateRuntimeLedger } from '../events/ledger.js';

/**
 * MetaOntology projection — a derived read-model of the hash-chained runtime ledger expressed in the
 * 9-space MetaOntology OS grammar (subject / resource / evidence / concept / claim / community /
 * outcome / lever / policy). It exists so the same facts Warden already records as ledger events can
 * be *queried as a graph* (cross-run knowledge, provenance walks, contradiction surfaces) without
 * standing up an external graph service.
 *
 * THESIS GUARD (load-bearing, do not weaken):
 * - This is a PROJECTION, never an authority. The `authority: false` literal is a compile-time
 *   reminder: completion is still declared only by `recomputeCompletionFromLedger` re-running
 *   acceptance over the bound evidence. This graph carries the *observed* completion CLAIM (from
 *   `run.completed` / `run.failed` events); it never *judges* completion.
 * - It is a pure, fully deterministic function of the events (its `as_of` is derived from the latest
 *   event timestamp, not a wall clock), so two rebuilds of the same ledger are byte-identical and it
 *   adds no new source of truth.
 * - It validates the hash chain per run before projecting (a tampered ledger throws here exactly as
 *   it does for `rebuildRuntimeProjection`), so a swapped event cannot silently re-shape the graph.
 *
 * Only nodes/edges derivable from real event fields are emitted — the graph asserts nothing the
 * ledger does not already say.
 */

export type OntologySpace =
  | 'subject'
  | 'resource'
  | 'evidence'
  | 'concept'
  | 'claim'
  | 'community'
  | 'outcome'
  | 'lever'
  | 'policy';

export interface OntologyNode {
  /** Namespaced id, `<space>:<localId>`, stable across rebuilds. */
  id: string;
  space: OntologySpace;
  /** node_type within the space, drawn from the MetaOntology manifest (e.g. Agent, Project, Claim). */
  type: string;
  label: string;
  /** Provenance metadata layer: the ledger events that evidence this node's existence. */
  source_event_ids: string[];
  /** Grounded attributes only — values copied from event payloads, never inferred. */
  attrs: Record<string, string | number | boolean>;
}

export interface OntologyEdge {
  from: string;
  /** A relation drawn from the manifest's meta_edges for the (fromSpace -> toSpace) pair. */
  relation: string;
  to: string;
  source_event_ids: string[];
}

export interface OntologyProjection {
  schema_version: 1;
  /**
   * Always `false`. This read-model is not the completion authority; it is a derived view. Encoded
   * as a literal type so any code that tries to treat the projection as a verdict source fails to
   * compile.
   */
  authority: false;
  /**
   * The data's as-of point: the latest event timestamp in the projected ledger (empty string for an
   * empty ledger). Deterministically derived from the events — NOT a wall-clock "computed at" stamp —
   * so `rebuildOntologyProjection(events)` is a pure function and two rebuilds are byte-identical.
   */
  as_of: string;
  nodes: OntologyNode[];
  edges: OntologyEdge[];
}

/**
 * A non-standalone fragment of the ontology graph (nodes + edges with no projection envelope). It is
 * NOT a projection: it carries no `authority`/`as_of` and is not ledger-validated on its own. Used by
 * descriptive overlays (e.g. the policy/ReBAC view) that are computed from runtime decisions rather
 * than rebuilt from the ledger; fold one into a real ledger-backed projection with
 * `composeOntologyProjections(base, ...overlays)`.
 */
export interface OntologySubgraph {
  nodes: OntologyNode[];
  edges: OntologyEdge[];
}

/** Map a ledger event source to the executor agent kind it represents, or undefined for non-agents. */
function agentKindForSource(source: string, payloadAdapterKind?: unknown): string | undefined {
  if (typeof payloadAdapterKind === 'string' && payloadAdapterKind) return payloadAdapterKind;
  if (source.endsWith('-adapter')) {
    const kind = source.replace('-adapter', '');
    return kind === 'direct' ? 'anthropic-direct' : kind;
  }
  return undefined;
}

class GraphBuilder {
  private readonly nodes = new Map<string, OntologyNode>();
  private readonly edges = new Map<string, OntologyEdge>();

  upsertNode(
    id: string,
    space: OntologySpace,
    type: string,
    label: string,
    sourceEventId: string,
    attrs: Record<string, string | number | boolean> = {},
  ): string {
    const existing = this.nodes.get(id);
    if (existing) {
      if (!existing.source_event_ids.includes(sourceEventId)) existing.source_event_ids.push(sourceEventId);
      // Later events overwrite mutable attrs (e.g. a run's status), matching last-write projection semantics.
      Object.assign(existing.attrs, attrs);
    } else {
      this.nodes.set(id, { id, space, type, label, source_event_ids: [sourceEventId], attrs: { ...attrs } });
    }
    return id;
  }

  upsertEdge(from: string, relation: string, to: string, sourceEventId: string): void {
    const key = `${from}|${relation}|${to}`;
    const existing = this.edges.get(key);
    if (existing) {
      if (!existing.source_event_ids.includes(sourceEventId)) existing.source_event_ids.push(sourceEventId);
    } else {
      this.edges.set(key, { from, relation, to, source_event_ids: [sourceEventId] });
    }
  }

  finish(asOf: string): OntologyProjection {
    return {
      schema_version: 1,
      authority: false,
      as_of: asOf,
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges.values()].sort(
        (a, b) =>
          a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to),
      ),
    };
  }
}

/**
 * Project a validated runtime ledger into the 9-space MetaOntology read-model. Throws (via
 * `validateRuntimeLedger`) if any run's hash chain is broken — the projection refuses to render a
 * tampered ledger.
 */
export function rebuildOntologyProjection(events: RuntimeEventEnvelope[]): OntologyProjection {
  const eventsByRun = new Map<string, RuntimeEventEnvelope[]>();
  for (const event of events) {
    const bucket = eventsByRun.get(event.run_id);
    if (bucket) bucket.push(event);
    else eventsByRun.set(event.run_id, [event]);
  }
  for (const runEvents of eventsByRun.values()) validateRuntimeLedger(runEvents);

  // Per-run aggregates computed up front so they are known when each run node is upserted.
  const countByRun = new Map<string, number>();
  for (const event of events) countByRun.set(event.run_id, (countByRun.get(event.run_id) || 0) + 1);
  // Executors that participated in each run, accumulated as events are seen. A run's session.started
  // (which carries adapter_kind) precedes its terminal event, so by the time a terminal event is
  // processed this set is populated — letting us link the executor lever to the run outcome even
  // though the terminal event itself is emitted by `harness`/`runtime-manager`, not an adapter.
  const executorsByRun = new Map<string, Set<string>>();

  const g = new GraphBuilder();

  for (const event of events) {
    const eid = event.event_id;
    const runNodeId = `resource:run:${event.run_id}`;
    // resource space — the run is the unit of work subjects act upon.
    g.upsertNode(runNodeId, 'resource', 'Project', `run ${event.run_id}`, eid, {
      event_count: countByRun.get(event.run_id) || 0,
    });

    // evidence space — every ledger event is a LogEntry; its artifacts are Evidence.
    const eventNodeId = `evidence:event:${eid}`;
    g.upsertNode(eventNodeId, 'evidence', 'LogEntry', `${event.type} #${event.sequence}`, eid, {
      type: event.type,
      sequence: event.sequence,
      source: event.source,
    });
    g.upsertEdge(runNodeId, 'contains', eventNodeId, eid);
    for (const ref of event.artifact_refs) {
      const artifactNodeId = `evidence:artifact:${ref}`;
      g.upsertNode(artifactNodeId, 'evidence', 'Evidence', ref, eid, {});
      g.upsertEdge(runNodeId, 'contains', artifactNodeId, eid);
    }

    // subject space — executor agents and the operator.
    const agentKind = agentKindForSource(event.source, event.payload.adapter_kind);
    if (agentKind) {
      const agentNodeId = `subject:agent:${agentKind}`;
      g.upsertNode(agentNodeId, 'subject', 'Agent', agentKind, eid, {});
      g.upsertEdge(agentNodeId, 'can_execute', runNodeId, eid);
      // lever space — choosing an executor is a control variable over the run's outcome.
      const leverNodeId = `lever:executor:${agentKind}`;
      g.upsertNode(leverNodeId, 'lever', 'Lever', `executor=${agentKind}`, eid, {});
      g.upsertEdge(leverNodeId, 'affects', runNodeId, eid);
      const executors = executorsByRun.get(event.run_id) ?? new Set<string>();
      executors.add(agentKind);
      executorsByRun.set(event.run_id, executors);
    } else if (event.source === 'web') {
      const operatorNodeId = 'subject:user:operator';
      g.upsertNode(operatorNodeId, 'subject', 'User', 'operator', eid, {});
      g.upsertEdge(operatorNodeId, 'owns', runNodeId, eid);
    }

    // concept space — runtime labels are topical tags on the run.
    const label = typeof event.payload.runtime_label === 'string' ? event.payload.runtime_label : undefined;
    if (label) {
      const conceptNodeId = `concept:label:${label}`;
      g.upsertNode(conceptNodeId, 'concept', 'Topic', label, eid, {});
      g.upsertEdge(eventNodeId, 'exemplifies', conceptNodeId, eid);
    }

    // policy space — approvals gate the run.
    if (event.type === 'approval.requested') {
      const approvalId = String(event.payload.approval_id || eid);
      const policyNodeId = `policy:approval:${approvalId}`;
      g.upsertNode(policyNodeId, 'policy', 'ApprovalRule', `approval ${approvalId}`, eid, {
        status: 'requested',
      });
      g.upsertEdge(policyNodeId, 'restricts', runNodeId, eid);
    }
    if (event.type === 'approval.decided') {
      const approvalId = String(event.payload.approval_id || 'unknown');
      const policyNodeId = `policy:approval:${approvalId}`;
      g.upsertNode(policyNodeId, 'policy', 'ApprovalRule', `approval ${approvalId}`, eid, {
        status: String(event.payload.decision || 'decided'),
      });
      g.upsertEdge(policyNodeId, 'restricts', runNodeId, eid);
    }

    // claim + outcome spaces — terminal events carry the OBSERVED completion claim (never a verdict).
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      const declared = event.type === 'run.completed' ? 'completed' : 'failed';
      g.upsertNode(runNodeId, 'resource', 'Project', `run ${event.run_id}`, eid, { status: declared });

      const claimNodeId = `claim:completion:${event.run_id}`;
      g.upsertNode(claimNodeId, 'claim', 'Claim', `run ${event.run_id} is complete`, eid, {
        declared_status: declared,
      });
      // Evidence supports the completion claim when it declares success, contradicts it on failure —
      // this is the graph form of the operator-UI CONTRADICTION surface.
      g.upsertEdge(eventNodeId, declared === 'completed' ? 'supports' : 'contradicts', claimNodeId, eid);

      const outcomeNodeId = `outcome:run:${event.run_id}`;
      g.upsertNode(outcomeNodeId, 'outcome', 'Outcome', `outcome of run ${event.run_id}`, eid, {
        result: declared,
      });
      // Link every executor that participated in this run to its outcome. Uses the accumulated set,
      // not the terminal event's source, so the lever -> outcome edge survives the fact that
      // run.completed/failed are emitted by harness/runtime-manager rather than an adapter.
      for (const kind of executorsByRun.get(event.run_id) ?? [])
        g.upsertEdge(`lever:executor:${kind}`, 'optimizes', outcomeNodeId, eid);
    }
  }

  // Deterministic as-of: the latest event timestamp (ISO-8601 sorts lexicographically), or '' for an
  // empty ledger. Keeps the whole projection a pure function of the events.
  let asOf = '';
  for (const event of events) if (event.timestamp > asOf) asOf = event.timestamp;
  return g.finish(asOf);
}

/** Count nodes per ontology space — a quick shape summary of a projection. */
export function ontologySpaceCounts(projection: OntologyProjection): Record<OntologySpace, number> {
  const counts = {
    subject: 0,
    resource: 0,
    evidence: 0,
    concept: 0,
    claim: 0,
    community: 0,
    outcome: 0,
    lever: 0,
    policy: 0,
  } satisfies Record<OntologySpace, number>;
  for (const node of projection.nodes) counts[node.space] += 1;
  return counts;
}

export function findOntologyNode(projection: OntologyProjection, id: string): OntologyNode | undefined {
  return projection.nodes.find((node) => node.id === id);
}

/** All edges leaving a node — the neighbor walk used by graph queries over the projection. */
export function ontologyNeighbors(projection: OntologyProjection, fromId: string): OntologyEdge[] {
  return projection.edges.filter((edge) => edge.from === fromId);
}

/**
 * Fold descriptive overlays into a ledger-backed base projection. The `base` MUST be a real
 * projection produced by `rebuildOntologyProjection` (it carries the validated, deterministic
 * `as_of`); the overlays are bare subgraphs (e.g. the policy/ReBAC view) computed from runtime
 * decisions rather than re-walked from the ledger. Nodes with the same id union their
 * `source_event_ids` and merge attrs (later wins); edges with the same (from, relation, to) union
 * their `source_event_ids`. The result inherits the base's `as_of`, so composition stays fully
 * deterministic, and remains `authority: false`. There is no way to fabricate a standalone
 * projection from overlays alone — that is the point.
 */
export function composeOntologyProjections(
  base: OntologyProjection,
  ...overlays: OntologySubgraph[]
): OntologyProjection {
  const nodes = new Map<string, OntologyNode>();
  const edges = new Map<string, OntologyEdge>();
  for (const fragment of [base, ...overlays]) {
    for (const node of fragment.nodes) {
      const existing = nodes.get(node.id);
      if (existing) {
        existing.source_event_ids = [...new Set([...existing.source_event_ids, ...node.source_event_ids])];
        Object.assign(existing.attrs, node.attrs);
      } else {
        nodes.set(node.id, { ...node, source_event_ids: [...node.source_event_ids], attrs: { ...node.attrs } });
      }
    }
    for (const edge of fragment.edges) {
      const key = `${edge.from}|${edge.relation}|${edge.to}`;
      const existing = edges.get(key);
      if (existing)
        existing.source_event_ids = [...new Set([...existing.source_event_ids, ...edge.source_event_ids])];
      else edges.set(key, { ...edge, source_event_ids: [...edge.source_event_ids] });
    }
  }
  return {
    schema_version: 1,
    authority: false,
    as_of: base.as_of,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to),
    ),
  };
}

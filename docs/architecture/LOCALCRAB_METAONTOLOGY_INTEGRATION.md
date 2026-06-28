# localcrab MetaOntology → Warden integration

**Status:** implemented (G001–G005), 2026-06-28.
**Thesis guard (binding):** localcrab is applied as a **local TypeScript projection layer**, never a
runtime dependency and never the completion authority. Completion is still declared only by
`recomputeCompletionFromLedger` re-running acceptance over the hash-chained, content-bound evidence.

## Why a projection, not a dependency

Warden's invariant is "own the evidence and the gate; rent the loop — local, file-backed, no hosted
service." `package.json` carries **zero runtime dependencies** by design. So the localcrab/OpenCrab
MetaOntology OS could not be wired in as an MCP/library the runtime calls. What *is* applicable is its
**9-space grammar and lifecycle patterns**, adopted as pure local code that rebuilds from the existing
hash-chained ledger — a derived read-model alongside the existing `src/projection/` SQLite read-model.

Two hard lines, enforced in code and tests:

1. **Not the authority.** Every projection carries an `authority: false` literal type. The graph
   carries the *observed* completion claim (from `run.completed` / `run.failed` events) and surfaces
   contradictions, but it never *judges* completion.
2. **Rebuildable + tamper-refusing + deterministic.** `rebuildOntologyProjection` is a pure function
   of the ledger that calls `validateRuntimeLedger` first (a tampered chain throws instead of
   rendering), and its `as_of` is derived from the latest event timestamp — not a wall clock — so two
   rebuilds of the same ledger are byte-identical.
3. **Overlays are subgraphs, not projections.** Views computed from runtime state rather than the
   ledger (the policy/ReBAC overlay) return a bare `OntologySubgraph` (nodes + edges, no envelope) and
   can only enter the graph by being folded into a real ledger-backed base via
   `composeOntologyProjections(base, overlay)`. Nothing can fabricate a standalone validated
   projection from non-ledger input.

Deliberately **not** done: making the runtime call the localcrab MCP; auto-ingesting run evidence to
the OpenCrab SaaS (same posture as no-auto-push — would require an explicit operator approval gate).

## The 9-space mapping (what shipped)

| MetaOntology space | Warden source of truth | Module |
| --- | --- | --- |
| subject (Agent/User) | executor adapters (codex/claude/agy/direct), operator | `ontology-projection.ts` |
| resource (Project/Tool) | runs, tools | `ontology-projection.ts`, `policy-projection.ts` |
| evidence (LogEntry/Evidence) | ledger events + artifact_refs (content-hashed) | `ontology-projection.ts` |
| concept (Topic) | runtime labels | `ontology-projection.ts` |
| claim (Claim) | observed completion claim; supports/contradicts edges | `ontology-projection.ts` |
| outcome (Outcome) | terminal run result | `ontology-projection.ts` |
| lever (Lever) | executor choice (control variable) | `ontology-projection.ts`, `impact.ts` |
| policy (Policy/Sensitivity/ApprovalRule) | tool-policy decisions + approvals | `policy-projection.ts` |
| community | — (no clustering source yet; intentionally empty) | — |

## What each milestone delivered

- **G001 — `src/projection/ontology-projection.ts`.** `rebuildOntologyProjection(events)` projects a
  validated ledger into the 9-space graph (`authority: false`); a `run.completed` event emits a
  `supports` edge to the completion claim, a `run.failed` emits `contradicts` (the graph form of the
  operator-UI CONTRADICTION surface). `composeOntologyProjections` folds sub-views in. 7 tests incl.
  tamper-refusal and rebuild determinism.
- **G002 — `src/project/promotion-lifecycle.ts`.** Formal `candidate → validated → promoted` (+
  `rejected`) state machine mapped 1:1 onto Warden's existing `proposed/approved/applied/rejected`
  vocabulary (unchanged — it is load-bearing for `product-gate.ts`/`core.test.ts`). The transition
  guard wired into `resolvePromotion` closes a real silent-overwrite bug: reverting an already
  `applied` promotion (which dropped its `applied_path`) now throws. 6 tests.
- **G003 — `src/memory/canonicalize.ts`.** The identity/canonicalize pattern (propose-duplicate →
  merge-by-tombstone → resolve-canonical) over the memory fabric, addressing the §6 gap-#2
  reconciliation. Exact duplicates auto-merge **provenance-preservingly** (UNION of `source_event_ids`,
  freshest `last_verified_at`); value-drift collisions are surfaced, never silently merged. The merged
  ids are kept as a `merged_alias_ids` tombstone so `resolveCanonicalFactId` still maps old → survivor.
  7 tests.
- **G004 — `src/projection/policy-projection.ts`.** Maps tool-policy `allow/ask/deny` + risk class
  into the policy grammar: `policy permits|denies|requires_approval subject`, `Sensitivity classifies`
  the tool, and a `can_view|can_edit|can_execute` capability edge is emitted **only on allow**.
  Because tool-policy decisions are computed at runtime (not recorded as ledger events), this is an
  `OntologySubgraph` **overlay**, not a standalone projection — it must be folded into a ledger-backed
  base via `composeOntologyProjections`, carries provenance only when given a real `sourceEventId`,
  and never decides anything (enforcement stays in `tool-policy.ts`). 8 tests.
- **G005 — `src/projection/impact.ts`.** I1–I7 change-impact analysis (with pre-built classifiers for
  Warden's concrete change kinds — e.g. a promotion apply always touches I6 because it calls
  `rebuildIndex`) plus read-only lever simulation that walks a lever's control edges to its observed
  outcomes (reports the observed control surface, not a forecast presented as fact). 6 tests.

## Honest ceiling

This adds a queryable knowledge view over what the ledger already proves; it does not raise the hard
completion ceiling. Independent review custody remains the only path past ~75 for a solo operator
(ADR-0001) — unchanged by this work.

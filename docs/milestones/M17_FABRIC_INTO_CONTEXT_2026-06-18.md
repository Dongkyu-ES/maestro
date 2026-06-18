# M17 (M2 slice) — wire the memory fabric into the live context path

**Date:** 2026-06-18
**Plan ref:** the three M16 follow-ups (see `M16_MEMORY_SCHEMA_RECONCILE_2026-06-18.md`) — the
executable wiring §6 deliberately left to M2.
**Status:** Honest. Build + full suite green (295, +5); the three follow-ups are now executable, not
prose. `warden harness run` is a real shipped call site for the fabric→gate path.

## What M16 left open, and what this closes

M16 reconciled the memory *schema* and made gate #4 require provenance, but flagged three
reach/coherence gaps. This slice makes each executable:

1. **`MemoryWriteRecord → MemoryFact` was prose-only** → `factFromWriteRecord` /
   `appendFactFromWriteRecord` (`fabric.ts`): a validated write record is now mapped onto the
   canonical stored fact in code (scope→layer), carrying its provenance. An ungrounded write is
   rejected by `validateMemoryWrite`, never stored.
2. **`last_verified_at` was write-dead** → `markFactsVerifiedByEvents(agentDir, verifiedEventIds, at)`
   stamps recency on exactly the facts whose `source_event_ids` are *fully* covered by a verified
   event set. A fact with empty provenance, or only partial coverage, is never stamped — recency is
   earned from a passing verifier, never self-asserted. The stamp does **not** mean "the fact's
   claim is true"; it means a verifier confirmed the cited events are authentic and chain-valid. So
   `runHarnessSlice` gates the stamp on a **ledger-integrity verifier** over the run's events (not on
   the diff-completion): a run with a tampered/invalid ledger stamps nothing even if it produced a
   diff. A blocked run stamps nothing.
3. **`gatingViewFromFact` was test-only** → `loadGatedMemoryFromFabric(agentDir)` projects every
   stored fact through gate #4, and `runHarnessSlice` merges the result into context behind an
   opt-in `fabricAgentDir`. **`warden harness run` enables it by default** (`fabricAgentDir: '.agent'`)
   — a real shipped production call site. It is a no-op when the fabric is empty.

## The end-to-end property

A stored fact is **`unverified` until a verifier stamps it**, then **`confirmed_fact`** — proven by
`loadGatedMemoryFromFabric` before/after `markFactsVerifiedByEvents`. So a fact only reaches the
executor as fact once (a) it has ledger provenance and (b) a passing verifier confirmed the events it
cites. This is the anti-laundering invariant extended from runs to memory: memory cannot self-assert
freshness.

## Verification

- `npm run build` clean; `node --test` **295/295** (+ new):
  - `fabric.test.ts`: `factFromWriteRecord` mapping + provenance; `appendFactFromWriteRecord`
    validate→persist + rejects ungrounded; `markFactsVerifiedByEvents` stamps only fully-covered
    facts, skips partial/empty-provenance.
  - `memory-gating.test.ts`: fabric→gate end-to-end (unstamped = `unverified`, stamped =
    `confirmed_fact`).
  - `harness-run-context.test.ts`: `fabricAgentDir` loads a stored fact into the executor prompt
    (gate #4 in prod, labeled `[unverified]`), and the completed run stamps **only** facts grounded
    in its own verified events (a fact citing an external event stays unstamped — no blanket stamp).

## Independent review

Critic (separate lane): **ACCEPT-WITH-RESERVATIONS, no Critical**. Three Major findings, all fixed
before commit:
- **In-run laundering window** — the stamp originally fired on diff-completion; now gated on a
  ledger-integrity verifier over the run's events (above), so "a diff happened" can no longer freshen
  a fact.
- **Default-on malformed-JSON crash** — `readMemoryFabric` now fails open + shape-validates (a
  corrupt `.agent/memory/fabric.json` contributes no facts instead of crashing the run);
  regression-tested.
- **scope→layer authority collapse** — documented as lossy-by-design in `factFromWriteRecord` (gate
  #4 keys on provenance + recency, not authority, so no decision impact; carrying authority is a
  future schema change).

## Honest residue

- The **positive** verifier-gated stamp (a fact *born within* a run gets stamped when that run
  completes) is wired and scoped, but the integration test asserts the *scoping* (no over-stamp); the
  positive path is covered at the unit level (`markFactsVerifiedByEvents`). The producer runs that
  create facts (`m8-boundary-evidence`, and the `core.ts` collect path) do not yet run through
  `runHarnessSlice` with `fabricAgentDir`, so cross-run stamping at scale is the next wiring.
- Only `warden harness run` enables the fabric read path so far; the daemon/skill execute phases
  don't pass `fabricAgentDir` yet. Extending it there is mechanical follow-up, deferred to keep this
  slice's blast radius small.

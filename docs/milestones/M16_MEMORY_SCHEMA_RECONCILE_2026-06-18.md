# M16 — §6 closure: reconcile memory to one provenance-keyed schema; gate #4 requires provenance

**Date:** 2026-06-18
**Plan ref:** HARNESS_OS_CORRECTED_PLAN §6 ("reconcile to ONE schema before M2/M12") + binding revision #7
**Status:** Honest. Build + full suite green (290, +2); the new gate-#4 provenance test is the
load-bearing proof.

## What §6 actually demanded vs. what was already true

§6 was written in the `driftRisk` era. Two of its three sub-asks had since been done implicitly:
- `driftRisk` is gone from all runtime schemas; and
- `evidence-contract.ts` already declares the canonical `MemoryContract { factId, sourceEventIds,
  lastVerifiedAt, authority }` — "keyed by provenance and verification recency, not ungrounded
  drift labels."

The gap that remained was that the **runtime types had not been unified to that contract**, and the
running gate was missing half of its key:

- `fabric.ts MemoryFact` had provenance (`source_event_ids`) but **no `last_verified_at`**.
- `memory-gating.ts MemoryEntry` (the gate-#4 view, consumed in production by `harness-run.ts`) had
  `lastVerifiedAt` but **no `sourceEventIds`** — so gate #4 keyed on verification *recency* only.
- `records.ts MemoryWriteRecord` (write authority) and `fabric.ts MemoryFact` (stored fact) read as
  separate vocabularies though they already share the provenance fields.

So a memory fact could be promoted to `confirmed_fact` on recency alone, with no ledger provenance.

## What shipped

- **One canonical fact** (`fabric.ts MemoryFact`): added `last_verified_at`, so the stored fact now
  carries *both* provenance (`source_event_ids`) and verification recency — matching
  `MemoryContract`. Doc comments now state the one-model/three-roles relationship explicitly
  (`MemoryWriteRecord` = write authority → `MemoryFact` = stored fact → gating projection).
- **Gate #4 now requires provenance** (`memory-gating.ts`): `classifyMemoryForInjection` returns
  `unverified` for any entry with empty `sourceEventIds`, *before* the recency check — a fact reaches
  `confirmed_fact` only with ledger provenance AND recent verification. `MemoryEntry` gained the
  `sourceEventIds` field it was missing.
- **`gatingViewFromFact(MemoryFact)`**: an adapter that projects the canonical stored fact into the
  gate view, so the gate provably consumes the one provenance model rather than a parallel
  vocabulary. A non-`success` outcome projects as `hypothesis` (never confirmed).

## Verification

- `npm run build` clean; `node --test` **290/290** (2 new):
  - *gate #4 provenance half*: a recently-verified fact with **no** provenance is `unverified`, is
    not injected, and forging it as a confirmed fact throws.
  - *gatingViewFromFact*: a canonical `MemoryFact` with provenance + recency gates as
    `confirmed_fact`; a `blocked` outcome does not.
- The pre-existing production gate path (`harness-run.ts` → `buildMemoryContextSections` /
  excluded-stale ids) still passes its T7 forgery tests unchanged.

## Honest residue (independently flagged; deferred to M2 by §6's own scope)

An independent critic review confirmed the gate logic is correct (no path to `confirmed_fact`
without provenance; ordering sound) but flagged three reach/coherence gaps. §6 explicitly says to
*stop crediting memory grading as M2 progress* — so the production wiring below is M2 work, named
here rather than silently claimed:

1. **`gatingViewFromFact` is not yet called in production.** The adapter proves the gate *can*
   consume the canonical fact, but no live `runHarnessSlice` caller currently feeds stored
   `MemoryFact`s through it — callers still pass hand-built `MemoryEntry[]`. Wiring the fabric store
   into the context path is M2.
2. **`last_verified_at` is write-dead.** The field exists on `MemoryFact` and the gate reads it, but
   no verification path writes it yet. Until a verifier stamps it, stored facts classify as
   `unverified` — fail-closed, which is the safe direction, but the recency signal is latent.
3. **`MemoryWriteRecord → MemoryFact` is prose-only.** The one-model/three-roles relationship is a
   doc contract, not code; a future `factFromWriteRecord` should make the write→store path
   executable, not just asserted.

The schema reconciliation and the provenance half of gate #4 — the parts §6 scoped here — are done
and tested. The three items above are the honest boundary of that scope.

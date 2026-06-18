# Revka → Warden Borrow & Upgrade Plan

**Date:** 2026-06-19
**Status:** Proposal for critic-panel review. NOT a completion claim.
**Basis:** Detailed read of Revka (`KumihoIO/Revka` @ `9a2bef7`, v2026.6.17) against Warden's current harness on `direction/ai-native-orchestrator`.
**Controlling thesis (unchanged):** Warden owns the *evidence/verifier/ledger/promotion* layer over rented native CLI loops. Completion is declared ONLY by the recomputable verifier over the hash-chained ledger — never by a model, a critic, or review prose. Anything borrowed must survive that constraint.

---

## 1. What the two systems are

| | **Revka** | **Warden** |
|---|---|---|
| Core | Memory-native agent runtime (Rust), fork of ZeroClaw | Provider-neutral evidence/control layer over rented executors (TS) |
| Owns | Graph memory (Kumiho), 40+ channels, 120+ tools, trust scoring, workflow DAG, 5 orchestration patterns | Hash-chained ledger, recomputable verifier, AcceptanceContract, promotion differential, memory fabric (provenance) |
| Completion authority | **LLM self-report** — refinement critic emits a `{"score":0-100}`, ≥70 = approved (`operator-mcp/.../patterns/refinement.py:57-123`) | **Recomputable acceptance** over content-addressed execute evidence in a clean checkout (`recomputeCompletionFromLedger`, `src/harness/orchestrator-skill.ts:386`) |
| Executor auth | CLI OAuth (`claude --print`, `codex exec`); subscription = runtime, no per-call API spend (`operator-mcp/.../agent_subprocess.py`) | Same model — native CLI via `-p`/`exec` (`M12_critic_panel_harness.mjs:43-47`) |

The two are **convergent on substrate** ("rent the loop"), **divergent on what layer they own**. That divergence is exactly the opportunity: Revka has orchestration *shapes* Warden lacks; Warden has a completion *gate* Revka lacks. The only safe borrow is **Revka's shapes, re-gated by Warden's recomputable verifier.**

## 2. The hard rule for every borrow

> A borrowed mechanism may add a new *shape of work* or a new *selection signal*. It may NOT introduce any path where a model's opinion, a score, or prose advances completion. The gate stays `runAcceptanceCheck` over content-addressed evidence; everything borrowed sits *upstream* of that gate (producing more/better candidate evidence) or *beside* it (advisory ordering), never *in place of* it.

Revka's own refinement gate (`score ≥ 70` from critic JSON) is **precisely the completion-laundering pattern Warden was built to refuse** — Warden's own M12 critic panel (claude lens) named "review EXECUTOR's opinion standing in for the verifier verdict" the single most dangerous regression. So we borrow Revka's *loop*, and **delete its scorer**, substituting the recomputable acceptance result as the loop's continue/stop condition.

## 3. Borrow candidates, ranked

### U1 — Verifier-gated refinement loop *(P1, in this slice)*

**Revka source:** `patterns/refinement.py` — draft → critique → fix, bounded, with a fallback ladder (same creator → fixer → escalate).
**Warden today:** `runOrchestratorSkill` runs execute **once**; if `runAcceptanceCheck` fails, `recomputeCompletionFromLedger` returns `failed` and the run blocks (`orchestrator-skill.ts:360-378`). A failed acceptance is terminal even when one more bounded attempt — fed the *actual failing evidence* — would pass.

**Upgrade:** make execute a bounded loop, `maxRefineIterations` (default 1 = today's behavior; opt-in > 1):

```
iter 1: execute → runAcceptanceCheck(executeRefs_1)
  pass → canonical execute ref = refs_1 ; stop
  fail → capture acceptance.reason + failing stdout/stderr as a content-addressed
         EvidenceRef (refs_1 stays in the store, immutable)
iter k: execute (context = original goal + verifier-failure evidence ref from iter k-1)
        → runAcceptanceCheck(executeRefs_k)
  pass → canonical execute ref = refs_k ; stop
exhausted → canonical execute ref = last iter ; completion = failed (honest block)
```

**Thesis defense:**
- The loop's *only* continue/stop signal is `runAcceptanceCheck.passed` — recomputable, clean-checkout, deterministic given the evidence. No critic score anywhere.
- The fix *context* is the verifier's own failure output (the failing command's stderr), captured as an immutable `EvidenceRef` — **not** a review executor's prose.
- Each iteration appends a distinct `phase.advanced` (`execute#k`) to the hash chain; prior iterations' evidence is never overwritten (mirrors the immutability `selectExecuteCandidateByAcceptance` already relies on).
- The winning iteration is chosen exactly like fan-out: **the iteration whose acceptance passes** (`selectExecuteCandidateByAcceptance`'s "winner by re-run, never by rank" rule, generalized over iterations instead of executors). Final completion still flows through `recomputeCompletionFromLedger` over the winning iteration's evidence.

**Honest limit (REVISED per §6.1 — the original claim was struck):** ~~this adds zero new integrity… surface unchanged~~. **Corrected:** U1 *widens* the teach-to-the-test surface — feeding the exact failing assertion plus N retries to an executor that owns file authority lowers the cost of neutering the graded test. Mitigated by operator-`testFiles` pinning (overlaid last, so the executor cannot edit the graded target) and the mandatory test-neutering forgery fixture; residual risk `R-U1-tamper`. It is a throughput/ergonomics win, not a trust win.

**Composition with fan-out:** orthogonal. Fan-out = N executors, same task, 1 round, winner by acceptance. Refinement = 1 executor, same task, N rounds, winner by acceptance. They compose (fan-out each round) but the slice ships them independent; combined mode is deferred to avoid an N×K blow-up with no proven demand.

### U2 — Verifier-grounded executor reliability score *(P1, in this slice)*

**Revka source:** `src/trust/types.rs` — per-domain `TrustScore` (decay half-life 30d, success boost 0.01, correction penalty 0.05); refinement auto-switches critic when `codex trust < 0.7`.
**Warden today:** execute fan-out picks the per-run winner by acceptance (`selectExecuteCandidateByAcceptance`) but keeps **no cross-run memory** of which executor tends to pass acceptance on which task class. Every run starts blind.

**Upgrade:** after a run, record per-executor reliability into the **memory fabric** — sourced ONLY from verifier outcomes:
- a `MemoryFact` (`layer: 'executor_reliability'`) keyed by `(executorLabel, taskClass)`, whose `source_event_ids` are the run's verified ledger events and whose `last_verified_at` is stamped via the existing `markFactsVerifiedByEvents` (so it inherits M17's ledger-integrity gate — an unverified/forged run can't stamp a fact).
- score = passes / attempts over **provenanced** facts only (empty provenance ⇒ `unverified` ⇒ excluded, via the existing gate #4 `classifyMemoryForInjection`).
- **Use:** order the fan-out candidate list (try the historically-reliable executor first; relevant when fan-out is capped or sequential) and break exact ties. Nothing else.

**Thesis defense:**
- Signal is verifier-grounded + ledger-provenanced — it reuses the M2 fabric provenance model verbatim, not a new heuristic store.
- It is **advisory-for-selection-only**. It can change *which evidence we try first*, never *whether evidence passes*. A maxed-out reliability score on a candidate whose acceptance fails still yields `failed`. Completion is 100% recomputable acceptance, untouched.
- Forgery: a tampered ledger can't stamp the fact (M17 gate); a hand-edited `fabric.json` score only mis-orders fan-out, and the per-run acceptance re-run catches the bad pick. **No completion path reads the score.**

**Honest limit:** unlike Revka's, this score may NEVER gate or auto-switch in a way that decides output acceptance — only ordering. Revka's `trust < 0.7 ⇒ switch critic` is itself a soft gate; we deliberately do not copy that semantics.

### U3 — Map-reduce decomposition *(P3, PROPOSED, explicitly OUT of this slice)*

**Revka source:** `patterns/map_reduce.py` — split into N segments, N parallel mappers, 1 reducer synthesis.
**Why deferred, not adopted now:** the split itself is an **LLM decision**, and the reducer synthesis is prose unless every segment carries its own `AcceptanceContract` and the synthesis is itself acceptance-gated. That is a real new module with real new laundering surface (a bad split that "looks complete"), and it risks becoming the "second orchestration language" Warden's M12 panel (agy lens, R5) warned against. Adopting it now would violate "one skill, not seven." **Documented as a future module with its required guard (per-segment AcceptanceContract + acceptance-gated reduce), not built in this slice.** Scope discipline over breadth.

### Not borrowed (and why)

- **Revka's refinement `parse_quality` 0-100 score / `verdict ≥ 70`** — completion-laundering by construction. Explicitly rejected; it is the anti-pattern, not a feature.
- **Trust-driven critic auto-switch as a gate** — soft gate on a heuristic; rejected (see U2 honest limit).
- **40+ channels / 120 tools / graph memory** — product-surface breadth, not layer-ownership; out of Warden's thesis scope.

## 4. Implementation slice (what actually ships)

1. **U1**: add `maxRefineIterations` to `OrchestratorSkillSpec` (+ JSON), generalize the execute phase into a bounded loop in `runOrchestratorSkill`; reuse `runAcceptanceCheck` as the gate and `selectExecuteCandidateByAcceptance`'s winner-by-acceptance rule across iterations; emit one `phase.advanced` per iteration; `recomputeCompletionFromLedger` unchanged (it already re-runs acceptance over the canonical execute refs).
2. **U2**: add `layer: 'executor_reliability'` facts; a `recordExecutorReliability(agentDir, {executorLabel, taskClass, verifiedEventIds, passed})` producer gated on `markFactsVerifiedByEvents`; an `orderCandidatesByReliability(agentDir, candidates, taskClass)` consumer used only to sort the fan-out list.
3. **Tests + forgery fixtures (mandatory, per Warden's HARD-skill rule):**
   - U1: (a) a run that fails iter 1 and passes iter 2 reports `passed` with the iter-2 evidence as canonical; (b) **forgery:** an executor that emits "FIXED — all tests pass" prose while acceptance still fails MUST yield `failed` (prose can't advance); (c) exhaustion ⇒ honest `failed`; (d) `maxRefineIterations=1` is byte-identical to today.
   - U2: (a) reliability fact with empty `source_event_ids` is excluded from scoring; (b) **forgery:** a hand-edited high score that mis-orders candidates still yields the acceptance-correct winner (score never gates); (c) a tampered ledger cannot stamp a reliability fact (inherits M17 test).
4. Build + full suite green (current baseline 321/321).

## 5. Residual honest risks

- **R-U1-determinism:** with a stochastic executor, "passed on iter k" is a real pass of *that* content-addressed evidence, but not a guarantee the next run passes on iter k. We record the iteration count; we do not claim convergence.
- **R-U1-no-new-integrity → R-U1-tamper (corrected):** refinement does NOT leave the gaming surface unchanged. Feeding exact verifier-failure evidence + N retries to a file-authoritative executor lowers the cost of teach-to-the-test (neutering the graded check). Mitigated — not eliminated — by operator-`testFiles` pinning + the test-neutering forgery fixture. The graded target of a HARD autonomous-refinement acceptance must live in operator `testFiles`, not in executor-editable evidence.
- **R-U2-cold-start:** reliability is empty until enough provenanced runs exist; ordering falls back to spec order. Acceptable (no completion impact).
- **R-scope:** U2 must never grow a gating semantics. A future PR that lets reliability skip acceptance would reintroduce laundering; called out here so review catches it.

---

## 6. Binding revisions from the Warden critic panel (2026-06-19)

Three heterogeneous critics (codex/claude/agy, each in an isolated worktree, all verifier-`supported`) returned **PROCEED-WITH-CHANGES**. Convergent blockers, now binding:

1. **Retract the "U1 adds zero new integrity / surface unchanged" claim — it is false.** A native executor owns file authority and, given the exact failing assertion plus N retries, can neuter the *graded test* rather than fix the product (teach-to-the-test / verifier-overfitting). U1 *lowers the cost* of that attack vs. one-shot. Honest framing: **U1 widens the teach-to-the-test surface; mitigated by contract+target pinning; residual risk `R-U1-tamper`.**
   - **Mitigation (already partly present):** `runAcceptanceCheck` overlays operator `testFiles` *after* the executor evidence (`orchestrator-skill.ts:244-248`), so operator-pinned test targets already win over executor edits. Binding additions: every iteration re-applies the **immutable** `spec.acceptance` (same `testFiles`); a HARD acceptance contract whose graded target is editable by the executor (not in `testFiles`) is out of scope for autonomous refinement.
   - **Forgery fixture (mandatory):** an iter-k executor that edits/neuters the failing test so it "passes" MUST still recompute to `failed` (graded against the pinned operator `testFiles`).

2. **The canonical winning iteration MUST be re-derived by re-running acceptance, never trusted as a stored pointer.** Implement U1 as the **fan-out machinery generalized over iterations**: each iteration's artifact is stored under an immutable per-iteration namespace; the winner is chosen by `selectExecuteCandidateByAcceptance` (re-run, never rank) and promoted to the canonical execute store; `recomputeCompletionFromLedger` re-runs acceptance over the promoted content-addressed bytes (it already does — it never reads a "this one won" flag).
   - **Forgery fixture (mandatory):** a ledger whose recorded canonical pointer claims a pass while honest re-derivation over the iteration refs yields `failed` MUST recompute to `failed`.

3. **U2 (executor reliability score) is REMOVED from this slice.** Deferred with named guards required before it may ship: append-only `executor_reliability_observation` facts (never a mutable verified aggregate); explicit exclusion of the reliability layer from `classifyMemoryForInjection` (no ContextBundle leak); compile-time isolation (selection logic in a module with zero import into the verifier/acceptance path); exploration floor + min-sample + decay + `not_attempted_due_to_cap` ledgering so ordering-under-cap is not a soft gate; binary-acceptance precondition for tie-breaks. **U3 (map-reduce) stays deferred.**

### Revised slice (what actually ships) — **U1 only, hardened**

- `maxRefineIterations` (default 1 = byte-identical to today) on `OrchestratorSkillSpec` + JSON.
- Execute phase becomes a bounded sequential candidate generator: iteration k+1 runs only if iteration k's acceptance failed, with iteration k's verifier-failure evidence as an immutable `EvidenceRef` context. Winner selection + promotion + recompute reuse the existing fan-out path verbatim.
- Forgery fixtures: (a) prose "FIXED" while acceptance fails ⇒ `failed`; (b) test-neutering iteration ⇒ `failed` (pinned target); (c) forged canonical pointer ⇒ recompute `failed`; (d) `maxRefineIterations=1` byte-identical; (e) exhaustion ⇒ honest `failed`.
- New residual risk **R-U1-tamper** recorded; the "zero new integrity" sentences are struck.

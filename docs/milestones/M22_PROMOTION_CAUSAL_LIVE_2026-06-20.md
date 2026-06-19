# M22 (#8) — promotion loop: strong causal verifier, CLI-exposed + live-dogfooded

**Date:** 2026-06-20
**Plan ref:** roadmap feature #8 ("fix the system, not the output"); corrected plan §3 M8
(three-run differential, closed-enum decision field); §10 R-causal-promotion (correlation ceiling).
**Status:** Honest. Build clean; `node --test` 394/394 (+1 new). Live A/A/B proven with real `claude`.

## Where #8 stood, and the gap this closes

The promotion loop had **two** mechanisms, unevenly finished:

1. **Provenance differential** (`promotion-differential.ts`, wired into `collectRun` via
   `writePromotionLearningGateForRun`): hash-chains the full loop — review finding → candidate →
   approval → apply → effect → before/after runs → a real `promotion.loaded` ledger event. Its
   evidence chain is real and recomputable (tamper any link → FAIL). **But its before/after
   `changed_field` value is synthetic** (`'promotion-not-loaded'` vs `'loaded:<id>'`, lifecycle.ts),
   so `deterministic_before_after` is true by construction. It proves the loop's *provenance*, not a
   measured behavioral *effect*.
2. **Causal verifier** (`promotion-causal.ts`): the real behavioral proof — but it was **test-only**
   (no CLI, never run against a live model).

This slice promotes mechanism #2 from test-only to a **reachable, live-proven product capability**.

## What shipped

- **`verifyPromotionCausal` gained an `executor` pass-through.** It accepted only an `executorBin`
  (native codex protocol); it now also takes a `HarnessExecutor`, threaded identically into all three
  arms — so the only between-arm difference stays the promotion context delta. This is what lets it
  drive a real `claude -p` (or any registry executor), not just codex.
- **CLI: `warden promotion verify-causal --goal <g> --promotion-file <path> [--executor codex|claude|agy] [--executor-bin <path>]`.**
  The strong proof is now an operator command, exit code 2 when non-causal.
- **Regression test** for the `executor` seam (`promotion-causal.test.ts`, +1): a pluggable
  `HarnessExecutor` drives all three arms, same as `executorBin`.

## Live dogfood (real claude, A/A/B)

`node scripts/promotion-causal-dogfood.mjs` — a strict merge-gate goal, with a "hard change-freeze →
reject all merges" promotion injected into context for the treatment arm only:

```
live executor: claude   (elapsed 56.3s)
baseline  decision: "APPROVE"
control   decision: "APPROVE"   (identical run → agreed = stable)
treatment decision: "REJECT"    (promotion in context)
contextDeltaIsPromotionOnly: true
causal: true — stable baseline/control plus promotion-only context delta changed the decision
```

This is the literal "fix the system, not the output" loop, proven on a live model: two identical runs
agreed (stability), and adding **only** the promotion text to context **flipped a real model's
decision**. The context delta is sha256-verified to be exactly the promotion (no smuggled change).

## The honesty boundary (kept explicit)

- **§10 stands:** A/A/B over a controlled single delta is **correlation, not causation** under a
  stochastic model. The report's `reason` says exactly that; this is not relabeled.
- **Stability is per-run, not guaranteed.** A live model can disagree between baseline and control by
  chance → the verifier then returns `causal: false` ("run behavior is not stable"). That is the
  **honest** outcome, not a bug — the verifier refuses to attribute an effect under instability.
- **Production gate unchanged.** `collectRun` still emits the weaker synthetic-field provenance
  differential. The strong causal verifier is now reachable and live-proven but is **not yet the
  production promotion gate**.

## Honest residue / named next step

- Make the causal verifier the production promotion gate. That needs stochastic-stability handling
  (corrected plan §3 M8: `temperature=0` or k-replay majority, record the determinism mode) so a
  flaky baseline/control pair doesn't randomly block or pass promotions.
- Replace the provenance differential's synthetic `changed_field` with the causal verifier's measured
  decision, so `deterministic_before_after` reflects a real verdict rather than a load marker.
- codex arm of the live dogfood was unavailable (account usage limit at run time); the path is
  executor-agnostic and proven on claude. Re-run with `--executor codex` once credits reset.

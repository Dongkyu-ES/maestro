# M20 (M8) — three-run promotion differential + determinism/causal honesty

**Date:** 2026-06-18
**Plan ref:** binding revision #10 ("M8: two-run → three-run differential; closed-enum decision
fields; determinism mode recorded") + §10 R-causal-promotion ("even three-run proves correlation, not
causation").
**Status:** Honest. Build + full suite green (321, +5). The production promotion path stays honestly
two-run; the three-run upgrade is the fixture/programmatic path.

## What changed

The promotion differential was a two-run before/after with a single controlled delta — which can't
distinguish a real promotion effect from run-to-run variance. This adds the A/A/B third run:

- A `baseline_run` with the same conditions as `before` and **no promotion**. The new check
  `baseline_stability_when_declared` requires (when a baseline is declared) that the baseline's
  changed-field value equals `before`'s — proving the field is deterministic absent the delta, so
  `after`'s change is attributable to the promotion, not noise.
- The report records `determinism_mode` (closed enum: `three-run-controlled-single-delta` when a
  stable baseline is present, else `two-run-single-delta`) and `causal_claim`
  (`correlation-under-controlled-single-delta`, hard-pinned — never "causation", per §10).

## Honest design: label, don't fake

The production gate-builder (`core.ts`) provides no baseline, because a genuine baseline needs a real
second no-promotion run — and **fabricating one to pass the check would be exactly the laundering
this project exists to prevent**. So the production path is honestly recorded as the weaker
`two-run-single-delta` (still PASS on the four core checks). Omitting a baseline is allowed but
*surfaced* in `determinism_mode`, not hidden. Making three-run mandatory needs the promotion flow to
execute a real baseline run — deferred, named.

## Independent review

Critic: **ACCEPT-WITH-RESERVATIONS** (no Critical; production path sound and unforgeable). Two Major
findings on the three-run *label*, both fixed before commit:
- **M1 baseline re-use:** a baseline could re-point at the `before` run (one run counted twice,
  falsely labeled three-run). Fixed: `baselineStable` now requires the baseline path AND sha differ
  from `before`. Regression-tested.
- **M2 unbacked no-promotion:** the "no promotion" guard was field-absence only (forgeable by
  dropping the field). Fixed: it is now **ledger-backed** — the baseline must carry its own
  hash-chained runtime ledger, bound to its recorded head, containing no `promotion.loaded` event.
  Regression-tested (a baseline whose ledger loaded a promotion is rejected).

## Verification

`node --test` 321/321 (+5): three-run stable baseline → `three-run-controlled-single-delta` PASS;
production two-run path → honestly `two-run-single-delta` PASS; a drifting baseline → FAIL; a
before-reuse baseline → FAIL; a baseline whose ledger loaded a promotion → FAIL. The four prior core
checks and the product-gate consumer (`decision === 'PASS'`) are unchanged.

## Honest residue

- Three-run is not yet MANDATORY (would require a real production baseline run; fabricating one is
  off-limits). The weaker two-run mode is honestly labeled, not silently accepted as three-run.
- §10 stands: even a clean three-run differential is correlation under a controlled single delta, not
  causation under a stochastic model — `causal_claim` says exactly that.

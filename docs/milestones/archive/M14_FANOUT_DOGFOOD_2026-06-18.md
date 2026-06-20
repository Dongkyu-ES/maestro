# M14 stage X — execute fan-out live dogfood (real codex + claude, parallel)

**Date:** 2026-06-18
**Spec:** `fixtures/skills/feature-builder-fanout.json` (research → execute(fan-out) → review)
**Executors:** research=codex, execute=**codex ∥ claude in parallel**, review=claude (real CLIs)
**What:** "a slugify helper buildFeatureName"
**Status:** Honest live evidence. Raw log under `reports/skill-dogfood/` (gitignored).

First end-to-end proof of stage-X multi-executor fan-out with REAL heterogeneous executors
racing in parallel, the winner chosen by recomputable acceptance.

## Result

```
research (codex)            → supported
execute  (codex ∥ claude)   → supported   (winner promoted to canonical evidence)
review   (claude)           → supported
acceptance: ran=true, passed=true, exit 0 (feature-builder.test.mjs re-run over the WINNER's
            evidence in a fresh clean checkout)
completion: passed
AUTHORITATIVE (ledger recompute, report field is display-only): completion=passed
```

Both candidates actually ran (proving real parallel fan-out, each isolated + namespaced):

```
.agent/skill-runs/<runId>/candidates/
  claude/   ← claude's execute attempt, stored under its own evidence namespace
  codex/    ← codex's execute attempt
```

The promoted canonical `artifacts/execute/feature-builder.mjs` is a real, working slugify
implementation (the candidate whose evidence passed the acceptance test). Winner selection was by
`selectExecuteCandidateByAcceptance` (re-run acceptance per candidate), never by rank/order/claim.

## Honest checks

- **Parallel, not sequential:** both candidate worktrees were created (serially, git index lock)
  and their slices ran concurrently via `runWorkersConcurrently`.
- **Fail-closed preserved:** had neither candidate passed, execute would be blocked and review
  skipped (unit-tested separately); the live run did not need to exercise that path.
- **Self-cleaning:** after the run, `.agent/worktrees/` is empty and no `wt/*` branches linger —
  the per-run namespacing + cleanup (P10) covers fan-out candidate worktrees too.
- **Recomputable:** the authoritative completion is recomputed from the ledger + the winner's
  content-addressed execute evidence, identical to the single-executor path.

## Takeaway

The anti-laundering thesis now holds through multi-executor synthesis: with two real models
competing on the same execute phase, the product picks the winner purely by re-running the
acceptance gate over each one's evidence — a model cannot win by self-claim, verbosity, or order.

# Stage 110 Evidence — Restore Recomputable Promotion Learning Gate

## Stage Objective

Restore Promotion Learning Gate PASS under the stricter verifier contract by producing or repairing digest-bound, ledger-bound promotion-learning evidence; add tests so self-certified promotion summaries cannot pass.

## Changed Files / Artifacts

- `src/harness/promotion-differential.ts`
- `src/core.test.ts`
- `.agent/hard-gates/promotion-learning.json`
- `.agent/hard-gates/promotion/effect.json`
- `.agent/runs/run-20260602070950982-udbnv7-task-20260602070019131-6/promotion-state.json`

## What Improved Toward Final Authority

Before this stage:

- `node dist/cli.js promotion verify-learning` returned FAIL.
- Product Gate reported Product Completeness Gate FAIL and Promotion Learning Gate FAIL.

After this stage:

- promotion verifier accepts explicitly rebound legacy prev-hash backfill evidence, using the same payload-hash/sequence/hash-chain constraints instead of trusting prose;
- after-run promotion state now includes raw `runtime_events_sha256`, `runtime_event_count`, `runtime_ledger_head_sha256`, `promotion_loaded_event_sequence`, and `promotion_loaded_event_sha256`;
- promotion gate now includes current `before_run_sha256`, `after_run_sha256`, and updated effect hash;
- `node dist/cli.js promotion verify-learning` returns PASS;
- latest Product Gate reports Product Completeness Gate PASS and Promotion Learning Gate PASS.

## Regression Evidence

Commands:

```bash
npm run build
node --test dist/core.test.js --test-name-pattern="G011 promotion differential|G008 promotion differential"
node dist/cli.js promotion verify-learning
node scripts/goal-reachability-harness.mjs --run-authority
```

Results:

- targeted promotion tests: PASS, including legacy prev-hash backfill and forged-summary negative tests
- promotion verify-learning: PASS
- authority: still BLOCKED, but only Hard Completion Ceiling Gate remains red
- latest Product Gate: `.agent/product-gates/product-gate-20260604050802.json`

## Current Product Completion Status

`BLOCKED`. Remaining blocker is now precise:

- Hard Completion Ceiling Gate FAIL because docs rows still declare one FAIL row / ceiling 60 and independent review is false with `provenance=no-signing-key`.

## Why This Stage Can Pass While Product Gate Still Fails

This stage removed Promotion Learning/Product Completeness blockers. It does not create independent review provenance or update hard ceiling docs, so final authority remains blocked by the final review/custody gate.

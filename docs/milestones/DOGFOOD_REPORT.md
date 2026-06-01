# Dominic Orchestration Dogfood Report

> **CORRECTION (2026-06-02):** The "95 tests, 95 pass" line below is order/state-dependent, not robust evidence. The suite is not isolated from a shared gitignored `.agent/` in the working directory, so re-runs oscillate (93/2, 94/1, 95/95); clearing the seeded fixtures yields 93/2, where the failures are the anti-self-deception gates themselves. A pristine checkout passes (96/96) only because the completion-gate tests author their own `independent-review-gate.json` fixture — i.e. they pass against a self-written fixture, not a real reviewer. See `INDEPENDENT_CRITIQUE_REPORT.md` (C1, C3).

**Date:** 2026-06-01  
**Standard:** hard-gated local product evidence; no percentage claim is allowed unless executable hard gates pass.

## Dogfood Scope

Validated the built product as an operator would use it, not by hand-editing internal `.agent` files:

1. Build product.
2. Initialize a fresh git repository.
3. Register the repo as a project.
4. Create a task.
5. Create/start/collect a real command-backed run that modifies a file.
6. Generate and approve an apply proposal record.
7. Create/start/collect a bounded two-worker multi run.
8. Cancel a run through the persistent cancel path.
9. Rebuild/show index and clean worktrees.

## Evidence

Latest smoke command produced:

```text
FINAL_PRODUCT_SMOKE_PASS root=/tmp/do-product-smoke-QmGPg9 basic_run=run-20260531164547476-mxc9pm-task-20260531164547393-t multi_run=run-20260531164547819-80e6jd-task-20260531164547393-t approval=approval-20260531164548573-4paqre-apply-proposal readonly_run=run-20260531164548926-sm8kas-task-20260531164547393-t
```

Regression suite:

```text
npm test: 95 tests, 95 pass
WEB_CSRF_SMOKE_PASS port=4397
FINAL_POLICY_EVIDENCE_PASS: unstarted collect blocked; arbitrary operator shell commands fail closed unless readonly allowlisted or exact command-digest approved; unsafe-host auth uses HttpOnly cookie for browser POSTs and does not leak tokens on unmatched POST; command secrets redacted including GitHub PATs; role env context verified
```

## Gate Result

- v0 Product Foundation: PASS with local CLI/Web/operator flow evidence.
- v1 Product Orchestration: PASS for process-backed manager/worker/reviewer adapter behavior and review evidence.
- v2 Product Multi-worker: PASS for bounded parallel worker launch, real worktree isolation, fail-closed worktree errors, deterministic conflict/mismatch blocking, typed approval-gated atomic apply proposal, live cancellation, and git-pruned worktree cleanup.

## Known Residual Risk

This is a local-first product. It does not claim hosted SaaS, remote worker daemonization, or automatic git push. Those are outside the corrected v0-v2 local product completion boundary. Foreground CLI starts are still supported, but cancellation is enforced through a persisted cancel request watched by active child processes. Mutating shell commands require a recorded approval before execution. Latest runtime architecture evidence also includes Codex app-server resume/fork/interrupt proof, full-target gate PASS, full-target verifier PASS, and server-render UI agreement PASS for the target run.


## Hard-Gate Live Integration Evidence

```text
LIVE_INTEGRATION_SMOKE_PASS live_integration_run=generated-by-scripts/live-integration-smoke.mjs
Tool / permission boundary visible on home page.
natural-language command ignored unless exact-shell confirmation is checked.
Run detail includes Run status summary and executor.process.json evidence.
```

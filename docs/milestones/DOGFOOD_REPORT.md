# Dominic Orchestration Dogfood Report

**Date:** 2026-06-01  
**Standard:** 95% product gate for v0-v2 local finished-product behavior.

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
npm test: 46 tests, 46 pass
WEB_CSRF_SMOKE_PASS port=4397
FINAL_POLICY_EVIDENCE_PASS: unstarted collect blocked; arbitrary operator shell commands fail closed unless readonly allowlisted or exact command-digest approved; unsafe-host auth uses HttpOnly cookie for browser POSTs and does not leak tokens on unmatched POST; command secrets redacted including GitHub PATs; role env context verified
```

## Gate Result

- v0 Product Foundation: PASS with local CLI/Web/operator flow evidence.
- v1 Product Orchestration: PASS for process-backed manager/worker/reviewer adapter behavior and review evidence.
- v2 Product Multi-worker: PASS for bounded parallel worker launch, real worktree isolation, fail-closed worktree errors, deterministic conflict/mismatch blocking, typed approval-gated atomic apply proposal, live cancellation, and git-pruned worktree cleanup.

## Known Residual Risk

This is a local-first product. It does not claim hosted SaaS, remote worker daemonization, or automatic git push. Those are outside the corrected v0-v2 local product completion boundary. Foreground CLI starts are still supported, but cancellation is enforced through a persisted cancel request watched by active child processes. Mutating shell commands require a recorded approval before execution.

# Current Baseline Gap Report

**Date:** 2026-06-01  
**Verdict:** Prior scaffold-level completion was invalid; current implementation has been reworked into a runnable local v0-v2 product with remaining risks tracked explicitly.

## What Exists

- TypeScript CLI prototype.
- `.agent/` file artifact generation.
- Local HTML viewer for existing artifacts.
- Tests for basic artifact lifecycle and v2 worktree conflict evidence.
- Milestone docs and reports from the prior scaffold-level pass.

## Invalidated Baseline Gaps

The previous scaffold/prototype was not a 95% complete product because:

1. Web UI is not a full operator control plane.
2. Project registry is missing.
3. Durable index/SQLite is missing.
4. Manager/Worker/Reviewer roles are not actually executed.
5. Executor adapter lifecycle is missing.
6. Approval queue is missing.
7. Promotion proposal lifecycle is missing.
8. Multi-worker scheduler/lifecycle/cancel/timeouts are incomplete.
9. Apply/merge proposal flow is missing.
10. Dogfood evidence is insufficient.

## Corrective Action

Use `FULL_PRODUCT_ROADMAP.md` and `PRODUCT_COMPLETION_STANDARD.md` as the controlling standard. Treat the current code as baseline infrastructure only.


## 2026-06-01 Progress Update

Implemented after the correction:

- Process-backed run start with stdout/stderr/exit-code artifacts.
- Project registry CLI.
- Durable `.agent/index.json` rebuild.
- Web forms for task creation, run creation, run start, and run collect.
- Approval records and CLI listing/resolution.
- Promotion proposal records from review suggestions.
- v1 manager/worker/reviewer process evidence.
- v2 real worktree creation and actual worktree diff/status conflict evidence.

Closed in the current implementation:

- Bounded parallel scheduler evidence via `scheduler.json` and regression timing test.
- Live cancellation path: `cancelRun` writes `cancel.requested`, active child process groups are terminated, descendant side effects are covered by regression tests, and CLI/Web controls persist the state.
- Worktree isolation now fails closed; unavailable worktrees do not execute inside `.agent/runs`, and cleanup removes/prunes git worktree registrations.
- Approval-gated apply proposal requires a passing collected run, clear conflict report, non-forgeable `apply_proposal` type, authoritative manifest patch set, digest bound to the approval, overlap rejection, whole-bundle precheck, and atomic apply.
- Web controls for task update/archive with validated statuses, run start/collect/cancel/apply proposal, and approval approve/reject/apply; POSTs require per-server CSRF tokens and fresh uninitialized repos self-heal `.agent/index.json` instead of 500ing.
- Product smoke dogfood recorded in `docs/milestones/DOGFOOD_REPORT.md`.

Remaining residual risk:

- This is local-first orchestration, not hosted SaaS or daemonized remote execution.
- Policy enforcement is intentionally focused on local evidence boundaries, CSRF-protected local web controls, injection-safe stored metadata rendering, strict path containment, secret/symlink-safe run rendering, fail-closed worker isolation, validated task/run states, and isolated multi-worker-only approval-gated apply; mutating operator-provided shell commands require an approval record before execution; non-mutating commands remain local operator-authorized execution.

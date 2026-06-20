# Current Baseline Gap Report

**Date:** 2026-06-01  
**Verdict:** Prior scaffold-level completion was invalid. Current implementation is now a stronger local control-plane prototype, but the current product gate is **FAIL / completion ceiling 60** until signed independent-review provenance exists. Remaining gaps are completion integrity, runtime breadth, and audit cleanliness.

## What Exists Now

- Installable TypeScript CLI and local `warden web` control plane.
- `.agent/` file-backed ledger plus `events.jsonl` runtime event ledger.
- Runtime projection and run detail UI/SSE event endpoint.
- Project/task/run/approval/apply/worktree/product-gate CLI and Web flows.
- Process-backed execution, v1 role execution evidence, v2 bounded worktree scheduler/conflict/apply evidence.
- Runtime adapter layer for shell, Codex, OMX, and agy evidence.
- Codex app-server lifecycle proof harness for resume/fork/interrupt.
- Full-target gate plus separate verifier exist, but the latest product gate intentionally fails closed at completion ceiling 60 because signed independent-review provenance is absent.

## Previously Invalidated Baseline Gaps

The previous scaffold/prototype was not a 95% complete product because the following were missing at that time. These are retained as historical correction anchors, not current status:

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

Use `HARD_COMPLETION_GATES.md` as the controlling current-truth standard. The current code is no longer baseline infrastructure only, but it must be reported as `Prototype / control-plane scaffold with hard blockers` until the hard completion gate passes with signed provenance.


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
- OMX/agy adapters are evidence/detection adapters, not full session lifecycle controllers.
- Codex app-server resume/fork/interrupt is proven through a target harness, not an always-on multi-session daemon.
- UI agreement is currently server-render smoke plus SSE endpoint visibility, not a full browser-client E2E suite.
- Policy enforcement is intentionally focused on local evidence boundaries, CSRF-protected local web controls, injection-safe stored metadata rendering, strict path containment, secret/symlink-safe run rendering, fail-closed worker isolation, validated task/run states, and isolated multi-worker-only approval-gated apply; mutating operator-provided shell commands require an approval record before execution; non-mutating commands remain local operator-authorized execution.

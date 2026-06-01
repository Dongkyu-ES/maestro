# Current Baseline Gap Report

**Date:** 2026-06-01  
**Verdict:** Prior scaffold-level completion was invalid. Current implementation has since been reworked into a PRD-scoped local v0-v2 completion candidate with product gate PASS; remaining gaps are runtime breadth/audit cleanliness, not the original scaffold gaps.

## What Exists Now

- Installable TypeScript CLI and local `agent web` control plane.
- `.agent/` file-backed ledger plus `events.jsonl` runtime event ledger.
- Runtime projection and run detail UI/SSE event endpoint.
- Project/task/run/approval/apply/worktree/product-gate CLI and Web flows.
- Process-backed execution, v1 role execution evidence, v2 bounded worktree scheduler/conflict/apply evidence.
- Runtime adapter layer for shell, Codex, OMX, and agy evidence.
- Codex app-server lifecycle proof harness for resume/fork/interrupt.
- Full-target gate plus separate verifier; latest product gate PASS with completion ceiling 95 for PRD-scoped local v0-v2.

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

Use `FULL_PRODUCT_ROADMAP.md`, `PRODUCT_COMPLETION_STANDARD.md`, and `HARD_COMPLETION_GATES.md` as the controlling standard. The current code is no longer baseline infrastructure only; it is a gated PRD-scoped local v0-v2 candidate.


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

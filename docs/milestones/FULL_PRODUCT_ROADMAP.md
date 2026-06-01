# Dominic Orchestration Full Product Roadmap: v0 → v2

**Status:** HARD-GATED; completion claims depend on executable hard gates
**Date:** 2026-06-01
**Standard:** `docs/milestones/PRODUCT_COMPLETION_STANDARD.md`

## Scope Guard

This roadmap is not allowed to invent a smaller target after implementation. The controlling target is `dominic_orchestration_PRD.md`: local webservice, task/run/worker/review/promotion control plane, v0 single run, v1 manager/worker/reviewer, v2 bounded multi-worker. SaaS, full custom Agents SDK runtime, broad MCP integration, and automatic push remain outside v0-v2 because the PRD excludes or postpones them.

Every completion report must include a Result-Reality Delta and pass the Scope Integrity Gate plus Anti-Self-Deception Critic Gate before the usual quality gates.

## Current Baseline

The current repository contains a useful scaffold/prototype:

- CLI commands exist.
- `.agent/` artifacts are created.
- tests cover baseline run creation, v1 role artifact preservation, v2 worktree conflict detection, and web evidence visibility.

This baseline is **not** v0-v2 completion under the corrected standard. After live UI/runtime failures, it is explicitly capped below 90% until `docs/milestones/HARD_COMPLETION_GATES.md` passes.

## v0 Product Foundation

### Goal

A real operator can install/run Dominic Orchestration locally, register real projects, create/manage tasks, start/collect runs, review results, and inspect all evidence through CLI and Web UI.

### Required Product Behavior

- Installable CLI (`npm link` or packaged bin) and documented local startup.
- Local server with practical Web UI, not read-only static list only.
- Project registry supporting multiple project roots.
- Durable file index or SQLite-backed index with recovery from `.agent/` files.
- Task CRUD from CLI and Web UI.
- Run create/start/collect/cancel from CLI and Web UI.
- Baseline/collect status and diff evidence.
- Review generation and status transition.
- Run detail UI showing all required evidence.
- No internal file editing required for normal happy path.

### Implementation Tasks

#### V0-PF-01 Packaging and installability
- Add `npm link`/local install instructions.
- Ensure `agent` binary works outside this repo after build/link.
- Add version/help output.

#### V0-PF-02 Project registry
- Add global or repo-local registry.
- Support `agent project add/list/show/remove`.
- Store project id, name, root path, agent dir, last opened.
- Recover invalid/missing projects safely.

#### V0-PF-03 Durable index
- Add SQLite or durable JSON/file index.
- Index projects/tasks/runs/artifacts.
- Rebuild index from `.agent/` files.
- Add schema versioning and migration guard.

#### V0-PF-04 Task CRUD
- CLI: add/list/show/update/status/delete/archive.
- Web: create/edit/status/filter task board.
- Validate frontmatter and body sections.

#### V0-PF-05 Run lifecycle
- CLI/Web: create, start, collect, cancel, show latest.
- Distinguish created/running/review/completed/failed/cancelled.
- Store baseline/collect evidence.
- Never overwrite user/operator notes.

#### V0-PF-06 Review and next action
- Deterministic review stub plus optional LLM review adapter.
- Structured decision mapping.
- Next action generation based on actual review decision.

#### V0-PF-07 Web operator UI
- Dashboard, project detail, task board, run detail.
- Forms for task/run actions.
- Evidence panes for diff/review/logs/artifacts.
- Local-only bind by default.

#### V0-PF-08 v0 dogfood
- Use the product on a separate real repo.
- Create task, run, modify file, collect, review, inspect in UI.
- Produce completion report.

### v0 Completion Gates

- Product Completeness Gate: PASS
- Real Execution Gate: PASS for run create/collect and optional executor handoff
- Evidence Integrity Gate: PASS
- Safety and Policy Gate: PASS
- Operator UX Gate: PASS
- Regression Gate: PASS
- Independent Review Gate: APPROVE/CLEAR
- Dogfood Gate: PASS

## v1 Product Orchestration

### Goal

The product runs real Manager, Worker, and Reviewer roles through executor adapters and manages the lifecycle deterministically.

### Required Product Behavior

- Role prompt templates are executed, not just written.
- Manager produces plan from task/project context.
- Orchestrator compiles/validates work order.
- Worker executes via selected adapter.
- Reviewer evaluates actual outputs/diff/logs.
- Transcripts/logs captured.
- Policies enforced before tool/action execution.
- Promotion proposals created from review findings.
- Approval artifacts visible in UI.

### Implementation Tasks

#### V1-PO-01 Executor adapter interface
- Define adapter contract: prepare, start, observe, collect, cancel.
- Implement process-backed command adapter.
- Implement OMX/Codex command templates.
- Persist stdout/stderr/exit code.

#### V1-PO-02 Manager execution
- Build context bundle.
- Execute manager role through adapter.
- Validate manager-plan schema.
- Reject invalid/unsafe plans.

#### V1-PO-03 Work order lifecycle
- Compile work order from manager recommendation.
- Enforce allowed files/tools/budget.
- Track queued/running/submitted/accepted/rejected/failed.

#### V1-PO-04 Worker execution
- Execute one worker through adapter.
- Capture transcript and workspace diff.
- Require structured worker output plus deterministic evidence.

#### V1-PO-05 Reviewer execution
- Execute reviewer role or deterministic reviewer.
- Map review decision to run/task state.
- Do not allow reviewer to mutate state directly.

#### V1-PO-06 Policy and approval artifacts
- Classify file writes, shell commands, package installs, network, git operations.
- Create approval requests for risky operations.
- Surface approvals in CLI/Web.

#### V1-PO-07 Promotion proposal pipeline
- Extract system patch suggestions.
- Create reviewable proposal files.
- No auto-apply by default.

#### V1-PO-08 v1 dogfood
- Use manager/worker/reviewer on a real repo task.
- Capture transcripts, logs, review, approval/proposal evidence.

### v1 Completion Gates

All named gates must pass, with Real Execution Gate proving roles actually ran through adapters.

## v2 Product Multi-worker

### Goal

The product safely runs bounded parallel workers in real isolated worktrees, synthesizes outputs, detects conflicts from actual workspace state, and offers approval-gated apply/merge proposals through the operator UI.

### Required Product Behavior

- Manager can propose multiple work orders.
- Orchestrator caps worker count by policy.
- Each worker gets real worktree isolation.
- Worker lifecycle is observable and cancellable.
- Actual git diff/status is collected per worktree.
- Conflicts block unsafe synthesis/apply.
- Synthesis uses actual outputs and deterministic evidence.
- Approval queue handles apply/merge proposals.
- UI shows worker lanes, conflicts, synthesis, approvals.
- Timeouts and cancellation work.

### Implementation Tasks

#### V2-PM-01 Multi-worker scheduler
- Queue and launch bounded workers.
- Enforce max worker policy.
- Track lifecycle and timeouts.

#### V2-PM-02 Real worktree lifecycle
- Create per-worker worktrees.
- Record branch/worktree metadata.
- Keep evidence until run closure.
- Add cleanup/prune command with confirmation.

#### V2-PM-03 Per-worker evidence ingestion
- Collect actual git status/diff per worktree.
- Compare actual changes to declared output.
- Treat mismatches as blockers.

#### V2-PM-04 Conflict detection
- Detect overlapping files/hunks.
- Detect denied paths and policy violations.
- Generate conflict report visible in UI.

#### V2-PM-05 Synthesis
- Synthesize accepted worker outputs.
- Separate facts, recommendations, risks.
- Block synthesis apply if conflicts exist.

#### V2-PM-06 Approval-gated apply/merge proposal
- Create patch/merge proposal.
- Show diff preview.
- Require approval before applying to main workspace.
- Never auto-push.

#### V2-PM-07 Operator UI for workers
- Worker lanes.
- Logs/transcripts.
- Worktree diff panes.
- Conflict/synthesis/approval panels.
- Cancel/retry controls.

#### V2-PM-08 v2 dogfood
- Run at least two workers on disjoint scopes and pass.
- Run adversarial overlapping scope and block.
- Run approval-gated apply proposal.

### v2 Completion Gates

All named gates must pass, including Dogfood Gate and Independent Review Gate.

## Product Acceptance Matrix

This matrix must be read as PRD-scoped v0-v2, not as a universal final-platform claim. A row may pass only when actual runnable behavior exists and the pass scope is traceable to the PRD.

| Area | 95% Product Pass Definition | Current Baseline | Status |
| --- | --- | --- | --- |
| Installable CLI | `agent` usable outside repo after documented install/link | package bin, README install/link docs, `agent --version` smoke | PASS |
| Web UI | operator can create/control tasks/runs and inspect evidence | operator/permission lane, agent work lanes, advanced shell separation, and run evidence summary implemented | PASS |
| Project registry | multiple real projects managed | CLI registry add/list/show/remove implemented | PASS |
| Durable index | index/recovery across projects/tasks/runs | `.agent/index.json` rebuild/show implemented and smoke-verified | PASS |
| v0 run lifecycle | create/start/collect/cancel/review from CLI+Web | lifecycle plus metadata reconciliation and process-evidence state truth implemented | PASS |
| v1 role execution | Manager/Worker/Reviewer actually execute via adapter | role execution remains covered, and UI now labels Start as task adapter rather than generic shell | PASS |
| Executor adapter | real process lifecycle/log/exit handling | process adapter uses absolute node path, Homebrew PATH, logs, and explicit-shell confirmation | PASS |
| Policy/approval | risky actions classified and approval-visible | permission boundary visible in UI, shell mutation approval digest/risk remains enforced | PASS |
| Promotion proposals | real review-derived proposal lifecycle | review-derived promotion records and apply proposal bundles implemented | PASS |
| v2 scheduler | bounded parallel launch/lifecycle/cancel/timeouts | bounded parallel scheduler implemented with scheduler evidence and timing regression | PASS |
| v2 worktrees | real worktree lifecycle and evidence | real worktree add, metadata, diff/status ingestion, cleanup implemented | PASS |
| Conflict detection | actual diff/hunk/policy conflict blocks | actual worktree conflict, denied path, and evidence-mismatch blocking implemented | PASS |
| Apply/merge proposal | approval-gated safe apply path | approval-gated patch proposal and approved `git apply --check` path implemented | PASS |
| Dogfood | real repo self-use with reports | live integration smoke added and dogfood report updated with operator-intent boundary evidence | PASS |
| Scope integrity | completion scope traceable to original PRD, not post-hoc shrinking | PRD local/v0-v2/non-goal sections cited in Product Gate Rerun Report | PASS |
| Anti-self-deception critic | result compared against PRD, not against implementation-friendly artifacts | hard completion ceiling blocks claims unless live hard gates, smoke, and reconciliation pass | PASS |

## Rule

No row marked FAIL can be ignored. Current PRD-scoped v0-v2 local product rows are gated by `HARD_COMPLETION_GATES.md`; future hosted, daemonized, broad MCP, custom Agents SDK runtime, or auto-push behavior must be planned as a new milestone, not silently folded into v2. A reviewer must not call this a universal final-product 95% completion claim.

# Warden Ultragoal Plan: v0 → v2

**Status:** Implementation ultragoal plan  
**Date:** 2026-05-31  
**Source PRD:** `dominic_orchestration_PRD.md`  
**Durable goal state:** `.omx/ultragoal/goals.json`, `.omx/ultragoal/ledger.jsonl`  
**Operating rule:** 각 마일스톤은 `목표 정의 → 구현 → 실무 태스크 실행 → 결과물 수집 → 목표 대비 비교 → 품질 게이트 → 실패 항목 재작업`을 통과해야 완료된다. 문서 작성만으로는 완료가 아니며, v2 구현과 검증까지 완료 범위에 포함한다.

---

## 1. Ultragoal Operating Contract

### 1.1 전체 목표

Warden을 한 번에 “완성형 개인 에이전트 OS”로 만들지 않는다. v0~v2는 다음 순서로 점진적으로 닫힌다.

```text
v0: CLI-first run record loop
  → v1: single-worker Manager/Worker/Reviewer runtime
  → v2: bounded multi-worker orchestration
```

### 1.2 완료 정의

각 마일스톤은 다음 네 가지가 모두 참일 때만 완료다.

1. **Scope Fidelity:** 해당 버전의 원래 목표를 벗어나지 않았다.
2. **Artifact Completeness:** 요구된 파일/DB/API/UI/문서 결과물이 실제로 존재한다.
3. **Verification Evidence:** 명령, 테스트, 수동 smoke, diff, review 중 하나 이상의 검증 증거가 있다.
4. **Quality Gate Pass:** 아래 공통 품질 게이트를 통과했다. 실패 시 해당 milestone은 완료가 아니라 재작업 상태다.

### 1.3 반복 루프

```text
Implement milestone tasks
  ↓
Collect actual outputs
  ↓
Compare against original milestone goal
  ↓
Run verification
  ↓
Run quality gate
  ↓
PASS → checkpoint milestone complete
FAIL → create fix tasks, return to implementation
```

### 1.4 공통 산출물 위치

```text
.agent/
  tasks/
  runs/
  policies/
  evals/
  logs/          # ignored/cache where appropriate

docs/milestones/
  ultragoal-v0-v2.md
```

---

## 2. v0 Milestone — CLI-first Run Record Loop

### 2.1 Original Goal

OMX/Codex를 계속 쓰되, 모든 작업이 `task → run → baseline/collect diff → result → review → next action`으로 남게 만든다. v0는 **CLI-first**이고 Web은 **read-only viewer** 수준으로 시작한다. 완전 자동 TUI 제어, multi-worker, 자동 commit/push, 자동 promotion 적용은 제외한다.

### 2.2 Expected Outputs

#### CLI

- `warden init`
- `warden task add "..."`
- `warden task list`
- `warden task show <task-id>`
- `warden run create <task-id>`
- `warden run collect <run-id>`
- `warden review latest`
- `warden web`

#### File artifacts

```text
.agent/
  project.yaml
  policies/
    tool-policy.yaml
    approval-policy.yaml
  evals/
    rubric.md
  tasks/
    <task-id>.md
  runs/
    <run-id>/
      run.yaml
      task.md
      context.md
      prompt.md
      baseline-status.txt
      baseline-diff.patch
      collect-status.txt
      collect-diff.patch
      diff.patch
      result.md
      review.md
      next-actions.md
```

#### Web viewer

- Task list
- Task detail
- Run detail
- Diff viewer
- Review viewer
- Status badges

### 2.3 Implementation Task List

#### V0-T01 Repository and toolchain skeleton

- Create `package.json`, `npm-lock.yaml`, `tsconfig.json`.
- Add TypeScript source layout.
- Add CLI binary entrypoint `agent`.
- Add lint/test scripts.
- Add README quickstart stub.

**Done when:** `npm install`, `npm test`, and `npm build` can run or have explicit stubs with documented follow-up.

#### V0-T02 `.agent/` initializer

- Implement `warden init`.
- Create `.agent/project.yaml` with `schema_version`, `id`, `name`, `root_path`, `default_executor`.
- Create policy/eval templates.
- Respect existing `.agent/`; do not overwrite without explicit flag.
- Add path canonicalization and project-root boundary checks.

**Done when:** running `warden init` twice is idempotent and leaves existing files safe.

#### V0-T03 Task file model

- Define task markdown frontmatter schema.
- Implement task id generation.
- Implement `task add/list/show`.
- Persist task status: `inbox`, `scoped`, `ready`, `running`, `review`, `changes_requested`, `done`, `blocked`, `cancelled`, `abandoned`.
- Add file index scan for DB-less recovery or SQLite index hydration.

**Done when:** tasks can be created, listed, shown, and recovered from files.

#### V0-T04 Run create

- Implement `warden run create <task-id>`.
- Create `.agent/runs/<run-id>/`.
- Copy task snapshot to `task.md`.
- Generate `context.md` and `prompt.md`.
- Capture `git status --short --branch` into `baseline-status.txt`.
- Capture `git diff` into `baseline-diff.patch`.
- Write `run.yaml` with `schema_version`, `id`, `task_id`, `status`, `executor`, timestamps.
- Print exact semi-auto OMX/Codex handoff command.

**Done when:** a user can start a run without any hidden state.

#### V0-T05 Run collect

- Implement `warden run collect <run-id>`.
- Capture `collect-status.txt` and `collect-diff.patch`.
- Produce `diff.patch` as the run review artifact.
- Preserve baseline diff so pre-existing dirty files are distinguishable.
- Create or prompt for `result.md`.
- Transition run to `reviewing` or `completed` depending on review mode.

**Done when:** baseline and collect artifacts prove what changed during the run.

#### V0-T06 Review v0

- Add rubric template.
- Implement deterministic review stub or Codex/OMX review prompt.
- Produce `review.md` with score, rubric breakdown, blocking issues, required changes, risks, decision, system patch suggestions.
- Produce `next-actions.md`.
- Apply state transition rule: approval belongs to Run/Approval, not Task.

**Done when:** `review.md` and task/run status are consistent.

#### V0-T07 Read-only web viewer

- Add Fastify server bound to `127.0.0.1` by default.
- Add Vite + React UI.
- Read `.agent/` files and render task/run/review/diff.
- No write actions required in v0 UI.
- Add polling or websocket for status refresh.

**Done when:** a user can inspect the full run evidence in browser.

#### V0-T08 Security baseline

- Normalize all paths with canonical realpath.
- Deny project-root escape and unsafe symlink targets.
- Add secret deny globs: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `secrets.*`, `.ssh/**`, `.config/**`.
- Restrict shell operations to git status/diff and read-only commands for v0.
- Redact secret-looking tokens from logs.

**Done when:** path/security unit tests cover root escape and secret patterns.

### 2.4 v0 Verification

Run at minimum:

```bash
npm lint
npm test
npm build
warden init
warden task add "smoke task"
warden task list
warden run create <task-id>
warden run collect <run-id>
warden web
```

Manual smoke:

- Confirm `.agent/runs/<run-id>/` contains all required v0 artifacts.
- Confirm `baseline-diff.patch` and `collect-diff.patch` are both visible.
- Confirm web viewer renders task, run, diff, review.

### 2.5 v0 Quality Gate

| Gate | Pass condition | Failure action |
| --- | --- | --- |
| Scope | No manager/worker multi-spawn, no auto commit/push, no auto promotion apply | Move feature to v1+ backlog |
| Artifact | All v0 required files exist for smoke run | Fix run create/collect |
| State | Task/Run/Approval responsibility is not mixed | Fix state transition code |
| Security | Server binds `127.0.0.1`; path escape denied | Block release until fixed |
| Reviewability | A reviewer can reconstruct what happened from files only | Add missing artifact/log |

---

## 3. v1 Milestone — Manager + Worker + Reviewer Single-worker Runtime

### 3.1 Original Goal

Introduce role-based runtime without dynamic multi-worker. v1 has one Manager, one Worker, and one Reviewer. The server still owns state transitions. LLM output is recommendation, not authority.

### 3.2 Expected Outputs

```text
.agent/runs/<run-id>/
  manager-plan.md
  work-orders/
    worker-001.yaml
  worker-outputs/
    worker-001.md
  transcript.md or transcript.jsonl
  tool-calls.jsonl
```

Runtime/API additions:

- Manager plan generation
- Work order validation against policy
- Single worker execution via OMX/Codex adapter
- Reviewer execution via rubric
- Promotion candidate proposal files only

### 3.3 Implementation Task List

#### V1-T01 Role contract templates

- Add manager, worker, reviewer prompt templates.
- Keep templates versioned.
- Include required output sections.
- Include forbidden actions: direct status mutation, policy bypass, unapproved writes.

#### V1-T02 Manager plan generation

- Implement context bundle builder from `AGENTS.md`, `project.yaml`, task, policy summary, previous run summaries.
- Generate `manager-plan.md`.
- Validate manager output structure.
- Store risks and acceptance criteria.

#### V1-T03 Work order compiler

- Convert manager recommendation into one deterministic `work-orders/worker-001.yaml`.
- Enforce allowed files, denied files, allowed tools, budget, output contract.
- Reject or request changes if plan violates policy.

#### V1-T04 Worker execution adapter

- Run single worker through OMX/Codex adapter.
- Provide only allowed context bundle.
- Capture stdout/stderr/logs.
- Capture `tool-calls.jsonl` where possible; otherwise document unavailable collection.
- Capture worker output in required markdown contract.

#### V1-T05 Reviewer role execution

- Feed task, manager plan, work order, worker output, diff, result, rubric.
- Produce `review.md`.
- Map reviewer recommendation to orchestrator-owned state transition.

#### V1-T06 Promotion proposal v1

- Extract system patch suggestions from review.
- Create promotion candidates as `.md` or `.patch` files.
- Keep promotion status `proposed`; no automatic application.

#### V1-T07 v1 UI additions

- Show manager plan.
- Show work order.
- Show worker output.
- Show reviewer decision and promotion proposal.

### 3.4 v1 Verification

```bash
npm lint
npm test
npm build
warden run create <task-id> --mode roles
warden run collect <run-id>
warden review latest
```

Manual smoke:

- Confirm exactly one worker work order exists.
- Confirm worker cannot write outside allowed scope without approval artifact.
- Confirm reviewer cannot directly set task status.

### 3.5 v1 Quality Gate

| Gate | Pass condition | Failure action |
| --- | --- | --- |
| Role separation | Manager plans, Worker executes, Reviewer evaluates | Split mixed responsibilities |
| Server authority | Orchestrator is sole state transition writer | Remove LLM-authored status mutation |
| Work order | Allowed files/tools/budget/output contract are explicit | Regenerate/reject work order |
| Review | Score, blocking issues, required changes, decision exist | Rerun reviewer |
| Promotion | Proposals are reviewable and unapplied by default | Move auto-apply to later milestone |

---

## 4. v2 Milestone — Bounded Multi-worker Orchestration

### 4.1 Original Goal

Enable safe bounded multi-worker execution with maximum worker count, scope separation, worktree isolation, synthesis, conflict detection, and review. v2 is not dynamic unlimited autonomy.

### 4.2 Expected Outputs

```text
.agent/runs/<run-id>/
  work-orders/
    worker-001.yaml
    worker-002.yaml
    worker-003.yaml
  worker-outputs/
    worker-001.md
    worker-002.md
    worker-003.md
  synthesis.md
  conflict-report.md
  review.md
```

Runtime additions:

- Max worker policy, default max 3.
- Worktree per worker or equivalent isolated workspace.
- File ownership/scope conflict detection.
- Synthesis stage before review.
- Conflict report when merge is unsafe.

### 4.3 Implementation Task List

#### V2-T01 Multi-worker policy model

- Add `limits.max_workers` enforcement.
- Add worker scope validator.
- Add shared-file conflict rules.
- Add per-worker budget enforcement.

#### V2-T02 Worktree isolation

- Implement `git worktree add` for each worker run when the project has a valid git `HEAD`.
- Use branch naming convention `agent/<run-id>/<worker-id>`.
- Capture worktree path in worker run metadata.
- Clean up only after review/approval; never destroy evidence automatically.

#### V2-T03 Parallel worker scheduling

- Dispatch up to max allowed workers.
- Track `queued`, `running`, `submitted`, `accepted`, `rejected`, `failed`, `timed_out`, `cancelled`.
- Store per-worker logs and outputs.

#### V2-T04 Conflict detection

- Compare changed files across workers.
- Detect overlapping worker-reported changed files.
- Detect policy violations and denied paths.
- Produce `conflict-report.generated.md` without overwriting human `conflict-report.md`.
- If conflict exists, stop before synthesis apply/merge.

#### V2-T05 Synthesis stage

- Combine worker outputs into `synthesis.generated.md` without overwriting human `synthesis.md`.
- Summarize accepted outputs, rejected outputs, conflicts, risks.
- Keep synthesis as recommendation; Orchestrator still owns state.

#### V2-T06 Review and approval integration

- Reviewer evaluates synthesized result plus conflict report.
- Approval artifacts are created for merge/apply operations.
- No automatic merge/push without explicit approval.

#### V2-T07 v2 UI additions

- Worker lane view.
- Worktree/branch display.
- Conflict report view.
- Synthesis view.
- Approval queue integration.

### 4.4 v2 Verification

```bash
npm lint
npm test
npm build
warden run create <task-id> --mode multi --max-workers 3
warden run collect <run-id>
warden review latest
```

Manual smoke:

- Run with two disjoint file scopes and confirm synthesis succeeds.
- Run with intentional shared-file conflict and confirm conflict report blocks completion.
- Confirm worktree evidence is retained until review completes.

### 4.5 v2 Quality Gate

| Gate | Pass condition | Failure action |
| --- | --- | --- |
| Bound | Worker count never exceeds policy max | Fix scheduler/policy enforcement |
| Isolation | Each worker has isolated workspace/worktree | Block multi-worker release |
| Conflict handling | Shared-file conflicts produce `conflict-report.md` and stop unsafe merge | Fix detector |
| Synthesis | `synthesis.md` clearly separates facts, recommendations, risks | Rerun synthesis |
| Approval | Merge/apply/push requires approval artifact | Block release until approval path works |

---

## 5. Shared Comparison and Quality Gate Protocol

### 5.1 Milestone Completion Report Template

Each milestone ends with this report:

```md
# Milestone Completion Report: vX

## Original Goal

## Expected Outputs

## Actual Outputs

## Goal vs Result Comparison

| Requirement | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- |

## Verification Run

## Quality Gate Result

## Failures / Rework Items

## Decision

PASS | REPEAT | BLOCKED
```

### 5.2 Quality Gate Checklist

A milestone passes only if all are true:

- Required commands/tests ran or have documented non-runnable reason.
- Required artifacts exist at expected paths.
- State machine transitions match PRD.
- Security constraints are not weakened.
- User-facing path works in the intended mode.
- Review output is inspectable from files.
- No hidden destructive operation occurred.
- New scope creep is moved to later milestone/backlog.

### 5.3 Repeat-until-pass Rule

If any gate fails:

1. Create rework tasks under the same milestone.
2. Mark milestone report decision as `REPEAT`.
3. Fix only the failed area.
4. Re-run verification.
5. Update the report.
6. Do not checkpoint milestone complete until decision is `PASS`.

---

## 6. Backlog Boundaries

### Move to v3+

- Custom Agents SDK runtime.
- Full MCP client orchestration.
- Dynamic worker spawn.
- Automatic memory/skill/workflow patch application.
- SaaS/multi-user sync.
- External network listeners.

### Never without explicit approval

- Automatic git commit/push.
- Destructive shell operations.
- Secret file access.
- Project-root escape.
- Unbounded worker creation.

---

## 7. Ultragoal Ledger Mapping

| OMX Goal | Milestone story | Primary document evidence |
| --- | --- | --- |
| G001 | v0 milestone execution plan | Section 2 |
| G002 | v1 single-worker runtime plan | Section 3 |
| G003 | v2 bounded multi-worker plan | Section 4 |
| G004 | Shared comparison/quality gate loop | Section 5 |
| G005 | Final verification, review, commit, push | Git commit and pushed remote |

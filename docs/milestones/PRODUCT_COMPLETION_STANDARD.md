# Warden Product Completion Standard

**Status:** Corrected standard, hardened after anti-rubber-stamp failure analysis
**Date:** 2026-06-01
**Supersedes:** any prior report that treated scaffold/MVP behavior, local-only reframing, or implementation-friendly self-review as completion.

## 1. Correction

The previous v0-v2 pass criteria were too weak. They allowed a scaffold with generated artifacts and tests to be treated as product completion. That is invalid.

Warden is complete only when it is a **95%+ complete PRD-scoped local agent orchestration product** that a real operator can use on a real repository without manually editing generated internals to make the happy path work.

The phrase **PRD-scoped** is mandatory. The scope can only be narrowed when the original PRD explicitly narrows it. For this repo, local-first is supported by the PRD itself (`dominic_orchestration_PRD.md`: local webservice, local agent work, v0 single run, v1 manager/worker/reviewer, v2 bounded multi-worker, no initial SaaS/auto-push). A reviewer may not invent a smaller scope after implementation just to pass the gate.

## 2. Why the previous critic failed

The earlier automatic critic failed because it graded the implementation against the artifacts it had just created instead of against the original product target. It was a rubber-stamp loop:

1. Build a smaller thing.
2. Rename that thing as the milestone.
3. Run tests on the smaller thing.
4. Mark the milestone complete.
5. Only during later human review admit that it is not the original product.

That loop is now forbidden. Every milestone review must begin with a **Result-Reality Delta**: original PRD/final-product intent vs actual artifacts and runnable behavior. In Korean shorthand: **원 PRD 대비 실제 결과물 차이**를 먼저 적는다.

## 3. Explicit Failure Conditions

A milestone fails if any of the following is true:

- **Scaffold-only pass:** files/classes/commands exist but the product cannot perform the real workflow.
- **MVP-only pass:** only the narrowest demo path works and normal operator flows are missing.
- **Docs-only pass:** the milestone is documented but not implemented.
- **Artifact-only fake execution:** the system creates plausible run artifacts without actually executing or observing the underlying work.
- **LLM self-certification:** model text says work is done, but deterministic evidence is missing.
- **Worker markdown trust boundary:** worker-reported markdown is used as the only source of execution truth.
- **Invisible operator state:** critical run/review/approval/conflict evidence exists only in files and is not visible in the UI/CLI.
- **Manual-internal dependency:** a normal user must edit `.agent/` internals to complete the standard path.
- **Scope shrinkage:** the review narrows the target after implementation without quoting the original PRD section that permits the narrower scope.
- **Implementation-friendly grading:** the critic grades tests, docs, or generated artifacts while avoiding the question “does this satisfy the original user/product goal?”
- **Rubber-stamp review:** the same execution lane effectively approves its own milestone without an adversarial PRD-vs-result comparison.

## 4. 95% Product Definition

95% complete means:

1. The primary happy path works end-to-end through CLI and Web UI.
2. Expected operator mistakes and failure states are handled explicitly.
3. Durable state can be recovered from disk.
4. Real executor runs are launched, tracked, collected, reviewed, and state-mapped.
5. Safety policies block risky actions and surface approvals.
6. Multi-worker execution uses real isolated workspaces and actual diff evidence.
7. All critical evidence is visible through the operator UI.
8. Tests, smoke, dogfood, and independent review pass.
9. Remaining gaps are non-core polish, not missing product behavior.
10. The scope statement is traceable to the original PRD, not to a post-hoc completion excuse.

## 5. Named Quality Gates

### 5.1 Scope Integrity Gate

Passes only if the claimed completion scope is quoted or directly traceable to the original PRD.

Required questions:
- What exact PRD objective is being claimed complete?
- What exact PRD non-goals permit any excluded behavior?
- Did the implementation introduce a smaller substitute scope?
- Are future/v3 items clearly separated from v0-v2 instead of being used as excuses?

Failure action: mark the milestone `scope_failed`; rewrite the acceptance matrix before doing more implementation.

### 5.2 Anti-Self-Deception Critic Gate

Passes only if the reviewer attacks the completion claim from the viewpoint of the original user, buyer/operator, and final product target.

The critic must answer:

| Question | Required answer shape |
| --- | --- |
| What was originally promised? | PRD-backed bullet list |
| What actually exists and runs? | files, commands, process/web evidence |
| What is missing or weaker? | explicit Result-Reality Delta |
| Is the pass standard being lowered? | yes/no with evidence |
| Is this scaffold, MVP, local-only excuse, or complete PRD-scoped product? | one explicit label |

Failure action: create blocker-resolution tasks and do not checkpoint the milestone.

### 5.3 Product Completeness Gate

Passes only if the milestone's user-visible workflow is usable without touching generated internals.

Evidence:
- CLI command transcript
- Web UI screenshots or HTTP/browser smoke
- Real repo dogfood run
- Acceptance matrix row-by-row PASS
- Result-Reality Delta showing no core missing behavior

### 5.4 Real Execution Gate

Passes only if the system actually launches or controls the executor/workflow it claims to orchestrate.

Evidence:
- process spawn record or explicit semi-auto handoff record
- stdout/stderr/log transcript
- exit status or operator completion event
- collected workspace diff from real filesystem/git state

### 5.5 Evidence Integrity Gate

Passes only if deterministic evidence is stronger than model/worker prose.

Evidence hierarchy:
1. actual filesystem/git/process state
2. persisted tool/process logs
3. structured run metadata
4. human/operator notes
5. LLM prose

Worker markdown alone is never enough.

### 5.6 Safety and Policy Gate

Passes only if risky actions are blocked, approval-gated, or explicitly recorded.

Required coverage:
- path canonicalization
- secret deny rules
- shell mutation classification
- package install approval
- git commit/push approval
- apply/merge approval
- local-only web bind by default
- unsafe host requires auth
- POST controls are CSRF-protected

### 5.7 Operator UX Gate

Passes only if a real operator can inspect and control the workflow from the UI/CLI.

Required visibility:
- projects
- tasks
- runs
- worker states
- logs/transcripts
- diffs
- reviews
- approvals
- promotions
- conflicts/synthesis
- product gate reports

### 5.8 Regression Gate

Passes only if automated tests and smoke flows cover normal and adversarial behavior.

Required:
- unit tests
- integration tests
- CLI smoke
- Web smoke
- executor smoke
- recovery smoke
- adversarial safety tests
- anti-self-deception product gate test

### 5.9 Independent Review Gate

Passes only if independent `code-reviewer` and `architect` lanes return APPROVE/CLEAR, or all blockers are fixed and re-reviewed.

Self-review, same-lane review, and implementation-summary-as-review do not pass.

### 5.10 Dogfood Gate

Passes only if Warden uses itself on this repository or a separate real repo to complete a meaningful task and produces durable evidence.

## 6. Closure Loop

Each milestone follows this loop:

```text
Restate original PRD target and non-goals
  -> implement real product behavior
  -> run automated verification
  -> run real operator smoke
  -> run dogfood scenario
  -> compare actual behavior to original PRD and acceptance matrix
  -> write Result-Reality Delta
  -> run Scope Integrity Gate
  -> run Anti-Self-Deception Critic Gate
  -> run named quality gates
  -> if any gate fails, create blocker-resolution tasks
  -> fix blockers
  -> repeat until every gate passes
```

No milestone can be marked complete while a blocker-resolution task remains open.


## 7. Hard Completion Ceiling Override

`docs/milestones/HARD_COMPLETION_GATES.md` is part of this standard. If any hard gate in that file is FAIL, then:

- `warden quality gate --write` must return FAIL;
- completion claims of 90%+, 95%+, 완제품, or v0-v2 complete are forbidden;
- reports must use the label `Prototype / control-plane scaffold with blockers`;
- the maximum completion ceiling is the value declared in `CURRENT_COMPLETION_CEILING`;
- a few follow-up fixes cannot raise the ceiling unless the executable hard gate and live-web smoke evidence both pass.

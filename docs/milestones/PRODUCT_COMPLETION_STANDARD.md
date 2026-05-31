# Dominic Orchestration Product Completion Standard

**Status:** Corrected standard, effective immediately  
**Date:** 2026-06-01  
**Supersedes:** any prior report that treated scaffold/MVP behavior as v0-v2 completion.

## 1. Correction

The previous v0-v2 pass criteria were too weak. They allowed a scaffold with generated artifacts and tests to be treated as product completion. That is invalid.

Dominic Orchestration is complete only when it is a **95%+ complete local agent orchestration product** that a real operator can use on a real repository without manually editing generated internals to make the happy path work.

## 2. Explicit Failure Conditions

A milestone fails if any of the following is true:

- **Scaffold-only pass:** files/classes/commands exist but the product cannot perform the real workflow.
- **MVP-only pass:** only the narrowest demo path works and normal operator flows are missing.
- **Docs-only pass:** the milestone is documented but not implemented.
- **Artifact-only fake execution:** the system creates plausible run artifacts without actually executing or observing the underlying work.
- **LLM self-certification:** model text says work is done, but deterministic evidence is missing.
- **Worker markdown trust boundary:** worker-reported markdown is used as the only source of execution truth.
- **Invisible operator state:** critical run/review/approval/conflict evidence exists only in files and is not visible in the UI/CLI.
- **Manual-internal dependency:** a normal user must edit `.agent/` internals to complete the standard path.

## 3. 95% Product Definition

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

## 4. Named Quality Gates

### 4.1 Product Completeness Gate

Passes only if the milestone's user-visible workflow is usable without touching generated internals.

Evidence:
- CLI command transcript
- Web UI screenshots or HTTP/browser smoke
- Real repo dogfood run
- Acceptance matrix row-by-row PASS

### 4.2 Real Execution Gate

Passes only if the system actually launches or controls the executor/workflow it claims to orchestrate.

Evidence:
- process spawn record or explicit semi-auto handoff record
- stdout/stderr/log transcript
- exit status or operator completion event
- collected workspace diff from real filesystem/git state

### 4.3 Evidence Integrity Gate

Passes only if deterministic evidence is stronger than model/worker prose.

Evidence hierarchy:
1. actual filesystem/git/process state
2. persisted tool/process logs
3. structured run metadata
4. human/operator notes
5. LLM prose

Worker markdown alone is never enough.

### 4.4 Safety and Policy Gate

Passes only if risky actions are blocked, approval-gated, or explicitly recorded.

Required coverage:
- path canonicalization
- secret deny rules
- shell mutation classification
- package install approval
- git commit/push approval
- apply/merge approval
- local-only web bind by default

### 4.5 Operator UX Gate

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

### 4.6 Regression Gate

Passes only if automated tests and smoke flows cover normal and adversarial behavior.

Required:
- unit tests
- integration tests
- CLI smoke
- Web smoke
- executor smoke
- recovery smoke
- adversarial safety tests

### 4.7 Independent Review Gate

Passes only if independent `code-reviewer` and `architect` lanes return APPROVE/CLEAR, or all blockers are fixed and re-reviewed.

### 4.8 Dogfood Gate

Passes only if Dominic Orchestration uses itself on this repository or a separate real repo to complete a meaningful task and produces durable evidence.

## 5. Closure Loop

Each milestone follows this loop:

```text
Implement real product behavior
  -> run automated verification
  -> run real operator smoke
  -> run dogfood scenario
  -> compare actual behavior to acceptance matrix
  -> run named quality gates
  -> if any gate fails, create blocker-resolution tasks
  -> fix blockers
  -> repeat until every gate passes
```

No milestone can be marked complete while a blocker-resolution task remains open.

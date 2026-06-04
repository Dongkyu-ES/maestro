---
name: goal-reachability-orchestrator
description: Drive divided goal work to the real final authority instead of stopping at sub-goal checkpoints or narrative completion.
---

# Goal Reachability Orchestrator

## When to Use

Use this skill when a repository goal must be divided into stages but previous runs risked false completion. It is especially for ultragoal, ralplan, team, or divide-and-conquer work where the real success condition is a hard gate such as Product Gate, independent review provenance, or a machine-verifiable quality report.

Do not use it for one-off edits whose success is fully proven by a single targeted test.

## Required Inputs

- the user's goal or goal document
- the repository's final authority command or artifact; if missing, discover and declare the narrowest credible one
- current known blockers from review or Product Gate
- expected final deliverables
- any explicit constraints around external review, custody, production access, or destructive actions

## Core Rule

A divided stage is not progress unless it changes, protects, or proves a named final-authority condition. Checkpoints, docs, tests, and local reviewer praise are supporting evidence, not completion authority, unless the goal contract explicitly makes them authority.

## Workflow

### 0. Postmortem Lock
Create `_workspace/goal-reachability/00_postmortem-lock.md` with:
- why prior divide-and-conquer failed;
- each escape hatch converted into a hard invariant;
- the exact phrase that must not be used until final authority passes.

### 1. Goal Contract
Create `_workspace/goal-reachability/00_goal-contract.md` with:
- final authority command(s);
- required PASS artifacts;
- forbidden substitutes;
- independent review/custody requirement;
- kill criteria;
- allowed partial status wording.

### 2. Stage Map
Create `_workspace/goal-reachability/01_stage-map.md` with one row per stage:
- stage id;
- owner/write surface;
- expected final-gate delta;
- tests/checks;
- critic prompt;
- stop condition.

### 3. Execute One Stage at a Time
For each stage, write `_workspace/goal-reachability/02_stage-{NN}-evidence.md` before claiming the stage is done. Evidence must include changed files, commands run, current Product Gate/review status, and remaining blockers.

### 4. No-Escape Critic
Write `_workspace/goal-reachability/03_stage-{NN}-critique.md`. The verdict must be exactly `PASS`, `FIX`, or `BLOCK`.
- `PASS`: no unresolved CRITICAL/HIGH issue and the stage's final-gate delta is proven.
- `FIX`: localized issues remain and can be repaired inside the stage.
- `BLOCK`: final authority, custody, or cross-stage proof is missing.

### 5. Final Gate
Run:

```bash
node scripts/goal-reachability-harness.mjs --run-authority
```

The goal is complete only if `_workspace/goal-reachability/final/reachability-report.json` has `decision: "PASS"`.

## Outputs

- `_workspace/goal-reachability/00_postmortem-lock.md`
- `_workspace/goal-reachability/00_goal-contract.md`
- `_workspace/goal-reachability/01_stage-map.md`
- `_workspace/goal-reachability/02_stage-{NN}-evidence.md`
- `_workspace/goal-reachability/03_stage-{NN}-critique.md`
- `_workspace/goal-reachability/final/reachability-report.json`
- `_workspace/goal-reachability/final/reachability-report.md`

## Validation

- Run `node scripts/goal-reachability-harness.mjs --self-test` after modifying this harness.
- Run `node scripts/goal-reachability-harness.mjs` after writing handoff files.
- Run `node scripts/goal-reachability-harness.mjs --run-authority` before saying the underlying goal is complete.

## Failure Policy

- If Product Gate fails, say `BLOCKED_BY_PRODUCT_GATE`, not complete.
- If independent review custody is required and missing, say `BLOCKED_BY_REVIEW_CUSTODY`, not complete.
- If CRITICAL/HIGH blockers remain, say `BLOCKED_BY_REVIEW`, not complete.
- If authority cannot run, say `BLOCKED_BY_AUTHORITY_UNAVAILABLE`, not complete.

## References

- `docs/harness/goal-reachability/team-spec.md`
- `.agents/skills/goal-reachability-orchestrator/references/no-escape-critic.md`


## G013 Trusted Reviewer Bundle Invariant

Final authority may not treat independent review as complete until `.github/workflows/trusted-independent-review-bundle.yml` exists, is covered by the review-input hash, is checked by `scripts/goal-reachability-harness.mjs`, and an actual successful GitHub Actions run has fetched trusted GitHub notification comments from `AGENT_TRUSTED_REVIEW_ACTORS`, produced a `trusted-independent-review-bundle` artifact, and included `reviewer-bundle-attestation.json` under protected reviewer custody. Local tests, local markdown, or implementer-owned signatures remain supporting evidence only.


## G013 Stale Review Rebinding Guard

Trusted reviewer notification comments must declare `status.reviewed_head_sha` and `status.reviewed_input_sha256`; the bundle workflow recomputes the current review input hash and rejects stale or cross-commit notifications before producing `reviewer-bundle-attestation.json`.

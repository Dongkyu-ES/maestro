# Goal Reachability Harness Team Spec

## Domain Summary

This harness exists because repeated ultragoal/divide-and-conquer runs produced many completed sub-goals while still failing the repository's real completion authority. The failure was not insufficient effort. The failure was a control-system bug: staged work closed on local artifacts, checkpoints, or tests before the top-level M7 full-target verifier, independent review provenance, and critical review blockers were proven current.

The harness treats a goal as a small product with a user-visible acceptance contract: every stage must show how it moves the final authority, and no stage may close if it leaves an unresolved CRITICAL/HIGH blocker that can invalidate the final Product Gate.

## Chosen Architecture Pattern

Pipeline + Producer-Reviewer, with optional bounded Fan-out/Fan-in only for independent implementation slices.

Why:
- goal work is sequential because acceptance criteria must be frozen before division;
- implementation can fan out only after file ownership and final gate mapping are explicit;
- every produced stage needs a reviewer/critic verdict before it can count as progress.

## Product Goal

Make goal execution reach the repository's final authority instead of merely completing sub-goals.

A run is complete only when all are true:
1. the goal contract's final authority command passes;
2. the M7 full-target verifier reports a recomputable PASS (`full-target-verification.json` / `gate.full_target.verified`) when the goal concerns product completion; the Product Gate is advisory diagnostics only and is NOT a completion authority;
3. independent review/custody requirements are either satisfied or explicitly outside the goal contract;
4. no unresolved CRITICAL/HIGH review blocker remains;
5. all stage handoff files exist and cite current evidence.

## Roles

| Role | Responsibility | Reusable skill | Writes |
| --- | --- | --- | --- |
| Contract Owner | Freezes final authority, forbidden substitutes, and kill criteria before work starts. | `.agents/skills/goal-reachability-orchestrator/SKILL.md` | `_workspace/goal-reachability/00_goal-contract.md` |
| Divider | Splits the goal into stages that each map to final authority deltas. | same | `_workspace/goal-reachability/01_stage-map.md` |
| Implementer | Executes one bounded stage at a time, with declared ownership. | existing executor/team skills | `_workspace/goal-reachability/02_stage-{NN}-evidence.md` |
| Critic | Attacks each stage for false closure, missing authority, and blocker laundering. | existing code-review/critic roles | `_workspace/goal-reachability/03_stage-{NN}-critique.md` |
| Gatekeeper | Runs deterministic harness checks and final authority commands. | `scripts/goal-reachability-harness.mjs` | `_workspace/goal-reachability/final/reachability-report.json` |

## Phase Order

### Phase 0: Postmortem Lock
- Input sources: user goal, prior failed review, current Product Gate artifacts.
- Actions: state why prior divide-and-conquer failed; convert each failure into a harness invariant.
- Output files: `_workspace/goal-reachability/00_postmortem-lock.md`.
- Completion criteria: every known escape hatch has a named invariant.

### Phase 1: Goal Contract
- Input sources: user goal, PRD/ultragoal docs, Product Gate docs, review blockers.
- Actions: define final authority command, required PASS artifacts, forbidden substitutes, and kill criteria.
- Output files: `_workspace/goal-reachability/00_goal-contract.md`.
- Completion criteria: a future agent can decide complete/blocked by running commands, not interpreting prose.

### Phase 2: Stage Map
- Input sources: goal contract.
- Actions: divide work into stages; each stage declares owner, write surface, expected final-gate delta, tests, and critic prompt.
- Output files: `_workspace/goal-reachability/01_stage-map.md`.
- Completion criteria: no stage has vague output like "improve" or "review" without a measurable gate delta.

### Phase 3: Stage Execution Loop
- Input sources: one stage from the stage map.
- Actions: implement the smallest slice; write evidence; run local checks.
- Output files: `_workspace/goal-reachability/02_stage-{NN}-evidence.md`.
- Completion criteria: evidence includes changed files, commands run, and current blocker status.

### Phase 4: No-Escape Critic
- Input sources: goal contract, stage map, stage evidence, current git diff, latest Product Gate artifact.
- Actions: request PASS/FIX/BLOCK. CRITICAL/HIGH findings block the stage.
- Output files: `_workspace/goal-reachability/03_stage-{NN}-critique.md`.
- Completion criteria: verdict is explicit and maps every blocker to either fixed, not applicable by contract, or still blocking.

### Phase 5: Final Gate
- Input sources: all handoff files, Product Gate artifacts, review artifacts.
- Actions: run `node scripts/goal-reachability-harness.mjs --run-authority`.
- Output files: `_workspace/goal-reachability/final/reachability-report.json` and `.md`.
- Completion criteria: report decision is PASS. Anything else is BLOCKED, not complete.

## Handoff Files

| From | To | File | Purpose |
| --- | --- | --- | --- |
| Contract Owner | Divider | `_workspace/goal-reachability/00_goal-contract.md` | Prevents changing the finish line mid-run. |
| Divider | Implementer | `_workspace/goal-reachability/01_stage-map.md` | Gives bounded stage ownership and final-gate delta. |
| Implementer | Critic | `_workspace/goal-reachability/02_stage-{NN}-evidence.md` | Supplies concrete evidence for adversarial review. |
| Critic | Gatekeeper | `_workspace/goal-reachability/03_stage-{NN}-critique.md` | Blocks false closure before final gate. |
| Gatekeeper | User/maintainer | `_workspace/goal-reachability/final/reachability-report.json` | Machine-readable PASS/BLOCKED verdict. |

## Failure Policy

- If the final authority command fails, the goal is `BLOCKED`, even if all stages are checked off.
- If a CRITICAL/HIGH review issue is unresolved, the goal is `BLOCKED`.
- If M7 full-target verification is required and reports non-PASS or cannot run, the goal is `BLOCKED`.
- If independent review custody is required but missing, the goal is `BLOCKED`.
- A stage may not be marked complete by docs, checkpoints, lint, or tests alone unless the goal contract explicitly says those are the final authority.
- The only allowed partial status is `PROGRESS_WITH_BLOCKERS`, never `complete`.

## Artifact Naming Convention

```text
_workspace/goal-reachability/
├── 00_postmortem-lock.md
├── 00_goal-contract.md
├── 01_stage-map.md
├── 02_stage-01-evidence.md
├── 03_stage-01-critique.md
└── final/
    ├── reachability-report.json
    └── reachability-report.md
```

## Validation Checks

- `node scripts/goal-reachability-harness.mjs --self-test`
- `node scripts/goal-reachability-harness.mjs`
- `npm run typecheck -- --pretty false`
- `npm test`
- `npm run lint`

## Test Scenarios

### Normal Flow
- Request: reach a product-completion goal.
- Expected outputs: contract, stage map, stage evidence, stage critique, final report.
- Expected final output: PASS only after M7 full-target verifier PASS and no unresolved CRITICAL/HIGH blockers.

### Failure Flow
- Failure point: M7 full-target verifier fails or latest review contains CRITICAL/HIGH blockers.
- Expected behavior: final report decision is BLOCKED and names exact blockers.
- Forbidden behavior: claiming completion because ultragoal checkpoints or tests passed.


## G013 Trusted Reviewer Bundle Invariant

Final authority may not treat independent review as complete until `.github/workflows/trusted-independent-review-bundle.yml` exists, is covered by the review-input hash, is checked by `scripts/goal-reachability-harness.mjs`, and an actual successful GitHub Actions run has fetched trusted GitHub notification comments from `AGENT_TRUSTED_REVIEW_ACTORS`, produced a `trusted-independent-review-bundle` artifact, and included `reviewer-bundle-attestation.json` under protected reviewer custody. Local tests, local markdown, or implementer-owned signatures remain supporting evidence only.


## G013 Stale Review Rebinding Guard

Trusted reviewer notification comments must declare `status.reviewed_head_sha` and `status.reviewed_input_sha256`; the bundle workflow recomputes the current review input hash and rejects stale or cross-commit notifications before producing `reviewer-bundle-attestation.json`.

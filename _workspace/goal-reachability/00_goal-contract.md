# Goal Reachability Contract

## Goal

Create a reusable harness that prevents divide-and-conquer goal work from falsely closing before the real repository authority passes.

## Final Authority For This Harness Creation Goal

This harness creation task is complete when all commands pass:

```bash
node scripts/goal-reachability-harness.mjs --self-test
node scripts/goal-reachability-harness.mjs
npm run typecheck -- --pretty false
npm test
npm run lint
```

## Final Authority For Future Product Completion Goals

A future product-completion goal is complete only when:

```bash
node scripts/goal-reachability-harness.mjs --run-authority
```

returns PASS. That command includes Product Gate execution and blocker reconciliation.

## Required Artifacts

- `.agents/skills/goal-reachability-orchestrator/SKILL.md`
- `.agents/skills/goal-reachability-orchestrator/references/no-escape-critic.md`
- `docs/harness/goal-reachability/team-spec.md`
- `scripts/goal-reachability-harness.mjs`
- `_workspace/goal-reachability/00_postmortem-lock.md`
- `_workspace/goal-reachability/00_goal-contract.md`
- `_workspace/goal-reachability/01_stage-map.md`
- `_workspace/goal-reachability/final/reachability-report.json`

## Forbidden Substitutes

- ultragoal `artifactComplete: true` alone
- tests passing while Product Gate fails
- docs saying completion without machine-readable PASS evidence
- reviewer praise without CRITICAL/HIGH blocker clearance
- caller-controlled custody issuer

## Known Current Product Blockers

Current product completion remains blocked by the latest review unless fixed:
- verifier command execution from skill contracts;
- legacy runtime ledger crash in Product Gate;
- caller-controlled independent review custody issuer;
- symlink/digest-optional HARD artifact proof;
- CI install fallback masking reproducibility.

## Kill Criteria

If a future run still has any current product blocker above, the status is `BLOCKED`, not complete.


## G013 Trusted Reviewer Bundle Invariant

Final authority may not treat independent review as complete until `.github/workflows/trusted-independent-review-bundle.yml` exists, is covered by the review-input hash, is checked by `scripts/goal-reachability-harness.mjs`, and an actual successful GitHub Actions run has fetched trusted GitHub notification comments from `AGENT_TRUSTED_REVIEW_ACTORS`, produced a `trusted-independent-review-bundle` artifact, and included `reviewer-bundle-attestation.json` under protected reviewer custody. Local tests, local markdown, or implementer-owned signatures remain supporting evidence only.


## G013 Stale Review Rebinding Guard

Trusted reviewer notification comments must declare `status.reviewed_head_sha` and `status.reviewed_input_sha256`; the bundle workflow recomputes the current review input hash and rejects stale or cross-commit notifications before producing `reviewer-bundle-attestation.json`.

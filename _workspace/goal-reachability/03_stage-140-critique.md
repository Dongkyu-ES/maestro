# Stage 140 No-Escape Critique — External Custody Preflight

## Hard critique
A preflight report is not independent review. It cannot lift Product Gate. If this stage claimed final completion, it would be another laundering step.

## Escape hatches closed
- The preflight no longer lets a dirty worktree masquerade as ready; it declares `COMMIT_REQUIRED_BEFORE_EXTERNAL_CUSTODY` until the exact reviewed code is committed, pushed to an upstream branch, GitHub custody setup exists, and the preflight is regenerated.
- It checks that local workflows still reject dispatch review prose, stale review binding, direct run-block input interpolation, and repo-controlled commands before first HMAC secret exposure.
- It records the exact review input hash required for trusted comments.
- It lists external requirements instead of generating local keys.
- It forbids local self-signing and manual gate editing.

## What remains outside local authority
First, the current commit must be pushed to an upstream branch and the missing GitHub custody setup must be configured; otherwise any reviewer comment would bind to a stale `reviewed_head_sha` and become invalid theater. After that, a trusted reviewer/CI operator must configure protected environment/secrets/vars, publish trusted notification comments, run the trusted bundle workflow, run the independent review gate workflow, and then rerun Product Gate. Until Product Gate returns PASS, G012/G006 must remain failed and the Codex aggregate goal must remain active.

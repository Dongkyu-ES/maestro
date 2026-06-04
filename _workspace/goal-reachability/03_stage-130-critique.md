# Stage 130 No-Escape Critique — Trusted Reviewer Bundle Producer

## Hard critique
A workflow file is not independent review. It only makes the external custody path executable. If this stage claimed final authority from local tests or repo-local markdown, it would repeat the same failure pattern: substituting scaffolding for Product Gate PASS.

## Escape hatches closed
- Caller-controlled reviewer paths remain rejected by `independent-review-gate.yml`; the signing workflow consumes only a prior trusted run id/artifact name plus expected agent ids.
- Dispatch inputs are not interpolated directly into shell `run` blocks in either workflow.
- Review provenance is now sensitive to `.github/workflows/trusted-independent-review-bundle.yml`; modifying the producer changes the review input hash.
- Harness structure validation now names the trusted bundle workflow as required infrastructure, so missing producer workflow cannot disappear behind passing unit tests.

## Still not enough
The final authority still requires live external custody evidence: a successful GitHub Actions `Trusted Independent Reviewer Bundle` run, HMAC bundle attestation from `AGENT_REVIEW_BUNDLE_HMAC_KEY`, and the downstream signing workflow using trusted custody/signing secrets. Until that happens, the correct state is BLOCKED at the hard completion ceiling, not complete.

## Critic-discovered blocker and repair

Initial G013 design was BLOCKED because it accepted base64 completed review text through `workflow_dispatch` and manufactured notification envelopes. That would have HMAC-signed caller-supplied prose. The repair removed completed-text dispatch inputs, requires trusted GitHub comment ids, fetches comment JSON through the GitHub API, requires `AGENT_TRUSTED_REVIEW_ACTORS`, rejects untrusted authors/prose bodies, and attests comment ids/authors plus artifact and notification digests.


## G013 Stale Review Rebinding Guard

Trusted reviewer notification comments must declare `status.reviewed_head_sha` and `status.reviewed_input_sha256`; the bundle workflow recomputes the current review input hash and rejects stale or cross-commit notifications before producing `reviewer-bundle-attestation.json`.

## Final critic closure

The local G013 implementation is no longer allowed to claim completion from shape alone. The critic forced six repairs: no dispatch review prose, no stale comment rebinding, no job-scoped secrets, no same-job repo-code-before-secret pattern, Product Gate-compatible metadata, and explicit regression tests for repo commands before first secret exposure. Final critic verdict: APPROVE. The remaining BLOCK is external custody execution, not local G013 code.

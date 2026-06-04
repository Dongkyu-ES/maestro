# Stage 130 Evidence — Trusted Reviewer Bundle Producer

## Target
Implement G013 without pretending the Product Gate is complete: add the missing trusted reviewer bundle producer and bind it into tests, hash inputs, docs, and the reachability harness.

## What changed toward final authority
- Added `.github/workflows/trusted-independent-review-bundle.yml` as the producer workflow for `Trusted Independent Reviewer Bundle` artifacts; after critic review, revised it so dispatch inputs are only selectors and the review source is trusted GitHub notification comments, not caller-supplied completed prose.
- Bound the new workflow into `currentReviewInputHash` in `src/product-gate.ts` and the mirrored test helper in `src/core.test.ts`, so changes to the bundle producer invalidate review provenance.
- Added `G013 trusted reviewer bundle workflow produces custody-attested artifact without run-block input interpolation` regression coverage.
- Extended `scripts/goal-reachability-harness.mjs` structure checks so the harness now fails if the trusted bundle workflow is missing, misnamed, lacks protected custody environment, lacks `AGENT_REVIEW_BUNDLE_HMAC_KEY`, lacks `AGENT_TRUSTED_REVIEW_ACTORS`, accepts caller-supplied completed prose, fails to fetch GitHub comments, fails to reject prose comments/untrusted authors, lacks attestation output, lacks artifact upload, or interpolates dispatch inputs directly inside `run` blocks.
- Updated `docs/milestones/REVIEW_PROVENANCE.md`, `docs/harness/goal-reachability/team-spec.md`, `.agents/skills/goal-reachability-orchestrator/SKILL.md`, and `_workspace/goal-reachability/00_goal-contract.md` to state the trusted bundle invariant.

## Verification evidence
- `npm run build`: PASS.
- `node --test dist/core.test.js --test-name-pattern 'G01[23]|review input hash'`: PASS, 102/102 selected tests passed, including G013 workflow and G012 hash tests.

## Remaining blocker
- Product Gate is still expected to fail until a real GitHub Actions run under protected reviewer custody produces the attested bundle and the signing workflow signs `.agent/independent-review-gate.json` with trusted external secrets. No local self-signing was done, no hard ceiling was lifted, and no final completion claim is made.


## G013 Stale Review Rebinding Guard

Trusted reviewer notification comments must declare `status.reviewed_head_sha` and `status.reviewed_input_sha256`; the bundle workflow recomputes the current review input hash and rejects stale or cross-commit notifications before producing `reviewer-bundle-attestation.json`.

## Final G013 verification update
- Critic Archimedes initially BLOCKED multiple escape hatches: caller-supplied completed review text, stale-review rebinding, job-scoped secret exposure, same-job background-process secret leakage, missing Product Gate review metadata, and weak regression locking.
- Repairs made: review source changed to trusted GitHub notification comments; notifications must bind `reviewed_head_sha` and `reviewed_input_sha256`; HMAC secrets are exposed only after no repo-controlled command has run; signing/prepare gates use inline workflow code before repo build/test; Product Gate-required review metadata is emitted; tests/harness reject repo-controlled commands before first secret exposure.
- Critic final verdict: APPROVE.
- Full verification: `npm test` PASS 169/169; `npm run typecheck -- --pretty false` PASS; `npm run harness:goal-reachability:self-test` PASS; `node dist/cli.js promotion verify-learning` PASS; `git diff --check` PASS.
- Authority loop: `node scripts/goal-reachability-harness.mjs --run-authority` remains intentionally BLOCKED with `.agent/product-gates/product-gate-20260604061415.json`, Product Gate FAIL, completion_ceiling 60, hard ceiling fails only because `independent_review=false (provenance=no-signing-key)`.

# Stage 140 Evidence — External Review Custody Preflight

## Target
Make the remaining G012/G006 blocker mechanically explicit without self-signing or pretending local code can complete external custody.

## What improved toward final authority
- Added `scripts/review-custody-preflight.mjs`, `scripts/review-custody-bootstrap.mjs`, `scripts/review-custody-comment-validate.mjs`, and npm scripts:
  - `harness:review-custody-preflight`
  - `harness:review-custody-preflight:self-test`
  - `harness:review-custody-bootstrap`
  - `harness:review-custody-bootstrap:self-test`
  - `harness:review-custody-comment-validate`
  - `harness:review-custody-comment-validate:self-test`
- The preflight emits:
  - `_workspace/goal-reachability/final/review-custody-preflight.json`
  - `_workspace/goal-reachability/final/review-custody-preflight.md`
- Decision now reports `COMMIT_REQUIRED_BEFORE_EXTERNAL_CUSTODY` while the worktree is dirty, and only reports `READY_FOR_EXTERNAL_CUSTODY` after the reviewed code can be bound to a clean commit/pushed head.
- It records the exact `review_input_sha256` required in trusted reviewer notification comments.
- It lists external requirements: protected environment, bundle/signing/custody secrets, trusted actor allowlist, trusted notification comment ids, trusted bundle run, independent review gate run.
- It forbids local self-signing, hand-edited `.agent/independent-review-gate.json`, and G012/G006 completion without Product Gate PASS.
- It emits exact setup command templates for branch push, GitHub environment creation, required variable/secrets, and preflight regeneration.
- The bootstrap dry-run fails closed with `MISSING_SECRET_INPUTS`; apply mode requires `--confirm-external-mutation` plus required environment variables before mutating GitHub.
- The comment validator checks trusted reviewer comments before workflow dispatch: trusted actor, JSON notification shape, distinct agent binding, reviewed head/input hash, and required APPROVE/CLEAR verdict text.
- Integrated the preflight into `scripts/goal-reachability-harness.mjs` required artifacts and structure checks.
- Added custody scripts to the canonical review input hash in `src/product-gate.ts`, both GitHub workflows, preflight, and mirrored test/build fixtures, so workflow and Product Gate hash expectations remain aligned.

## Verification evidence
- `npm test`: PASS 169/169.
- `npm run typecheck -- --pretty false`: PASS.
- `npm run harness:goal-reachability:self-test`: PASS.
- `npm run harness:review-custody-preflight:self-test`: PASS.
- `npm run harness:review-custody-bootstrap:self-test`: PASS.
- `npm run harness:review-custody-comment-validate:self-test`: PASS.
- `npm run harness:review-custody-comment-validate:self-test`: PASS.
- `node dist/cli.js promotion verify-learning`: PASS.
- `git diff --check`: PASS.
- Full local authority loop rerun:
  - `npm test`: PASS 169/169.
  - `npm run typecheck -- --pretty false`: PASS.
  - `npm run harness:goal-reachability:self-test`: PASS.
  - `npm run harness:review-custody-preflight:self-test`: PASS.
- `npm run harness:review-custody-bootstrap:self-test`: PASS.
  - `node dist/cli.js promotion verify-learning`: PASS.
  - `git diff --check`: PASS.
  - `node scripts/goal-reachability-harness.mjs --run-authority`: expected BLOCKED with `.agent/product-gates/product-gate-20260604062454.json`; all checks pass except Hard Completion Ceiling because `independent_review=false (provenance=no-signing-key)`.
- Latest `npm run harness:review-custody-preflight`: PASS as a preflight command and emits decision `PUSH_REQUIRED_BEFORE_EXTERNAL_CUSTODY`, `review_input_sha256=<fresh preflight hash>`, `reviewed_head_sha=<fresh preflight committed HEAD>`, and `git_state.dirty=false`, `git_state.has_upstream=false`, and `github_state.missing` lists missing environment/variable/secrets.

## Remaining blocker
Priority blocker is now publication plus GitHub custody setup before custody: push the committed branch to an upstream, configure the missing GitHub environment/variable/secrets, regenerate the preflight, and only then ask external reviewer/CI custody to bind comments/workflows to the regenerated `reviewed_head_sha` and `review_input_sha256`. External reviewer/CI custody must then execute the documented commands and produce signed provenance. Final authority is not complete.

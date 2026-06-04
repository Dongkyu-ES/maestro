# Stage 120 Evidence — Independent review provenance hardening

## Target gap
G012: Resolve independent review provenance and hard completion ceiling without self-signing or narrative completion.

## What improved
- Shared verifier no longer executes `test` or `diff` commands from verifier input; diff verification now requires a digest-bound status artifact.
- Independent-review GitHub signing workflow no longer accepts repo-relative reviewer artifacts from dispatch input.
- Signing workflow now requires a prior `Trusted Independent Reviewer Bundle` run for the same commit, validates workflow path/id, optional trusted actor allowlist, non-PR-target event, and an HMAC-signed `reviewer-bundle-attestation.json` over commit/run/workflow/actor/agent ids and artifact/notification digests.
- Review input hash now includes package/lockfile and gate-executed e2e/harness scripts in addition to verifier/product/workflow/docs surfaces.
- Promotion legacy backfill now requires explicit `projection_legacy_prev_hash_backfill` plus migrated event count.
- Runtime projection validates `event.run_id` against the run directory before accepting even already-linked events.
- Product Gate projection reconciliation requires explicit regenerated projection PASS evidence.

## Verification
- `npm run typecheck -- --pretty false`: PASS.
- `npm test`: PASS, 168/168.
- `npm run lint`: exit 0, warnings only (pre-existing style/any warnings remain).
- `npm run harness:goal-reachability:self-test`: PASS.
- `node dist/cli.js promotion verify-learning`: PASS.
- `node scripts/goal-reachability-harness.mjs --run-authority`: BLOCKED as expected because no external trusted signed independent-review custody is present; latest Product Gate remains FAIL / completion ceiling 60 with `independent_review=false (provenance=no-signing-key)`.

## Remaining blocker
External reviewer/CI custody evidence is still absent. This is intentional fail-closed behavior; do not lift `HARD_COMPLETION_GATES.md` or call the aggregate Codex goal complete until trusted signed review evidence exists and Product Gate PASSes.


## Independent re-review results
- Architect Pasteur: BLOCK only because external custody/signing evidence is absent; design escape hatches closed.
- Code-reviewer Galileo: APPROVE; workflow input injection blocker fixed, no remaining blocking code-review issues.

## Latest authority artifact
- `node scripts/goal-reachability-harness.mjs --run-authority`: BLOCKED. Latest observed Product Gate remains FAIL / ceiling 60 due `independent_review=false (provenance=no-signing-key)`.

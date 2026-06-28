# Independent Review Provenance Protocol

**Status:** Required before any 90/95/completion-candidate claim.
**Current local state:** FAIL-CLOSED. No signed independent-review provenance is present.

## Goal

The independent-review gate must prove more than an internally consistent JSON file. The current completion-lifting implementation accepts only the GitHub Actions trusted-bundle path: a protected `trusted-reviewer-custody` environment, allowlisted GitHub comment authors, immutable workflow/run attestation, and `reviewer-ci` custody signed by CI-held secrets. Local signatures are diagnostic only and must not be treated as hard-completion evidence.

## Required artifacts

A completion-lifting review requires all of these:

1. `.agent/independent-review-gate.json` with `status: PASS`.
2. Distinct code-reviewer and architect artifacts referenced by the gate.
3. Distinct notification envelopes for both reviewer artifacts.
4. `input_sha256` matching the current review input hash.
5. `provenance.algorithm: HMAC-SHA256` and a valid `provenance.signature` over:

```text
input_sha256:reviewer_artifact_sha256:architect_artifact_sha256
```
6. `provenance.custody` must be `reviewer-ci`. Legacy/non-CI labels such as `reviewer-owned` or `review-service` are not accepted by the product gate for completion-lifting evidence.
7. The provenance block must include custody metadata: `custody_issuer`, `review_session_id`, `reviewer_agent_id`, `reviewer_artifact_path`, `architect_artifact_path`, `reviewer_artifact_sha256`, and `architect_artifact_sha256`.
8. `provenance.custody_signature` must be a valid HMAC-SHA256 signature from a **separate custody key** over the custody label, current input hash, artifact signature, and all custody metadata:

```text
custody:input_sha256:provenance.signature:custody_issuer:review_session_id:reviewer_agent_id:reviewer_artifact_path:architect_artifact_path:reviewer_artifact_sha256:architect_artifact_sha256
```

The custody key is read from `AGENT_REVIEW_CUSTODY_HMAC_KEY` or `~/.dominic_orchestration/review-custody.key`. In the GitHub trusted-bundle path, the downloaded reviewer bundle must also include `reviewer-bundle-attestation.json` signed by `AGENT_REVIEW_BUNDLE_HMAC_KEY` and bound to the review run id, trusted workflow id/path, actor, commit SHA, agent ids, and reviewer artifact/notification digests. The product gate also requires `custody_issuer` to be present in `AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS`; test/fixture-looking issuers require explicit `AGENT_ALLOW_TEST_REVIEW_CUSTODY=1` and are not valid for production completion claims.

## Key custody rule

The signing key must live outside the repo and outside the implementer's normal write path.

Current completion-lifting custody:

- `reviewer-ci` only, produced by `.github/workflows/independent-review-gate.yml` from a successful `.github/workflows/trusted-independent-review-bundle.yml` run for the same commit.
- The trusted bundle must be produced under the protected `trusted-reviewer-custody` GitHub environment and must be bound to allowlisted GitHub comment authors, the current commit SHA, the current review input hash, the exact workflow/run identity, and the expected agent ids.

Non-lifting / disallowed custody for completion claims:

- `reviewer-owned` and `review-service` labels in local `runtime sign-review` output. These names may describe future custody models, but the current product gate does not accept them.
- Implementer-generated local key used to sign their own review.
- Committed key material.
- A key stored under the project working tree.
- Test fixture keys.

## Prepare and signing commands

First prepare the gate from external reviewer artifacts and matching notification envelopes:

```bash
maestro runtime prepare-review-gate \
  --code-reviewer-artifact .agent/review-gates/code-reviewer.md \
  --architect-artifact .agent/review-gates/architect.md \
  --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json \
  --architect-notification .agent/review-gates/subagent-notifications/architect.json \
  --code-reviewer-agent <agent-id> \
  --architect-agent <agent-id>
```

Then sign only inside trusted reviewer CI custody:

```bash
maestro runtime sign-review --custody reviewer-ci --custody-issuer <reviewer-ci-name> --review-session <ci-run-or-review-session-id>
```

The signer reads `AGENT_REVIEW_HMAC_KEY` or `~/.dominic_orchestration/review-signing.key`, computes the current review-input hash, hashes the referenced reviewer/architect artifacts, and writes `provenance.signature` into `.agent/independent-review-gate.json`. The prepare command refuses mismatched artifact/notification text before writing `.agent/independent-review-gate.json`. The signer also requires `provenance.custody` via `--custody`, existing gate metadata, or `AGENT_REVIEW_CUSTODY`; requires custody issuer/session metadata via `--custody-issuer` and `--review-session` (or `AGENT_REVIEW_CUSTODY_ISSUER` and `AGENT_REVIEW_SESSION_ID`/CI run env); then reads `AGENT_REVIEW_CUSTODY_HMAC_KEY` or `~/.dominic_orchestration/review-custody.key` and writes `provenance.custody_signature` bound to that metadata.

This command is a signer only. In a local shell it is diagnostic and non-lifting, even if it can produce HMAC-valid JSON. Hard completion requires the trusted GitHub Actions path because the product gate also checks `CI=true`, GitHub Actions session shape, allowlisted issuer, exact artifact/run attestation, and `reviewer-ci` custody. The command fails rather than writing a partial, non-lifting provenance block when custody metadata or the custody key is absent.

## Gate semantics

- No key or no signed review gate: product gate must fail closed at completion ceiling 60.
- Invalid signature: product gate must fail closed at completion ceiling 60.
- Valid signature with implementer-owned key or local shell custody: mechanically valid but not acceptable for completion claims.
- Valid provenance signature without custody metadata: mechanically valid but custody-unverified and cannot lift the ceiling.
- Valid provenance signature with custody metadata but no custody signature/key: mechanically valid but custody-unattested and cannot lift the ceiling.
- Valid provenance signature plus valid custody signature that omits issuer/session/reviewer/artifact metadata: invalid and cannot lift the ceiling.
- Valid provenance signature plus valid custody signature over current artifacts and required custody metadata, with `reviewer-ci` custody, GitHub Actions CI session, trusted bundle attestation, and an allowlisted custody issuer: eligible for hard completion gate review.
- Valid custody signature from an unallowlisted issuer, or a test/fixture issuer without explicit test-only allowance: invalid and cannot lift the ceiling.


## Trusted reviewer bundle workflow rule

The repo-local producer for this path is `.github/workflows/trusted-independent-review-bundle.yml`. It is intentionally separate from the signing workflow and must run under the protected `trusted-reviewer-custody` GitHub environment with `AGENT_REVIEW_BUNDLE_HMAC_KEY` configured as an environment/repository secret. The workflow must not accept reviewer markdown or completed review prose as dispatch input. Dispatch inputs are only selectors: expected reviewer/architect agent ids, trusted GitHub comment ids, and a safe artifact name. The workflow fetches the selected GitHub issue/PR comments through the GitHub API, requires `AGENT_TRUSTED_REVIEW_ACTORS` to be configured, rejects comment authors outside that allowlist, rejects prose comment bodies, and accepts only notification-envelope JSON whose `agent_path` matches the expected agent id, whose `status.reviewed_head_sha` equals the current commit, whose `status.reviewed_input_sha256` equals the current review input hash, and whose `status.completed` contains the required `Recommendation: APPROVE` or `Architectural Status: CLEAR` verdict. It resolves its immutable GitHub workflow id/path through the Actions API and writes `reviewer-bundle-attestation.json` with an HMAC over the exact current review input hash, comment ids, comment authors, artifact digests, notification digests, workflow identity, run id, commit SHA, actor, and agent ids. Dispatch inputs are assigned through workflow `env` and are not interpolated directly inside shell `run` blocks.

The GitHub signing workflow downloads reviewer artifacts from a prior successful workflow run named `Trusted Independent Reviewer Bundle` whose `head_sha` exactly matches the commit being signed, whose workflow path matches `AGENT_TRUSTED_REVIEW_WORKFLOW_PATH`, and whose actor is in `AGENT_TRUSTED_REVIEW_ACTORS` when that allowlist is configured. The dispatch inputs identify only that trusted run/artifact name and the expected agent ids; they do not accept repo-relative reviewer artifact paths. The bundle must contain a signed attestation over `head_sha`, `review_run_id`, `workflow_id`, `workflow_path`, `actor`, both agent ids, and SHA-256 digests for both review artifacts and notification envelopes. This prevents a branch author from committing fabricated `.agent/review-gates/*.md` files and asking CI to custody-sign them as independent review evidence.

## Current next action

Use `.github/workflows/independent-review-gate.yml` only with a successful `Trusted Independent Reviewer Bundle` GitHub Actions run for the same commit. Do not claim an equivalent local, reviewer-owned, or service-owned path unless the product gate code has been changed and tested to accept that path. The signing workflow must not read reviewer markdown directly from caller-controlled repo paths. Then rerun:

```bash
npm test
maestro runtime sign-review --custody reviewer-ci --custody-issuer <trusted-reviewer-ci> --review-session <ci-run-or-review-session-id>
node dist/cli.js quality gate --write
```

Only if the product gate returns PASS may docs use high-completion wording.

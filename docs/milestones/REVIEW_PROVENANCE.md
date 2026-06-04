# Independent Review Provenance Protocol

**Status:** Required before any 90/95/completion-candidate claim.
**Current local state:** FAIL-CLOSED. No signed independent-review provenance is present.

## Goal

The independent-review gate must prove more than an internally consistent JSON file. The current implementation proves a **mechanically valid binding** between review artifacts, notification envelopes, the current review-input hash, and a repo-external HMAC secret. It does **not** mechanically prove that the secret is held by an independent reviewer; custody remains an operational requirement until a reviewer/CI-owned signer is implemented.

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
6. `provenance.custody` must identify the claimed custody boundary (for example `reviewer-ci`, `reviewer-owned`, or `review-service`).
7. The provenance block must include custody metadata: `custody_issuer`, `review_session_id`, `reviewer_agent_id`, `reviewer_artifact_path`, `architect_artifact_path`, `reviewer_artifact_sha256`, and `architect_artifact_sha256`.
8. `provenance.custody_signature` must be a valid HMAC-SHA256 signature from a **separate custody key** over the custody label, current input hash, artifact signature, and all custody metadata:

```text
custody:input_sha256:provenance.signature:custody_issuer:review_session_id:reviewer_agent_id:reviewer_artifact_path:architect_artifact_path:reviewer_artifact_sha256:architect_artifact_sha256
```

The custody key is read from `AGENT_REVIEW_CUSTODY_HMAC_KEY` or `~/.dominic_orchestration/review-custody.key`. The product gate also requires `custody_issuer` to be present in `AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS`; test/fixture-looking issuers require explicit `AGENT_ALLOW_TEST_REVIEW_CUSTODY=1` and are not valid for production completion claims.

## Key custody rule

The signing key must live outside the repo and outside the implementer's normal write path.

Allowed custody:

- CI secret owned by a reviewer/release role.
- Reviewer-owned local key used only after independent review.
- A dedicated review service that emits the signed gate.

Disallowed custody for completion claims:

- Implementer-generated local key used to sign their own review.
- Committed key material.
- A key stored under the project working tree.
- Test fixture keys.

## Prepare and signing commands

First prepare the gate from external reviewer artifacts and matching notification envelopes:

```bash
agent runtime prepare-review-gate \
  --code-reviewer-artifact .agent/review-gates/code-reviewer.md \
  --architect-artifact .agent/review-gates/architect.md \
  --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json \
  --architect-notification .agent/review-gates/subagent-notifications/architect.json \
  --code-reviewer-agent <agent-id> \
  --architect-agent <agent-id>
```

Then sign under reviewer/CI custody:

```bash
agent runtime sign-review --custody reviewer-ci --custody-issuer <reviewer-ci-name> --review-session <ci-run-or-review-session-id>
```

The signer reads `AGENT_REVIEW_HMAC_KEY` or `~/.dominic_orchestration/review-signing.key`, computes the current review-input hash, hashes the referenced reviewer/architect artifacts, and writes `provenance.signature` into `.agent/independent-review-gate.json`. The prepare command refuses mismatched artifact/notification text before writing `.agent/independent-review-gate.json`. The signer also requires `provenance.custody` via `--custody`, existing gate metadata, or `AGENT_REVIEW_CUSTODY`; requires custody issuer/session metadata via `--custody-issuer` and `--review-session` (or `AGENT_REVIEW_CUSTODY_ISSUER` and `AGENT_REVIEW_SESSION_ID`/CI run env); then reads `AGENT_REVIEW_CUSTODY_HMAC_KEY` or `~/.dominic_orchestration/review-custody.key` and writes `provenance.custody_signature` bound to that metadata.

This command is a signer only. Valid signatures mean “the artifact bundle matches the configured secrets”; they do **not** by themselves mean “an independent reviewer approved this” unless the custody key is actually reviewer/CI-owned. The command now fails rather than writing a partial, non-lifting provenance block when custody metadata or the custody key is absent.

## Gate semantics

- No key or no signed review gate: product gate must fail closed at completion ceiling 60.
- Invalid signature: product gate must fail closed at completion ceiling 60.
- Valid signature with implementer-owned key: mechanically valid but not acceptable for completion claims.
- Valid provenance signature without custody metadata: mechanically valid but custody-unverified and cannot lift the ceiling.
- Valid provenance signature with custody metadata but no custody signature/key: mechanically valid but custody-unattested and cannot lift the ceiling.
- Valid provenance signature plus valid custody signature that omits issuer/session/reviewer/artifact metadata: invalid and cannot lift the ceiling.
- Valid provenance signature plus valid custody signature over current artifacts and required custody metadata, with an allowlisted custody issuer: eligible for hard completion gate review, subject to external custody audit.
- Valid custody signature from an unallowlisted issuer, or a test/fixture issuer without explicit test-only allowance: invalid and cannot lift the ceiling.

## Current next action

Use `.github/workflows/independent-review-gate.yml` or an equivalent reviewer-owned CI job with `AGENT_REVIEW_HMAC_KEY` and `AGENT_REVIEW_CUSTODY_HMAC_KEY` configured as CI secrets, then rerun:

```bash
npm test
agent runtime sign-review --custody reviewer-ci --custody-issuer <trusted-reviewer-ci> --review-session <ci-run-or-review-session-id>
node dist/cli.js quality gate --write
```

Only if the product gate returns PASS may docs use high-completion wording.

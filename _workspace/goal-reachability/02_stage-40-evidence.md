# Stage 40 Evidence — Independent Review Custody Workflow Hardening

## Stage Objective

Remove caller-controlled custody trust from GitHub Actions and pin trusted issuer configuration outside workflow inputs. Remove `npm ci || npm install` fallback. Add/document validation evidence.

## Changed Files

- `.github/workflows/independent-review-gate.yml`
- `scripts/goal-reachability-harness.mjs`

## What Improved Toward Final Authority

1. Removed the `workflow_dispatch.inputs.custody_issuer` input.
2. Stopped setting `AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS` from workflow caller input.
3. Pinned `AGENT_REVIEW_CUSTODY_ISSUER` to `github-actions-reviewer-ci` in the workflow.
4. Trusted issuers now come from repository/environment variable `vars.AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS` or the repo-pinned fallback literal, not from dispatch input.
5. Review session id now binds to immutable GitHub context: repository, run id, run attempt, commit SHA, and actor.
6. Removed `npm ci || npm install`; the review gate now uses `npm ci` only.
7. Goal reachability harness now fails if the workflow reintroduces caller-controlled `custody_issuer`, input-derived trusted issuers, or `npm ci || npm install`.

## Validation Evidence

Commands:

```bash
grep -n "custody_issuer\|AGENT_REVIEW_CUSTODY_ISSUER\|AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS\|npm ci" .github/workflows/independent-review-gate.yml
npm run harness:goal-reachability:self-test
npm run build
npm run harness:goal-reachability
```

Observed workflow anchors:

- `AGENT_REVIEW_CUSTODY_ISSUER: github-actions-reviewer-ci`
- `AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS: ${{ vars.AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS || 'github-actions-reviewer-ci' }}`
- `run: npm ci`
- no `custody_issuer` workflow input remains.

## Current Product Completion Status

Still `BLOCKED`. The workflow blocker is fixed, but final Product Gate remains blocked by runtime projection quarantine, promotion learning gate, independent review signing/custody absence in the current local environment, and hard completion ceiling.

## Why This Stage Can Pass While Product Gate Still Fails

This stage removes a review-trust vulnerability and dependency fallback. It does not create reviewer-owned signed artifacts or migrate/quarantine old local ledgers, so final authority remains blocked for explicit next stages.

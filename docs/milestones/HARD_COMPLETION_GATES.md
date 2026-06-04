# Hard Completion Gates: No 90/95% Inflation

> **CORRECTION (2026-06-02):** An independent critique found this "PASS / ceiling 95" status was itself inflated. From a clean `.agent/` state the gates here FAIL, and the decisive "independent review" gate is satisfiable by a hand-authored fixture (`.agent/independent-review-gate.json`), not a real reviewer. Treat the product as a **v0 prototype**, not a "completion candidate", until the integrity fixes in `INDEPENDENT_CRITIQUE_REPORT.md` (C1–C4) are addressed. The PASS rows below reflect a seeded local machine, not reproducible evidence.
>
> **PROVENANCE FIX (2026-06-02):** The independent-review gate now requires both an HMAC-SHA256 artifact signature (`provenance.signature`) over `input_sha256:reviewer_artifact_sha256:architect_artifact_sha256` and a separate custody attestation signature (`provenance.custody_signature`) over `custody:input_sha256:provenance.signature`. The signing keys are read from repo-external env/files (`AGENT_REVIEW_HMAC_KEY` / `review-signing.key`, plus `AGENT_REVIEW_CUSTODY_HMAC_KEY` / `review-custody.key`). This prevents a hand-authored `.agent/independent-review-gate.json` from lifting the ceiling without both secrets. Honest caveat: custody is still operationally meaningful only when the custody key is controlled by reviewer/CI, never the implementer.
>
> See `docs/milestones/REVIEW_PROVENANCE.md` for the required key-custody protocol.

**Status:** FAIL-CLOSED — current local gate result is FAIL / ceiling 60 until a custody-attested signed independent-review provenance artifact exists
**Created:** 2026-06-01
**Purpose:** prevent the product from being re-labeled as 90% or 95% complete after a few cosmetic fixes.

## Claim Lock

`CLAIM_LOCK: FORBID_90_95_UNTIL_ALL_HARD_GATES_PASS`

No report, milestone, final answer, quality gate, roadmap, dogfood note, or commit message may claim **90%+**, **95%+**, **완제품**, or **v0-v2 complete** while any hard gate below is failing. As of the latest local gate, the custody-attested signed independent-review provenance is absent, so high-completion wording is forbidden. The allowed wording is **Prototype / control-plane scaffold with hard blockers; 90/95 claims forbidden**.

## Current Completion Ceiling

`CURRENT_COMPLETION_CEILING: 60`

Most local hard gates pass with live evidence, but the completion ceiling remains locked because the independent-review gate now requires custody-attested signed provenance from outside the repo. Without matching signing and custody keys plus a matching `.agent/independent-review-gate.json`, the product gate must fail closed at ceiling 60.

## Non-Negotiable Hard Gates

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Local-Web State Truth Gate | Home and run detail classify created/running/waiting/failed/cancelled from process evidence, not stale status strings. No contradictory `.agent/runs/*/run.yaml` active status with `ended_at` or `cancel.requested`. | PASS |
| Real Agent Runtime Gate | Start from UI launches the task adapter by default; explicit shell is hidden under advanced confirmation. | PASS |
| Operator Intent Boundary Gate | Natural-language operator replies such as `진행해` are ignored unless the exact-shell confirmation checkbox is set. Command entry is separated under Advanced shell command. | PASS |
| Tool/Permission Adequacy Gate | UI shows allowed/approval-required/blocked tool boundaries, approval records expose risk and command preview/digest, and CLI exposes reconcile/quality paths. | PASS |
| Live Integration Gate | `scripts/live-integration-smoke.mjs` drives local web, CLI, `.agent`, run start, and run detail evidence together and prints `LIVE_INTEGRATION_SMOKE_PASS`. | PASS |
| UX Readability Gate | Home separates operator input/permissions from agent work, shows permission boundary, running/waiting/recent lanes, and run detail status summary. | PASS |
| Completion Ceiling Gate | Product gate computes `completion_ceiling`, fails on hard-gate failures, and lifts the ceiling only when this table is PASS plus live smoke, artifact reconciliation, and custody-attested signed independent-review provenance pass. | FAIL |

## Required Closure Rule

A hard gate can move to PASS only when all are true:

1. deterministic automated test exists;
2. live local-web smoke evidence exists;
3. Result-Reality Delta is updated;
4. no known contradictory run artifacts remain unreconciled;
5. `agent quality gate --write` returns PASS;
6. independent review explicitly attacks the 90/95% claim;
7. the independent-review gate has valid artifact HMAC provenance and valid custody attestation from keys stored outside the repo and held by a reviewer/CI boundary rather than the implementer.

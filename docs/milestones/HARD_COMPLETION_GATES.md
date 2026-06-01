# Hard Completion Gates: No 90/95% Inflation

**Status:** ACTIVE BLOCKER
**Created:** 2026-06-01
**Purpose:** prevent the product from being re-labeled as 90% or 95% complete after a few cosmetic fixes.

## Claim Lock

`CLAIM_LOCK: FORBID_90_95_UNTIL_ALL_HARD_GATES_PASS`

No report, milestone, final answer, quality gate, roadmap, dogfood note, or commit message may claim **90%+**, **95%+**, **완제품**, or **v0-v2 complete** while any hard gate below is failing.

## Current Completion Ceiling

`CURRENT_COMPLETION_CEILING: 60`

Until every hard gate below passes with live evidence, the maximum allowed completion claim is:

> **Prototype / control-plane scaffold with useful artifacts, not a 95% product.**

## Non-Negotiable Hard Gates

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Local-Web State Truth Gate | Home and run detail classify created/running/waiting/failed/cancelled from process evidence, not stale status strings. No contradictory `.agent/runs/*/run.yaml` active status with `ended_at` or `cancel.requested`. | PASS |
| Real Agent Runtime Gate | Start from UI launches the task adapter by default; explicit shell is hidden under advanced confirmation. | PASS |
| Operator Intent Boundary Gate | Natural-language operator replies such as `진행해` are ignored unless the exact-shell confirmation checkbox is set. Command entry is separated under Advanced shell command. | PASS |
| Tool/Permission Adequacy Gate | UI shows allowed/approval-required/blocked tool boundaries, approval records expose risk and command preview/digest, and CLI exposes reconcile/quality paths. | PASS |
| Live Integration Gate | `scripts/live-integration-smoke.mjs` drives local web, CLI, `.agent`, run start, and run detail evidence together and prints `LIVE_INTEGRATION_SMOKE_PASS`. | PASS |
| UX Readability Gate | Home separates operator input/permissions from agent work, shows permission boundary, running/waiting/recent lanes, and run detail status summary. | PASS |
| Completion Ceiling Gate | Product gate computes `completion_ceiling`, fails on hard-gate failures, and lifts the ceiling only when this table is PASS plus live smoke and artifact reconciliation pass. | PASS |

## Required Closure Rule

A hard gate can move to PASS only when all are true:

1. deterministic automated test exists;
2. live local-web smoke evidence exists;
3. Result-Reality Delta is updated;
4. no known contradictory run artifacts remain unreconciled;
5. `agent quality gate --write` returns PASS;
6. independent review explicitly attacks the 90/95% claim.


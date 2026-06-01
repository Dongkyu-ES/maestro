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
| Local-Web State Truth Gate | Home and run detail classify created/running/waiting/failed/cancelled from process evidence, not stale status strings. No contradictory `.agent/runs/*/run.yaml` active status with `ended_at` or `cancel.requested`. | FAIL |
| Real Agent Runtime Gate | Start from UI launches a real selected executor/adapter for the task, not a default smoke command, unless the operator explicitly chooses smoke. | FAIL |
| Operator Intent Boundary Gate | Natural-language operator replies such as `진행해` cannot be captured as shell commands. Command entry must be visually and semantically separated from approval/input controls. | FAIL |
| Tool/Permission Adequacy Gate | UI/CLI shows allowed tools, denied tools, approval reason, command digest, and exact risk before action. | FAIL |
| Live Integration Gate | Local LaunchAgent/web runtime, CLI, `.agent` store, process runner, approvals, and browser-visible pages are smoke-tested together in one scripted scenario. | FAIL |
| UX Readability Gate | A real operator can answer “what is waiting for me, what is the agent doing, what finished, what failed, why” from the first screen without opening raw files. | FAIL |
| Completion Ceiling Gate | Product gate computes a ceiling and fails if any hard gate fails. | FAIL |

## Required Closure Rule

A hard gate can move to PASS only when all are true:

1. deterministic automated test exists;
2. live local-web smoke evidence exists;
3. Result-Reality Delta is updated;
4. no known contradictory run artifacts remain unreconciled;
5. `agent quality gate --write` returns PASS;
6. independent review explicitly attacks the 90/95% claim.


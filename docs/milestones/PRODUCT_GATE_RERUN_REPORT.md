# Product Gate Rerun Report

> **CURRENT TRUTH (2026-06-02):** This historical rerun report is superseded by `HARD_COMPLETION_GATES.md`. The current gate is FAIL / completion ceiling 60 because signed independent-review provenance is absent. Treat older PASS wording below as historical, not current.

**Date:** 2026-06-01  
**Trigger:** User rejected the previous automatic critic because it only became realistic after implementation and did not enforce the final-product/PRD target during the loop.  
**Decision standard:** `docs/milestones/PRODUCT_COMPLETION_STANDARD.md` with Scope Integrity Gate and Anti-Self-Deception Critic Gate.

## 1. Non-negotiable correction

The gate no longer accepts these statements as completion evidence by themselves:

- “tests pass”
- “docs exist”
- “CLI command exists”
- “artifact folder exists”
- “the implementation is good for the smaller scope I chose”
- “local-first” unless the original PRD supports local-first for the milestone

The gate must compare the actual product against `dominic_orchestration_PRD.md` and the v0-v2 roadmap.

## 2. Result-Reality Delta

| Original PRD / v0-v2 target | Current runnable evidence | Delta |
| --- | --- | --- |
| Local webservice control plane | `maestro web`, loopback server, task/run/approval forms | PRD-scoped local target satisfied; not SaaS and not claimed as SaaS |
| Task/run/review durable state | `.agent/tasks`, `.agent/runs`, `.agent/index.json`, review/next-actions | Satisfied for local file-backed product |
| Manager/Worker/Reviewer v1 runtime | roles mode launches manager, worker, reviewer process records | Process-backed adapter exists; not a full custom LLM runtime, which PRD places later |
| Bounded v2 multi-worker | git worktrees, bounded max workers, scheduler evidence, conflict reports | Satisfied for local worktree model |
| Deterministic server decides state | `collectRun`, `writeReview`, `updateTaskStatus`, approval state records | Satisfied for implemented modes |
| Safety before autonomy | path/secret checks, shell mutation approvals, CSRF/auth for unsafe host, apply digest/check | Satisfied for local command/control boundary |
| Promotion learning loop | promotion proposal records from review findings | Basic proposal lifecycle exists; not automatic memory/skill application, which PRD excludes early |

## 3. Scope Integrity Gate

**Decision:** HISTORICAL PASS for PRD-scoped v0-v2 only; current completion gate is FAIL-CLOSED / ceiling 60 until signed independent-review provenance exists.

Evidence:

- PRD says maestro is a local webservice control plane.
- PRD v0/v1/v2 scope is single run, manager/worker/reviewer, bounded multi-worker.
- PRD explicitly excludes initial SaaS, automatic push, full custom Agents SDK runtime, and broad MCP integration.

Constraint:

This PASS does **not** mean “universal final agent platform 95% complete.” It means the current claim is limited to PRD-scoped local v0-v2. Any broader final-product claim must be a new milestone with its own PRD.

## 4. Anti-Self-Deception Critic Gate

**Decision:** PARTIAL after hardening; current hard completion gate still fails closed without signed independent-review provenance.

Why it passes now:

- The completion standard now contains an explicit rubber-stamp failure analysis.
- A new executable product gate command exists: `maestro quality gate --write`.
- The gate now emits a generated `result_reality_delta` array derived from current PRD anchors, built CLI behavior, acceptance matrix rows, dogfood identifiers, and regression evidence.
- The gate checks PRD scope integrity, anti-self-deception language, real execution evidence, deterministic evidence integrity, safety/policy, UX exposure, tests, and dogfood evidence.
- Regression tests cover both the passing current repo and a fake string-only repo that must fail.

Why the previous loop failed:

- It allowed implementation-friendly grading.
- It did not require Result-Reality Delta.
- It treated local v0-v2 evidence as if it automatically answered the broader “95% 완제품” phrase.

## 5. Rerun Quality Gate Checklist

| Gate | Result | Evidence |
| --- | --- | --- |
| Scope Integrity Gate | HISTORICAL PASS | PRD-backed local v0-v2 scope; no post-hoc local-only invention |
| Anti-Self-Deception Critic Gate | HISTORICAL PASS | standard hardened; executable gate added; regression test added |
| Product Completeness Gate | HISTORICAL PASS | acceptance matrix + CLI/Web controls + run viewer |
| Real Execution Gate | HISTORICAL PASS | process JSON, scheduler JSON, stdout/stderr logs |
| Evidence Integrity Gate | HISTORICAL PASS | actual worktree diff compared to worker output |
| Safety and Policy Gate | HISTORICAL PASS | safeJoin, secret deny, shell approvals, CSRF/auth, apply digest/check |
| Operator UX Gate | HISTORICAL PASS | CLI + Web task/run/approval/product evidence paths |
| Regression Gate | HISTORICAL PASS after `npm test` rerun | see command evidence below |
| Dogfood Gate | HISTORICAL PASS for existing recorded dogfood | `DOGFOOD_REPORT.md` evidence |

## 6. Commands rerun

```text
npm run build
npm test
node dist/cli.js quality gate --write
```

The exact command output is recorded in the current agent transcript and the latest `.agent/product-gates/*.json` file. The latest report includes its own `report_path` plus generated `result_reality_delta` rows, so the gate is not only a manually authored narrative.

## 7. Final wording guard

Allowed completion claim now:

> Prototype / control-plane scaffold with hard blockers; 90/95 claims forbidden until signed independent-review provenance exists and `maestro quality gate --write` passes.

Forbidden completion claim:

> The whole imaginable final product is 95% complete.

The second statement is still invalid unless a broader PRD is written and passed.

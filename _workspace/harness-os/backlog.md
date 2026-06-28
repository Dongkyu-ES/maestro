# Harness-OS Redirected Backlog (supervisor: Claude, implementer: Codex)

Goal: provider-neutral harness-OS spine (own rules/memory/hooks/context/policy/ledger/verifier/promotion; LLMs+Codex are executors). Source of truth: `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`.

Pivot (2026-06-05): STOP chasing solo independent-review custody (structurally unreachable for a single principal). Cap it by construction; redirect effort to real spine capability. The old goal-reachability loop's custody stages are deprecated.

## Tasks (one at a time, Codex implements, Claude verifies + commits)

| # | Task | Why | Size | Status |
|---|---|---|---|---|
| T0 | **Solo ceiling cap** — classify the independent-review blocker as `external_principal_required`, expose `solo_ceiling_cap` + `independence_locally_reachable:false`; keep decision honest (no inflation). Reclassify it in the goal-contract so no further local stage targets it. | Ends the custody detour honestly; stops the loop. | S | DONE |
| T1 | End-to-end harness run slice | done (verifier-gated) | L | DONE |
| T2 | **M3 Product Hook Runtime** — lifecycle hooks that can BLOCK (BeforeToolExecution), wired into the run slice. | Critique: hooks absent (0 in src). Real harness ownership. | M | DONE |
| T3 | **M1 BaseRule Engine** — compile BaseRuleSet → prompt segment + policy assertion with hardness enforcement; `prompt_only` vs `policy_enforced`/`verifier_enforced`. | The product owns its rules, not AGENTS.md/CLAUDE.md. | M | DONE |
| T4 | **M8 real causal control-run** — promotion-differential re-executes baseline-WITHOUT vs WITH promotion (real 3-run), hand-authored effect fails. | Last theater point in the learning loop. | M | DONE |
| T5 | **Web dashboard — finish the operator surface** — redesigned to a dark mission-control UI (commit `7c94da0`) but still feature-incomplete; treat as WIP, NOT a shipped product surface. Define what "done" means for the web UI. | The web mode was a half-abandoned surface; the look is fixed but the feature set isn't. | M | WIP |

Done so far on this branch: M-1 integrity baseline, L ledger hash-chain, M7.1 reviewer-decision, evidence-contract, verifier (input-sensitive), native-evidence, context-provenance, skill-contracts, provider-normalization fixtures, harness integrity meta-gate.

## Open follow-ups (2026-06-28)

- **Web dashboard is WIP** (T5) — visually redesigned (dark mission-control), not feature-complete. Don't present it as finished.
- **BYO executor only reaches `harness run`** — `maestro magic run` (the path the `/maestro` skill uses most) still hard-codes `codex|claude|agy`. Generalize its routing to arbitrary `--executor-bin`, same as `resolveHarnessExecutor`.
- **Web run-creation form can't set `--executor-bin`** — so bring-your-own executors aren't selectable from the UI yet.
- _(optional)_ git history still carries `ciuizz@naver.com` on ~170 commits — left by choice; scrub via `git filter-repo` if it should go before wider sharing.
- _(optional)_ disabled LaunchAgent plist `~/Library/LaunchAgents/com.dominic.orchestration.web.plist` still on disk (auto-start already disabled).

# Harness-OS Redirected Backlog (supervisor: Claude, implementer: Codex)

Goal: provider-neutral harness-OS spine (own rules/memory/hooks/context/policy/ledger/verifier/promotion; LLMs+Codex are executors). Source of truth: `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`.

Pivot (2026-06-05): STOP chasing solo independent-review custody (structurally unreachable for a single principal). Cap it by construction; redirect effort to real spine capability. The old goal-reachability loop's custody stages are deprecated.

## Tasks (one at a time, Codex implements, Claude verifies + commits)

| # | Task | Why | Size | Status |
|---|---|---|---|---|
| T0 | **Solo ceiling cap** — classify the independent-review blocker as `external_principal_required`, expose `solo_ceiling_cap` + `independence_locally_reachable:false`; keep decision honest (no inflation). Reclassify it in the goal-contract so no further local stage targets it. | Ends the custody detour honestly; stops the loop. | S | ▶ in progress |
| T1 | **End-to-end harness run slice** (contract §7): one task flows goal→ContextBundle(hash)→native codex executor→git-diff ToolExecution evidence→M7 verifier→state, on the hash-chained ledger, labeled native-harness-assisted. | The actual product: a task run through product-owned pieces over the rented loop. | L | queued |
| T2 | **M3 Product Hook Runtime** — lifecycle hooks that can BLOCK (BeforeToolExecution), wired into the run slice. | Critique: hooks absent (0 in src). Real harness ownership. | M | queued |
| T3 | **M1 BaseRule Engine** — compile BaseRuleSet → prompt segment + policy assertion with hardness enforcement; `prompt_only` vs `policy_enforced`/`verifier_enforced`. | The product owns its rules, not AGENTS.md/CLAUDE.md. | M | queued |
| T4 | **M8 real causal control-run** — promotion-differential re-executes baseline-WITHOUT vs WITH promotion (real 3-run), hand-authored effect fails. | Last theater point in the learning loop. | M | queued |

Done so far on this branch: M-1 integrity baseline, L ledger hash-chain, M7.1 reviewer-decision, evidence-contract, verifier (input-sensitive), native-evidence, context-provenance, skill-contracts, provider-normalization fixtures, harness integrity meta-gate.

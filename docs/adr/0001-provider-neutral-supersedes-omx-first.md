# ADR 0001 — Provider-neutral harness supersedes "OMX/Codex first"

**Status:** Accepted (2026-06-04)
**Supersedes:** the "OMX First" / "Codex-first executor strategy" language in `dominic_orchestration_PRD.md` (esp. §19.1) and the v0 roadmap framing.
**Related:** `docs/milestones/ULTIMATE_GOAL_DIVIDE_AND_CONQUER_PLAN.md`, `docs/milestones/PROVIDER_NEUTRAL_HARNESS_CONTRACT.md`, `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`.

## Context

The original PRD positioned OMX/Codex as the first-class executor strategy and treated vendor agent harnesses as peer runtimes. Two analyses (a code-grounded audit and a cross-critique with Codex) converged on a different ultimate goal: Dominic Orchestration must **own the harness** (base rules, memory, hooks, context, policy, event ledger, verifier, promotion, state transitions) and treat LLMs and vendor CLIs as **interchangeable lower-level executors**. Letting each vendor's native harness (its own `AGENTS.md`/`CLAUDE.md`, memory, hooks, subagents, compaction, permission model) decide behavior makes cross-model parity impossible to prove — the harness, not the model, silently changes the task.

A second, equally binding finding from current-repo reality: making the **direct provider-API path** (OpenAI/Anthropic) the *canonical proof path* is premature. The only working executor today is `src/runtime/codex-exec-runner.ts` (`codex exec`); direct-API is 0% (`package.json` `dependencies={}`). Rebuilding the commoditized agent loop from scratch just to relabel it "canonical" would strand the product as a toy while every real run routed through the native loop.

## Decision

1. **"OMX/Codex first" is historical v0 strategy.** It is retained only as context; it is not the current canonical direction.
2. **The current canonical direction is: a Dominic-owned evidence/verifier/policy/ledger/promotion LAYER over a rented native-executor loop, with direct provider adapters as a deliberately-sequenced future path.** Short term the canonical *working substrate* is the native executor (`codex exec`) wrapped by the product's evidence contract; long term the ultimate goal remains a provider-neutral harness OS.
3. **Completion is verifier-owned.** No model, vendor CLI message, or review prose may mark work complete — only the product's recomputable verifier over the (to-be) hash-chained event ledger.
4. **Native-harness participation is a per-run label** (`native-harness-assisted`) that enumerates unowned surfaces (native memory/hooks/subagents/compaction); it is not a second-class completion status, and it can never satisfy a verifier claim by itself.
5. **Build order is the merged Phase-A spine:** M‑1 Integrity Baseline → L Ledger Hash-Chain → M7 Verifier Demolition → N Native-Executor Evidence Adapter → M8 Three-run Promotion; direct-API normalization (M6) is a required Phase-B spec + minimal implementation, not a permanent deferral.

## Consequences

- The PRD's executor-strategy sections are now historical; this ADR is the controlling record where they disagree.
- Direct provider SDKs must still be specced (provider→ToolIntent normalization) in Phase B so the product does not calcify into a "Codex evidence wrapper"; permanent direct-API deferral is explicitly disallowed.
- A solo-operator configuration is honestly ceiling-capped (~75) because independent review custody is structurally impossible for a single principal; ≥90 requires a real second principal.
- Future agents must follow this ADR + the corrected plan, not the "OMX First" prose, when the two conflict.

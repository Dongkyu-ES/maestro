# Warden — Current Truth (single source of truth)

**Last updated:** 2026-06-21
**Read this first.** This is the one doc a new agent/operator should read before anything else in
`docs/milestones/`. It pins the *current* direction, completion status, and the canonical-vs-archived
document map. Everything dated/finished has moved to `docs/milestones/archive/`.

> Honesty rule (binding, see `archive/INDEPENDENT_CRITIQUE_REPORT.md` history): no doc may claim
> completion that the product's own recomputable verifier cannot reproduce. Local executable gates can be
> green while hard completion stays blocked. State both.

---

## 1. What Warden is (current canonical direction)

A **provider-neutral evidence-and-control LAYER** that owns the harness — base rules, memory, hooks,
context, policy, hash-chained event ledger, recomputable verifier, promotion, state transitions — and
runs it **on top of interchangeable rented executor loops** (Codex CLI, Claude Code, agy — driven
headless). **Completion is declared only by re-running acceptance over the ledgered evidence in a clean
checkout — never by a model, a CLI, a score, or review prose.**

Thesis in one line: **own the evidence and the gate; rent the loop.**

This **supersedes** the original PRD framing (`/dominic_orchestration_PRD.md`, "Dominic Orchestration",
local web orchestration board with "OMX/Codex first"). The PRD is retained as historical scope context
only; where they conflict, the controlling records are:

- `HARNESS_OS_CORRECTED_PLAN.md` — **binding** plan (post-critique re-baseline + corrected module order).
- `DIRECTION_AI_NATIVE_BRND_REVIEW.md` — north-star product target (the BRND AI-native model).
- `../adr/0001-provider-neutral-supersedes-omx-first.md` — the ADR that retired "OMX First".
- `PROVIDER_NEUTRAL_HARNESS_CONTRACT.md` — the executor/evidence contract.

## 2. Status (honest)

- **Build/test:** `npm run build` green; `npm test` = 396/396 pass (as of 2026-06-21).
- **Spine runs for real.** The four substrate primitives — delegate → log to hash-chained ledger →
  verify → gate-on-verifier — execute end-to-end over a real rented loop. Proven by the M23 self-critic
  dogfood (2026-06-20): Warden drove a real `claude` executor to find + fix a real rename-bypass security
  bug *in Warden's own verifier*, gated by its own clean-checkout acceptance command, then independently
  revert-checked. See `archive/M23_SELF_CRITIC_CLOSED_LOOP_2026-06-20.md`.
- **The §9 "daily-usable slice" is shipped** as `maestro harness run "<goal>" --executor <codex|claude>
  --acceptance-file <accept.json>`: task → ContextBundle → native adapter → ledger → M7 verifier →
  state transition. (Slice defined in `HARNESS_OS_CORRECTED_PLAN.md` §9.)
- **Hard completion is BLOCKED by design at ceiling ~60–75.** The product gate fails closed because
  **independent-review custody is structurally impossible for a single operator who holds every key**
  (ADR-0001; corrected plan R-solo-independence). This is a shared, accepted ceiling (the BRND reference
  is also solo), not a bug. ≥90 requires a real second principal that does not exist today.

## 3. Real remaining gaps (both against PRD v0–v2 and the new harness-OS goal)

1. **Independent completion custody** → solo ceiling ~75. Only closable by a second principal.
2. **Memory: 3 unreconciled schemas** (`MemoryEntry` vs `fabric.ts MemoryFact` vs `records.ts
   MemoryWriteRecord`). Corrected plan §6 mandates converging on `fabric.ts`'s provenance model
   (`source_event_ids` + `lastVerifiedAt`) and keying gate #4 on provenance + verification recency.
   Partially done; until finished, "no stale memory as fact" cannot fully run.
3. **Direct provider-API adapter = 0%** (`package.json` `dependencies={}`). **Intentional future**
   per ADR-0001, not a defect — but permanent deferral is disallowed; it needs the normalization sub-spec.
4. **UI verification is server-render smoke + SSE**, not full browser-client E2E. OMX/agy adapters are
   evidence/detection adapters, not full session-lifecycle controllers.

## 4. Document map (what is canonical vs archived)

**Canonical / current — keep in `docs/milestones/`:**

| File | Role |
| --- | --- |
| `_CURRENT_TRUTH.md` | this file — read first |
| `HARNESS_OS_CORRECTED_PLAN.md` | binding plan + corrected module order |
| `DIRECTION_AI_NATIVE_BRND_REVIEW.md` | north-star product target |
| `PROVIDER_NEUTRAL_HARNESS_CONTRACT.md` | executor/evidence contract |
| `FULL_PRODUCT_ROADMAP.md` | roadmap v0→v2 *(load-bearing: parsed by `product-gate.ts`)* |
| `PRODUCT_COMPLETION_STANDARD.md` | completion standard *(load-bearing: `core.test.ts`)* |
| `HARD_COMPLETION_GATES.md` | controlling hard gate *(load-bearing: `product-gate.ts`)* |
| `DOGFOOD_REPORT.md` | rolling dogfood evidence *(load-bearing)* |
| `REVIEW_PROVENANCE.md` | review custody provenance *(load-bearing)* |
| `PRODUCT_GATE_RERUN_REPORT.md` | latest gate rerun *(load-bearing: `core.test.ts`)* |
| `HARNESS_OS_ULTRAGOAL_PLAN.md` | superseded by CORRECTED_PLAN, **kept in place** because `scripts/harness-os-integrity-gate.mjs` pins it |
| `reports/` | v0/v1/v2 completion reports + critique JSON |

> **Do not move the load-bearing files.** `product-gate.ts`, `core.test.ts`, and
> `scripts/harness-os-integrity-gate.mjs` read them by path; moving them breaks gates/tests.

**Archived — `docs/milestones/archive/` (superseded plans + finished milestone writeups):**
superseded plans (`ORCHESTRATION_PLAN`, `ULTIMATE_GOAL_DIVIDE_AND_CONQUER_PLAN`, `HARD_GATE_CLOSURE_PLAN`,
`REVKA_BORROW_UPGRADE_PLAN`, `ultragoal-v0-v2`, `CURRENT_BASELINE_GAP_REPORT`), the critique report, all
finished milestone writeups (`M12*`, `M14`–`M23`, `WARDEN_MAGIC_*`), and `archive/panels/` (one-off
`.mjs` verify/critic panels). These are history, not current truth.

## 5. Next candidate work (not a completion claim)

- **Finish memory schema reconciliation** (gap #2) — closes a real gate-blocking dimension.
- **Second-principal review-custody experiment** — the only path past the ~75 ceiling.
- Keep this file current whenever direction or completion status changes.

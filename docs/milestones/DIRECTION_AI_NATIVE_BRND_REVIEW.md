# Direction Review — "AI-Native Orchestration" (BRND model) vs. this repo

**Date:** 2026-06-18
**Branch:** `direction/ai-native-orchestrator`
**Trigger:** operator handed an external example/direction to steer toward:
`https://maily.so/josh/posts/3jrk3ny6z51` — an interview with the founder of **BRND**,
a one-person AI-native branding agency run by ~100 agents and 50+ workflows.
**Status:** honest feasibility review. Not a completion claim.

> Why this doc exists: without a concrete target the harness work drifts toward
> general "improve everything" or whatever bug is currently visible. This review pins
> the work to a concrete, *externally validated* reference architecture and asks one
> question: **can we proceed in this direction, and what is the shortest honest path?**

---

## 1. The direction, distilled from the source

The BRND model is not a tool list; it is an operating model:

- **AI-Native, not AI-Assisted.** Assisted = you tell AI *how* (the method). Native =
  you define only *what*, and the system chooses the method. This is what expands one
  person's reachable scope.
- **Fix the system, not the output.** When a result is wrong, do **not** hand-edit the
  output. Read the agent's *intermediate logs*, find why it produced that, and revise the
  agent's underlying rules — so all future outputs improve. (Training the employee, not
  redoing the work.)
- **Orchestrator-as-Skill = "team lead".** 7 orchestrators, each sharing the same phase
  spine: **research → execute → review**. They delegate to specialized sub-agents
  ("team members": frontend, design, research).
- **SOT (Source of Truth).** A log repository of session records / metrics / logs that
  is *analyzed*, and whose findings are reflected back into `CLAUDE.md` / `agent.md`
  (the "execution rules") so mistakes don't repeat.
- **Completion is type-specific and objective.** "Autonomous Service Builder" (0→1) is
  validated by a *full deploy completing*; "Autonomous Feature Builder" is validated by
  *compatibility*. Completion is a gate, not a vibe.
- **Stated limitation (their words):** AI still struggles with subjective judgment and
  human consensus on aesthetic preference; the human stays in that loop.

---

## 2. Alignment with this repo (it is high — and not accidental)

This repo's own corrected north star (`HARNESS_OS_CORRECTED_PLAN.md` §1) is:
*"a provider-neutral evidence-and-control LAYER that owns the harness … and runs it on top
of interchangeable lower-level executors … completion declared only by the product's
recomputable verifier."* The BRND model is essentially the **product form** of that thesis.

| BRND concept | This repo's mechanism | Honest status |
| --- | --- | --- |
| Orchestrator-as-skill, research→execute→review | `runTaskGraph` (verifier-gated DAG) + planned M12 "wrap-don't-rebuild" skills | M11 = **experimental sidecar**; M12 not started |
| Specialized sub-agents / team members | pluggable heterogeneous executors (codex/claude/agy) via `runParallelWorkers` | **works — dogfooded live today** (§4) |
| SOT log repository | per-run **hash-chained event ledger** + evidence store, refs-not-raw | **works** (forgery-fixture gated) |
| Fix the system not the output (read intermediate logs) | ledger as the readable trace + **M8 promotion loop** (three-run differential) feeding rules/skills | partial — M8 is P2, not landed |
| CLAUDE.md/agent.md = execution rules updated from findings | Rules + memory fabric + promotion to `target_type: rule/skill/agent_instruction` | partial — 3 memory schemas unreconciled (§6 of corrected plan) |
| Completion by deploy/compatibility, not self-report | **M7 recomputable verifier owns completion** | **the crux gap** — see §3 |

The mapping is close enough that the blog is best read as a **target spec for the same
architecture this repo already chose**, plus proof that the architecture pays off at scale.

---

## 3. Where this repo is NOT the BRND model yet (the honest gaps)

1. **BRND is a production system delivering paid client work daily. This repo is ~7% of
   its own corrected goal** (`HARNESS_OS_CORRECTED_PLAN.md` §0). The "first daily-usable
   slice" (corrected plan §9: UI task → ContextBundle → codex-exec → hash-chained ledger →
   M7 verifier → state transition) is **not yet shipped as one operator product**.
2. **Completion authority is still split.** The new M7 verifier exists, but the legacy
   `collectRun` heuristic path and the self-certifying `product-gate.ts` could still emit a
   completion verdict beside it — a *second, forgeable* authority. M11 is therefore
   **reclassified EXPERIMENTAL SIDECAR, not shipped** (`ORCHESTRATION_PLAN.md` status
   banner). The most recent commits (`66b92ef`, `b07d430`, `ee76951`, `de878e0`) are the
   work of collapsing this to a single authority — this is the live front, and it must
   close before any "research→execute→review" orchestrator can be trusted.
3. **The harness verifies *objective artifacts*, BRND's scope is partly *creative*.** This
   orchestrator proves completion by diff/test/deploy over files in a worktree. That fits
   "Autonomous Feature Builder" (compatibility/tests) and "Service Builder" (deploy)
   cleanly. It does **not** fit aesthetic acceptance (30 logo concepts, ad creatives) —
   and BRND itself keeps a human in exactly that loop. So the repo should target the
   *engineering* orchestrators first and treat creative acceptance as human-gated by design,
   not as a verifier gap to "fix".
4. **Solo-independence ceiling.** The corrected plan caps honest completion at **~75 in
   solo mode** because the verifier's "independent custody" is structurally weak when one
   principal holds every key. BRND is also solo — so this is a shared, accepted ceiling,
   not a blocker, but it must not be papered over.

---

## 4. Dogfood evidence (run today through the repo's own orchestrator)

Per the operator's request, the orchestrator drove a **real** `codex exec` worker (no fake
executor), watched live:

```
# Real codex dogfood — elapsed 10.2s
| worker | state     | verifier  | evidence ref                                   |
| w-real | completed | supported | agent://w-real+b1037d8bd3787f3d3607ff089f215dd3… |
supported (verifier-confirmed): 1/1
ledgerHead: { event_count: 4, ledger_head_sha256: e36bfcbd6edc4a84… }
dogfood.txt written by real codex: "HELLO_FROM_REAL_ORCHESTRATOR\n"
```

What this proves honestly: (a) the executor seam carries a **real external model** in an
isolated `git worktree`; (b) output is captured as an **evidence ref (sha256), not raw text**;
(c) an **independent verifier owns the completion verdict**; (d) the SOT trace is a
**hash-chained ledger**. The four BRND substrate primitives — delegate → log to SOT →
verify → gate — exist and run. At trivial scale, but real.

Supporting gates run today: deterministic orchestration demo = 2/3 supported with the no-op
worker correctly `blocked/unproven`; `goal-reachability --self-test` = PASS;
`harness-os-integrity-gate --self-test` = PASS (rejects tampered fixtures). Build green.

Reproduce: `node /tmp/dogfood-real-codex.mjs` (throwaway script; mirrors
`scripts/harness-orchestration-demo.mjs` with the fake executor swapped for real `codex`).

---

## 5. Verdict and the shortest honest path

**Verdict: YES, proceed in this direction.** It is the same architecture the corrected plan
already commits to, the blog is concrete external validation that it pays off, and a live
dogfood shows the substrate runs. The risk is **not** "wrong direction" — it is "chasing
BRND's *breadth* (100 agents, 50 workflows) before closing this repo's own *depth* gaps".

Proceed depth-first, in the order the corrected plan already mandates:

1. **Close the single completion authority (finish M7).** Make `collectRun` /
   `product-gate.ts` structurally incapable of emitting completion; regression-test that the
   old path can no longer green a run. *Until this lands, every orchestrator built on top
   inherits a forgeable gate.* (In progress on `harness-os-phase-a`.)
2. **Ship the §9 daily-usable slice as one operator product.** This is the minimal
   "Autonomous Feature Builder": task in → ContextBundle (rules+memory+acceptance) → real
   codex-exec → ledger → M7 verifier → state. One real task, end to end, daily-usable.
3. **Wrap ONE real skill (M12) as the first orchestrator-as-skill.** A thin
   verifier+contract+hardness wrapper around an existing native skill, with the
   research→execute→review spine. This is the literal BRND "team lead" shape — do it once,
   correctly, before generalizing to seven.
4. **Encode BRND's type-specific completion gates as `AcceptanceContract`s.**
   Feature-Builder → compatibility/tests; Service-Builder → deploy reachable. Reuse the M7
   closed verifier set; forbid bespoke per-skill verifiers (corrected plan §5).
5. **Make "fix the system not the output" the promotion loop (M8).** Findings mined from
   the SOT ledger become candidate rule/skill promotions under the three-run differential —
   not hand-edits to outputs.
6. **Keep the honest boundary explicit.** Objective-artifact verification is owned;
   subjective/aesthetic acceptance stays human-in-the-loop (BRND agrees). Don't let
   "AI-native" pressure the verifier into rubber-stamping taste.

**One-line summary:** the BRND post is not a pivot — it is the product target for the layer
this repo is already building; the job is to finish the single completion authority and ship
the first end-to-end orchestrator-as-skill, not to widen scope.

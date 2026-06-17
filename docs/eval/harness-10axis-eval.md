# Harness 10-axis evaluation — Dominic Orchestration (DH) vs the reference 7

Replicates the `../harness_learn` harness-wiki rubric (`10_프레임워크분석/_분석축_루브릭`,
`20_비교분석/_비교매트릭스`): score a harness on the **same 10 axes, 1–5** (1 = absent/weak,
5 = core strength), with **file-citation evidence**, then **cross-validate Claude ↔ Codex**.

This doc adds an 8th column — **DH** (this repo) — to the wiki's 7-framework matrix. The 7
reference scores are quoted verbatim from the wiki (not re-derived). DH is scored here with
evidence from this codebase, then independently re-scored by Codex and reconciled.

> Honesty note: the rubric was built to compare *full harnesses*. DH is a provider-neutral
> evidence-and-control **layer over rented executor loops** ("own the layer, not the loop" —
> `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`). It deliberately under-invests in
> orchestration / tools / DX and over-invests in verification / state. Expect a spiky
> specialist profile, not a generalist — a low total is identity, not failure (same caveat
> the wiki applies to fable-ish at 33).

## The 10 axes (rubric)

| # | Axis | One-line question |
|---|------|-------------------|
| 1 | Architecture / positioning | where it sits, what it's built on |
| 2 | Context engineering | what it shows the model |
| 3 | Tools / extension | what it can be told to do |
| 4 | Orchestration / multi-agent | how it runs many workers |
| 5 | Guardrails / safety | how it stops unsafe actions |
| 6 | Verification loop | how it confirms work is real |
| 7 | Self-improvement / iteration | does it fix itself in a loop |
| 8 | State / persistence | how it remembers |
| 9 | Deploy / DX | how easy to install/use |
| 10 | Philosophy / differentiation | what's special |

## DH scorecard (Claude, evidence-grounded)

| # | Axis | Score | Evidence (file) |
|---|------|-------|-----------------|
| 1 | Architecture/positioning | 4 | Provider-neutral evidence layer over a pluggable executor (`src/harness/harness-run.ts` `HarnessExecutor`); native codex + generic claude/agy (`src/runtime/{codex-exec-runner,generic-cli-runner}.ts`); 11 runtime adapters. Deliberate "own the layer" stance. Not 5: rides rented loops by design; spine young. |
| 2 | Context engineering | 4 | Canonical order-invariant sha256 `ContextBundle` (`src/harness/context-bundle.ts`); base-rules compiled to prompt segments (`base-rules.ts`); memory-as-fact gating excludes stale/unverified (`memory-gating.ts`); provenance verification (`context-provenance.ts`). Not 5: no token-budget/progressive-disclosure economy (owns evidence, not in-loop context). |
| 3 | Tools/extension | 3 | 3 blocking lifecycle hooks `BeforeContextBuild/BeforeToolExecution/BeforeStateTransition` (`hooks.ts`); skill contracts wrap-don't-rebuild (`skill-contracts.ts`, `composition/composition.ts`). No MCP, no skill/command marketplace — far thinner than Claude Code/Codex (5). |
| 4 | Orchestration/multi-agent | 3 | Worker + independent isolated critic split (`closed-loop.ts`), executor now pluggable; omx/agy adapters parity-shaped. No teams/parallel/subagent-routing depth (OMC/ouroboros = 5). |
| 5 | Guardrails/safety | 4 | Risk classified from the ACTUAL command not caller label, 6 classes, deny-first (`tool-policy.ts`); secret redaction at every persistence sink (`util.ts redact`, wired into `harness-run.ts`/`ledger.ts`); rule hardness `prompt_only/policy_enforced/verifier_enforced` (`base-rules.ts`). Honest ceiling: native CLI owns file/shell authority → hard tool-mediation is `external/unowned`. |
| 6 | Verification loop | 5 | The thesis. Recomputable input-sensitive verifier (`verifier.ts` `assertVerifierInputSensitive`) over a forgery-failing hash-chained ledger (`events/ledger.ts`); demolished self-certifying gate; verify-cmd exit gate + isolated critic that caught model reward-hacking 3/3 live (`closed-loop.ts`); 3-run causal promotion differential (`promotion-differential.ts`). Best-in-class — matches/exceeds the wiki's sole 5 (내패턴). |
| 7 | Self-improvement/iteration | 3 | Closed loop with stall→escalate→strategist (`closed-loop.ts`); promotion loop (`promotion-causal.ts`, `promotion-differential.ts`). No tournament/evolutionary depth (ouroboros/OMC = 4); causal claim is an acknowledged residual (plan §10 R-causal-promotion). |
| 8 | State/persistence | 5 | Hash-chained ledger `prev_event_sha256`, tampered-middle forgery fixture fails (`events/ledger.ts`); JSON + SQLite projection (`projection/{projection,sqlite-store}.ts`); provenance-keyed memory fabric (`memory/fabric.ts`). Audit-grade, recomputable. Caveat: 3 memory schemas not fully reconciled (plan §6). |
| 9 | Deploy/DX | 2 | `agent` CLI (51 subcommands) + local web UI (`src/cli.ts`). Early; no packaging/marketplace/docs polish. Codex (5) is far ahead. |
| 10 | Philosophy/differentiation | 5 | Sharp, defensible thesis: completion is declared only by the product's recomputable verifier over a product-owned ledger — never by a model, vendor CLI, or review prose. Proven adversarially this session. (All 7 wiki frameworks scored 5 here.) |
| | **Total (50)** | **38 (Claude)** | spiky specialist: verification/state/philosophy = 5, orchestration/tools/self-improve = 3, DX = 2 |

## Same-basis re-scoring of the 7 references

The 7 reference scores are **not** casual imports: each was derived by the same method used
for DH — per-axis 1–5 with file citations, then Claude↔Codex cross-validated against the real
source (see each `_개요.md`; every framework has a recorded "점수 보정" reconciliation, e.g.
Codex pulled OMC 49→44, fable-ish 38→33, Claude Code down 5 axes). Their source is not on this
machine, so the basis for the 7 is each project's documented code-cited cross-validation; DH's
basis is live source here, scored by the same evaluator pair. Method parity, different evidence
locus — stated plainly so the matrix isn't over-read as a single live benchmark.

Re-summing each row from its per-axis evidence surfaced one wiki arithmetic slip: **OMC sums to
45** (5+5+4+5+4+4+4+5+4+5), though the wiki states 44. The corrected per-axis total is used below.

## Extended comparison matrix (wiki 7 + DH) — all 10 axes

| Axis | Claude Code | Codex | OMC | gajae | ouroboros | fable-ish | 내패턴 | **DH (Claude)** |
|------|---|---|---|---|---|---|---|---|
| Architecture | 4 | 5 | 5 | 4 | 5 | 5 | 4 | **4** |
| Context | 5 | 5 | 5 | 5 | 5 | 3 | 5 | **4** |
| Tools/extension | 5 | 5 | 4 | 4 | 5 | 2 | 4 | **3** |
| Orchestration | 4 | 4 | 5 | 4 | 5 | 2 | 5 | **3** |
| Guardrails | 4 | 5 | 4 | 5 | 3 | 3 | 4 | **4** |
| Verification | 4 | 4 | 4 | 4 | 4 | 4 | 5 | **5** |
| Self-improve | 3 | 3 | 4 | 3 | 4 | 2 | 3 | **3** |
| State | 4 | 5 | 5 | 5 | 5 | 4 | 4 | **5** |
| Deploy/DX | 4 | 5 | 4 | 4 | 4 | 3 | 3 | **2** |
| Philosophy | 5 | 5 | 5 | 5 | 5 | 5 | 5 | **5** |
| **Total** | 42 | 46 | 45¹ | 43 | 45 | 33 | 42 | **38** |

¹ wiki states 44; per-axis sum is 45 (wiki arithmetic slip).

Reading: DH is the **verification + state specialist** — it ties/beats everyone on Verification
(5, with 내패턴) and State (5), and holds a sharp Philosophy (5), but is deliberately thin on
Orchestration / Tools / Self-improve / DX because it is a layer, not a full harness. Profile
shape > total: it most resembles a 내패턴-style verification thesis hardened into a recomputable,
forgery-resistant ledger + critic.

## Codex cross-validation

Codex re-scored DH independently over this repo (`codex exec --sandbox read-only`, skeptical
reviewer, 76k tokens). It agreed **exactly** on all six spine axes and was slightly more
generous on three breadth axes:

| Axis | Claude | Codex | Reconciled | Reconciliation note |
|------|---|---|---|---|
| 1 Architecture | 4 | 4 | **4** | agree ("control-plane; lifecycle ownership partly unproven") |
| 2 Context | 4 | 4 | **4** | agree (hash-addressed bundles, provenance, freshness gating) |
| 3 Tools/extension | 3 | 4 | **4** | accept Codex — adapters+hooks+policies+51 CLI cmds is broad; the missing piece is a plugin *ecosystem* (caps at 4, not 5), not breadth |
| 4 Orchestration | 3 | 3 | **3** | agree (multi-worker modes exist, live lifecycle mostly unproven) |
| 5 Guardrails | 4 | 4 | **4** | agree (approvals, redaction, safe paths, loopback web) |
| 6 Verification | 5 | 5 | **5** | agree — the differentiator |
| 7 Self-improve | 3 | 4 | **3** | hold Claude — machinery exists but causal promotion is an acknowledged residual (plan §10); no evolutionary depth |
| 8 State | 5 | 5 | **5** | agree (hash ledger, projections, memory fabric) |
| 9 Deploy/DX | 2 | 3 | **3** | accept Codex — 51-subcommand CLI + web UI + scripts is a real if unpolished DX, above a "2" |
| 10 Philosophy | 5 | 5 | **5** | agree (anti-self-deception evidence-layer thesis) |
| **Total** | **38** | **41** | **40** | |

The independent agreement on every core axis (and the narrow, breadth-only disagreement) is
the rubric's credibility signal: two models with the same yardstick converged on DH's shape.

## Final reconciled placement

| | Codex | OMC | ouroboros | gajae | Claude Code | 내패턴 | **DH** | fable-ish |
|---|---|---|---|---|---|---|---|---|
| Total /50 | 46 | 45 | 45 | 43 | 42 | 42 | **40** | 33 |

DH lands just below the mature generalist cluster (42–46) and well above the lean specialist
(fable-ish 33) — consistent with a young **evidence-layer specialist**: it ties the best on
Verification (5) and State (5), holds a sharp Philosophy (5), and deliberately trails on
Orchestration / DX because it owns the layer, not the loop. Its closest sibling is 내패턴 (the
dual-model verification thesis) — DH is that thesis hardened into a recomputable, forgery-
resistant ledger + an independent critic that caught live reward-hacking 3/3.


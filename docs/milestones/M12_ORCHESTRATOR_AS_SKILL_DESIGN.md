# M12 — First orchestrator-as-skill (research → execute → review)

**Date:** 2026-06-18
**Branch:** `direction/ai-native-orchestrator`
**Aligns:** `DIRECTION_AI_NATIVE_BRND_REVIEW.md` step 3; `HARNESS_OS_CORRECTED_PLAN.md` §5 (skills = wrap-don't-rebuild, strictly after M7+M8).
**Status:** plan + design for critique. Not a completion claim.

---

## 0. Why this is the next slice (verified current state)

The spine the corrected plan ordered *before* skills is now in place — verified, not assumed:

- **M7 single completion authority — DONE.** `product-gate.ts` carries
  `completion_authority: 'revoked'`; regression test `'old product gate can no longer green a
  run'` passes; `dist/core.test.js` = **109/109 pass**; apply eligibility is gated on the
  validated ledger, not the mutable `run.yaml` (`b07d430`).
- **§9 daily-usable slice — DONE as `runHarnessSlice`** (`src/harness/harness-run.ts`):
  ContextBundle (base rules + gated memory + provenance, hashed) → pluggable executor
  (codex default) → redacted tool evidence (diff/status + file hashes) → hash-chained ledger
  → `runVerifier` → state. Exposed at `agent harness run "<goal>"`.
- **DAG with per-node acceptance — DONE.** `runTaskGraph` starts a node only when every dep
  is `verifier: supported`; each node now carries an `AcceptanceContract` (`3d11996`).
- **Closed verifier set:** `artifact | test | ledger | diff | review_custody`
  (`src/harness/verifier.ts`).
- **Executors available:** `codex`, `claude`, `agy` (heterogeneous panels are possible).

So the next BRND-faithful step is the **"orchestrator-as-skill = team lead"** with the
`research → execute → review` spine — the thing that turns the low-level fan-out primitive
into a usable team lead. It is unblocked *because* the spine beneath it is closed.

---

## 1. Goal

Accept a high-level **what** (AI-native: the operator states the outcome, not the method) and
run it through a fixed `research → execute → review` phase spine over the **existing**
`runTaskGraph` + native executors, where:

- every phase transition is gated by the **per-node AcceptanceContract** (already supported),
- final completion is owned by the **M7 verifier**, never by the review executor's opinion,
- every phase logs to the **hash-chained ledger (SOT)** with refs-not-raw,
- the skill is a **thin wrapper** — the native loop does the work (wrap-don't-rebuild),
- the skill's acceptance is a **parameterization of the closed verifier set only** — no
  bespoke per-skill verifier code (corrected plan §5).

Non-goals: not seven skills (one, correct); not a new verifier type; not auto-acceptance of
subjective/aesthetic work (human-gated by design, matching BRND's own stated limitation).

---

## 2. Design

### 2.1 Declarative SkillSpec (the HARD-skill contract)

```ts
interface OrchestratorSkillSpec {
  id: string;                       // e.g. "feature-builder"
  target_type: 'skill';             // classifies to exactly ONE (corrected plan §5.4)
  trigger: { keywords: string[] };  // CAPABILITY: trigger-activated (vs always-on Rule)
  phases: PhaseSpec[];              // ordered; canonical: research, execute, review
}

interface PhaseSpec {
  id: 'research' | 'execute' | 'review';
  executor: 'codex' | 'claude' | 'agy';      // wrap a native loop
  goalTemplate: string;                       // interpolates {what} + upstream refs
  deps: PhaseSpec['id'][];                    // research ← execute ← review
  acceptance: VerifierBinding[];              // CLOSED SET ONLY: artifact|test|ledger|diff
}
```

A `Rule` (always-on constraint, no trigger) is explicitly *not* this; the precedence clause
(rules dominate skills on conflict) is recorded in the ContextBundle.

### 2.2 Compiler — `compileSkillToGraph(spec, { what }) → TaskGraph`

Pure function. Emits one DAG node per phase with `deps` and the phase's `acceptance` as the
node's `AcceptanceContract`. **No new orchestration code** — it produces the exact `TaskGraph`
shape `runTaskGraph` already consumes.

### 2.3 Runner — `runOrchestratorSkill(spec, { what, root }) → SkillRunReport`

Thin: builds the graph, calls `runTaskGraph`, maps results. Phase N starts only if phase N-1's
verifier verdict is `supported` (the existing DAG gate — reused, not reimplemented).
`SkillRunReport = { skillId, what, phases: PhaseResult[] (refs only), ledgerHead, completion }`
where `completion` is the **verifier verdict on the review node**, never a self-report.

### 2.4 Cross-phase handoff (the real hard part — see R2)

Each phase runs in its own isolated worktree. `execute` needs `research`'s output. Handoff is
by **evidence ref**: the research node's `outputRef` (path + sha256) is appended to the ledger;
the compiler injects that ref into `execute`'s ContextBundle as `included_context_refs`. The
execute worktree reads the referenced artifact from the research worktree branch (read-only).
**No raw transcript is merged into a shared context** — refs-not-raw holds across phases.

### 2.5 Completion authority (must not regress the core thesis)

The **review phase produces a review artifact**; it does **not** decide completion. Completion
is the M7 verifier evaluating the review node's `AcceptanceContract` over recomputable evidence.
BRND-style gate mapping:
- **Feature-Builder** → review acceptance `{ type:'test', command:[compatibility/test cmd] }`.
- **Service-Builder** → review acceptance `{ type:'test', command:[deploy-smoke cmd] }`.
- **Research-Brief** → review acceptance `{ type:'artifact', artifactRef:'brief.md' }` (+ a
  `diff` binding so an empty file fails).

### 2.6 Subjective/creative work — explicit human gate

For aesthetic acceptance (BRND's logo/ad case), a phase may declare `acceptance:
[{ type:'review_custody' }]` bound to an **external approval record** (reuse the existing
approval lifecycle). It BLOCKS until a human approves; it is never auto-greened. This encodes
the blog's own limitation rather than pretending the verifier can judge taste.

---

## 3. Implementation phases

- **P1** `SkillSpec`/`PhaseSpec` types + `compileSkillToGraph` + deterministic unit test
  (fake executors): assert the 3-node graph, deps, per-node acceptance; assert `review` blocks
  when `execute` is unsupported.
- **P2** `runOrchestratorSkill` + `SkillRunReport` + `skill.started/phase.advanced/skill.completed`
  ledger events; deterministic test (refs-not-raw asserted).
- **P3** CLI `agent skill run <spec.json> --what "<...>"` (mirrors `agent orchestrate run --file`).
- **P4** one **live heterogeneous** dogfood: codex research → codex execute → claude review,
  recorded to `reports/`.
- **P5** two fixture specs: `feature-builder.json`, `research-brief.json`.

Forgery fixture (reuse M7's class): a review phase whose acceptance is **constant w.r.t. input**
must FAIL the verifier.

---

## 4. Honest risks I already see (pre-critique)

- **R1 — handoff fidelity.** Ref-based handoff avoids context bloat but can be *lossy*: execute
  may need more than the research artifact exposes. Mitigation: research node's acceptance
  requires a structured `research.json` (closed schema), not free prose.
- **R2 — cross-worktree reads.** Phase worktrees are isolated; reading an upstream branch's
  artifact is the weakest mechanical point (path/branch resolution, sha verification). This is
  where M11.4 reconciliation complexity leaks in.
- **R3 — review/verifier conflation.** The single most dangerous regression: letting the review
  *executor's* prose stand in for the *verifier's* verdict. The design forbids it, but the test
  suite must prove a review node saying "LGTM" with no passing acceptance cannot complete.
- **R4 — autonomy vs human gate.** `review_custody` phases block on a human; over-using them
  collapses the AI-native promise back to AI-assisted. Keep them only for genuinely subjective
  acceptance.
- **R5 — spec sprawl.** SkillSpec could grow into a second orchestration language. Cap it: if a
  spec needs anything the closed verifier set can't express, that is a signal to extend M7 once
  (reviewed), not to add spec features.

---

## 5. Definition of done (this slice)

`agent skill run feature-builder.json --what "<small real task>"` drives research→execute→review
through native executors, each phase verifier-gated, completion owned by the M7 verifier over a
recomputable ledger, one live heterogeneous run recorded, and the forgery fixture failing —
with `npm test` green. That is one correct BRND "team lead", not seven half-built ones.

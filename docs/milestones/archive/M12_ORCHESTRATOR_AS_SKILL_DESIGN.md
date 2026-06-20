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
  → `runVerifier` → state. Exposed at `warden harness run "<goal>"`.
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
- **P3** CLI `warden skill run <spec.json> --what "<...>"` (mirrors `warden orchestrate run --file`).
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

`warden skill run feature-builder.json --what "<small real task>"` drives research→execute→review
through native executors, each phase verifier-gated, completion owned by the M7 verifier over a
recomputable ledger, one live heterogeneous run recorded, and the forgery fixture failing —
with `npm test` green. That is one correct BRND "team lead", not seven half-built ones.

---

## 6. Binding revisions from the orchestrator critic panel (2026-06-18)

This design was critiqued **by the repo's own orchestrator** — `runParallelWorkers` fanned it
to 3 heterogeneous real executors in isolated worktrees, each with a distinct adversarial lens;
all 3 verifier-confirmed `supported`, all 3 returned **PROCEED-WITH-CHANGES** (evidence:
`reports/M12_CRITIC_PANEL_2026-06-18.md`). The convergent findings below are **binding** and
supersede the cited sections. Provenance tag = which critic raised it.

1. **Handoff must be content-addressed, not worktree-to-worktree (supersedes §2.4).**
   [codex BLOCKER, agy MAJOR] Phases must NOT read each other's live worktree filesystem. At node
   completion, copy bytes into the ledger/evidence store; downstream phases resolve a stable
   `EvidenceRef { runId, nodeId, artifactId, kind, relativePath, sha256, size, producerCommit,
   storeUri }` and the runner materializes that artifact into the next worktree at setup. Worktree
   reads are an implementation cache only, never the contract.

2. **The verifier RE-RUNS `test`/deploy in a clean, verifier-controlled checkout (supersedes §2.5).**
   [claude BLOCKER] The M7 verifier (a) ignores any executor-reported pass/fail entirely, and
   (b) re-executes the command in a fresh checkout it materializes from the **execute** node's
   sha-pinned evidence — never the review executor's mutable worktree (which it could poison with a
   stub binary or cached pass). Forgery fixture: a planted `./node_modules/.bin/test` that exits 0
   in the review worktree must NOT green.

3. **No `artifact`-only acceptance on a node whose own executor authored the artifact (supersedes §2.5).**
   [claude BLOCKER, agy MAJOR] `{artifact}`+`{diff}` is a content-blind existence check =
   completion-laundering for prose deliverables. Research-Brief completion binds to a `test` that
   independently validates a structured `research.json` (closed schema: required fields populated,
   each claim carries a `source_event_id`), or is classified subjective → §2.6 human gate. Add a
   schema-validation capability to the closed verifier set **once** (reviewed), not per-skill.

4. **`SkillRunReport.completion` is display-only; truth is `recomputeCompletion(ledger)` (supersedes §2.3).**
   [claude MAJOR] A struct field carrying the verdict is a second authority one layer up. The
   report carries only `ledgerHead` + the review node's contract id; the authoritative verdict is
   recomputed by validating the hash chain and re-evaluating the review node's `AcceptanceContract`.
   Test: mutate the field to `supported` while the ledger says `blocked` → recompute still `blocked`.

5. **Split static compile from dynamic bind; drop the "no new orchestration code" claim (supersedes §2.2).**
   [codex MAJOR] The research `outputRef` does not exist at compile time, so there IS a runtime
   binder. Make it explicit: `compileSkillToGraphTemplate(spec)` (static nodes/deps/contracts) +
   `runOrchestratorSkill` as a documented dynamic binder that records a `NodeOutputManifest` after
   each supported node and derives the next node's ContextBundle from ledgered refs. No downstream
   context is created when an upstream node is unsupported.

6. **Lifecycle ledger events are derived projections only (supersedes §3 P2).**
   [codex MAJOR] `skill.completed` must include `{ finalNodeId, verifierVerdictRef,
   ledgerHeadBeforeEvent }` and **no free-form decision field**. Replay test: reorder/delete
   lifecycle events and recompute the same completion from node verifier events; a forged
   `skill.completed: supported` cannot advance state without the review node's verifier result.

7. **Build concrete-first, then extract the spec (reorders §3).**
   [agy MAJOR] Hardcode the 3-node graph for ONE skill (`feature-builder`) in TypeScript, run the
   live heterogeneous dogfood (P4) to prove handoff/verifier/ledger mechanics, and only then extract
   `OrchestratorSkillSpec`/`compileSkillToGraph`. New order: **P1 hardcoded graph → P2 live dogfood
   → P3 extract spec+compiler → P4 CLI → P5 second spec.** Avoids the premature-abstraction trap.

8. **SkillSpec configures fixed phases only; every HARD spec ships a forgery fixture (supersedes §2.1).**
   [agy BLOCKER, claude MAJOR] Remove dynamic `phases`/`deps` topology from the declarative spec —
   the `research→execute→review` sequence is hardcoded; JSON only binds per-phase executor +
   acceptance. Closed verifier *type* ≠ strong gate: a `{type:'test', command:['echo ok']}` is
   nominally typed but self-certifying. Therefore a HARD spec may run autonomously only if it ships a
   **committed forgery fixture** proving its acceptance fails on a trivially-forged execute output
   (corrected plan §5.5); otherwise it runs `soft-by-decision`/human-gated.

9. **Human gate constrained + crypto-anchored (supersedes §2.6).**
   [agy MAJOR] `review_custody` is allowed ONLY for subjective/creative outputs (ledgered
   `soft-by-decision` per corrected plan §4); prohibited on objective tasks where hard verification
   exists. Approval must be a **signed ledger event** verified against a known operator key, not a
   mutable external record. (Honest caveat: this collides with `R-solo-independence` — one principal
   holds the key — so it raises integrity but does not lift the solo ~75 ceiling.)

**Kept (all 3 critics affirmed):** one skill not seven; wrap-don't-rebuild (native loop does the
work, product owns evidence/ledger/verifier/state); acceptance = parameterization of the closed
verifier set, no bespoke per-skill verifier (caps code at O(types)); `review_custody` for subjective
work instead of faking taste verification; R3 (review/verifier conflation) named as the top threat;
refs-not-raw across handoff.

## 7. Revised definition of done

`warden skill run feature-builder` (concrete graph first) drives research→execute→review through
native executors; each phase verifier-gated; handoff content-addressed via the evidence store; the
verifier re-runs the review `test` from execute's sha-pinned evidence in a clean checkout;
completion recomputable from the ledger (display field non-authoritative); the `feature-builder`
forgery fixture fails on forged output; one live heterogeneous run recorded; `npm test` green.

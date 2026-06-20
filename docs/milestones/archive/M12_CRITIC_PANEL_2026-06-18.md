seed repo: /var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO
작업 트리 준비 중 (새 브랜치 'wt/crit-codex')
작업 트리 준비 중 (새 브랜치 'wt/crit-claude')
작업 트리 준비 중 (새 브랜치 'wt/crit-agy')

# Critic panel — elapsed 128.0s

| critic | state | verifier | evidence ref |
| --- | --- | --- | --- |
| crit-codex | completed | supported | agent://crit-codex+fbf6c698a93a472d3fe4b3e861e046a78 |
| crit-claude | completed | supported | agent://crit-claude+70cd2eb38a6806fffd82e7e6e5432534 |
| crit-agy | completed | supported | agent://crit-agy+16dacbe0e9a39ff204a8b8b5f7c0eb228e4 |

supported: 3/3

================ crit-codex (completed/supported) ================
# Feasibility & Mechanism Critique

## Serious issues

1. [BLOCKER] Section 2.4 hand-waves the hardest mechanism: cross-worktree refs are not a runnable handoff contract.

   The design says the research node's `outputRef` is `(path + sha256)`, ledgered, injected into `execute` as `included_context_refs`, and then the execute worktree reads the artifact from the research worktree branch read-only. That is not enough information to implement safely. A path is meaningful only relative to a specific worktree root, branch, commit, or evidence-store namespace. A sha256 proves content only after the reader has already located bytes. "Research worktree branch" also implies durable branch naming, lifetime, cleanup, and concurrent-run collision rules, none of which are specified.

   What breaks first in P2: the execute phase cannot deterministically resolve `research/outputRef.path`, or worse, it resolves a same-named file in the wrong checkout and still appears plausible. The verifier can then validate a hash over the wrong artifact or fail nondeterministically when the upstream worktree is cleaned.

   Concrete fix: replace `path + sha256` with a stable `EvidenceRef` object that includes `runId`, `nodeId`, `artifactId`, `kind`, `relativePath`, `sha256`, `size`, `producerCommit`, and `storeUri`. Store the bytes or a content-addressed copy under the ledger/evidence store at node completion. Downstream phases must read from the evidence store by `artifactId`/`sha256`, not from another live worktree branch. If branch/worktree reads remain necessary, make them an implementation cache only, never the contract.

2. [BLOCKER] Sections 2.1-2.3 assume `PhaseSpec.acceptance: VerifierBinding[]` maps cleanly to `AcceptanceContract`, but the real verifier set is closed and likely has stricter per-type evidence requirements.

   The design's type sketch lists `artifact|test|ledger|diff` and omits `review_custody` even though section 2.6 uses it. It also treats acceptance as a flat array of bindings, while `runTaskGraph` is described as carrying a per-node `AcceptanceContract`. Without the actual contract shape, this is not a compiler design; it is a lossy adapter waiting to invent semantics. For example, `{ type:'artifact', artifactRef:'brief.md' } (+ diff binding so an empty file fails)` is not a robust artifact contract unless the existing artifact verifier can express minimum size, schema validation, content hash binding, and producer node ownership.

   What breaks first in P1: `compileSkillToGraph` either cannot typecheck against `AcceptanceContract`, or it creates a permissive shim that reintroduces bespoke verifier behavior under a different name. The first "deterministic unit test" will test the compiler's invented shape rather than the real verifier.

   Concrete fix: define `PhaseSpec.acceptance` as exactly `AcceptanceContract` or a validated `AcceptanceContractTemplate` that compiles through the same schema/parser used by `runVerifier`. Include all five closed verifier types: `artifact | test | ledger | diff | review_custody`. Add negative fixtures per type: unknown verifier type rejected, extra ad hoc fields rejected, artifact path outside declared outputs rejected, review prose without passing acceptance rejected.

3. [MAJOR] Section 2.2 says "No new orchestration code", but section 2.4 requires new orchestration semantics that `runTaskGraph` cannot infer from a static DAG alone.

   A static graph with deps and acceptance can gate phase start, but it does not by itself create isolated worktrees, materialize upstream evidence into downstream context, bind node outputs, or preserve refs-not-raw. The compiler cannot inject the research `outputRef` into execute at compile time because that ref does not exist until research finishes. That means P2 needs a runtime phase-advance mechanism, not just a pure `compileSkillToGraph`.

   What breaks first in P1-P2: either `compileSkillToGraph` emits placeholder refs that are not recomputable evidence, or `runOrchestratorSkill` grows hidden orchestration logic to mutate node context after each phase. That hidden logic becomes the real orchestrator, contradicting section 2.2's "exact TaskGraph shape" claim.

   Concrete fix: split the design into two explicit layers: `compileSkillToGraphTemplate(spec)` for static nodes/deps/contracts, and `runOrchestratorSkill` as a documented dynamic binder that, after each supported node, records `NodeOutputManifest` and derives the next node's `ContextBundle` from ledgered refs. Add a P1/P2 test where execute's context is produced only after research has a supported verifier result, and no downstream context is created when research is unsupported.

4. [MAJOR] Section 2.5's review-node completion model is under-specified and may verify the wrong thing.

   The design says completion is "the verifier verdict on the review node", but the sample Feature-Builder acceptance is just `{ type:'test', command:[compatibility/test cmd] }`. If that command runs in the review worktree, it may not test the execute worktree's patch. If it runs against execute's output, the design needs a clear reviewed-artifact binding. The review phase also produces a review artifact that "does not decide completion", but no contract says the review artifact must reference the exact diff/test evidence being accepted.

   What breaks first in P2/P4: review can become a detached checker that passes tests in a clean or wrong worktree, while the actual execute diff is unreviewed. Alternatively, implementers will shortcut by letting review prose name the execute result, recreating the review/verifier conflation section 4.R3 warns about.

   Concrete fix: make the review node's `AcceptanceContract` explicitly consume `execute.outputManifest.diffRef` and any test/deploy evidence refs. For `test` bindings, specify `cwdRef` or `subjectRef` so the command target is the execute artifact, not an incidental review checkout. Require the review artifact to include machine-checkable references to the execute diff and test evidence, and add a forgery fixture where review says "LGTM" while the execute diff/test refs are missing or mismatched.

5. [MAJOR] Section 3's P2 ledger events are product-shaped but not verifier-shaped.

   `skill.started/phase.advanced/skill.completed` sounds useful operationally, but the design does not define their payloads, hash inputs, or relation to the existing hash-chained ledger and node verdicts. A `skill.completed` event is especially risky: if it carries a completion verdict, it can become a second completion authority; if it only mirrors verifier output, it must be mechanically derived and replay-checkable.

   What breaks first in P2: tests may assert the presence of lifecycle events instead of proving that state transitions are derived solely from verifier-supported node events. That makes the new skill layer look complete while completion authority quietly drifts back into orchestration code.

   Concrete fix: define lifecycle events as derived projections only. `skill.completed` must include `finalNodeId`, `verifierVerdictRef`, `ledgerHeadBeforeEvent`, and no free-form decision field. Add a replay test that deletes/reorders lifecycle projection events and recomputes the same completion from node verifier events, plus a negative test where a forged `skill.completed: supported` cannot advance state without the review node's verifier result.

## What the design gets right and must keep

- It correctly keeps the slice to one orchestrator-as-skill instead of trying to build seven workflows at once.
- It preserves the central thesis: native executors do the work, while the product owns evidence, ledger, verifier, and state transitions.
- It correctly forbids bespoke per-skill verifier code and anchors skill acceptance to the closed verifier set.
- It correctly identifies review/verifier conflation as the most dangerous regression and requires a forgery fixture for "LGTM with no passing acceptance".
- It keeps subjective/aesthetic acceptance behind `review_custody` instead of pretending objective verifiers can judge taste.

VERDICT: PROCEED-WITH-CHANGES

================ crit-claude (completed/supported) ================
# Adversarial Critique — DESIGN.md (M12) through the anti-self-deception lens

**Reviewer stance:** the author is overconfident. The single question is: *can the review
executor's opinion (or any prose) end up standing in for the M7 verifier verdict?* I attacked
§2.5 and R3 hardest. It finds three places where it can.

---

## 1. Most serious issues

### [BLOCKER] Research-Brief completion IS the review executor self-certifying via a non-empty file — §2.5

§2.5 maps Research-Brief review acceptance to `{ type:'artifact', artifactRef:'brief.md' }`
"(+ a `diff` binding so an empty file fails)". The design *concedes in its own parenthesis*
that the only forgery this catches is emptiness. The review-phase executor (P4: `claude review`)
is exactly the agent that can write `brief.md`. So for this orchestrator the chain is:
review executor emits arbitrary non-empty prose → artifact exists → diff is non-empty → verifier
greens. **That is completion-laundering: "the review executor produced a non-empty file" is
indistinguishable from "the work is done."** This is the precise R3 failure ("a review node
saying 'LGTM' ... cannot complete") surviving in a sanctioned config, just with the LGTM moved
into the artifact body. An `artifact`+`diff` binding is a content-blind existence check; it can
never be a HARD gate for a deliverable whose *value lives in the prose*.

**Fix:** forbid `artifact`-only (and `artifact`+`diff`) acceptance on any review node whose
phase executor also *authored* the artifact under review. Either (a) bind Research-Brief
completion to a `test` that runs an **independent** structured check against the closed
`research.json` schema R1 already mandates (schema-valid + required fields populated + each
claim carries a `source_event_id` ref), evaluated by the verifier, not the review executor; or
(b) classify Research-Brief as subjective and route it to the §2.6 `review_custody` human gate.
Do not ship the `artifact`+`diff` mapping as an autonomous completion path.

### [BLOCKER] The verifier must RE-RUN `test`/deploy acceptance in a verifier-controlled environment — §2.5 + §2.4 leave this unspecified

§2.5's engineering gates (`{type:'test', command:[...]}`, deploy-smoke) are only honest if the
**M7 verifier independently executes the command over the execute node's evidence in an
environment the verifier controls.** Two unaddressed laundering vectors:

1. **Reported-result trust.** If "evaluate the contract" means reading a test result the review
   executor reported into its output, then the executor's claim *is* the verdict — R3 verbatim.
   The design never states the verifier re-executes rather than reads.
2. **Executor-controlled environment.** §2.4 says each phase runs in its own isolated worktree.
   The review node's worktree is where the review executor (`claude`) ran with write authority.
   Re-running the `test` command *there* trusts an environment the executor could poison (stub
   the test binary, plant a passing cache, edit the command's fixtures). A passing exit code from
   an executor-owned worktree is not recomputable evidence.

**Fix:** state explicitly in §2.5 that for `test`/deploy bindings the verifier (a) ignores any
executor-reported pass/fail entirely, and (b) re-runs the command in a fresh checkout it
materializes from the **execute** node's evidence ref (sha-pinned), not from the review
executor's mutable worktree. Add a forgery fixture: a review worktree containing a planted
`./node_modules/.bin/test` stub that exits 0 must NOT green when the command is re-run from clean
evidence.

### [MAJOR] `SkillRunReport.completion` is runner-transcribed prose, not ledger-recomputed — §2.3

§2.3 defines `completion` as "the **verifier verdict on the review node**" and the runner
"maps results." That mapping is a transcription step inside `runOrchestratorSkill`. Any consumer
(a human, M8 promotion, a CI gate) that reads `SkillRunReport.completion` is now trusting a field
a buggy or forged runner could set to `supported` regardless of the ledger. The whole thesis is
that completion must be **recomputable from the ledger**, never asserted by an intermediary. A
struct field carrying the verdict is just review-prose with a type annotation — it reintroduces a
second authority one layer up from the one §2.5 correctly closed.

**Fix:** make `completion` non-authoritative by construction. The report must carry only
`ledgerHead` + the review node's contract id; the authoritative verdict is obtained by an
independent `recomputeCompletion(ledger)` that validates the hash chain and re-evaluates the
review node's `AcceptanceContract`. Add a test: mutate `SkillRunReport.completion` to `supported`
while the ledger says `blocked`, and assert the recompute path still reports `blocked`. State in
§2.3 that the field is display-only.

### [MAJOR] SkillSpec acceptance is an unreviewed surface — closed verifier *type* ≠ strong gate — §2.1, R5

§2.1 lets the SkillSpec author supply `acceptance: VerifierBinding[]` per phase. The §1 / corrected
plan §5.2 constraint caps the verifier *type* (artifact|test|ledger|diff), but not its *strength*.
A human author can write `{type:'test', command:['echo ok']}` or a `mustExist:['out.txt']` an
executor satisfies with `touch`. The §3 forgery class ("constant w.r.t. input must FAIL") only
catches a verifier that ignores input — a test that genuinely runs `echo ok` is input-independent
in effect but may slip the literal forgery check. R5 frames this as "spec sprawl / feature creep,"
which *understates* it: the real hazard is that SkillSpec becomes the place to encode a weak
completion gate that is nominally M7-typed but practically self-certifying.

**Fix:** treat every HARD SkillSpec as requiring its own committed forgery fixture *before* it can
run autonomously (corrected plan §5.5: "promote to HARD only when a concrete forgery fixture
justifies it"). The fixture must demonstrate the acceptance fails on a trivially-forged execute
output. Specs without such a fixture run only in `soft-by-decision` / human-gated mode. Add this
gate to §3/P5 so fixture specs cannot ship with a green-by-`touch` acceptance.

### [MINOR] The "review" phase is a vestigial completion-authority-shaped slot — §2.5

Once completion is a `test`/deploy command, that command could attach to the **execute** node's
contract directly. The separate review node exists only to host a review *executor* whose prose
output the design then has to keep insisting is not consulted. Keeping an executor-bearing node
adjacent to the gate is exactly the shape that invites the R3 regression on the next edit.

**Fix:** if the review phase is retained, §2.5 must state flatly that the review node's executor
output is **never an input to any verifier binding** — it may only be ledgered as an advisory
artifact. Better: document why the review node is not collapsed into execute (e.g., it runs a
*different* executor for independence), so the node has a stated purpose beyond holding prose.

---

## 2. What the design gets RIGHT and must keep

- **§2.5 correctly forbids the review executor from deciding completion** and binds the engineering
  orchestrators to `test`/deploy, not to an artifact the reviewer wrote. This is the core thesis
  held in the right place — the blockers above are about *closing the remaining holes in this
  mechanism*, not about the mechanism being wrong.
- **§1 + §2.1: acceptance is a parameterization of the closed M7 verifier set only; no bespoke
  per-skill verifier code.** This caps verifier code at O(types), not O(skills) — directly avoids
  the `product-gate.ts`-at-N-scale failure (corrected plan §5.2). Keep this hard line.
- **§2.6 routes subjective/aesthetic work to a `review_custody` human gate that BLOCKS and is never
  auto-greened.** Encoding BRND's own stated limitation instead of pretending the verifier can
  judge taste is the honest move. Keep it; resist the R4 temptation to overuse it.
- **§2.4 refs-not-raw across phase handoff** — no raw transcript merged into shared context;
  handoff is a sha-pinned evidence ref. Keep.
- **§3 forgery fixtures** (constant-w.r.t-input review node must fail; OLD product-gate regression
  proving it can no longer green a run). Keep and *extend* per the blockers above.
- **§4 R3 is named honestly as "the single most dangerous regression."** The author saw the right
  threat; the issue is the design under-specifies the defenses, not that it is blind to it.

---

VERDICT: PROCEED-WITH-CHANGES

================ crit-agy (completed/supported) ================
# Critique of DESIGN.md: M12 Orchestrator-as-Skill

This document presents an adversarial design critique of [DESIGN.md](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md), incorporating context from [DIRECTION.md](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DIRECTION.md) and [CORRECTED_PLAN.md](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/CORRECTED_PLAN.md).

---

## 1. Most Serious Issues

### Issue 1: [BLOCKER] Spec Sprawl & Second Orchestration Language in OrchestratorSkillSpec
* **Reference:** [DESIGN.md §2.1 & §2.2](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L54-L80)
* **Critique:** The proposed [OrchestratorSkillSpec](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L57-L62) interface defines dynamic `phases: PhaseSpec[]` and explicitly supports dynamic wiring via `deps: PhaseSpec['id'][]`. This is clear scope creep that violates the `R5` risk (spec sprawl) and the "wrap-don't-rebuild" rule. By allowing arbitrary phase ordering and dependencies to be declared in JSON, the design starts creating a new orchestration language that overlaps with the existing engine. 
* **Concrete Fix:** Remove the dynamic `phases` array and `deps` wiring from the declarative JSON spec entirely. The compiler/runner must hardcode the standard 3-phase `research -> execute -> review` sequence. The JSON spec should only configure overrides and parameter bindings for these three fixed phases (e.g. specifying the executors and acceptance verifiers for each phase) instead of defining custom graph topologies.

### Issue 2: [MAJOR] Violation of Tidy First and TDD via Premature Abstraction
* **Reference:** [DESIGN.md §2.1, §2.2, & §3 (P1/P2)](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L54-L87)
* **Critique:** The implementation plan (P1/P2) attempts to design and compile a generic declarative JSON spec first. This violates Kent Beck's "Tidy First" and TDD principles. Building a generic spec-to-graph compiler (`compileSkillToGraph`) before executing a single concrete task end-to-end leads to premature abstraction, over-engineered interfaces, and design drift.
* **Concrete Fix:** Implement the first orchestrator-as-skill (e.g. `feature-builder`) by hardcoding the three-node task graph directly in TypeScript first. Run a live dogfood test (P4) with this concrete, non-declarative graph to verify the handoff mechanics, verifiers, and ledger logging. Extract the commonalities into the declarative [OrchestratorSkillSpec](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L57) JSON schema and [compileSkillToGraph](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L76) function only after the concrete case is fully verified.

### Issue 3: [MAJOR] Temporal and Spatial Coupling in Cross-Worktree Handoff
* **Reference:** [DESIGN.md §2.4](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L89-L96)
* **Critique:** The design states that the `execute` worktree reads the research artifact directly from the research worktree's filesystem path ("reads the referenced artifact from the research worktree branch"). This introduces a fragile temporal and spatial coupling: it assumes the research worktree remains untouched at a static disk path. If the workspace is cleaned, or if worktrees are pruned concurrently, the execute phase will fail to locate its input.
* **Concrete Fix:** Completely decouple worktrees. The runner must retrieve the research artifact from the hash-chained ledger/evidence store using its sha256 reference and write it directly into the `execute` worktree's input directory during setup. Worktrees must never read from each other's filesystem paths directly.

### Issue 4: [MAJOR] Shallow and Forgeable Verification of Intermediate Artifacts
* **Reference:** [DESIGN.md §2.5](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L97-L106)
* **Critique:** The design relies on `{ type: 'artifact', artifactRef: 'brief.md' }` plus a `diff` binding to verify research or review outputs. This verification is too shallow: a model can write a file containing garbage or repeated text, which would trivially satisfy the existence and diff checks, greening the verifier while producing no actual value.
* **Concrete Fix:** Mandate that intermediate artifacts (e.g. research briefs, reviews) conform to a structured format (like JSON) matching a closed schema. Add a schema-validation verifier to the M7 closed verifier set. The verifier must assert that the artifact is present, valid JSON, and conforms strictly to the schema (e.g. verifying the presence of non-empty arrays for findings and sources).

### Issue 5: [MAJOR] Unconstrained Human Gate as an Autonomy Cop-out
* **Reference:** [DESIGN.md §2.6](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L107-L114)
* **Critique:** The `review_custody` human gate is introduced without explicit constraints or cryptographic anchoring. Unconstrained human gating risks becoming a cop-out for failing to write robust automated verifiers, reverting the "AI-native" system to an "AI-assisted" loop. Furthermore, reading a mutable "external approval record" introduces a forgeable authority path.
* **Concrete Fix:** Restrict the `review_custody` gate strictly to subjective/creative outputs (which must be ledgered as `soft-by-decision` per [CORRECTED_PLAN.md §4](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/CORRECTED_PLAN.md#L72-L78)). Prohibit its use on objective tasks (like compatibility or smoke tests) where hard verification is possible. Additionally, require that human approval be recorded as a cryptographically signed event in the ledger, with the public key verified against a known operator key, rather than reading a mutable external database or file.

---

## 2. What the Design Gets Right

* **Wrap, Don't Rebuild:** The design correctly leverages existing native executors (`codex`, `claude`, `agy`) and the existing `runTaskGraph` engine, keeping the orchestrator-as-skill as a thin wrapper.
* **M7 Completion Authority:** It correctly maintains the boundary that the review executor does not decide completion; only the M7 verifier evaluates the review node's [AcceptanceContract](file:///private/var/folders/tx/vskd6j4j1197bvg4mkxdjp7w0000gn/T/critique-N55WuO/.agent/worktrees/crit-agy/DESIGN.md#L23) over recomputable evidence.
* **Ledger-based State (SOT):** Appending all phase outputs and execution metadata to the hash-chained ledger via evidence refs (refs-not-raw) preserves the source-of-truth integrity.
* **One Skill Focus:** Scoping the milestone to "one skill, not seven" is a disciplined cut that prevents scope creep and focuses on building depth.

---

VERDICT: PROCEED-WITH-CHANGES
PANEL_EXIT=0

# Harness-OS Ultragoal Plan: Divide, Conquer, and Critic-Lock

**Date:** 2026-06-04
**Status:** Binding execution ultragoal. Not a completion claim.
**Source docs reviewed together:**
- `docs/milestones/ULTIMATE_GOAL_DIVIDE_AND_CONQUER_PLAN.md`
- `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`

**External critic method tested:** local Claude CLI through `$ask-claude` canonical path, `omx ask claude ...`; see §8.

---

## 0. Blunt thesis

maestro must become a **provider-neutral evidence-and-control layer** over rented lower-level executors.

The product does **not** win by rebuilding the full coding-agent loop from scratch first. It wins by owning the parts that cannot be trusted to a vendor harness:

- base rules;
- memory provenance;
- lifecycle hooks and state transitions;
- context composition;
- policy and permission classification;
- append-only event ledger;
- verifier harness;
- promotion and effect proof;
- operator-visible trust UI.

For Phase A, the canonical execution substrate is **native executor over Dominic-owned evidence contract**: start with the existing native executor path (`codex exec` / Claude Code-style rented loop where available), but never let vendor-native success text, prose review, or self-written JSON mark completion.

Direct provider APIs are **future optional adapters** behind the same contract. They are not the current proof path.

---

## 1. Non-negotiable anti-weasel law

Every stage below is blocked unless it satisfies all rules in this section.

### 1.1 No prose-only completion

A stage cannot pass because a document says it passes. It passes only by a command that recomputes from raw evidence and exits with the expected result.

Required per stage:

```text
Done gate command: <exact command>
Expected result: <exit code and key output>
Evidence inputs: <raw files read by the gate>
Evidence outputs: <new artifacts written by the gate>
```

### 1.2 Every load-bearing claim needs a forgery fixture

If the stage says “X is enforced,” the same stage must include a committed fixture that tries to forge X and is rejected.

No fixture means the claim is only `soft-by-decision`, never `supported`.

### 1.3 Recompute from raw, not from summaries

Verifiers may read:

- source files;
- git diff/status/tree;
- event ledgers;
- artifact hashes;
- test stdout;
- signed or custody-attested review inputs when present.

Verifiers must not treat the following as proof by themselves:

- hand-written `*-effect.json`;
- manually edited pass reports;
- model or Claude/Codex prose saying “looks good”;
- prior verifier summary as input to the next verifier;
- old run artifacts not chained to the current ledger head.

### 1.4 Input sensitivity is mandatory

Every verifier must have a negative test proving its decision changes when the raw input is tampered.

A verifier that returns the same pass result for good and broken input is a theater gate and must be demolished.

### 1.5 Demolish old self-certifying paths before claiming replacement

If a new gate replaces old completion logic, the old route must be blocked in the same stage.

Specific demolition targets:

- `product-gate.ts` self-certifying completion logic;
- hardcoded reviewer / symmetric self-signing paths around `core.ts:784/818/1822` if still present;
- any gate that accepts author-written review files as independent review;
- any completion path that credits stale `.agent` artifacts without current ledger chaining.

### 1.6 Closed status vocabulary

Allowed statuses only:

```text
supported | degraded | unproven | unsupported | native-harness-assisted | soft-by-decision | blocked
```

Default is `unproven`. Absence of evidence never upgrades to `supported`.

### 1.7 Solo ceiling and native ceiling are hard caps

- Solo-run “independence” is capped at approximately **75** because the operator still controls the machine, keys, prompts, and artifacts.
- Native-executor mode can own evidence and gating, but cannot honestly claim full in-loop tool mediation when the rented harness owns shell/file actions. Such claims are `external/unowned` unless a direct-model tool loop is actually implemented and verified.

---

## 2. Completion percentage formula

Completion percent must not be guessed from lines of code or passing prose gates.

Use this formula:

```text
stage_score = min(done_gate, forgery_fixture, input_sensitivity, freshness_binding, demolition_if_applicable)
module_score = weighted average of stage_scores
native executor LOC credit toward M1-M8 spine = 0 unless it is wrapped by Dominic-owned ledger/verifier/policy evidence
solo independence cap = 75
hard completion cap with any blocked P0 = 60
```

Where each gate component is binary:

- `1` only if verified by command in the current checkout;
- `0` otherwise.

No stage may receive partial credit for intent.

---

## 3. Divide-and-conquer stage order

This replaces “many parallel modules” with a spine. Later stages may branch, but no branch may bypass an earlier blocking stage.

```text
M-1 Integrity Baseline
  -> M0 Provisional Contract
  -> L Ledger Hash Chain
  -> M7 Verifier Demolition Harness
  -> N Native Executor Evidence Slice
  -> P Policy / Permission Reality
  -> C Context + Memory Provenance
  -> M8 Promotion Three-Run Differential
  -> S Skill Wrapper Hardness
  -> U Operator Trust UI
  -> D Direct Provider Adapters (optional future)
  -> X Multi-Executor Scale
```

---

## 4. Stage contracts

### M-1 — Integrity Baseline

**Goal:** A clean checkout reproduces the product. No invisible local-only code can carry the plan.

**Must build:**
- clean clone reproduction check;
- committed source for the native executor runner used by the plan;
- ADR superseding old OMX-first canonical language;
- doc-lint rule that flags stale canonical-runtime wording.

**Done gate command:**

```bash
git status --porcelain
npm test
npm run lint
git diff --check
```

**Pass condition:**
- `git status --porcelain` empty;
- tests/lint/diff-check pass;
- ADR exists at `docs/adr/0001-provider-neutral-supersedes-omx-first.md` or an explicit successor;
- stale direct-provider-canonical wording is either removed or marked superseded.

**Forgery fixture:**
- create a fixture clean-checkout or test temp tree missing the native executor runner; gate must fail.

**May not credit:**
- untracked files;
- `.agent` local artifacts;
- `.omx` state;
- a successful build on the author’s dirty working tree.

**Critic lock:** If this stage fails, every later stage is `blocked`. No “but it works locally” exception.

---

### M0 — Provisional Contract

**Goal:** Define the evidence contract but do not freeze unproven fields.

**Must build:**
- one canonical contract surface for run, event, verifier, context, memory, promotion, and status;
- explicit `unstable: pending evidence` labels for fields not proven by real runs;
- removal or quarantine of contradictory contract vocabulary.

**Done gate command:**

```bash
npm test -- --runInBand contract
# or the repo's equivalent targeted contract/schema test
```

**Pass condition:**
- all referenced types exist;
- no stage consumes an undefined type;
- direct provider fields remain provisional until a real provider adapter proves them.

**Forgery fixture:**
- contract references a missing type; gate rejects it.

**May not credit:**
- a pretty schema document without a parser or test;
- freezing `ExecutorResult`, `ToolIntent`, or memory fields before one real run exercises them.

**Critic lock:** “We’ll define it later” means `blocked`, not `supported`.

---

### L — Ledger Hash Chain

**Goal:** Make event history tamper-evident.

**Must build:**
- `prev_event_sha256` or equivalent hash-chain field;
- ledger verifier that recomputes from raw events;
- current-run head binding for evidence freshness.

**Done gate command:**

```bash
npm test -- ledger
node dist/cli.js runtime verify-ledger --run <run-id>
```

**Pass condition:**
- untampered ledger passes;
- tampered middle event fails;
- stale evidence not chained to current head fails.

**Forgery fixture:**
- mutate a middle event while preserving final summary; verifier must fail.

**May not credit:**
- append-only by convention;
- JSONL files without hash linkage;
- latest report timestamp without ledger head binding.

**Critic lock:** If stale evidence can be replayed as current, the stage is failed.

---

### M7 — Verifier Demolition Harness

**Goal:** Replace self-certifying completion with recomputable gates.

**Must build:**
- shared verifier library;
- closed verifier types such as `artifact`, `test`, `ledger`, `diff`, `review_custody`;
- demolition tests proving old self-certifying product gates cannot mark complete;
- input-sensitivity test for every verifier type.

**Done gate command:**

```bash
npm test -- verifier
node dist/cli.js quality gate --write
```

**Pass condition:**
- quality gate fails when independent custody is absent;
- quality gate cannot pass on hand-authored reviewer JSON alone;
- every verifier type has at least one negative fixture.

**Forgery fixture:**
- hand-authored “independent review” with internally consistent hashes but no reviewer custody; gate must not claim independent completion.

**May not credit:**
- code-review prose;
- Claude/Codex approval text;
- author-signed artifacts as independent review;
- a verifier output JSON as its own evidence.

**Critic lock:** If a model can say “APPROVE” and upgrade completion, the stage is failed.

---

### N — Native Executor Evidence Slice

**Goal:** Prove the first daily-usable slice over a native executor while owning the evidence layer.

**Must build:**
- one real task run through existing native executor path;
- launch metadata, transcript/session identifier when available, stdout/stderr capture, git diff capture, artifact hash chain;
- `native-harness-assisted` label with unowned surfaces enumerated;
- post-hoc diff and effect classification.

**Done gate command:**

```bash
node dist/cli.js run native-evidence-smoke --task <fixture-task>
node dist/cli.js runtime verify-ledger --run <run-id>
node dist/cli.js verifier run --run <run-id>
```

**Pass condition:**
- real work happens;
- verifier recomputes from ledger, diff, and artifacts;
- native harness text alone cannot pass;
- unowned surfaces are visible.

**Forgery fixture:**
- a native CLI completion message without matching diff/artifact evidence; verifier rejects.

**May not credit:**
- “Codex said done”;
- Claude/Codex native memory/hooks/subagents as Dominic-owned enforcement;
- shell process exit without result evidence.

**Critic lock:** Native executor is allowed as substrate, but it is never allowed to own truth.

---

### P — Policy and Permission Reality

**Goal:** Classify risk from actual tool/action content, not caller-supplied labels.

**Must build:**
- closed mediated-tool catalog;
- parser/classifier for actual command/tool args;
- `requires_approval` default for unknown or invalid tools;
- native mode caveat: `mediation: external/unowned` for in-loop actions not visible to Dominic.

**Done gate command:**

```bash
npm test -- permission
node dist/cli.js policy verify-fixtures
```

**Pass condition:**
- destructive command tagged `general_tool` is still rejected or requires approval;
- allowed safe command passes only when args are valid;
- native unseen tool execution cannot claim `supported` mediation.

**Forgery fixture:**
- destructive shell labeled `general_tool`; broker must not auto-allow.

**May not credit:**
- executor-provided risk labels;
- prompt instructions telling the model to be safe;
- sandbox claims without post-hoc evidence.

**Critic lock:** If the executor can relabel danger as safe, the policy layer is forgeable and failed.

---

### C — Context, Memory, and Projection Provenance

**Goal:** Make context and memory auditable, fresh, and visible.

**Must build:**
- one memory schema keyed by provenance, source event ids, and verification recency;
- context bundle hash that lists exact rules, memories, docs, and policy used;
- projection/UI state derived from ledger, not manually curated reports;
- stale-memory rejection gate.

**Done gate command:**

```bash
npm test -- memory
npm test -- projection
node dist/cli.js context verify --run <run-id>
```

**Pass condition:**
- context bundle can be recomputed;
- stale or unverified memory cannot be presented as current fact;
- UI/projection agrees with ledger head.

**Forgery fixture:**
- old memory fact copied into current run without source-event chain; gate rejects.

**May not credit:**
- memory storage without grading/provenance;
- UI showing a status not derived from ledger;
- summaries that omit source freshness.

**Critic lock:** “I remember” is not evidence.

---

### M8 — Promotion Three-Run Differential

**Goal:** Prove approved learning changes later behavior under controlled conditions.

**Must build:**
- run A: baseline behavior;
- run B: promotion proposal and approval;
- run C: later behavior with exactly one promoted delta loaded;
- deterministic mode recorded (`temperature=0`, fixed fixture, or k-replay policy);
- closed enum decision fields.

**Done gate command:**

```bash
node dist/cli.js promotion three-run-fixture --write
node dist/cli.js promotion verify-effect --fixture .agent/promotion-fixtures/<id>
```

**Pass condition:**
- behavior changes only after approved promotion is loaded;
- unrelated changes are controlled;
- stochastic uncertainty is recorded and bounded.

**Forgery fixture:**
- promotion effect JSON is edited without corresponding run evidence; verifier rejects.

**May not credit:**
- proposal creation alone;
- reviewer prose saying learning happened;
- two-run correlation without baseline/control.

**Critic lock:** If causality is not bounded, the promotion claim is `unproven`.

---

### S — Skill Wrapper Hardness

**Goal:** Wrap existing native skills with explicit contracts instead of rebuilding every skill.

**Must build:**
- `AcceptanceContract` per hard skill;
- zero bespoke verifier logic per skill unless it extends the shared M7 verifier type set;
- `SOFT` skill label for guidance-only skills;
- `HARD` skill label only when forgery fixture exists.

**Done gate command:**

```bash
node dist/cli.js skills verify-contracts
npm test -- skills
```

**Pass condition:**
- hard skills carry contract + verifier binding;
- soft skills cannot gate completion;
- native skill output is advisory unless verifier evidence exists.

**Forgery fixture:**
- skill emits plausible success text without required artifact; gate rejects.

**May not credit:**
- native skill existence;
- skill README claims;
- per-skill checker sprawl that bypasses M7.

**Critic lock:** Skill output is not proof. Skill output is raw material for proof.

---

### U — Operator Trust UI

**Goal:** Make truth understandable to the operator.

**Must build:**
- run status derived from ledger/projection;
- visible labels for `supported`, `unproven`, `native-harness-assisted`, `soft-by-decision`, `blocked`;
- evidence drill-down for each gate;
- contradiction panel when docs and gates disagree.

**Done gate command:**

```bash
npm test -- ui
node dist/cli.js ui agreement-smoke --run <run-id>
```

**Pass condition:**
- UI cannot show green when gate is red;
- stale docs are subordinated to current evidence;
- unowned native surfaces are visible.

**Forgery fixture:**
- manually edit report to PASS while gate artifact is FAIL; UI/projection must show FAIL or contradiction.

**May not credit:**
- API 200 alone;
- static page screenshot without data agreement;
- optimistic labels hidden from evidence.

**Critic lock:** If the UI can comfort the operator with a lie, the product failed.

---

### D — Direct Provider Adapters Optional Future

**Goal:** Add direct OpenAI/Anthropic/Gemini/local adapters only after the evidence spine works.

**Must build:**
- provider normalization spec for tool calls and refusals;
- conformance fixtures for OpenAI `tool_calls`, Anthropic `tool_use`, Gemini `functionCall`, and local-model equivalents;
- direct tool loop owned by Dominic if claiming tool mediation.

**Done gate command:**

```bash
npm test -- provider-normalization
node dist/cli.js provider conformance --all
```

**Pass condition:**
- same acceptance contract can evaluate at least two providers or one provider plus deterministic mock;
- tool intent parsing is byte-recorded and fixture-backed.

**Forgery fixture:**
- provider-native “done” text without schema-valid output and evidence; verifier rejects.

**May not credit:**
- SDK installation alone;
- a single prompt-response demo;
- direct provider path as Phase A proof.

**Critic lock:** Direct API is optional future, not a loophole to dodge native-over-evidence delivery.

---

### X — Multi-Executor Scale

**Goal:** Coordinate multiple executors only after single-run truth is hard.

**Must build:**
- bounded parallel runs;
- blackboard/event merge rules;
- conflict detection;
- synthesis based on artifacts and verifier outputs, not model rank.

**Done gate command:**

```bash
node dist/cli.js multi-executor fixture --write
node dist/cli.js multi-executor verify --fixture .agent/multi-executor-fixtures/<id>
```

**Pass condition:**
- parallel conflicts are detected;
- synthesis cannot hide failed worker evidence;
- no worker can self-promote its own completion.

**Forgery fixture:**
- one worker writes PASS summary while its raw diff/test fails; synthesis rejects.

**May not credit:**
- many panes running;
- many agents talking;
- consensus prose.

**Critic lock:** Coordination theater is worse than single-agent honesty.

---

## 5. High-intensity critic protocol per stage

Every stage must run the critic protocol before it can be marked complete.

### 5.1 Critic prompt shape

The critic must answer these questions bluntly:

1. What exact claim is being made?
2. What raw evidence proves it?
3. What fixture proves the verifier rejects a forgery?
4. What stale evidence could be reused to fake success?
5. What old path still lets the executor bypass this gate?
6. What status must be downgraded because evidence is incomplete?
7. What would make this stage fail even if all prose looks good?

### 5.2 Critic output rules

Allowed critic verdicts:

```text
APPROVE_WITH_EVIDENCE
REQUEST_CHANGES
BLOCK_AS_THEATER
SOFT_ONLY_NOT_SUPPORTED
```

A critic verdict cannot mark a stage complete. It can only block, downgrade, or add required evidence. Completion still comes from recomputable gates.

### 5.3 External critic option

Claude CLI may be used as an external advisor/critic signal through the tested local path in §8, but its output is:

- advisory;
- `native-harness-assisted`;
- non-custodial;
- not independent review by itself;
- never a completion gate by itself.

---

## 6. Global kill conditions

The ultragoal must be stopped or downgraded if any of these are true:

- a stage passes without a forgery fixture;
- a stage passes from a model/reviewer prose artifact alone;
- a gate reads a summary generated by the executor instead of raw evidence;
- stale evidence from a prior run is accepted as current;
- clean clone cannot reproduce the product;
- native harness participation is hidden;
- solo Claude/Codex review is presented as independent custody;
- completion percent rises while a P0 blocker is open;
- UI says PASS while current gate says FAIL;
- an old self-certifying gate remains reachable.

---

## 7. First executable slice

The next slice is **not** “finish all architecture.” It is the smallest daily-usable proof:

1. clean integrity baseline;
2. hash-chained ledger;
3. verifier demolition of self-certifying completion;
4. one native executor run through Dominic-owned evidence contract;
5. high-intensity critic artifact;
6. UI/projection displays `native-harness-assisted`, raw evidence, and unowned surfaces.

Success means a real task can run through a rented executor while maestro owns the evidence and refuses to lie about what it does not own.

---

## 8. Claude CLI callability test and required documentation

### 8.1 Tested command path

The `$ask-claude` skill requires local Claude CLI and prefers the canonical OMX command path:

```bash
omx ask claude "<prompt>"
```

Local binary was present in this checkout:

```text
command -v claude
~/.local/bin/claude

claude --version
2.1.161 (Claude Code)
```

Callability smoke was executed:

```bash
omx ask claude 'Return exactly: CLAUDE_OK'
```

Result artifact:

```text
.omx/artifacts/claude-return-exactly-claude-ok-2026-06-04T00-51-25-195Z.md
```

The artifact records provider `claude`, exit code `0`, raw output `CLAUDE_OK`.

### 8.2 External high-intensity critique test

A second Claude critic invocation was executed against this ultragoal rewrite requirement:

```bash
omx ask claude "$(cat /tmp/claude-ultragoal-critique-prompt.txt)"
```

Result artifact:

```text
.omx/artifacts/claude-you-are-an-external-adversarial-reviewer-for-the-dominic-orc-2026-06-04T00-52-44-795Z.md
```

The Claude critique was used only as advisory input. Its key anti-weasel requirements are incorporated here:

- every stage needs a committed failing-forgery fixture;
- gates recompute from raw evidence;
- input-sensitivity tests are mandatory;
- old self-certifying gates must be demolished before replacement claims;
- stale evidence must be rejected by current ledger-head binding;
- Claude output cannot mark completion;
- solo Claude review does not create independent custody.

### 8.3 Future stage requirement

Each future stage should capture external critic calls under `.omx/artifacts/claude-*.md` when Claude is available. If Claude is absent, the stage must record:

```text
claude_status: unproven
reason: local Claude CLI unavailable
verification_command: claude --version
```

The absence of Claude must not block purely deterministic gates, but it also must not be hidden.

---

## 9. Ultragoal ledger update rule

When this document is converted into active `.omx/ultragoal/goals.json`, goals must be generated as stage goals in this exact order:

1. `M-1-integrity-baseline`
2. `M0-provisional-contract`
3. `L-ledger-hash-chain`
4. `M7-verifier-demolition-harness`
5. `N-native-executor-evidence-slice`
6. `P-policy-permission-reality`
7. `C-context-memory-projection-provenance`
8. `M8-promotion-three-run-differential`
9. `S-skill-wrapper-hardness`
10. `U-operator-trust-ui`
11. `D-direct-provider-adapters-optional`
12. `X-multi-executor-scale`

Do not let an automated goal parser split baseline notes, critic rules, or caveats into fake goals. The goals are the numbered stage list above only.

---

## 10. Final hard statement

This ultragoal is designed to prevent the executor from escaping through:

- documentation theater;
- stale artifact reuse;
- self-authored independent review;
- model approval laundering;
- string-matching gates;
- native harness success claims;
- completion percentage inflation;
- dirty-working-tree proof;
- UI optimism.

If a stage cannot survive its own forgery fixture and high-intensity critic, it is not done.

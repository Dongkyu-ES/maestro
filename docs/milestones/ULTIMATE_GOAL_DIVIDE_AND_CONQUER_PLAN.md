# Ultimate Goal Redesign: Provider-Neutral Harness Control Plane

**Date:** 2026-06-04
**Status:** Design rewrite + self-critique. This is not a completion claim.
**Supersedes:** prior “Ultimate Goal → Divide & Conquer Plan” framing that treated Codex/OMX/Claude-style native agent runtimes as first-class product runtime targets too early.
**Controlling thesis:** Warden must own the harness. LLMs are independent lower-level executors, not the source of runtime truth.

> **BINDING CORRECTION (2026-06-04, applied):** A 5-lens code-grounded critique found this draft *right in direction, wrong in sequencing* (`structure_survives: false`; honest re-baseline vs this goal ≈ **7%**). Two reversals are now folded into §4.2/§5/§11 below and detailed in `HARNESS_OS_CORRECTED_PLAN.md`: (1) **own the LAYER, not the loop** — the canonical execution substrate is the existing native executor (`codex exec`) wrapped by the evidence contract; direct-provider API is an *optional future* adapter, NOT the proof path; (2) a new **M‑1 Integrity Baseline** blocks M0, and the shipped self-certifying gate (`product-gate.ts`, `core.ts:784/1822`) must be demolished before M7. Where this banner and the corrected plan disagree with the original prose below, the corrected plan wins.

---

## 0. Blunt Restatement

The old direction was close but still too vendor-agent-shaped: “wrap Codex/OMX/agy/Claude-like runtimes and compare them.” That risks letting each vendor’s native harness decide behavior through its own `AGENTS.md`, `CLAUDE.md`, memory, hooks, subagents, permissions, and compaction lifecycle.

The redesigned target is stricter:

> **Warden is a provider-neutral local control plane that builds its own base rules, memory, hook lifecycle, context composer, tool policy, event ledger, verifier, and promotion loop. OpenAI/Anthropic/Gemini/local models are invoked as disposable lower-level LLM executors. Codex CLI, Claude Code, OMX, and other native agent harnesses may be used only as optional compatibility adapters, never as the controlling harness.**

The ultimate product is therefore not “a better Codex wrapper” or “a bridge between Codex and Claude Code.” It is a **cross-model warden harness OS** whose own deterministic contracts force different models to satisfy the same acceptance criteria.

---

## 1. Why the Target Changed

### 1.1 The real problem

Codex and Claude Code are both strong, but their harnesses are strong in different directions:

- Codex/OMX-style operation is naturally centered on `AGENTS.md`, Codex config/hooks, skills, plugins, subagents, sandbox/approval, and local runtime wrappers.
- Claude Code-style operation is naturally centered on `CLAUDE.md`, `.claude/rules`, auto memory, skills, custom subagents, rich hook events, settings, and permission modes.

If Warden treats those native harnesses as peer runtimes, the product inherits their differences:

- different instruction precedence;
- different memory semantics;
- different hook timing and enforcement;
- different subagent spawning rules;
- different compaction/resume behavior;
- different permission/sandbox assumptions;
- different “what counts as done” defaults.

That makes cross-model parity impossible to prove. The same model quality can produce different outcomes because the **harness**, not the model, quietly changed the task.

### 1.2 Corrected product insight

The model is not the product. The vendor agent CLI is not the product. The harness is the product.

So Warden must define:

1. the base instruction contract;
2. the memory authority model;
3. the lifecycle hooks;
4. the tool/permission broker;
5. the context assembly graph;
6. the executor interface;
7. the evidence ledger;
8. the verifier gates;
9. the promotion/learning loop;
10. the operator UI for inspecting all of the above.

LLMs then become interchangeable workers under this contract.

---

## 2. New Ultimate Goal

Warden is complete when a clean local install can take a user goal, assemble deterministic context and policy, invoke one or more model providers as bounded executors, run allowed tools through the orchestration layer, collect evidence, verify acceptance gates, and update approved learning artifacts — **without depending on Codex CLI, Claude Code, OMX, or any vendor-native warden harness for correctness.**

### 2.1 Invariants

1. **Harness-owned truth.** State, memory, policy, hooks, verifier decisions, and lifecycle transitions live in Warden, not in vendor CLIs.
2. **LLM-as-executor.** OpenAI, Anthropic, Gemini, local models, Codex CLI, Claude Code, and shell are all adapter choices behind one executor contract.
3. **Native agent minimization.** Vendor-native agent harnesses are optional compatibility bridges. They cannot be required for product identity, hard gates, or completion claims.
4. **Canonical base rules.** The product owns its own base rules (`BaseRuleSet`) and composes them into prompts/tool policies. `AGENTS.md`/`CLAUDE.md` may be generated or imported, but they are not the canonical authority.
5. **Deterministic lifecycle hooks.** Before/after prompt, model call, tool call, file write, compaction, stop, and promotion are product hooks, not vendor hooks.
6. **Memory is evidence-graded.** Memory is not a rule. Memory is retrieved, graded, verified when necessary, and then included or excluded with provenance.
7. **Verification beats narration.** No model output can mark work complete. Only verifier gates over artifacts, diffs, logs, browser/PPT/test evidence, and schemas can do that.
8. **Composable modules.** Each module has a contract, input/output schema, ledger events, tests, and a paired forgery case that must fail.
9. **Degraded modes are honest.** If only shell or a weaker model is available, the product can run in degraded mode but must label unsupported/unproven behavior.
10. **Vendor harness escape hatch is explicit.** If Codex CLI or Claude Code is used for a task, the run is labeled `native-harness-assisted`, and the verifier distinguishes Dominic-owned evidence from vendor-owned behavior.

---

## 3. Terminology Reset

| Term | New meaning |
|---|---|
| **Harness** | Dominic-owned deterministic lifecycle: rules, hooks, memory selection, policy, tool execution, ledger, gates. |
| **LLM Executor** | A model call or model session that proposes text/tool intents under a bounded contract. |
| **Native Agent Harness** | Codex CLI, Claude Code, OMX, agy, or any environment with its own instructions/hooks/memory/subagents. |
| **Compatibility Adapter** | A bridge to a native warden harness used only when useful, labeled as such, never trusted as canonical. |
| **BaseRuleSet** | Product-owned invariant rules. Compiled into prompts and policy checks. |
| **ContextBundle** | Deterministic, hash-addressed context assembled from task, repo, memory, rules, policy, and artifacts. |
| **ToolIntent** | Model-proposed action before policy approval and execution. |
| **ToolExecution** | Harness-owned execution of an allowed tool intent. |
| **Verifier** | Deterministic or reviewer-custodied gate that checks evidence, not claims. |
| **Promotion** | Approved change to base rules, skill, memory, policy, verifier, or workflow, proven by later behavioral effect. |

---

## 4. Target Architecture

```text
Warden
├─ Operator UI / CLI
├─ Goal Intake
├─ BaseRule Engine
├─ Memory Fabric
├─ Context Composer
├─ Policy + Permission Broker
├─ Product Hook Runtime
├─ Tool Runtime
├─ LLM Executor Runtime
│  ├─ OpenAI direct model adapter
│  ├─ Anthropic direct model adapter
│  ├─ Gemini direct model adapter
│  ├─ Local/OSS model adapter
│  ├─ Codex CLI compatibility adapter        # optional, labeled
│  ├─ Claude Code compatibility adapter      # optional, labeled
│  └─ Shell/no-model executor                # degraded, labeled
├─ Event Ledger + Artifact Store
├─ Projection / UI truth model
├─ Verifier Harness
└─ Promotion / Learning Engine
```

### 4.1 Control rule

Only the orchestrator can advance state:

```text
model output -> parsed proposal -> policy check -> harness execution -> evidence -> verifier -> state transition
```

Never:

```text
model says done -> state complete
vendor CLI says done -> state complete
review text says pass -> state complete
```

### 4.2 Canonical path is native-executor-over-evidence-contract (CORRECTED)

> ~~Original draft: "Direct model path is the primary product path."~~ **Reversed.** The only working executor today is the native `codex exec` adapter; direct-provider API is 0% (`package.json` `dependencies={}`). Rebuilding the commoditized warden loop (tool-calling/patch/retry/compaction) from scratch for a solo dev — while every real run keeps routing through `codex exec` and is stamped `native-harness-assisted` forever — is self-defeating.

The first-class runtime path is a **thin native-executor adapter wrapped by the product's evidence contract**: rent the loop (Codex CLI / Claude Code as commodity agent loops), own the layer (ledger + verifier + promotion + projection + policy) on top. A run is canonical when its evidence is recomputable in the Dominic ledger and passes the Dominic verifier — regardless of which loop produced the diffs.

**Direct provider calls (OpenAI/Anthropic/Gemini API)** are an **optional future adapter behind the same contract**, NOT the proof path. They require a per-provider tool-call normalization sub-spec (OpenAI `tool_calls` vs Anthropic `tool_use` vs Gemini `functionCall` → one `ToolIntent`) that is specified nowhere yet; until that exists with conformance fixtures, the direct path is `unproven` by construction.

### 4.3 Native harnesses are compatibility paths

Codex CLI and Claude Code may be useful for specific tasks, but they are treated as black-box or semi-black-box executors with known contamination risks:

- hidden or tool-specific instruction layers;
- auto memory behavior;
- hook side effects;
- permission mode drift;
- compaction/resume differences;
- subagent behavior not owned by Warden.

Therefore native-harness-assisted runs must emit:

```yaml
runtime_label: native-harness-assisted
adapter: codex-cli | claude-code | omx | agy
known_unowned_surfaces:
  - native_instructions
  - native_memory
  - native_hooks
  - native_subagents
  - native_compaction
verifier_status: supported | unproven | unsupported
```

---

## 5. Divide & Conquer Modules

Each module is composable, but they are a **spine with branches, not 7+ orthogonal tracks** (M2's injected context only reaches a model through the executor; M8 = M7 ⊕ promotion). The **CORRECTED** build order (see `HARNESS_OS_CORRECTED_PLAN.md` §3):

```text
M-1 Integrity Baseline        (NEW; BLOCKS M0 — clean clone reproduces product incl.
                               codex-exec-runner.ts; commit-or-delete ~2878 uncommitted
                               lines; ADR 0001 supersedes PRD "OMX First")
  -> M0  Provisional Contract  (was "freeze" → provisional schemas + fixture validator;
                                define the dangling AcceptanceContract type)
  -> L   Ledger Hash-Chain     (prev_event_sha256; precondition for every recompute gate)
  -> M5' Policy/Tool mediation (classify from actual tool+args, not caller label)
  -> N   Native-Executor Canonical Adapter  (wrap codex-exec-runner in the evidence contract)
  -> M7  Verifier Harness      (+ DEMOLISH product-gate.ts, core.ts:784 APPROVE, :1822 score)
  -> M8  Promotion Loop        (three-run differential)
  -> M2  Memory Fabric         (reconcile 3 schemas to ONE first)
  -> M9  Operator UI / Projection
  -> M12 Skills = wrap-don't-rebuild  (STRICTLY after M7+M8)
  -> M6  Direct LLM Executor   (OPTIONAL future; needs the normalization sub-spec)
  -> M11 Multi-Executor Orchestration
```

The native executor is the **canonical substrate, not a late "compatibility" afterthought.** "native-harness-assisted" labels the *unowned surfaces* (memory/hooks/subagents/compaction), not a second-class run. Direct-API (M6) is the late/optional one. No completion-% may credit the 1206-LOC `runtime/*` surface against spine modules M1–M8.

---

## 6. Module Contracts

### M0 — Contract Baseline

**Goal:** Freeze the provider-neutral contract before implementation expands.

**Outputs:**

- `docs/milestones/PROVIDER_NEUTRAL_HARNESS_CONTRACT.md`
- JSON schemas for `BaseRuleSet`, `ContextBundle`, `ExecutorRequest`, `ExecutorResult`, `ToolIntent`, `VerifierResult`, `PromotionEffect`.
- Status vocabulary: `supported`, `degraded`, `unproven`, `unsupported`, `native-harness-assisted`.

**Done gate:** clean checkout can validate all schemas and reject malformed fixtures.

**Forgery that must fail:** a fixture that marks `complete` without verifier evidence.

---

### M1 — BaseRule Engine

**Goal:** Replace vendor instruction files as the source of truth.

**Responsibilities:**

- own invariant operating rules;
- own project-specific rules;
- own model/provider-specific adaptation notes;
- compile rules into prompt segments and policy assertions;
- export optional `AGENTS.md`/`CLAUDE.md` compatibility files when needed.

**Interface:**

```ts
interface BaseRuleSet {
  version: string;
  invariants: Rule[];
  projectRules: Rule[];
  providerHints: Record<string, Rule[]>;
  enforcement: Array<{ ruleId: string; hookId?: string; verifierId?: string }>;
}
```

**Done gate:** a rule can be compiled into both (a) prompt text and (b) a verifier/policy check when marked enforceable.

**Forgery that must fail:** a model prompt includes a rule, but the enforceable check is absent while the system labels it hard-enforced.

---

### M2 — Memory Fabric

**Goal:** Make memory product-owned, evidence-graded, and provider-neutral.

**Responsibilities:**

- store user preferences, project facts, prior run summaries, rejected assumptions, known pitfalls;
- distinguish memory categories: `preference`, `project_fact`, `runtime_fact`, `prior_result`, `hypothesis`, `rejected`;
- grade freshness and verification need;
- retrieve minimal relevant memory for a task;
- record whether memory was verified in the current run.

**Interface:**

```ts
interface MemoryEntry {
  id: string;
  category: string;
  claim: string;
  scope: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
  driftRisk: 'low' | 'medium' | 'high';
  lastVerifiedAt?: string;
}
```

**Done gate:** context assembly can include memory only with category, source, and verification status.

**Forgery that must fail:** stale memory is injected as confirmed-current without verification label.

---

### M3 — Product Hook Runtime

**Goal:** Build lifecycle hooks directly in Warden instead of depending on Codex/Claude hooks.

**Events:**

```text
BeforeGoal
AfterGoal
BeforeContextBuild
AfterContextBuild
BeforeModelCall
AfterModelCall
BeforeToolIntent
BeforeToolExecution
AfterToolExecution
BeforeFileWrite
AfterFileWrite
BeforeVerifier
AfterVerifier
BeforePromotionApply
AfterPromotionApply
BeforeCompact
AfterCompact
BeforeStop
AfterStop
```

**Handlers:** command, internal TypeScript function, MCP/tool call, verifier check, optional model-evaluator.

**Done gate:** a `BeforeToolExecution` hook can block a risky tool intent before any external command runs.

**Forgery that must fail:** direct shell execution bypasses the hook runtime but still appears as supported.

---

### M4 — Context Composer

**Goal:** Build deterministic, hash-addressed context bundles for every executor.

**Inputs:** goal, task, repo snapshot, BaseRuleSet, selected memory, policy, tool catalog, prior artifacts, acceptance contract.

**Output:**

```ts
interface ContextBundle {
  id: string;
  sha256: string;
  role: 'manager' | 'worker' | 'reviewer' | 'verifier' | 'critic' | 'generic';
  providerProfile: string;
  sections: ContextSection[];
  includedMemoryIds: string[];
  includedRuleIds: string[];
  toolPolicyId: string;
  acceptanceContractId: string;
}
```

**Done gate:** same inputs produce same context hash; adding/removing a rule or memory entry changes the hash and is recorded.

**Forgery that must fail:** a model response claims it saw a rule/memory ID not present in the bundle.

---

### M5 — Policy + Tool Runtime

**Goal:** Own tool execution. Models propose; the harness disposes.

**Responsibilities:**

- parse model tool intents;
- classify risk;
- enforce allow/ask/deny;
- execute approved shell/fs/browser/MCP/API tools;
- capture stdout/stderr/diff/screenshot/file hashes;
- append events.

**Done gate:** mutating tools require policy evaluation and produce durable evidence.

**Forgery that must fail:** a model directly writes a file outside the tool runtime and the run still passes.

---

### M6 — Direct LLM Executor Runtime

**Goal:** Invoke models directly as lower-level executors.

**Adapters:**

- `openai-direct`
- `anthropic-direct`
- `gemini-direct`
- `local-direct`
- `shell-no-model` degraded path

**Interface:**

```ts
interface ExecutorRequest {
  executorId: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'local' | 'shell';
  model: string;
  contextBundleSha256: string;
  outputSchema: object;
  allowedToolIntents: string[];
  budget: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number };
}

interface ExecutorResult {
  executorId: string;
  provider: string;
  model: string;
  contextBundleSha256: string;
  rawTranscriptRef: string;
  parsedOutput: unknown;
  proposedToolIntents: ToolIntent[];
  exitStatus: 'completed' | 'failed' | 'timeout' | 'cancelled';
}
```

**Done gate:** the same fixture task can be run through at least two direct providers or one provider plus a deterministic mock, and both are judged by the same verifier.

**Forgery that must fail:** provider-native “done” text without schema-valid output and evidence.

---

### M7 — Verifier Harness

**Goal:** Make completion claims independent from model/provider claims.

**Verifier types:**

- schema verifier;
- artifact verifier;
- git diff verifier;
- test/build verifier;
- browser/screenshot verifier;
- PPT/report artifact verifier;
- policy verifier;
- memory/promotion effect verifier;
- external custody verifier when needed.

**Done gate:** a run cannot become `completed` unless required verifier results are present and pass.

**Forgery that must fail:** handcrafted verifier JSON with no recomputable evidence.

---

### M8 — Promotion Closed Loop

**Goal:** Approved learning changes later behavior through Dominic-owned rule/memory/skill/policy/verifier artifacts.

**Flow:**

```text
review finding
  -> promotion candidate
  -> approval
  -> apply to BaseRuleSet / Memory / Skill / Policy / Verifier
  -> later ContextBundle includes promotion
  -> behavior/evidence changes
  -> PromotionEffect verifier proves causal path
```

**Done gate:** a before/after run proves a named promotion changed context and at least one verifier-observed decision/output field.

**Forgery that must fail:** hardcoded `before/after` strings or handwritten `promotion-effect.json` pass without replay.

---

### M9 — Operator UI / Projection

**Goal:** Show the real state of the harness, not just task prose.

**Surfaces:**

- task/run board;
- context bundle inspector;
- memory inclusion/exclusion panel;
- policy decision timeline;
- tool intent/execution timeline;
- verifier gate panel;
- promotion queue/effect panel;
- provider comparison view;
- unsupported/unproven labels.

**Done gate:** operator can answer “what rule/memory/tool/verifier caused this result?” from UI evidence.

**Forgery that must fail:** UI labels a run complete while gate/projection says unsupported or unproven.

---

### M10 — Native Executor Substrate / Compatibility Surface

**Goal:** Support Codex CLI, Claude Code, OMX, agy as optional executors without letting them own truth.

**Rules:**

1. Must be labeled `native-harness-assisted`.
2. Must record unowned native surfaces.
3. Must capture raw command/session evidence.
4. Must still pass Dominic-owned verifier gates.
5. Must not satisfy direct-model-runtime completion gates.

**Done gate:** a Codex/Claude native run can be used for work, but the product can distinguish Dominic-owned evidence from native-harness side effects.

**Forgery that must fail:** native CLI completion text upgrades the run without Dominic verifier evidence.

---

### M11 — Multi-Executor Orchestration

**Goal:** Divide and conquer across models without vendor harness control.

**Patterns:**

- cheap model explorer;
- frontier model architect;
- standard model executor;
- adversarial critic;
- deterministic verifier;
- native harness optional worker only when explicitly chosen.

**Done gate:** two or more direct executors can work on bounded slices, with synthesis based on artifacts and verifier output, not model authority.

**Forgery that must fail:** two fabricated worker summaries synthesize without artifacts/diffs/tests.

---

## 7. Composition Graph

```text
             ┌──────────────────┐
             │  M0 Contract     │
             └────────┬─────────┘
                      │
          ┌───────────▼───────────┐
          │ Harness Spine          │
          │ M1 Rules               │
          │ M2 Memory              │
          │ M3 Hooks               │
          │ M4 Context             │
          │ M5 Policy/Tools        │
          └───────────┬───────────┘
                      │
          ┌───────────▼───────────┐
          │ M6 Direct Executors    │
          │ OpenAI/Anthropic/etc   │
          └───────────┬───────────┘
                      │
          ┌───────────▼───────────┐
          │ M7 Verifier Harness    │
          └───────────┬───────────┘
                      │
          ┌───────────▼───────────┐
          │ M8 Promotion Loop      │
          └───────────┬───────────┘
                      │
          ┌───────────▼───────────┐
          │ M9 Operator UI         │
          └───────────┬───────────┘
                      │
     ┌────────────────▼────────────────┐
     │ M10 Native Executor Evidence Substrate │
     │ M11 Multi-Executor Orchestration │
     └─────────────────────────────────┘
```

The corrected key design choice: **native executor over the evidence contract is the Phase-A substrate, while unowned native surfaces remain explicitly labeled.** Codex/Claude Code output cannot define M1–M8 truth by itself; only Dominic-owned ledger/verifier evidence can.

---

## 8. Roadmap Reframing

### Phase A — Provider-Neutral Harness Spine

- M0 Contract Baseline
- M1 BaseRule Engine
- M2 Memory Fabric
- M3 Product Hook Runtime
- M4 Context Composer
- M5 Policy + Tool Runtime

**Exit condition:** deterministic mock executor can complete a trivial task only through product-owned hooks, policy, context, tool execution, ledger, and verifier.

### Phase B — Direct Model Execution

- M6 Direct LLM Executor Runtime
- provider adapters for OpenAI and Anthropic first;
- optional Gemini/local after interface stabilizes.

**Exit condition:** same acceptance contract can judge two different direct model providers.

### Phase C — Verification and Learning

- M7 Verifier Harness
- M8 Promotion Closed Loop

**Exit condition:** a verified promotion changes a later run through product-owned context, not vendor memory or instructions.

### Phase D — Operator Product

- M9 Operator UI / Projection

**Exit condition:** user can inspect every rule/memory/tool/verifier decision and see unsupported/unproven labels.

### Phase E — Compatibility and Scale

- M10 Native Executor Substrate / Compatibility Surface
- M11 Multi-Executor Orchestration

**Exit condition:** Codex/Claude Code-style native executors can be used as the Phase-A working substrate only when wrapped by Dominic-owned ledger/verifier evidence; direct-provider mode remains an optional future adapter behind the same contract, not the current proof path.

---

## 9. What Happens to Existing PRD Concepts

| Existing concept | New treatment |
|---|---|
| OMX-first executor strategy | Demoted. OMX becomes optional native compatibility adapter. |
| Codex adapter | Split into `openai-direct` first-class adapter and `codex-cli` compatibility adapter. |
| Claude Code | Add `anthropic-direct` first-class adapter and `claude-code` compatibility adapter. |
| AGENTS.md | Useful export/import artifact, not canonical authority. BaseRuleSet is canonical. |
| CLAUDE.md / soul.md | Useful provider-specific compatibility/persona artifact, not canonical authority. |
| Memory | Product-owned memory fabric; vendor memories are optional imported evidence, not authority. |
| Hooks | Product hook runtime is canonical; vendor hooks are compatibility side effects. |
| Manager/Worker/Reviewer | Roles remain, but are executor profiles under Dominic context/policy/verifier contracts. |
| Promotion | Must update Dominic artifacts and prove later effect through ContextBundle/Verifier. |
| Completion gates | Must reject vendor-native success claims unless evidence is recomputable in Dominic ledger. |

---

## 10. Self High-Intensity Critique

### C1 — This redesign may be too ambitious and delay working product value.

The plan demotes Codex/Claude Code native harnesses, but those tools already solve many practical problems: file editing, session management, approvals, compaction, subagents, and tool UX. Rebuilding all of that may stall the product for months.

**Countermeasure:** Phase A must start with a tiny deterministic mock/shell loop, not a full clone of Codex/Claude Code. The first win is “harness-owned truth over one trivial task,” not “full agent replacement.”

### C2 — Direct API execution loses native coding-agent ergonomics.

Codex CLI and Claude Code are optimized for repo work. Direct model APIs require building tool calling, patch application, transcript UX, retries, and context management manually.

**Countermeasure:** Use native harnesses as compatibility adapters for productivity, but never for canonical gates. Dogfood can use native assistance; product proof must run direct or clearly label native assistance.

### C3 — “LLM-as-executor” still needs a tool loop, which is itself an warden runtime.

The redesign says native agent harnesses are minimized, but the product must still build its own warden loop. That is not simpler; it just moves complexity inside the repo.

**Countermeasure:** That is intentional. The product thesis is harness ownership. If the repo is unwilling to own the loop, it cannot claim cross-model parity.

### C4 — Provider-neutral parity may be weaker than advertised.

OpenAI, Anthropic, Gemini, and local models differ in tool call format, context length, refusal style, cost, latency, and reasoning behavior. A single contract can compare outputs, but it cannot force equal capability.

**Countermeasure:** Claim only acceptance parity, not semantic identity. The system guarantees “same gate,” not “same thought process” or byte-identical output.

### C5 — BaseRuleSet could become another bloated AGENTS.md.

If BaseRuleSet is just a bigger instruction blob, it repeats the same failure under a new name.

**Countermeasure:** Every rule needs a type: `prompt_only`, `policy_enforced`, `verifier_enforced`, or `deprecated`. Hard claims require policy/verifier linkage. Prompt-only rules must be labeled soft.

### C6 — Memory grading can become theater.

Confidence/freshness labels are easy to stamp and hard to prove.

**Countermeasure:** Memory entries with medium/high drift risk cannot be injected as current fact unless verified or explicitly labeled stale/unverified in the ContextBundle.

### C7 — Product hooks can be bypassed unless all tools are mediated.

If any executor can write files or run commands outside M5, the hook runtime is decorative.

**Countermeasure:** Direct executors must not receive raw shell/file authority. Native harness adapters must be labeled unowned unless sandboxed to a controlled worktree and verified afterward.

### C8 — Native compatibility may contaminate the canonical path.

Once Codex/Claude Code adapters exist, practical pressure will push the team to rely on them again.

**Countermeasure:** M10 is late and cannot satisfy M6/M7/M8 canonical gates. Compatibility runs carry `native-harness-assisted` labels forever.

### C9 — The verifier harness can still become self-certifying.

Handwritten JSON, string-grep tests, or implementer-controlled signatures can recreate the old failure mode.

**Countermeasure:** Each verifier must either recompute evidence from artifacts or explicitly require reviewer-held external custody. Every module ships with a forgery fixture that must fail.

### C10 — Multi-executor orchestration risks creating coordination theater.

Spawning multiple models can generate impressive-looking summaries without improving evidence.

**Countermeasure:** M11 synthesis must cite artifact IDs, diffs, tests, screenshots, or verifier results. Summary-only workers cannot contribute to completion state.

### C11 — This plan changes the PRD identity enough to require explicit migration.

The existing PRD says OMX/Codex first in several places. This redesign demotes them. If both documents coexist without migration notes, future agents will follow whichever is convenient.

**Countermeasure:** Create a provider-neutral contract doc and update PRD sections 8, 9, 19, 24, and 31 or add a formal ADR stating this document supersedes executor-strategy language.

### C12 — The hardest problem is not model invocation; it is UX of trust.

A user must understand why a run is complete, degraded, native-assisted, unsupported, or blocked. Without UI clarity, the harness will be correct but unusable.

**Countermeasure:** M9 is not optional polish. Projection/UI must expose rule/memory/policy/tool/verifier causality before compatibility adapters scale.

---

## 11. Final Redefined Completion Standard

Warden reaches the redesigned ultimate goal only when all of the following are true from a clean checkout:

1. A task can run through product-owned base rules, memory selection, hooks, policy, context composition, tool execution, **hash-chained** event ledger, verifier, and promotion loop.
2. **(CORRECTED)** A task completes through the **native-executor canonical adapter over the evidence contract** — the product owns ledger/verifier/promotion/policy on top of the rented loop. (Two *direct* providers under one contract is an optional later milestone, M6, not the bar.)
3. Codex CLI / Claude Code / OMX runs are the canonical substrate; **unowned surfaces** (native memory/hooks/subagents/compaction) are enumerated and labeled, and never satisfy a verifier claim by themselves.
4. The shipped self-certifying machinery (`product-gate.ts`, hardcoded `decision:'APPROVE'`, `score=hasIssue?6:9`, symmetric-HMAC custody) is demolished/quarantined and cannot mark a run complete.
5. A promotion changes a later run through Dominic-owned artifacts and the effect is recomputed via a **three-run** (baseline / control-without-promotion / with-promotion) differential.
6. Every module’s paired forgery test fails.
7. The operator UI can show the causal chain from goal → rules/memory/context → model/tool actions → evidence → verifier → state transition.
8. **Solo-mode honest ceiling is hard-capped ~75 by construction** (independent custody is structurally impossible for a single principal); ≥90 requires a real second principal that does not exist today.

Until then, honest labels are:

- **Prototype scaffold** when core harness modules are missing (current state: ~7% of this goal).
- **Harness-over-native alpha** when M‑1/M0/L/N/M7 let a task complete over the native executor through the product-owned ledger+verifier.
- **Learning-harness beta** when M8 proves a promotion changes a later run via the three-run differential.
- **Native-harness-assisted** is a per-run label (unowned surfaces enumerated), not a completion status.
- **Complete (solo)** caps at ~75; **Complete (independent)** requires a second principal.

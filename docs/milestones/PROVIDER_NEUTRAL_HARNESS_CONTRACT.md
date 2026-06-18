# Provider-Neutral Harness Contract

**Date:** 2026-06-04
**Status:** Draft contract for the redesigned ultimate goal. **PROVISIONAL, not frozen** — `ExecutorResult.parsedOutput`, `ToolIntent.args`, and all reasoning/refusal/streaming fields are `unstable: pending evidence`; a freeze is earned after one real executor integration, not declared before it.
**Parent design:** `docs/milestones/ULTIMATE_GOAL_DIVIDE_AND_CONQUER_PLAN.md`
**Binding correction:** `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md` (canonical substrate is the native executor over this contract; direct-API is optional; the existing `product-gate.ts` must be demolished before M7; reconcile 3 memory schemas before gate #4 can run).

---

## 1. Contract Purpose

This contract defines the minimum provider-neutral runtime semantics Warden must own before it can claim cross-model agent orchestration.

The product may call OpenAI, Anthropic, Gemini, local models, Codex CLI, Claude Code, OMX, agy, or shell. None of those providers/harnesses owns completion. Warden owns completion through this contract.

---

## 2. Hard Boundary

### 2.1 Canonical owner

Warden owns:

- base rules;
- memory selection and verification labels;
- lifecycle hooks;
- context bundle construction;
- tool intent parsing;
- policy/permission decisions;
- tool execution;
- event ledger;
- artifact store;
- verifier results;
- promotion application and effect proof;
- state transitions.

### 2.2 Non-canonical surfaces

These may be imported, generated, or used as compatibility aids, but are not canonical:

- `AGENTS.md`;
- `CLAUDE.md`;
- `CLAUDE.local.md`;
- `.claude/rules`;
- Codex memories;
- Claude auto memory;
- Codex hooks;
- Claude hooks;
- Codex subagents;
- Claude subagents;
- OMX/team/ultragoal runtime state;
- vendor CLI completion messages.

A run using these surfaces must label which surfaces are unowned.

---

## 3. Status Vocabulary

| Status | Meaning |
|---|---|
| `supported` | Product-owned contract and verifier evidence fully cover the claim. |
| `degraded` | Product-owned path works with reduced capability, cost, fidelity, or automation. |
| `unproven` | The system may work, but evidence is insufficient or not recomputable. |
| `unsupported` | The system does not support the behavior. |
| `native-harness-assisted` | A vendor-native warden harness materially participated; evidence must be separated from product-owned proof. |

Rules:

1. `native-harness-assisted` is an additional label, not a completion status.
2. Native harness participation cannot upgrade `unproven` to `supported` by itself.
3. Completion claims require `supported` verifier evidence over product-owned artifacts.

---

## 4. Core Schemas

These are conceptual TypeScript contracts. Implementation may serialize them as JSON with matching schemas.

### 4.1 BaseRuleSet

```ts
interface BaseRuleSet {
  id: string;
  version: string;
  invariants: Rule[];
  projectRules: Rule[];
  providerHints: Record<string, Rule[]>;
  enforcement: EnforcementBinding[];
}

interface Rule {
  id: string;
  text: string;
  scope: 'global' | 'project' | 'path' | 'task' | 'provider';
  hardness: 'prompt_only' | 'policy_enforced' | 'verifier_enforced' | 'deprecated';
}

interface EnforcementBinding {
  ruleId: string;
  policyId?: string;
  hookId?: string;
  verifierId?: string;
}
```

### 4.2 MemoryEntry

```ts
interface MemoryEntry {
  id: string;
  category: 'preference' | 'project_fact' | 'runtime_fact' | 'prior_result' | 'hypothesis' | 'rejected';
  claim: string;
  scope: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
  driftRisk: 'low' | 'medium' | 'high';
  lastVerifiedAt?: string;
}
```

### 4.3 ContextBundle

```ts
interface ContextBundle {
  id: string;
  sha256: string;
  role: 'manager' | 'worker' | 'reviewer' | 'verifier' | 'critic' | 'generic';
  providerProfile: string;
  sections: ContextSection[];
  includedRuleIds: string[];
  includedMemoryIds: string[];
  unverifiedMemoryIds: string[];
  toolPolicyId: string;
  acceptanceContractId: string;
}

interface ContextSection {
  id: string;
  kind: 'goal' | 'rule' | 'memory' | 'repo' | 'artifact' | 'policy' | 'acceptance' | 'provider_hint';
  text: string;
  sourceRef: string;
  sha256: string;
}
```

### 4.4 ExecutorRequest / ExecutorResult

```ts
interface ExecutorRequest {
  executorId: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'local' | 'shell' | 'codex_cli' | 'claude_code' | 'omx' | 'agy';
  mode: 'direct_model' | 'native_harness' | 'deterministic';
  model?: string;
  contextBundleSha256: string;
  outputSchema: object;
  allowedToolIntents: string[];
  budget: { maxTokens?: number; maxToolCalls?: number; timeoutMs?: number };
}

interface ExecutorResult {
  executorId: string;
  provider: string;
  mode: 'direct_model' | 'native_harness' | 'deterministic';
  model?: string;
  contextBundleSha256: string;
  rawTranscriptRef: string;
  parsedOutput: unknown; // unstable: pending real-executor evidence
  proposedToolIntents: ToolIntent[];
  exitStatus: 'completed' | 'failed' | 'timeout' | 'cancelled';
  nativeHarnessSurfaces?: string[];
}
```

### 4.5 ToolIntent / ToolExecution

```ts
interface ToolIntent {
  id: string;
  executorId: string;
  tool: string;
  args: unknown; // unstable: pending M6 normalization (OpenAI tool_calls / Anthropic tool_use / Gemini functionCall)
  reason: string;
  riskClass: 'safe' | 'read_only' | 'mutating' | 'destructive' | 'network' | 'credentialed';
}

interface ToolExecution {
  id: string;
  toolIntentId: string;
  policyDecisionId: string;
  status: 'allowed' | 'blocked' | 'approval_required' | 'executed' | 'failed';
  evidenceRefs: string[];
}
```

### 4.6 VerifierResult

```ts
interface VerifierResult {
  id: string;
  verifierId: string;
  claim: string;
  status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  recomputed: boolean;
  evidenceRefs: string[];
  nativeHarnessAssisted: boolean;
  gaps: string[];
}
```

### 4.7 PromotionEffect

```ts
interface PromotionEffect {
  id: string;
  promotionId: string;
  beforeRunId: string;
  afterRunId: string;
  beforeContextSha256: string;
  afterContextSha256: string;
  // beforeRun = baseline, controlRun = baseline replayed WITHOUT the promotion,
  // afterRun = WITH the promotion. Causal only if the field is STABLE across
  // before/control and CHANGES with the promotion.
  controlRunId: string;
  changedDecisionFields: string[]; // must be drawn from a closed enum of verifier-decision fields, never free text/token stats
  determinismMode: 'temperature_0' | 'k_replay_majority';
  verifierResultId: string;
}
```

### 4.8 AcceptanceContract (was dangling — `acceptanceContractId` referenced in §4.3 but never defined)

```ts
interface AcceptanceContract {
  id: string;
  criteria: AcceptanceCriterion[];
}

interface AcceptanceCriterion {
  id: string;
  claim: string;
  // A criterion MUST bind to the closed M7 verifier-type set by PARAMETERIZATION,
  // never bespoke checker code (caps verifier code at O(verifier-types), not O(skills)).
  verifierType: 'schema' | 'artifact' | 'git_diff' | 'test' | 'browser' | 'report' | 'policy' | 'promotion_effect' | 'external_custody';
  params: unknown;       // declarative parameters for the chosen verifier type
  hardness: 'verifier_enforced' | 'soft_by_decision';
  forgeryFixtureRef?: string; // a HARD criterion must ship a fixture the soft layer alone cannot catch
}
```

---

## 5. Lifecycle Events

Every first-class run must be expressible through these events:

```text
goal.received
rules.loaded
memory.candidates_found
memory.selected
context.build.requested
context.built
executor.requested
executor.started
executor.output.received
tool.intent.proposed
policy.evaluated
approval.requested
approval.resolved
tool.execution.started
tool.execution.completed
artifact.recorded
verifier.requested
verifier.completed
promotion.candidate_created
promotion.applied
promotion.effect_verified
state.transitioned
run.completed
run.blocked
```

Native harness adapter events must additionally include:

```text
native_harness.started
native_harness.surface_detected
native_harness.completed
native_harness.evidence_separated
```

---

## 6. Required Gates

1. **No unverified completion:** `run.completed` requires at least one passing verifier result for each required acceptance criterion.
2. **No unmanaged mutation:** mutating tool execution requires policy event and evidence ref.
3. **No silent native harness:** any Codex/Claude/OMX/agy participation requires `native-harness-assisted` label.
4. **No stale memory as fact:** high/medium drift memory must be verified or labeled unverified in the context bundle.
5. **No prompt-only hard rule:** a rule cannot be called enforced unless policy or verifier binding exists.
6. **No promotion theater:** promotion effect requires before/after context hash and verifier-observed behavioral delta.
7. **No handwritten proof:** verifier result must be recomputable or explicitly blocked.

---

## 7. Minimal Acceptance Slice

The first acceptable slice is not multi-agent, and it is **not a mock executor** (a mock emits ToolIntents in the shape the harness already expects, so it greens the spine without proving real work — the same no-op-proposer anti-pattern the project is escaping). It is **real work over the native canonical adapter**:

1. receive a small task;
2. load BaseRuleSet;
3. retrieve memory candidates (with provenance + verification status);
4. build ContextBundle (hash it);
5. **run it through the existing native executor (`codex-exec-runner`), wrapped by this contract** — real edits happen;
6. ingest the executor's tool effects (`git diff --stat` + per-file hashes) as evidence;
7. classify policy from those effects. **Honest caveat for native mode:** `codex exec` runs its OWN tool loop inside the child process and exposes only a final message + session id — the harness does NOT see per-tool intents, so per-`tool+args` mediation is **impossible** here; native runs enforce policy via the pre-launch sandbox flag (`--sandbox`) + **post-hoc git-diff classification**, and carry a permanent `mediation: external/unowned` status. Per-`tool+args` mediation holds only for the future direct-model mode where the harness owns the loop;
8. append every step to the event ledger with `prev_event_sha256` hash-chain and bind downstream evidence to the current `ledger_head_sha256`;
9. run the **new M7 verifier** (not the demolished `product-gate.ts`) over recomputable evidence;
10. transition state **only** through the verifier result;
11. label the run `native-harness-assisted` and enumerate unowned surfaces.

If this works, the product owns the harness **layer over a rented loop** — daily-usable. A deterministic mock is allowed ONLY for testing ledger/policy determinism and is `unproven` for execution by construction. Direct-provider adapters and multi-provider parity are later, optional refinements behind this same contract.

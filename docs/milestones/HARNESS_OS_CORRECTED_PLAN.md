# Harness-OS Corrected Plan (post-critique, binding)

**Date:** 2026-06-04
**Status:** Binding correction of the two redesign docs. Not a completion claim.
**Amends:** `ULTIMATE_GOAL_DIVIDE_AND_CONQUER_PLAN.md` and `PROVIDER_NEUTRAL_HARNESS_CONTRACT.md`.
**Basis:** 5-lens code-grounded adversarial critique → binding synthesis. Verdict: `structure_survives: false` as-sequenced; **salvageable by reordering + de-scoping**. Every load-bearing claim was verified against real code.

---

## 0. Verdict banner

- **Direction is right, sequencing is dishonest.** Provider-neutral harness-OS / LLM-as-executor / hardness-grading / verifier-bound capability is the correct vision. The *build order* reconstitutes the project's own anti-pattern (a sanctioned no-op proposer greens the spine).
- **Honest re-baseline vs the NEW goal: ~7%.** Spine types (M1/M4/M5/M6/M7) ~0%; hooks (M3) ~0%; direct-provider path (M6) ~0% (`package.json` `dependencies={}`); memory (M2) partial *storage only*, with a schema the verifier gate cannot evaluate; the 1206-LOC `runtime/*` surface counts toward **M10 (downstream-optional), NOT spine progress.** No completion-% may credit native-CLI LOC against M1–M8.
- **One fatal strategic error + its fix** (see §2): do not rebuild the commoditized agent loop; own the evidence layer over rented loops.

---

## 1. Corrected Ultimate Goal (paste-ready; amends PLAN §2/§4.2, CONTRACT §1)

> **maestro is a provider-neutral evidence-and-control LAYER that owns the harness — base rules, memory, hooks, context, policy, event ledger, verifier, promotion, state transitions — and runs them ON TOP of interchangeable lower-level executors. The CANONICAL execution substrate is a thin native-executor adapter (Codex CLI / Claude Code as rented commodity agent loops) wrapped by the product's evidence contract. Direct provider-API execution (OpenAI/Anthropic/Gemini) is an OPTIONAL future adapter behind the same contract, NOT the proof path. Completion is declared only by the product's recomputable verifier over the product-owned ledger — never by a model, a vendor CLI, or review prose.**

What changed vs the user's draft, and why (binding):
1. **Direct-API path demoted** from "primary/canonical" → "optional future adapter." Delete "direct-API is the proof path" from PLAN §4.2, §8 Phase-B exit, §11 standard #2. *Rationale: the only working executor today is native (`codex exec`); rebuilding the hard-80% agent loop from `deps={}` solely to relabel it canonical strands the product — every real run would be permanently "native-harness-assisted / spine-bypassed," and C7 ("executors get no raw shell authority") makes the canonical path strictly **less** capable than the bypass the user actually uses.*
2. **"Own the layer," not "own the loop."** The genuinely-missing, cheap, real value is ledger + verifier + promotion + projection + policy. Rent the loop; own the evidence.
3. **Native-executor-over-evidence-contract is the canon, not a demotion.** M10 "compatibility" is renamed: native adapters are the *first-class substrate*; "native-harness-assisted" labels the **unowned surfaces** (memory/hooks/subagents/compaction), not a second-class status.

---

## 2. The one fatal error and the resolution (decisive)

**Inverted canon (verified):** working executor = `src/runtime/codex-exec-runner.ts` shelling `codex exec --json --sandbox` — declared M10/late/optional/"liability." "Primary product path" M6 = 0% (`deps={}`, no SDK, no HTTP, no tool loop). The plan converts a strategic refutation into a statement of intent ("Resolve: that is intentional") and then *freezes a contract over it.*

**Resolution (Critic-3 wins over Critic-1):** keep the agent loop rented and improving on the vendor's dime; own only the layer that does not exist elsewhere. Ship the layer over the EXISTING `codex-exec-runner`, label runs native-harness-assisted, and make **daily-usable-over-native** the Phase-A exit — not "a mock executor completes a trivial task through product-owned hooks," which produces a toy nobody uses. The provider-normalization layer (Critic-1's fatal gap: OpenAI `tool_calls` vs Anthropic `tool_use` vs Gemini `functionCall`, specified/implemented nowhere) becomes **future-optional** instead of a blocking prerequisite.

---

## 3. Corrected module order (replaces PLAN §5)

```
M‑1  Integrity Baseline        (NEW, BLOCKS M0)
M0   Provisional Contract       (was "freeze" → provisional + executable JSON schemas + fixture validator)
L    Ledger Hash‑Chain          (cross‑cutting precondition for every gate)
M5′  Policy/Tool mediation       (arg‑level risk, not caller label)
N    Native‑Executor Canonical Adapter  (wrap codex‑exec‑runner in the evidence contract)
M7   Verifier Harness            (+ DEMOLISH the existing self‑certifying gate)
M8   Promotion Loop              (three‑run differential)
M2   Memory Fabric               (reconcile to ONE schema first)
M9   Operator UI / Projection
M12  Skills = wrap‑don't‑rebuild  (STRICTLY after M7+M8)
M6   Direct‑API adapter          (OPTIONAL, future; needs the normalization sub‑spec)
M11  Multi‑executor              (artifact/verifier‑based synthesis only)
```

### M‑1 — Integrity Baseline *(new; blocks everything)*
CI gate: `git status --porcelain` empty AND a clean clone reproduces the product **including** `codex-exec-runner.ts`. Commit-or-delete the ~2878 uncommitted insertions first. Write `docs/adr/0001-provider-neutral-supersedes-omx-first.md` superseding PRD §19.1 "OMX First"; doc-lint fails on any unmarked OMX-first canonical text. *You cannot honestly freeze a contract whose clean-checkout gate rests on a checkout that lacks the product.*

### M0 — Provisional Contract *(was "freeze")*
Land executable JSON schemas + a malformed-fixture rejector NOW (cheap, real). Mark `ExecutorResult.parsedOutput`, `ToolIntent.args`, and all reasoning/refusal/streaming fields **`unstable: pending evidence`**. A freeze is *earned by evidence*, not declared before the hardest layer runs once. **Define the dangling `AcceptanceContract` type** (referenced CONTRACT §4.3 line 134, never defined).

### L — Ledger Hash-Chain *(P0, cheapest highest-value)*
Add `prev_event_sha256 = sha256(stableJson(previous full envelope))` to every `RuntimeEventEnvelope` (genesis → run-seed zero hash); `validateRuntimeLedger` recomputes head-to-tail and rejects ANY break. Forgery fixture: edit one middle payload, recompute only its `payload_sha256`, assert validation now FAILS (today it PASSES — `ledger.ts:115-118` checks only `sequence==prev+1` + per-event hash; `parent_event_id` is a UUID, not a hash). *Every downstream gate reads this ledger as ground truth; a forgeable ground truth defeats the entire anti-self-deception thesis.*

### M7 — Verifier Harness **+ demolition clause** *(P0)*
Before M7 work: **deprecate-and-quarantine** the shipped self-certifying machinery and forbid any completion path from consulting it — `src/product-gate.ts` (989 LOC, string-matches test names, greps markdown), `core.ts:784` (`decision:'APPROVE'`), `core.ts:818` (hardcoded `changedField`), `core.ts:1822` (`score = hasIssue ? 6 : 9`), the symmetric-HMAC custody gates. M7 done-gate must include: (a) forgery class "a verifier whose decision is **constant w.r.t. input** MUST fail"; (b) a regression test proving the OLD product-gate can no longer mark a run complete; (c) a fixture feeding a hand-written `recommendation: APPROVE` + self-signed HMAC that the NEW verifier rejects. *Else: a clean-looking new verifier sits beside the old forgeable one and completion routes through whichever passes — strictly worse than today.*

### M8 — Promotion: three-run differential *(P2, after M7)*
Upgrade two-run → **three-run**: baseline, baseline-replayed-**without**-promotion (control), with-promotion. Causal claim holds only if the field is STABLE across baseline/control and CHANGES with promotion. Changed field must come from a **closed enum of verifier-decision fields** (never free-text/token stats). Stochastic executors require `temperature=0` or k-replay majority; record the determinism mode. *The two-run version is a one-line noise forgery.*

---

## 4. Soft/Hard harness — corrected (Addition A → acceptance criterion, not a module)

Reframe the soft/hard split as a **per-module acceptance criterion**, not a cross-cutting layer:
- Every load-bearing artifact in M1/M2/M5/M7 must either **demonstrate a HARD binding via a FAILING forgery fixture the soft layer alone cannot catch**, or be explicitly labeled **`soft-by-decision`** with the reason ledgered.
- Add the third status `soft-by-decision` so the HARD layer cannot silently swallow everything (it will, since every author claims correctness-relevance).
- **Operational definition of "load-bearing":** *a forgery fixture exists that the SOFT layer alone cannot catch.*
- State plainly: the **SOFT layer provides ZERO correctness/parity guarantee by construction** (executor MAY deviate) — its value is ergonomic, not contractual. **Move `providerHints` OUT of "provider-portable soft"** → relabel `provider-specific-soft`.

---

## 5. Skills — corrected (Addition B → "wrap, don't rebuild", strictly after M7+M8)

Sound in direction, FLAWED as scoped. Binding scope:
1. **Wrap, don't rebuild.** A product-owned Skill is a thin **verifier + contract + hardness wrapper** around an existing native skill. The ~80 live gstack/OMC/Claude skills **keep doing the work**, labeled native-harness-assisted. Zero reuse exists in current code (`core.ts` `findSkillFilesUnder` scans `.codex/skills/**/SKILL.md`; `composition.ts` `modules.skills` is a `string[]` of native names) — a from-scratch rewrite delivers no user-visible capability for months.
2. **FORBID bespoke per-skill verifiers (decisive).** Every HARD skill's binding MUST be a declarative **parameterization of the M7 closed verifier set** (`{type:'artifact',mustExist:[...]}`, `{type:'test',cmd,expect}`), never new checker code. A genuinely new verifier type extends the shared M7 library once (reviewed). This caps verifier code at **O(verifier-types), not O(skills)** — preventing `product-gate.ts`-at-N-scale (the exact C9 failure).
3. **SOFT skill** = guidance injected into ContextBundle, carries NO verifier, can NEVER gate completion. **HARD skill** = carries an `AcceptanceContract` + a verifier binding a forgery fixture defeats.
4. **Rule-vs-Skill boundary (docs never draw it):** a **Rule = CONSTRAINT** (always-on, no trigger, no output schema, "must/never"); a **Skill = CAPABILITY** (trigger-activated, has `allowedToolIntents` + `outputSchema` + acceptance). `PromotionRecord.target_type` (`util.ts:90`) lists `skill`/`agent_instruction`/`workflow` as siblings with no tie-breaker → the promotion engine must **reject any candidate that doesn't classify into exactly one** `target_type`; CONTRACT §4 adds a precedence clause (rules dominate skills on conflict; resolution recorded in ContextBundle).
5. Promote to HARD only when a concrete forgery fixture justifies the verifier cost; else `soft-by-decision` (logged).

---

## 6. Memory — reconcile to ONE schema before M2/M12 (P1)

Three incompatible vocabularies today: CONTRACT §4.2 `MemoryEntry` (`category/confidence/driftRisk/lastVerifiedAt`) vs `fabric.ts` `MemoryFact` (`layer/outcome/source_event_ids` — none of those) vs `records.ts` `MemoryWriteRecord` (`scope/authority/merge_policy`). **Gate #4 ("no stale memory as fact") cannot run — `driftRisk` exists in no stored record.** Adopt `fabric.ts`'s provenance model (`source_event_ids` + `lastVerifiedAt`) as canonical, key gate #4 on **provenance + verification recency**, drop the ungrounded `driftRisk`. Stop crediting memory grading as M2 progress — that dimension is 0%.

---

## 7. Policy/tool mediation — operationalize C7 (P1)

`permission-broker.ts:30` auto-allows `general_tool`/`sandbox_local` on a **caller-supplied label the executor chooses** → an executor that tags its destructive shell as `general_tool` is auto-allowed. Fix: classify risk from the **actual tool+args** (parse the command); replace auto-allow with a closed mediated-tool catalog; uncatalogued/arg-invalid → `requires_approval`. Forgery fixture: a destructive shell tagged `general_tool` must NOT auto-allow. **Honest scope:** for native-CLI executors (`codex exec --sandbox` owns its own file authority) HARD tool-mediation is **impossible** → permanent `mediation: external/unowned` status that can never reach `supported` for tool-safety claims.

---

## 8. Binding revisions (ranked)

| # | Pri | Target | Change |
|---|---|---|---|
| 1 | **P0** | `ledger.ts:115-118` | hash-chain the ledger (`prev_event_sha256`); forgery fixture must fail a tampered middle event |
| 2 | **P0** | PLAN §4.2/§5/§8/§11 | flip canon: native-executor-over-evidence-contract canonical; direct-API optional; own only the layer |
| 3 | **P0** | `product-gate.ts`, `core.ts:784/818/1822` | demolish/quarantine the self-certifying gate + hardcoded reviewer; M7 regression proves it can't mark complete |
| 4 | P0 | PLAN §6 M‑1 (new) | integrity baseline blocks M0: clean clone reproduces product; ADR supersedes "OMX First"; git clean |
| 5 | P1 | CONTRACT §4.4-4.5 + parity-gate.ts:13 | *if* direct-API kept: per-provider normalization sub-spec + byte-recorded conformance fixtures; re-home `runtime/*` under M10; split `ExecutorResult`→`ExecutorTurn`/`ExecutorRun` with `refused` status |
| 6 | P1 | `permission-broker.ts:30` | classify from actual tool+args, not caller label; native-CLI = `mediation: external/unowned` |
| 7 | P1 | memory ×3 schemas | reconcile to one provenance-keyed schema; fix gate #4 |
| 8 | P1 | Addition A | acceptance-criterion per module + `soft-by-decision` status; SOFT = zero guarantee; `providerHints`→provider-specific-soft |
| 9 | P2 | Addition B / M12 | wrap-don't-rebuild; forbid bespoke verifiers; define `AcceptanceContract`; rule-vs-skill precedence; one-target_type |
| 10 | P2 | M8 | two-run → three-run differential; closed-enum decision fields; determinism mode recorded |

---

## 9. The first slice that is actually daily-usable (replaces CONTRACT §7 mock slice)

Not "mock executor through product-owned hooks." The real first win:

1. operator gives a small task in the UI;
2. product builds a `ContextBundle` (rules + graded memory + acceptance) and hashes it;
3. **runs it through the existing `codex-exec-runner` (native canonical adapter)** — real work gets done;
4. every step appends to the **hash-chained ledger**;
5. tool effects (git diff, files) are captured as evidence;
6. the **new M7 verifier** (not the demolished gate) judges acceptance over recomputable evidence;
7. state transitions **only** through the verifier result;
8. the run is labeled `native-harness-assisted` with unowned surfaces enumerated.

If this works, the product owns the harness over a rented loop — daily-usable in weeks. Direct-API, multi-provider parity, and the normalization sub-spec are *later, optional* refinements behind the same contract.

---

## 10. Residual honest risks (not closable by planning)

- **R-native-ownership:** in native-canonical mode, M3 hooks / M5 mediation / M4 context are partly *advisory* (the native loop owns file/shell authority). The product owns **evidence and gating**, not in-loop control. That is the honest ceiling of "own the layer" — and it is far more reachable than "own the loop."
- **R-solo-independence:** the verifier's "independent custody" remains structurally impossible for a single principal (operator holds every key). Hard-cap the honest ceiling **~75 by construction** in solo mode; ≥90 needs a real second principal that does not exist today. (Unchanged from the prior binding finding; both docs must stop implying solo independence is achievable.)
- **R-causal-promotion:** even the three-run differential proves controlled-single-delta correlation, not true causation under a stochastic model. M8 stays the most likely module to slip.

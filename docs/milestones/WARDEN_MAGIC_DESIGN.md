# Warden Magic — DESIGN (dynamic per-project dependency composition & injection)

**Date:** 2026-06-19 · **Status:** design for critic-panel review (NOT a completion claim).
**Thesis (unchanged):** Warden owns the evidence/verifier/ledger layer over rented native CLI loops; completion is declared ONLY by the recomputable verifier over the hash-chained ledger. Anything here must survive that.

## 1. Problem

LLM tooling (skills, MCP servers, sub-agents, harnesses, `soul.md`, `agent.md`/`AGENTS.md`) has exploded. Picking and wiring the right set **per project, before every run, by hand** is friction. Goal (Tuist analogy): treat these as fine-grained composable "modules," **detect what kind of project this is → resolve the needed set from a catalog → inject it → run** — no manual per-project setup.

## 2. What already exists (build on, don't rebuild)

`buildCompositionPlan()` (`src/composition/composition.ts`) already emits `CompositionPlan { modules: { skills[], harnesses[], agents[], soul, agents_md_stack[], runtime_adapter } }` and is **already wired into the run lifecycle**: `core.ts:328` → ledger event `composition.resolved` + artifact `composition.json`, checked by `full-target-gate.ts:198-200`, replayed by `context-provenance.ts:47`. Today it is **static** (hardcoded off `mode`) and is **never injected** — Warden runs native CLIs hands-off (no `--mcp-config`), so the executor only sees its own global/committed config (verified: `generic-cli-runner.ts`/`codex-exec-runner.ts` inherit env, inject nothing).

## 3. Design — 4 stages feeding the existing CompositionPlan

1. **Detect** (`src/composition/detect.ts`, new) — `detectProjectSignals(root) → ProjectSignals`, DETERMINISTIC and replayable: manifests/lockfiles (Tuist `Project.swift`/`Workspace.swift`/`Tuist/`, `Package.swift`, `Cargo.toml`, `package.json`+lock, `pyproject.toml`, `go.mod`…), language census, monorepo markers, existing AI surfaces (reuse `detectNativeSurfaces`/`detectPathSurface`, plus `.claude/`/`.codex/`/`.mcp.json`/`soul.md`/`AGENTS.md` presence). Optional advisory LLM pass (`magic --analyze`) runs one bounded executor turn → structured JSON, labeled `advisory`, **operator-confirmed before it can influence resolution**. Deterministic signals are always the recorded basis.
2. **Catalog** (`src/composition/catalog.ts`, new) — `loadModuleCatalog()` merges (a) discovered-installed (`~/.claude/skills`, plugin dirs, installed MCP, `listSkillSpecs()`), (b) declared `warden.modules.json` (repo) + `~/.warden/catalog/*.json` (global). `CatalogModule{ id, kind: skill|harness|agent|soul|mcp|agents_md, appliesTo: predicates over ProjectSignals, inject: descriptor }`. Declared overrides/annotates discovered.
3. **Resolve** — upgrade `buildCompositionPlan()` in place: accept `signals` + `catalog` + `recommendModules()` (verified-run learned signal) + operator overrides → existing `CompositionPlan` extended with `mcp_servers[]`, `detection: ProjectSignals`, per-module `selected_because` (deterministic|learned|declared|operator). Keep `composition.json`/`composition.resolved` contract unchanged.
4. **Inject** (`src/composition/inject.ts`, new) — `applyCompositionToWorktree(worktreePath, plan, catalog, executorLabel)` writes the resolved set into the worktree **after** `materializeEvidenceInto` and **before** `options.executor(...)` (`orchestrator.ts` ~L126): compose `.mcp.json`; write/merge `CLAUDE.md`+`soul`; copy skill files to `.claude/skills/` or `.codex/` per executor. Emit `composition.injected` carrying **sha256 of every file written** (tamper-evident, replayable). Native CLIs auto-load by convention — no executor-contract change.

## 4. Thesis guardrails (attack these)

- **Injection recorded, not trusted benign:** `composition.injected` hashes the full written set into the hash chain → replayable, tamper-evident.
- **Injection NEVER advances completion:** verdict stays `recomputeCompletionFromLedger`/acceptance only. Magic shapes *what the executor can do*, never *whether it passed*.
- **Model detection advisory + operator-confirmed:** deterministic `ProjectSignals` are the recorded basis; LLM proposal never auto-applies, never gates.
- **Scope/secret approval:** reuse `CompositionPlan.approval_policy` — global-catalog edits and secret-bearing MCP entries require approval before injection.

## 5. First slice — REVISED per critic panel (§7): detect + resolve + dry-run, NO injection

Slice 1 ships the **planning half** only — the visible "magic" (analyze → decide) end-to-end, almost entirely deterministic/safe — and defers ALL injection to slice 2 (which gets its own critic pass). This dissolves most of the §7 blockers (no injection ⇒ consumption-proof/closure/worktree-mutation are slice-2 problems).

**Slice 1 (this implementation):**
- `detect.ts` — deterministic, emits **flat tags only** (`swift`,`tuist`,`rust`,`node`,`monorepo`, native-surface tags), NO predicate DSL.
- `catalog.ts` — declared `warden.modules.json` (repo) + `~/.warden/catalog/*.json` (global) + discovered installed; module match = **module tags ⊆ detected tags** (flat subset, no boolean/version logic).
- dynamic `buildCompositionPlan` resolves from signals(tags) + catalog + `recommendModules` + operator overrides → extended `CompositionPlan` (`detection`, `selected_because`), still `composition.resolved`/`composition.json`.
- CLI: **`warden magic plan <goal>`** (dry-run: print detected tags + resolved plan; no run, **no injection**). `warden magic catalog list`.
- **Acceptance-independence invariant encoded now (claude BLOCKER #1):** a catalog module MUST NOT carry an `AcceptanceContract`; resolve rejects any module that does. Acceptance stays operator-owned, frozen before composition.

**Slice 2 (deferred, own critic pass):** the `InjectionAdapter` (per-executor, with `smokeProbe` proving consumption — else `mcp_injection: unsupported`), `inject.ts` for MCP `.mcp.json` only (local, no-secret, pre-installed binaries; exec-time installs forbidden), `composition.injected` as a **post-write disk re-read + closure check + replay re-derivation + pre/post-exec hashes**, write-lock + post-exec re-verify, `warden magic run`.

**Deferred further:** advisory LLM detection; instruction kinds (CLAUDE.md/soul/skill-guidance — blocked behind M7 demolition + approval, claude #5); caching/incremental resolution.

## 7. Binding revisions from the critic panel (2026-06-19)

3/3 critics PROCEED-WITH-CHANGES. Convergent, now binding:

- **B1 (claude):** composition may contribute capability(MCP)/guidance, **never an `AcceptanceContract`**; acceptance is operator-owned and frozen before `buildCompositionPlan`. Encoded as a slice-1 invariant (resolve rejects acceptance-bearing modules) + forgery fixture.
- **B2 (codex):** no "auto-load by cwd convention" claim — slice 2 needs a per-executor `InjectionAdapter` with a `smokeProbe`; unproven consumption ⇒ `mcp_injection: unsupported`, never a false injection claim.
- **B3 (codex+claude):** `composition.injected` (slice 2) = hash of the **actual post-write worktree AI-surface set re-read from disk**, with a **closure** check (no AI-surface file outside the recorded set) + independent replay re-derivation + pre/post-exec hashes. Forgery fixtures: smuggled file rejected; content≠plan rejected.
- **B4 (claude):** per-kind guardrail — MCP=capability (hash+verifier sufficient); instruction kinds (CLAUDE.md/soul/skill-guidance) are teaching-to-the-test channels → approval-gated AND verifier evidence must be a class an injected instruction can't fabricate without real work. Instruction kinds blocked until M7 demolition (slice ≥3).
- **B5 (agy+codex):** **eliminate the `appliesTo` predicate DSL** → flat tag-subset matching. Detector emits flat tags only.
- **B6 (agy):** no exec-time installs in the ephemeral worktree; injected configs point to pre-installed binaries; write-lock + post-exec hash re-verify (slice 2).
- **B7 (agy+codex):** first slice was too thick → re-scoped to detect+resolve+dry-run, injection deferred (above).

## 6. Honest risks

- **R-inject-loop:** active injection means Warden now shapes the in-loop surface (it previously deliberately did not — CORRECTED_PLAN §10 R-native-ownership). Mitigation: everything injected is hashed+ledgered and completion stays verifier-gated; but this IS a real expansion of what the harness touches. Stated, not hidden.
- **R-catalog-trust:** a malicious/declared catalog module could inject a hostile MCP/skill. Mitigation: secret/global entries require approval; injected set is recorded. Residual: a catalog the operator trusts can still inject what it declares.
- **R-second-language:** `appliesTo` predicate DSL risks becoming a second orchestration language (M12 R5). Mitigation: keep predicates a tiny closed set (manifest/lang/surface presence), no arbitrary logic.

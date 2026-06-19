# Warden

**A provider-neutral evidence & control layer for AI coding agents.** Warden rents the agent loop (Codex CLI, Claude Code, Antigravity/agy — driven headless) and owns the layer that doesn't exist elsewhere: a hash-chained event ledger, a recomputable verifier, content-addressed evidence, promotion, policy, and an operator UI. **Completion is declared only by re-running acceptance over the ledgered evidence — never by a model, a CLI, a score, or review prose.**

> Local, file-backed, single-operator. State lives under `.agent/`. No hosted service, no SaaS, no auto-push.

**Use it when** you hand a bounded coding task to a CLI agent and need to *know* it's actually done — not take the agent's word. You give Warden a task and an acceptance check (a test command); it runs a native CLI in an isolated worktree, records the work to a tamper-evident ledger, and tells you `passed` only if re-running your acceptance over the produced diff in a clean checkout actually passes. The payoff is a completion verdict you can recompute and audit, instead of a model saying "done."

## Why

LLM coding agents are good at *doing the work* and bad at *honestly reporting whether it's done* — they will self-certify completion from prose. Warden's thesis: **own the evidence and the gate, rent the loop.** A native CLI does the work inside an isolated git worktree; Warden records every step to a tamper-evident ledger and judges completion by re-running the acceptance check over the produced evidence in a clean checkout. If the gate can't be recomputed, it isn't completion.

## Install / local run

```bash
npm install
npm run build
npm link            # puts `warden` on PATH (state is still per-cwd .agent/)
warden --version
```

Without linking: `node dist/cli.js --help`.

## Core operator flow (v0–v2 product)

```bash
warden init
warden project add "$PWD"
warden task add "Investigate and fix a bounded issue"
warden run create <task-id> --mode basic --command "npm test"
warden run start <run-id>
warden run collect <run-id>
warden review latest
warden web --port 4317      # operator UI: recomputes truth from the ledger, flags contradictions
```

- **Role / multi-worker:** `--mode roles` (manager/worker/reviewer) and `--mode multi --max-workers N` (bounded parallel workers in real isolated worktrees; conflicts/denied-paths/evidence-mismatch block synthesis).
- **Approval-gated apply:** `warden apply propose <run-id>` → `warden approval approve <id>` → `warden apply approved <id>` (`git apply --check` first; never auto-pushes).
- **Mutating shell** creates a `shell_mutation` approval and does not execute until approved.

## Harness runtime (the evidence layer)

```bash
warden harness run "<goal>" --executor codex|claude|agy|anthropic-direct
warden skill run <spec.json> --what "<goal>"   # research → execute → review
warden skill show <runId>                       # recompute completion from the ledger; flag contradictions
warden runtime verify-ledger <runId>            # hash-chain tamper check
warden verifier run --run <runId>               # recomputable acceptance verdict
warden orchestrate serve | run --file <graph.json>   # DAG daemon (request verifyCmd rejected)
```

The canonical executor is a native CLI driven headless (`codex exec`, `claude -p`, `agy -p`) using its own login — your subscription is the runtime, no per-call API spend. `anthropic-direct` is an optional direct-API adapter behind the same evidence contract. Every run is labeled `native-harness-assisted` with its unowned surfaces named.

### orchestrator-as-skill

`warden skill run` compiles a spec into a `research → execute → review` graph over native executors. Completion is `recomputeCompletionFromLedger`: it validates the hash chain, **asserts the stored execute evidence still matches its hash-chained content digest** (a swapped store file recomputes `failed`, never a silent re-grade), then **re-runs the acceptance command over that evidence in a clean checkout**, with operator `testFiles` overlaid last (the executor cannot edit the test it is graded by).

- **Evidence granularity** — the execute phase records either a single self-contained artifact (`evidence: 'artifact'`, the default) or the **full worktree diff** (`evidence: 'diff'`). Diff mode grades genuine multi-file repo work: acceptance deterministically reconstructs `base@pinned-commit + git apply(diff) + testFiles overlaid last` with the repo's `node_modules` linked in, so a real `npm test` over a multi-file change is gradable — not just a self-contained file.
- **Execute fan-out** — race N executors on the same task; winner by re-running acceptance, never by rank/self-claim.
- **Refinement loop** (`maxRefineIterations`) — bounded draft→verify→fix; the loop's only continue/stop signal is the recomputable acceptance, never a critic score.

## Warden Magic — per-project dependency composition (Tuist-for-LLM-deps)

Analyze a project, resolve the LLM-dependency modules it needs (MCP servers, instruction files), inject them, run — no manual per-project wiring.

```bash
warden magic plan "<goal>"        # detect project tags + resolve modules (dry-run; injects nothing)
warden magic catalog              # list the module catalog (declared + discovered)
warden magic apply [--into <dir>] [--executor ...] [--approve-secrets]   # inject + hash-chained record
warden magic show <magicRunId>    # recompute the injection record from the ledger; flag contradiction
warden magic run "<goal>" [--executor ...] [--prove]                     # inject then run the executor
```

- **Detect** (deterministic, flat tags): manifests/lockfiles (Tuist, SwiftPM, Cargo, npm/pnpm/yarn, go, python…) + AI-surface markers. No predicate DSL.
- **Catalog**: declared `warden.modules.json` (repo) + `~/.warden/catalog/*.json` (global) + discovered installed skills; a module matches when its tags ⊆ the detected tags.
- **Inject**: writes the resolved set into the run worktree; recorded as a tamper-evident, replayable `composition.injected` ledger event.
- **`--prove`**: injects a canary MCP server; consumption is proven by the sentinel it writes *when actually called* — never by the model's word.

**Honest ceiling (by design).** The executor owns the worktree (R-native-ownership), so Warden guarantees **integrity + replayability of what it injected**, not what the executor does with it. Consumption proof is non-adversarial. MCP (capability) injects freely; **instruction injection (CLAUDE.md/soul) is approval-gated AND mechanically restricted to pinned-test acceptance** — a teaching-to-the-test channel that can never launder a verdict, because the graded test stays operator-pinned.

## Evidence & safety model

- Project state under `.agent/`, rebuildable into `.agent/index.json`.
- Hash-chained `RuntimeEventEnvelope` ledger (`prev_event_sha256`); a tampered middle event fails re-validation. The chain proves the **event narrative** is unedited — and, for the skill path, **binds the graded execute evidence**: its content digest is recorded in the chain and re-asserted before completion is recomputed. The chain is tamper-evidence + evidence-binding; the completion *authority* is still re-running acceptance over that bound evidence, not the chain itself.
- Process output captured as `*.process.json` / `*.stdout.log` / `*.stderr.log`; rendered artifacts redact common API tokens.
- Memory fabric admits only **provenanced + freshly-verified** facts (gate #4); freshness is earned from a passing verifier, never self-asserted.
- Injection never advances completion; the web UI shows a CONTRADICTION panel rather than ever showing green when the gate is red.

## Quality gate (advisory)

```bash
warden quality gate --write
```

Rejects scaffold/MVP/docs-only/self-certified completion and writes a durable report under `.agent/product-gates/`. **Advisory only** — it cannot mark a run complete; completion authority is the recomputable ledger/diff verifier. PRD-scoped local v0–v2 gates pass; hard completion is honestly capped (`completion_ceiling: 60`) until review custody exists, and the honest solo-operator ceiling is ~75 by construction.

**The custody bar is forgery-resistance, not proven independence — and it is in deliberate tension with "local, single-operator."** Custody (the `≥90` path) is a CI workflow that binds a review bundle to the run's `head_sha` and HMAC-signs it: it makes a forged or after-the-fact review *tamper-evident and provenance-bound*, raising the cost of self-certification. It does **not** prove a genuinely independent principal judged the work — the operator still owns the CI definition, the signing keys, and the reviewer agents. So a purely local solo run is capped (~75) **by design**, and crossing ≥90 deliberately requires an external second principal (the custody CI) — i.e. stepping outside the pure local-solo posture the headline describes. That tension is intentional and stated, not hidden; the `60` cap is the honest acknowledgement that custody is forgery-resistance, not independence.

## How this was built

Design and implementation are reviewed by an in-repo **critic panel** — three heterogeneous executors (codex/claude/agy) in isolated worktrees, each under a distinct adversarial lens, the verifier owning "supported" (`docs/milestones/*_panel.mjs`). Writer and reviewer passes are kept separate; nothing self-approves. Several features were materially reshaped or narrowed by panel BLOCKERs (e.g. injection's guarantee was narrowed to what R-native-ownership actually allows).

## Layout

- `src/harness/` — ledger, verifier, orchestrator-skill, fan-out, refinement, injection wiring
- `src/composition/` — Warden Magic: detect / catalog / resolve / inject / ledger-evidence / canary
- `src/events/ledger.ts` — hash-chained runtime event ledger
- `src/memory/` — provenance-keyed memory fabric
- `src/cli.ts` — the `warden` CLI; `src/view.ts` — operator web UI
- `docs/milestones/` — design docs, critic panels, and the binding corrected plan
- Upstream/scope: `dominic_orchestration_PRD.md`, `docs/milestones/HARNESS_OS_CORRECTED_PLAN.md`

## License

See repository license files.

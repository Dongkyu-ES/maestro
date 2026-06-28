# maestro

> **Task-aware orchestration for AI coding agents.** One task in, the right multi-agent pattern out — composed from the CLIs you already pay for.

*Read this in other languages: **English** · [한국어](README.ko.md)*

![Claude Code plugin](https://img.shields.io/badge/Claude_Code-plugin-d97757)
![runtime deps](https://img.shields.io/badge/runtime_deps-0-2ea44f)
![footprint](https://img.shields.io/badge/local-single--operator-3b82f6)
![evidence](https://img.shields.io/badge/evidence-opt--in-64748b)

Give maestro a task. It classifies the work, picks the orchestration pattern that fits, composes the right CLI for each role (Codex, Claude Code, Antigravity/`agy` — each driven headless on its own login), gives every role only the context it needs, runs the orchestration, and hands back **one synthesized result**. Most often it rides along as the `/maestro "<task>"` Claude Code skill.

## Install

```text
/plugin marketplace add Dongkyu-ES/maestro
/plugin install maestro@maestro
```

Self-contained: the engine ships *inside* the plugin, zero runtime dependencies, nothing to build. Needs `node` + `git`, and one executor CLI (`codex` / `claude` / `agy`) on its own login. From source instead → [Build from source](#build-from-source).

## What you get

- **Four patterns, picked per task** — build → independent-review · fan-out + select · panel / debate · scout → plan → build → verify.
- **Your subscription is the runtime** — drives Codex / Claude / agy on their own logins; no per-call API spend.
- **Right-sized isolation** — git worktrees + selective MCP / instruction injection *only* when a step mutates files in parallel; read-only steps stay in-session, light tasks stay light.
- **Opt-in evidence** — a hash-chained ledger, a recomputable verifier, content-addressed evidence, for when you want a completion verdict you can replay and audit (`--prove` / `--gate`). Off by default.
- **Local & honest** — file-backed under `.agent/`, single-operator, no hosted service, no SaaS, no auto-push.

---

## Contents

- [Background](#background)
- [Why maestro](#why-maestro)
- [How it works](#how-it-works)
  - [The four patterns](#the-four-patterns)
  - [Role to CLI mapping](#role-to-cli-mapping)
  - [maestro magic — dependency composition](#maestro-magic--dependency-composition)
- [Usage](#usage)
  - [As a Claude Code skill](#as-a-claude-code-skill)
  - [Operator flow](#operator-flow)
  - [Harness runtime](#harness-runtime)
- [Use cases](#use-cases)
- [Evidence and safety](#evidence-and-safety)
- [Quality gate](#quality-gate)
- [How this was built](#how-this-was-built)
- [Build from source](#build-from-source)
- [Project layout](#project-layout)
- [License](#license)

---

## Background

AI coding CLIs are individually strong and mutually blind. Codex, Claude Code, and Antigravity each carry their own login, their own sandbox, their own way of being driven headless — and none of them knows the others exist. The moment a task wants *more than one* of them — a second model to review the first, three independent attempts to choose between, a debate before a decision — you are back to hand-wiring: copy-pasting context between terminals, juggling worktrees so parallel writers don't collide, and trusting whatever "looks done" prose each tool emits.

maestro is the layer that does that wiring for you, and only as much of it as the task actually needs.

## Why maestro

maestro **composes existing tools instead of building new infrastructure**: `git worktree`, the native CLIs and their own logins (your subscription is the runtime — no per-call API spend), and a tested engine for detect → resolve → inject → spawn → cleanup.

On top of that sits an **opt-in** evidence layer — a hash-chained ledger, a recomputable verifier, content-addressed evidence — for when you want a completion verdict you can recompute and audit. It stays off the default path: orchestration first, proof only when you ask for it (`--prove` / `--gate`).

The guiding rule, enforced in the skill itself: **pick the lightest existing path that improves the result.** Multi-agent fan-out is the exception, not the default — it earns its cost only when independent attempts are genuinely valuable, single-shot confidence is low, or the work is hard. Otherwise one agent, in-session, is the answer.

## How it works

maestro runs a five-step loop on every task: **classify → pick a pattern → map roles to CLIs → provision each role with only what it needs → run and synthesize.** Heavy steps (worktree split, selective injection, DAG fan-out) run on the local, provider-neutral engine; read-only steps (panel, scout, review) run in-session with no worktree at all.

### The four patterns

| Signal | Pattern | Why |
| --- | --- | --- |
| One artifact, quality matters, "need to be sure it's right" | **build → independent-review loop** | a *different* model reviews than the one that built — breaks the self-verification blind spot |
| One goal, several independent attempts, "best of N" | **fan-out + select** | N parallel attempts → a judge selects / synthesizes |
| A decision or design question, no file changes | **panel / debate** | advisors across different models / lenses → synthesis |
| Broad, ambiguous build, "don't know where to start" | **scout → plan → build → verify** | explore → plan → implement → verify pipeline |

When fan-out *is* warranted, it caps at 3–5 and prioritizes **perspective diversity** (different models / lenses) over raw count.

### Role to CLI mapping

Default heuristics, overridable per role:

- **build** → `codex` in a workspace-write worktree.
- **review** → a *different* model than the builder (`codex` gpt-5.5 high, or `claude`).
- **scout / judge** → `claude` or the in-session `Explore` agent.

```bash
# read-only advisor / reviewer, in-session, no worktree:
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only "<prompt>" </dev/null
```

### maestro magic — dependency composition

Think *Tuist, but for LLM dependencies.* Analyze a project, resolve the LLM-dependency modules it needs (MCP servers, instruction files), inject them, run — no manual per-project wiring.

```bash
maestro magic plan "<goal>"     # detect project tags + resolve modules (dry-run; injects nothing)
maestro magic catalog           # list the module catalog (declared + discovered)
maestro magic run "<goal>" --executor codex|claude|agy [--prove]   # inject, then run the executor
maestro magic show <magicRunId> # recompute the injection record from the ledger; flag contradiction
```

- **Detect** (deterministic, flat tags): manifests / lockfiles (Tuist, SwiftPM, Cargo, npm/pnpm/yarn, go, python…) + AI-surface markers.
- **Catalog**: declared `maestro.modules.json` (repo) + `~/.maestro/catalog/*.json` (global) + discovered installed skills; a module matches when its tags ⊆ the detected tags.
- **`--prove`**: injects a canary MCP server; consumption is proven by the sentinel it writes *when actually called* — never by the model's word.

## Usage

### As a Claude Code skill

The everyday path. Once the plugin is installed:

```text
/maestro "find and fix the flaky test in the payments suite, then verify"
```

maestro classifies it, picks `scout → plan → build → verify`, and drives the executors for you.

### Operator flow

The CLI surface behind the skill (v0–v2 product):

```bash
maestro init
maestro project add "$PWD"
maestro task add "Investigate and fix a bounded issue"
maestro run create <task-id> --mode basic --command "npm test"
maestro run start <run-id>
maestro run collect <run-id>
maestro review latest
maestro web --port 4317      # operator UI: recomputes truth from the ledger, flags contradictions
```

- **Role / multi-worker** — `--mode roles` (manager / worker / reviewer) and `--mode multi --max-workers N` (bounded parallel workers in real isolated worktrees; conflicts / denied-paths / evidence-mismatch block synthesis).
- **Approval-gated apply** — `maestro apply propose <run-id>` → `maestro approval approve <id>` → `maestro apply approved <id>` (`git apply --check` first; never auto-pushes).
- **Mutating shell** creates a `shell_mutation` approval and does not execute until approved.

### Harness runtime

The evidence layer, when you want a verdict you can recompute:

```bash
maestro harness run "<goal>" --executor codex|claude|agy|anthropic-direct
maestro skill run <spec.json> --what "<goal>"   # research → execute → review
maestro skill show <runId>                       # recompute completion from the ledger; flag contradictions
maestro runtime verify-ledger <runId>            # hash-chain tamper check
maestro verifier run --run <runId>               # recomputable acceptance verdict
maestro orchestrate serve | run --file <graph.json>   # DAG daemon (request verifyCmd rejected)
```

The canonical executor is a native CLI driven headless (`codex exec`, `claude -p`, `agy -p`) on its own login — your subscription is the runtime, no per-call API spend. `anthropic-direct` is an optional direct-API adapter behind the same evidence contract. Every run is labeled `native-harness-assisted` with its unowned surfaces named.

`maestro skill run` compiles a spec into a `research → execute → review` graph. Completion is `recomputeCompletionFromLedger`: it validates the hash chain, **asserts the stored execute evidence still matches its hash-chained content digest** (a swapped store file recomputes `failed`, never a silent re-grade), then **re-runs the acceptance command over that evidence in a clean checkout**, with operator `testFiles` overlaid last — the executor cannot edit the test it is graded by.

## Use cases

**"I have a bug and I don't know where to start."** Broad and ambiguous → scout maps the territory, plan scopes the fix, build implements, verify proves it.

```text
/maestro "users intermittently get logged out after deploy — find the cause and fix it"
```

**"Give me the best of several approaches."** Wide solution space → race independent attempts, judge by re-running acceptance, never by self-claim.

```bash
maestro harness run "design a rate limiter for the gateway" --executor codex   # fan-out variant selects by acceptance
```

**"Which approach is right — A or B?"** A decision with no file changes → a panel of advisors across different models / lenses, synthesized.

```bash
codex exec -m gpt-5.5 -c model_reasoning_effort="high" --sandbox read-only \
  "Compare optimistic vs pessimistic locking for this schema. Argue both, then recommend." </dev/null
```

**"Build this and make sure it's actually right."** Quality matters → the builder and the reviewer are different models; nothing self-approves.

```bash
maestro skill run spec.json --what "add idempotency keys to the orders endpoint"
maestro skill show <runId>   # completion recomputed from the ledger, not from prose
```

## Evidence and safety

- Project state lives under `.agent/`, rebuildable into `.agent/index.json`.
- A hash-chained `RuntimeEventEnvelope` ledger (`prev_event_sha256`) makes a tampered middle event fail re-validation. The chain proves the **event narrative** is unedited and **binds the graded execute evidence** — its content digest is recorded in the chain and re-asserted before completion is recomputed. The chain is tamper-evidence; the completion *authority* is still re-running acceptance over that bound evidence.
- Process output is captured as `*.process.json` / `*.stdout.log` / `*.stderr.log`; rendered artifacts redact common API tokens.
- The memory fabric admits only **provenanced + freshly-verified** facts; freshness is earned from a passing verifier, never self-asserted.
- Injection never advances completion; the web UI shows a CONTRADICTION panel rather than ever showing green when the gate is red.

## Quality gate

```bash
maestro quality gate --write
```

Rejects scaffold / MVP / docs-only / self-certified completion and writes a durable report under `.agent/product-gates/`. **Advisory only** — it cannot mark a run complete; completion authority is the recomputable ledger / diff verifier.

The honest ceiling is stated, not hidden: hard completion is capped (`completion_ceiling: 60`) until review custody exists, and a purely local solo run tops out at ~75 **by construction** — the operator still owns the machine, the keys, the prompts, and the artifacts. Crossing ≥90 deliberately requires an external second principal (custody CI that binds an HMAC-signed review bundle to the run's `head_sha`), i.e. stepping outside the pure local-solo posture. That tension is intentional: custody is forgery-resistance, not proof of independence.

## How this was built

Design and implementation are reviewed by an in-repo **critic panel** — three heterogeneous executors (codex / claude / agy) in isolated worktrees, each under a distinct adversarial lens, the verifier owning "supported" (`docs/milestones/*_panel.mjs`). Writer and reviewer passes are kept separate; nothing self-approves. Several features were materially reshaped or narrowed by panel BLOCKERs — e.g. injection's guarantee was narrowed to what executor-owns-the-worktree actually allows.

## Build from source

```bash
npm install
npm run build
npm link            # puts `maestro` on PATH (state is still per-cwd .agent/)
maestro --version
```

Without linking: `node dist/cli.js --help`. After changing `src/`, rebuild and recommit `dist/` — that committed build is what the plugin ships.

## Project layout

- `src/harness/` — ledger, verifier, orchestrator-skill, fan-out, refinement, injection wiring
- `src/composition/` — maestro magic: detect / catalog / resolve / inject / ledger-evidence / canary
- `src/events/ledger.ts` — hash-chained runtime event ledger
- `src/memory/` — provenance-keyed memory fabric
- `src/cli.ts` — the `maestro` CLI; `src/view.ts` — operator web UI
- `bin/maestro` — plugin launcher (PATH shim → bundled `dist/cli.js`)
- `docs/milestones/` — canonical docs; finished milestones + one-off panels under `docs/milestones/archive/`
- **Start here:** `docs/milestones/_CURRENT_TRUTH.md` (single source of truth: direction, status, doc map)

## License

See repository license files.

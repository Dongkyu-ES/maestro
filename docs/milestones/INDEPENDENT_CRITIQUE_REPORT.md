# Independent Critique Report — Warden

**Date:** 2026-06-02
**Method:** 7-dimension multi-agent critique (claim-vs-reality, architecture, code quality, test integrity, security, scope/PRD, process hygiene), each finding adversarially verified by an independent agent. Key facts reproduced empirically.
**Verdict:** The product is a solid **v0 local control plane plus scaffolded v1/v2 plumbing (~30–35% of the PRD)**. The "completion_ceiling: 95 / all gates PASS" claim is **not honest**: from a clean state the anti-self-deception gates themselves FAIL, the decisive "independent review" gate is satisfiable by a hand-authored fixture, and the entire runtime/harness layer the docs describe is uncommitted to git.

> This report intentionally contradicts the optimistic status lines in the other milestone docs. Where they disagree, this report is the corrected record. The raw machine output is archived alongside this file as evidence.

---

## Dimension scorecard

| Dimension | Score /10 | One-line verdict |
| --- | --- | --- |
| Claim-vs-Reality | 2.5 | "95% complete" rests on self-certifying artifacts |
| Architecture | 3.5 | The "LLM proposes" layer does not exist in any realized path |
| Code Quality | 3.0 | `core.ts` is a 506-line god-object; 92/103 functions are single physical lines |
| Test Integrity | 2.5 | From a clean state the gates fail; suite is non-deterministic |
| Security / Safety | 5.5 | `redact()` was theater (now fixed); web CSRF/path-containment are real |
| Scope / PRD | 4.0 | Scope narrowing is faithful; in-scope v1/v2 capability is stubbed |
| Process Hygiene | 1.5 | The central product is entirely uncommitted |

---

## CRITICAL findings (all adversarially confirmed)

### C1. `completion_ceiling: 95` is gated by a hand-written fake-reviewer fixture
`runProductGate` computes `completionCeiling = hardGatesAllPass ? 95 : 60` (`src/core.ts:473`) — **95 is a boolean flip, not a measurement**. The decisive condition `independentReviewOk` (`src/core.ts:447`) reads `.agent/independent-review-gate.json`, a **gitignored, hand-authored** file containing synthetic agent IDs (`019e0000-0000-7000-...`) and a zero-clock timestamp (`2026-06-01T00:00:00.000Z`). No code path anywhere generates this file — only tests and manual editing write it.

**Empirical proof:** with the fixture present, `quality gate` → PASS / ceiling 95. After `mv` it aside → **FAIL / ceiling 60 / "Prototype scaffold"**. `reviewArtifactOk` (`core.ts:319-364`) has real anti-forgery cross-checks (sha256 binding, path guards) but they only detect an *internally inconsistent* bundle — they cannot distinguish a self-consistent hand-authored bundle from a real reviewer's output. The gate is therefore self-certifiable by the implementer.

### C2. The touted runtime/harness layer is untracked in git
Committed `HEAD`'s `src/` is **only 3 files** (`cli.ts`, `core.ts`, `core.test.ts`), importing nothing beyond node builtins + `./core.js`. The working tree adds **22 untracked files** (`runtime/`, `harness/`, `events/`, `memory/`, `policy/`, `projection/`, `composition/`, `runtime-architecture.test.ts`) and modifies `cli.ts`/`core.ts` to import them — none committed.

Result: **two divergent products.** (1) Committed `HEAD` = a self-contained v0 control plane that builds fine. (2) Working tree = `HEAD` + the uncommitted runtime/gate layer that every milestone doc and the ceiling-95 claim depend on. ("HEAD is broken" is *false* — HEAD builds; the problem is the impressive product is uncommitted.) A project whose thesis is durable evidence and anti-self-deception kept its evidence machinery outside version control.

### C3. `npm test` is order/state-dependent; the green run proves a self-authored fixture, not a real reviewer
`npm test` is **not isolated** from a shared, gitignored `.agent/` directory in the working directory, so re-runs in a dirty repo oscillate (observed 93/2, 94/1, 95/95 in one session); clearing the seeded fixtures mid-session yields **93/2**, where the two failures are exactly the anti-self-deception gates (*"hard completion ceiling requires independent review and reconciliation artifacts"*, *"durable report contains report_path after hard gates pass"*). A **pristine checkout** does pass (96/96) — but only because those completion-gate tests **author their own** `independent-review-gate.json` fixture in `cwd/.agent`. So the green run demonstrates the gate passing against a test-written fixture, **not** real reviewer evidence (this is the C1 problem). Net: the suite is order/state-dependent, and "95/95" is not evidence of independent verification.

### C4. The "LLM proposes" layer is absent; roles are an env-var trick
- **No LLM is invoked in any realized execution path.** The default "task adapter" (`src/core.ts:128`) runs `node -e "console.log('...task adapter executed')"` — a no-op echo — and the dogfood gate "verifies execution" by grepping that literal string out of stdout (`core.ts:404`).
- **Manager/Worker/Reviewer (the v1 core)** is the *same* operator command run three times with a different `ROLE` env var (`core.ts:151`); role artifacts are static boilerplate. Roadmap `v1 role execution: PASS` (`FULL_PRODUCT_ROADMAP.md:245`) is contradicted by the code.
- **OMX/agy adapters are 3-line detection stubs;** the Codex adapter is CLI detection + transcript reading, not a session controller. (Credit: the UI labels these honestly as `primitive_shell` / `unproven`.)

---

## HIGH findings

- **Product gate is partly circular.** `safetyOk`/`evidenceOk`/`regressionOk` (`core.ts:435-438`) are computed as `hasAll(tests, ["string literal", ...])` and `countTests(...)` against the test *source file*; `acceptanceOk` parses the roadmap markdown table for "PASS" rows (`core.ts:433`). The gate partly verifies that documents contain the right words, not that behavior works. (It does also run real checks — CLI execution, dogfood-artifact reads, contradictory-run detection — so it is not pure theater.)
- **`redact()` was a two-vendor allowlist** (`core.ts:167`) catching only OpenAI `sk-` and GitHub tokens, leaking AWS/Slack/Stripe/Google/JWT/PEM/DB-URL/npm secrets (10 of 12 tested formats), and it is the *only* secret filter on stdout logs, `executor-command.txt`, and the web run viewer. **→ Fixed 2026-06-02** (multi-vendor patterns + key/value + DB-URL redaction + regression test `redact masks multi-vendor secret formats`).
- **Promotion — the PRD's reason-for-being — is a single hardcoded stub.** `createPromotionProposal` (`core.ts:195`) always emits `target_type: 'memory'`; the other 5 declared targets and any apply path do not exist.
- **`full-target-verifier` re-reads the artifact `full-target-gate` just wrote** (circular verification); "UI render agreement" gates are in-process substring matching, never a real browser.

## MEDIUM / LOW findings

- `core.ts` mixes engine + SSR HTML + self-grading gate + git shell-outs in one 506-line module; 92/103 functions on single physical lines (longest 3684 chars); `lint` is aliased to `tsc` (no real linter); 13 `as unknown as` casts; `listTasks` force-casts `priority` to the literal `'normal'` (`core.ts:108`), silently dropping non-normal priorities.
- `isReadonlyShellCommand` allows `cat ../../etc/passwd`-style traversal without approval (local threat model limits impact); web auth token is passed in the URL query string (`?auth=`); `git apply` lacks symlink/traversal guards on patch *content* targets; `normalizeNoIndexPatch` (`core.ts:41`) is dead identity code.

---

## What genuinely works (fair credit)

- Installable CLI (`warden --version/--help`) and a real local SSR web UI with **solid web security**: output escaping (`esc`/`attr`, stored-XSS safe), per-server CSRF token + `timingSafeEqual`, Origin allowlist, HttpOnly cookie, loopback-only bind by default.
- Project/Task/Run CRUD over a `.agent/` file store, index rebuild, **real git worktree isolation** (`core.ts:125`), actual worktree-diff conflict / evidence-mismatch blocking (`core.ts:182`), and an **approval-gated, sha256-bound, atomic `git apply --check`** path (`core.ts:240`). This multi-worker safety path is genuinely well built.
- **Scope narrowing is legitimate:** PRD §3 Non-Goals explicitly defer Web UI / multi-agent / SaaS / custom Agents SDK (v3+). The v0-v2 limitation is faithful to the PRD, not post-hoc shrinking.

---

## Recommendations (prioritized)

1. **Integrity (now):** commit the runtime/harness source so committed == working product; replace the "independent review" gate with an artifact the implementer cannot author (separate CI process with verifiable provenance). Until then, report status as **v0 prototype**, not "95% / completion candidate".
2. **High:** isolate `npm test` from `.agent/` state (per-test temp dirs/fixtures) for determinism; keep the expanded `redact()`; connect or honestly relabel the no-op "task adapter".
3. **Medium:** split `core.ts` by concern and add Biome/Prettier (expand the one-line functions); implement a real promotion engine or demote it to "stub" in the roadmap.

# M15 — §9 closure: launch a skill run from the operator UI

**Date:** 2026-06-18
**Plan ref:** HARNESS_OS_CORRECTED_PLAN §9 ("the first slice that is actually daily-usable")
**Status:** Honest. Build + full suite green; launch path smoked live over HTTP; independently
reviewed (critic: ACCEPT-WITH-RESERVATIONS, no Critical/Major, one minor fix applied).

## The gap this closes

§9 steps 2–8 (ContextBundle hash → codex-exec → hash-chained ledger → M7 verifier → state only
through the verifier → `native-harness-assisted` labeling) already existed via the
orchestrator-as-skill engine (M12–M14). The one missing step was **§9 step 1: "operator gives a
small task in the UI."** The web home *listed* skill runs but offered no way to start one — the
empty state literally told the operator to drop to the `warden skill run` CLI. Skill-run launch
was CLI-only; the UI was a read-only projection.

## What shipped

- **POST `/api/skill-runs`** (`src/cli.ts`): wrap-don't-rebuild. It validates `specId` against a
  server-owned whitelist (`listSkillSpecs()` over bundled `fixtures/skills/*.json`), rejects an
  empty or `--`-prefixed goal, then spawns the **exact existing `warden skill run` CLI** as a
  detached child (`node cli skill run <spec> --what <what> --run-id <id>`, argv array — no shell).
  Same CSRF + auth + origin + loopback posture as the sibling `/api/runs` endpoints.
- **Launch form** in the operator zone + **status pills** in the skill lane (`src/view.ts`).
- **Async lifecycle, mirroring native runs** (`src/harness/orchestrator-skill.ts`): a
  `skill-launch.json` marker records operator input + child pid (never a verdict).
  `skillRunStatus()` derives `running | final | exited-without-verdict` from on-disk facts only
  (report presence first, then pid liveness). `listSkillRunSummaries()` surfaces in-flight
  launches so the operator can watch a run they just started.

## Anti-laundering invariant preserved

A launched-but-unfinished run has **no report**, so it can never show green:
`renderSkillRun` short-circuits to a no-verdict panel for any non-`final` run *before* it would
compute `authoritativeCompletion`. The home pills are status-only (`running — no verdict yet`,
`exited without verdict`, `has report — open to verify`) — none is a completion claim. A `final`
run still routes through the unchanged `projectSkillRun` ledger recompute. The independent critic
traced this path and confirmed the laundering regression "does not exist."

## Verification

- `npm run build` clean; `node --test` **288/288** (5 new tests for marker round-trip, the
  `running/exited/final` status transitions via live-vs-dead pid, in-flight discovery without a
  green, and the two no-verdict render branches).
- **Live HTTP smoke**: started `warden web`, confirmed the home launch form + spec options, POSTed
  a launch → `303 → /skill/<id>`, marker written, the detached child ran (deterministic fake
  executors) and wrote its report, and the detail page rendered an honestly **recomputed** verdict
  (it came out `skipped`, not a fake green — the throwaway fake's output didn't reach the isolated
  worktree's acceptance, which is the correct anti-laundering behavior). Real-executor green
  through the same engine is already proven by the M14 fan-out dogfood.
- **Independent review** (critic, separate lane): ACCEPT-WITH-RESERVATIONS. Fixes applied: parent
  `launch.log` fd closed after spawn (no per-launch fd leak); goal `--` guard (stops an argv
  flag-name collision from corrupting the child run id and orphaning the marker).

## Honest residue (not closed here)

- Pid-reuse can in principle keep an `exited-without-verdict` run labeled `running`; it never shows
  green. No launch concurrency cap and no `launch.log` rotation (consistent with `/api/runs`).
- A crashed child with no report leaves a marker stuck at `exited-without-verdict` — surfaced
  honestly in the UI, but no auto-cleanup affordance yet.

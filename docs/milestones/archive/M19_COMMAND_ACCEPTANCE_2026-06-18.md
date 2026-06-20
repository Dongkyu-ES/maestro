# M19 (broader M7) — executable task-correctness acceptance for generic runs

**Date:** 2026-06-18
**Plan ref:** M7 verifier harness. Closes the standing residual "the diff verifier proves evidence
authenticity, not task correctness, except where a node declares accept" — for any `runHarnessSlice`,
not just skills.
**Status:** Honest. Build + full suite green (313, +5).

## The gap

`verifier.ts`'s `test` type is deliberately **non-executing** (the demolition clause: don't trust a
command run inside the executor's own, possibly-doctored, worktree). So completion for a generic run
rested on the diff verifier — "a digest-bound diff exists" — which proves the executor changed
something, not that the change is *correct*. Only the skill path had executable acceptance
(`runAcceptanceCheck`, clean checkout); generic runs and the CLI did not.

## What shipped

- `src/harness/command-acceptance.ts` — `runCommandAcceptance({ worktreePath, acceptance })`. It does
  NOT run the command in the executor's worktree. It rebuilds a **clean checkout** from `git archive
  HEAD`, overlays **only** the run's changed files (re-derived itself via `git status -z` with
  `core.quotepath=false`, so unicode/space/quoted names can't diverge), then writes the
  **operator-declared `testFiles` over the top** — so the acceptance test comes from the spec, never
  the executor — and runs the command there with a hard timeout. The clean dir is always removed.
- `runHarnessSlice` gains an opt-in `acceptance: { command, testFiles? }`. When set, the run is
  `completed` only if a diff exists (verifier supported) AND acceptance passes; it emits an
  `acceptance.completed` event. Absent → behavior is unchanged, so every existing caller (workers,
  CLI, skill-compare) is unaffected.

## The property this buys

"A diff exists" is no longer sufficient. A run that changes a file but does not satisfy the task now
ends `blocked`, not `completed`. Proven end-to-end: the same fake executor writing a **correct** vs a
**wrong** `add` both produce a real diff (verifier `supported`), but only the correct one reaches
`completed` — the wrong one is `blocked` by acceptance.

## Anti-doctoring (the honesty core)

Because the operator's `testFiles` are overlaid LAST onto a clean checkout, an executor that writes
its own always-passing `accept.mjs` cannot win — the spec test replaces it. Tested. The clean base
(`git archive HEAD`) also excludes the executor's untracked process state; only the verified diff is
carried in.

## Verification

`node --test` 313/313 (+5): correct change passes; a wrong change with a real diff FAILS acceptance
(the M7 property); the operator test overrides an executor-doctored test; a deleted file is absent
from the clean checkout; and the end-to-end `runHarnessSlice` gate flips `completed` → `blocked` on
the wrong implementation.

## Independent review

Critic (separate lane): **REVISE → two PoC-proven CRITICAL forge/escape bugs fixed before commit.**
- **C1 (Critical): symlink escape.** A HEAD-committed symlink was carried in by `git archive`, and the
  overlay's `copyFileSync`/`writeFileSync` would follow it to write OUTSIDE the clean dir (arbitrary
  write) and defeat operator-test-wins. Fixed: symlinks are stripped after extraction, and every
  write is realpath-confined — a path with any symlinked ancestor is refused. Regression-tested.
- **C2 (Critical): git quotepath divergence.** `git status --porcelain` octal-escapes non-ASCII
  names, so the overlay missed the real file and silently dropped it (a one-byte forge). Fixed: the
  changed set is now re-derived inside the module with `git status -z` + `core.quotepath=false`,
  decoupled from the evidence parser. Regression-tested with a unicode filename.
- **MAJOR fixed:** a hard `timeout` + `SIGKILL` (a hung acceptance command no longer wedges the
  slice); `finally`-style clean-dir removal (no temp leak); exec-bit/mode preserved via `chmodSync`.

## Honest residue

- Still opt-in: nothing forces an acceptance contract, so a run with no `acceptance` declared keeps
  the weaker diff-only gate. Making acceptance mandatory per target type is a policy decision.
- `changedFilesFromStatus` (harness-run.ts, the evidence parser feeding `changed_files`/`file_hashes`)
  has the same pre-existing quotepath weakness; the acceptance path no longer depends on it (it
  derives its own set), but the evidence parser itself is a separate fix, noted not done.
- DAG `node.accept` still uses artifact-sha acceptance; wiring command-acceptance into DAG nodes is a
  mechanical follow-up (the reusable function is now available).

# M23 — Warden self-critic closed loop (Warden improves Warden, in a worktree)

**Date:** 2026-06-20
**Branch:** `selfcritic-loop` (isolated git worktree off `direction/ai-native-orchestrator` @ 4c05978)
**Status:** Honest. A real security bug in Warden was found, fixed, and acceptance-gated **by Warden
driving a real `claude` executor** — then independently revert-checked. Suite 396/396 (+1).

## What ran (the loop, all through the product's own commands)

1. **Self-critic** — `warden harness run "<critique goal>" --executor claude`
   (run `harness-495185c1…`, state `completed`, verifier `supported`). claude reviewed the codebase
   and wrote a single bounded finding.
2. **Closed-loop improve** — `warden harness run "<fix goal>" --executor claude --acceptance-file accept.json`
   (run `harness-9c5fe23d…`, state `completed`). claude applied the fix + a regression test; **Warden's
   own command-acceptance gate** rebuilt a clean checkout of the run's diff and ran `npm test`
   (build + full suite) over it → emitted `acceptance.completed`: *"acceptance command passed over a
   clean checkout of the run diff."* A wrong change could not have reached `completed`.
3. **Independent revert-check** (this orchestrator, not the executor): reverting only the fix makes the
   new test **FAIL** (buggy verifier returns `supported`); restoring it makes it **PASS** — proving the
   regression test genuinely binds the bug, not a doctored always-pass.

## The bug Warden found in Warden (real, reachable)

`src/harness/verifier.ts` — the `diff` verifier's `forbiddenChangedPaths` gate (the check that blocks a
run for touching a protected path like `.github/workflows/*` or the review-custody store) parsed the
digest-bound `git status --porcelain` with `line.slice(3)`. For a **rename** line —
`R  scratch.txt -> .github/workflows/ci.yml` — that yields the whole
`scratch.txt -> .github/workflows/ci.yml` string, which never equals the forbidden path. So an
adversarial executor could **rename a file into (or out of) a protected path and the verifier returned
`supported`** — a one-line move fully under the executor's control silently bypassed the gate.

It was the **lone holdout**: every other porcelain consumer in the repo already normalizes the rename
arrow (`harness-run.ts` `changedFilesFromStatus`, `apply.ts`, `lifecycle.ts`, `command-acceptance.ts`).

## The fix (~4 lines, no signature change)

```ts
const changed = statusText
  .split('\n')
  .filter(Boolean)
  .flatMap((line) => {
    const path = line.slice(3);
    return path.includes(' -> ') ? path.split(' -> ') : [path];
  });
```

Both sides of a rename/copy are now emitted, so a rename into **or** away from a forbidden path is
caught. Regression test `G012` in `verifier.test.ts` pins it.

## Why this is a meaningful dogfood

The four BRND/harness substrate primitives all ran on Warden itself: **delegate** to a real rented loop
(claude) → **log to the hash-chained ledger** (event_count 8) → **verify** (diff verifier + a real
clean-checkout build/test acceptance gate) → **gate** state on the verifier, not the executor's word.
The executor never self-certified; completion was owned by Warden's recomputable gate, and the human
orchestrator added an independent revert-check on top.

## Honest residue

- The acceptance clean-checkout needs `node_modules`; since deps are gitignored, the acceptance command
  symlinks the real `node_modules` into the clean checkout before `npm test`. Fine locally; a hermetic
  CI run would `npm ci` instead.
- One iteration was sufficient (claude's first attempt passed the gate); the loop's retry-on-`blocked`
  path was therefore not exercised this run.
- Scope was deliberately bounded to one small, verifiable fix — the critic was asked for exactly that.

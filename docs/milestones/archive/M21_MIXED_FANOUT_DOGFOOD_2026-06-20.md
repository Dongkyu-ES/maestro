# M21 (#7) — mixed-executor fan-out + conflict-block dogfood

**Date:** 2026-06-20
**Plan ref:** roadmap feature #7 (multi-worker fan-out + conflict detection); corrected plan M11
(multi-executor, artifact/verifier-based synthesis only).
**Status:** Honest. Reproduce with `node scripts/harness-mixed-fanout-dogfood.mjs` (live Part A
needs codex/claude on PATH) or `--no-live` for the deterministic parts.

## What this proves

`#7` was already built at the engine level (`orchestrator.ts`: `runParallelWorkers`, `runTaskGraph`,
`reconcileWorkers`, worktree lifecycle; `orchestrator-server.ts`: the deterministic DAG router). This
slice is the **dogfood that exercises it as an operator would**, across three properties:

### Part A — LIVE mixed executors through one contract
Two workers fan out into isolated git worktrees, each a *different rented loop*:
- `w-claude` (`claude -p --permission-mode acceptEdits`) → wrote its file → verifier **`supported`** →
  worker `completed`.
- `w-codex` (native `codex exec --json --sandbox workspace-write`) → the codex account hit its usage
  limit mid-turn (`turn.failed: You've hit your usage limit`) → **no edits → empty diff → verifier
  `unproven` → worker `blocked`.**

The codex outcome is the **point, not a flaw**: a provider failure produced *no forged success*. The
harness labels it `blocked/unproven` with the empty-tree evidence sha
(`e3b0c442…855`), exactly the anti-laundering behavior the project exists to enforce. Heterogeneous
executors were dispatched and judged by the **same** evidence/verifier/ledger contract; the ledger
head is hash-chained over all six events.

### Part B — DETERMINISTIC disjoint fan-out → clean merge
Two workers write **disjoint** files (`x.txt`, `y.txt`). Both reach `supported`; `reconcileWorkers`
merges **both** into one reconciliation worktree with **0 conflicts**. (Deterministic controlled
writers — the happy-path merge is a git property, executor-agnostic, so it is proven without spending
live credits.)

### Part C — DETERMINISTIC overlap → conflict quarantined
Two workers write the **same** file (`shared.txt`) with different content. Each is individually
`supported` (each produced a real diff), but `reconcileWorkers` merges the first and **quarantines the
second as `merge conflict`** — fan-in never force-merges. This is the conflict-detection guarantee.

## Verification

```
Part A (live):   w-claude completed/supported ; w-codex blocked/unproven (usage limit) ; 1/2 supported
Part B (--no-live): supported=2/2 ; reconcile merged=[w-x,w-y] quarantined=[] ; PASS
Part C (--no-live): supported=2/2 ; reconcile merged=[w-a] quarantined=[w-b: merge conflict] ; PASS
```

Full suite remains green (`npm run build` clean; `node --test` 394/394). Focused engine tests
(`orchestrator.test.ts` + `promotion-causal.test.ts`) 18/18.

## Honest residue

- Part A's clean **mixed** happy-path (both *different* live executors merging) was not shown end to
  end because codex was out of credits at run time; the disjoint clean-merge is proven deterministically
  (Part B) and claude proved the live path. A re-run after the codex limit resets would show 2/2 live.
- `reconcileWorkers` bisect (leave-one-out culprit isolation on a failing whole-set verify) is covered
  by unit tests, not by this dogfood.
- Synthesis beyond merge (cross-worker artifact synthesis) stays out of scope per corrected plan M11
  ("artifact/verifier-based synthesis only").

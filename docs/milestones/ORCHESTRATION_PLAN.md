# Orchestration plan (M11) — evidence-reconciled parallel workers

**Goal:** raise DH's weakest spine axis (Orchestration = 3) by adding real parallel
multi-worker execution **under the evidence contract**, without betraying the thesis. The
5-scorers reach it differently — OMC via a tmux team runtime, ouroboros via a
dependency-stage parallel executor + coordinator + evidence verification, 내패턴 via an
asymmetric dual-model split. DH already has the asymmetric split (worker + isolated critic)
and a pluggable executor; what's missing is **parallel fan-out, isolation, a dependency DAG,
and verifier-reconciled merge**. This is M11 in `HARNESS_OS_CORRECTED_PLAN.md` ("multi-executor,
artifact/verifier-based synthesis only").

**Design invariant (what keeps it DH, not a clone):** workers return **evidence refs
(path + sha256), never raw output merged into one context**; every stage gate is a **verifier
verdict over the ledger**, never a self-report; conflicts that fail verification are
**quarantined, not silently merged**. This is the OMC ReadPath/WritePath + gajae-receipt +
ouroboros evidence-contract lesson applied to fan-out.

## Existing primitives to reuse (no rebuild)
- Pluggable executor: `runHarnessSlice({executor})` + `generic-cli-runner` (heterogeneous workers: codex/claude/agy).
- Per-run hash-chained ledger + `captureToolEvidence` (redacted diff/status) + `runVerifier` (digest-bound diff).
- Isolated critic + `computeRunMetrics` (`closed-loop.ts`, `metrics.ts`).
- Worktree isolation already exists at the agent layer (the Agent tool's `isolation: "worktree"`); mirror it for workers with `git worktree add`.

## Phases

### M11.1 — Worktree-isolated worker (foundation)
`runIsolatedWorker({root, workerId, goal, executor})`: create `git worktree add .agent/worktrees/<workerId>` on a scratch branch, run `runHarnessSlice` there, capture evidence, return a `WorkerResult` = `{workerId, branch, runDir, verifier, diffRef, diffSha256, state}` — **no raw output**. Auto-remove the worktree if unchanged. This makes parallel writers conflict-free by construction (the R-native-ownership concern: each worker owns its own tree).

### M11.2 — Parallel fan-out + barrier with ledger join
`runParallelWorkers(workers[], {concurrency})`: bounded-concurrency fan-out; a **parent ledger** records `orchestration.spawned` (per worker, with its run_id) and `orchestration.joined` (with each worker's `outputRef = agent://<workerId>+<diffSha256>` and verifier verdict). Parent never ingests raw worker transcripts — only refs + verdicts. A worker that throws resolves to a `failed` WorkerResult (never crashes the barrier — reuse the close-handler guards already added).

### M11.3 — Dependency DAG decomposition
A `TaskGraph = {nodes:[{id, goal, deps[]}]}`; the coordinator runs nodes whose deps are all `verifier:supported`, in parallel waves, blocking dependents on **verifier status, not "ran"**. Emits `orchestration.stage.advanced` per wave. Cycle/over-fan-out rejected at submit time.

### M11.4 — Conflict reconciliation via verifier (the hard part)
When parallel workers touch overlapping paths, the coordinator does **not** text-merge. It applies each verified worker diff into a fresh reconciliation worktree in dependency order; if applying a diff breaks the verifier (or a supplied verify-cmd), that worker's change is **quarantined** (`orchestration.conflict.quarantined`) and the rest proceed. Final result = the verifier-passing merged tree. Artifact/verifier-based synthesis — exactly M11's mandate.

### M11.5 — Spawn governance
Depth + count caps (default depth 2, fan-out ≤ 8) and a **spawn-justification receipt** (mirror gajae's "5+ spawn ⇒ justification"); over-budget spawns are denied and ledgered as `orchestration.spawn_denied`. Prevents recursive worker explosion.

### M11.6 — Heterogeneous diverse-worker panels (payoff)
Because the executor is pluggable, a wave can run the **same goal across codex/claude/agy** and reconcile by verifier + critic — a diverse-perspective panel (the workflow judge-panel pattern) whose disagreement is itself signal. Optional, but it's the orchestration capability the single-executor harnesses can't cheaply match.

## Metrics + tests
- Extend `computeRunMetrics`: `parallelWorkers`, `conflictsQuarantined`, `stagesAdvanced`, `spawnDenied`.
- Deterministic test (fake executors, no live calls): fan out 3 workers in 3 worktrees; one produces an unverifiable diff → assert it is quarantined, the other two merge, parent ledger has `orchestration.spawned`×3 + `orchestration.joined` with refs (not raw), and the final tree passes the verifier. Reuse the `fakeCodex`/`tmpRepo` pattern.
- A `scripts/harness-orchestration-demo.mjs` (like the compare/trap scripts) running a 3-node DAG over fake workers, writing a report to `reports/`.

## Honest ceiling
This lands Orchestration at a defensible **4**: real parallel multi-worker + DAG + verifier-
reconciled merge + spawn governance, with heterogeneous workers. It does **not** chase a 5 — an
OMC-style long-running tmux team runtime/UI is outside the evidence-layer remit. DH's
orchestration stays "evidence-reconciled fan-out," consistent with own-the-layer-not-the-loop.
Residual risk: M11.4 reconciliation is the most likely to slip (apply-order sensitivity);
keep it conservative (quarantine on any verifier regression) rather than clever-merge.

## Verification (how to run)
1. `npm run build && npm test` — new orchestration tests pass alongside the 221.
2. `npm run harness:orchestration-demo` — prints the DAG fan-out/quarantine/merge table; deterministic, no live calls.
3. Optional live: a 3-way heterogeneous wave (codex/claude/agy) on one goal via `runParallelWorkers`, reconciled by verifier — confirms the pluggable seam carries into orchestration.

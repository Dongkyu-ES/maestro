# M12 P9 — research-brief live dogfood (real codex + claude)

**Date:** 2026-06-18
**Spec:** `fixtures/skills/research-brief.json` (research→execute→review)
**Executors:** research=codex, execute=codex, review=claude (heterogeneous, real CLIs:
codex-cli 0.140.0, claude 2.1.181)
**What:** "how the Warden skill acceptance gate keeps completion recomputable from the ledger"
**Status:** Honest live evidence. Raw run logs under `reports/skill-dogfood/` (gitignored).

This is the second orchestrator-skill proven against REAL executors (feature-builder
was the first, M12 P6). fake-executor unit tests prove wiring; a live run proves a real
heterogeneous chain clears the M7 gate.

---

## Run 1 — honest failure that fakes could never surface

`completion = skipped`. The real codex research phase did real work (the worker's own
`diff` verifier was `supported`) but wrote its notes to
`_workspace/warden-skill-acceptance-gate-raw-notes.md` instead of the contracted
`acceptArtifact: notes.md`. `storePhaseArtifact` could not read `notes.md` at the
contracted path → research node `blocked` → execute/review `skipped` →
`completion: skipped`, and `recomputeCompletionFromLedger` agreed ("no execute evidence
in store").

**The harness behaved correctly:** the contracted artifact was absent, so it failed
closed — it did NOT launder a real-but-misplaced output into success. The anti-laundering
thesis held under a real run. The finding is a real *spec brittleness*: a fixed
`acceptArtifact` filename is fragile to an autonomous executor's own path/filename choices.

**Fix:** both fixture specs (`research-brief.json`, `feature-builder.json`) now pin the
exact output path in each phase's `goalTemplate` ("write the single file ./X at the root
of your working directory — exactly that path, not a subdirectory and not a different
filename").

## Run 4 — green after the fix

```
research (codex)  → supported
execute  (codex)  → supported
review   (claude) → supported
acceptance: ran=true, passed=true, exit 0  (validate-brief.mjs re-run over the real
            brief.json materialized into a fresh temp checkout)
completion: passed
AUTHORITATIVE (ledger recompute, report field is display-only): completion=passed
```

The real codex execute phase produced a genuinely well-sourced `brief.json` — 10 findings,
each carrying a `source_event_id` pointing at real `file:line` refs in this repo (e.g.
`src/harness/orchestrator-skill.ts:312-349` for the "skill.completed never consulted as
completion authority" claim). The schema-validation gate (`validate-brief.mjs`, #3) passed
on real content, not a fake; an unsourced brief would still fail (#8 fixture proves it).

The P8 lifecycle ledger was emitted as designed — refs-only projection, no decision field:

```
1 skill.started   | payload: [skillId]
2 phase.advanced  | payload: [nodeState, outputRef, phase, skippedReason]
3 phase.advanced  | payload: [nodeState, outputRef, phase, skippedReason]
4 phase.advanced  | payload: [nodeState, outputRef, phase, skippedReason]
5 skill.completed | payload: [finalNodeId, ledgerHeadBeforeEvent, verifierVerdictRef]
```

---

## Known issue surfaced (follow-up, not closed here)

`runOrchestratorSkill` → `runIsolatedWorker` uses **fixed** worktree dirs / branch names
(`.agent/worktrees/<phase>`, `wt/<phase>`), so back-to-back skill re-runs collide
("branch/dir already exists") and need manual cleanup between runs. The run-token
namespacing that commit `5dac804` applied to the DAG (`runParallelWorkers`) path was NOT
applied to the orchestrator-skill path. Track as a re-run-isolation fix.

## Honest takeaways

1. The harness is honest under real executors: it fails closed on a missing contracted
   artifact rather than crediting misplaced real work.
2. The schema-validation acceptance (#3) and recomputable ledger completion (#6/#8) work
   end-to-end with real codex+claude, not just fakes.
3. Autonomous-executor output-path drift is a real ergonomic risk; pinning paths in the
   goalTemplate is the current mitigation. Skill re-run worktree isolation is an open bug.

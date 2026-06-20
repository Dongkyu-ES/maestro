# Warden Magic slice 7 — DESIGN: instruction-kind injection + skill-run injection wiring

**Date:** 2026-06-19 · **Status:** design for critic-panel review (NOT a completion claim).
**Thesis (unchanged):** completion is declared ONLY by `recomputeCompletionFromLedger` over clean-checkout acceptance; injection shapes what the executor *can do / is told*, NEVER whether it passed.

These are the two HIGH-RISK deferred items, taken together because they share machinery. Both were flagged hardest by the prior panels (instruction = teaching-to-the-test channel, claude slice-2 B4; skill wiring = the M12 hot path).

## Item A — instruction-kind injection (CLAUDE.md / soul / AGENTS.md)

Slices 2-6 inject only `kind:'mcp'` (capability). Item A adds `kind:'agents_md'|'soul'` (instruction content) to `inject.ts`.

- **Approval-gated (binding).** Instruction kinds are OFF by default and require an explicit `approveInstructions` flag — they are a teaching-to-the-test channel (an injected "to finish, create ACCEPTANCE_PASSED" or "stub the test" shapes *how* the executor satisfies the bar). Capability (MCP) stays the only kind injected without instruction approval.
- **Tamper-evident, same as MCP.** Each instruction file is written into the worktree and recorded in the `InjectionManifest` with its on-disk sha; a pre-existing `CLAUDE.md`/`AGENTS.md` is backed up (hashed) before a MERGE-append (injected content appended after a `<!-- warden-injected -->` marker), recording base+injected hashes separately.
- **HONEST BOUNDARY (binding, the load-bearing claim):** instruction injection CANNOT advance completion, because completion stays `recomputeCompletionFromLedger` over **operator-pinned acceptance `testFiles`** (slice-2: testFiles overlaid last, executor can't edit them). An injected instruction cannot pass a test it cannot edit. The residual — operator injects a malicious instruction AND writes a weak acceptance contract (greps a string / checks file-exists) — is operator responsibility, identical to the catalog-trust / secret-heuristic framing: Warden guards the gate (recomputable acceptance over pinned tests), not the operator against themselves.
- **Forgery fixture (mandatory):** inject an instruction telling the executor to fake completion (write a sentinel / stub the test); a run with a pinned `test` acceptance MUST still recompute to `failed`.

## Item B — orchestrator-skill run injection wiring

Wire Magic into the real `research→execute→review` run (`runOrchestratorSkill`), opt-in.

- **Opt-in `inject?` on `OrchestratorSkillSpec`** (default unset = byte-identical to today's skill runs — the M12 hot path is unchanged unless the operator asks). When set, the EXECUTE phase injects the resolved capability (and, if approved, instruction) modules into the execute worktree via the slice-4 `beforeExecute` hook, and emits `composition.injected` into the skill run ledger (`skillRunDir`).
- **`recomputeCompletionFromLedger` UNCHANGED (binding).** Injection events are evidence appended to the ledger; they are NEVER read by the completion recompute (which re-runs acceptance over the promoted execute evidence). Injection cannot move the verdict.
- **Scope:** wire the single-executor execute path first; fan-out / refinement injection deferred (avoid N× surface). Review/research phases are not injected in this slice.
- **Forgery fixture (mandatory):** a skill run with injection enabled whose injected instruction tries to fake completion still recomputes `failed`; and the `composition.injected` event is recomputable (not self-reported).

## Guards (binding; the panel lenses)

1. Completion robustness rests on pinned-acceptance — already true; Item A/B add a forgery fixture proving an injected instruction can't pass a pinned test.
2. Instruction injection is approval-gated and tamper-evidently recorded; capability (MCP) unchanged.
3. `recomputeCompletionFromLedger` takes NO injection input — structurally (no import / no read of composition.injected in the completion path).
4. R-native-ownership ceiling unchanged and documented: integrity+replay of what Warden wrote; consumption non-adversarial; injection never gates.

## Files

- Modify: `src/composition/inject.ts` (instruction kinds + approveInstructions in apply/verify/manifest), `src/composition/magic-run.ts` + `src/composition/inject-ledger.ts` (carry instruction modules), `src/harness/orchestrator-skill.ts` (opt-in `inject?` on the execute phase + `composition.injected` emit), `src/cli.ts` (`--approve-instructions`; skill spec inject field).
- Reuse: `beforeExecute` hook (orchestrator.ts), `applyCompositionToWorktree`/`verifyInjection` (inject.ts), `recordInjectionEvent` (inject-ledger.ts), pinned-acceptance recompute (orchestrator-skill.ts).

## Verification

Build + full suite green (368/369 baseline). Forgery fixtures: (a) injected "fake completion" instruction → pinned-test acceptance still `failed`; (b) skill run with injection → `recomputeCompletionFromLedger` unchanged + injection ledgered + recomputable; (c) instruction kinds gated off without `approveInstructions`; (d) default skill run (no inject) byte-identical. Then code critic panel.

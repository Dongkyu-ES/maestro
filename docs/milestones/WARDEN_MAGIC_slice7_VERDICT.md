# Warden Magic slice 7 — verification verdict + follow-up closure

**Date:** 2026-06-19 · **Commits under review:** `5c2006b` (Item A: instruction kinds, gated to
pinned-test) + `6343727` (Item B: opt-in MCP injection into the skill execute phase) + `7b81a8e`
(impl-panel follow-up).

## Panel result (live, 3 adversarial reviewers in isolated worktrees)

`docs/milestones/WARDEN_MAGIC_slice7_impl_panel.mjs`, elapsed 335.6s, supported 3/3.

| reviewer | lens | verdict |
| --- | --- | --- |
| verify-codex | mechanism conformance | SHIP-WITH-FOLLOWUP |
| verify-claude | anti-self-deception / laundering | SHIP-WITH-FOLLOWUP |
| verify-agy | scope & tests | BLOCK |

The completion-laundering question — the one the thesis lives or dies on — came back clean from all
three: `recomputeCompletionFromLedger` takes NO injection input, re-runs pinned acceptance over
promoted execute evidence with operator `testFiles` overlaid last, and the forgery fixture ("create
ACCEPTANCE_PASSED, do not fix") still recomputes `failed`. Injection shapes what the executor can
do/is told, never whether it passed. That holds.

## Adjudication of the lone BLOCK

agy's BLOCK rested on one [BLOCKER] plus four scope/test MAJORs. Traced against real source:

- **[BLOCKER] `recomputeInjectionFromLedger` omits instruction inputs → false contradiction.**
  REAL but UNREACHABLE on any shipped path: the only callers (`cli.ts:792/800/860`,
  `magic-run.ts:73/87`) inject `mcpModules` only — instruction modules never flow into the magic-CLI
  recompute. The one path that DOES inject instructions (skill execute) is verdict-gated by
  `recomputeCompletionFromLedger`, not the injection recompute. So it is a latent landmine for the
  next slice (wiring instructions into the magic CLI), not a slice-7 ship blocker. **Fixed anyway**
  (cheap, correct): forwarded the instruction inputs through `recomputeInjectionFromLedger`, recorded
  `instruction_files` (with the `merged` flag) in the `composition.injected` payload, and made the
  comparison merge-aware (merge files are base-dependent → excluded from pure replay, mirroring
  `manifestReproducible`). Regression pinned by two new `inject-ledger.test.ts` cases.
- **[MAJOR] "no tests for `loadModuleCatalog` instruction parsing" — FALSE POSITIVE (seed artifact).**
  The test exists (`magic.test.ts:203`, "a declared instruction descriptor survives the allowlist
  loader"). The panel seed copies only `inject.test.ts` + `orchestrator-skill.test.ts`, so agy could
  not see it. No action.
- **[MAJOR] worktree cleanup defeats post-hoc disk re-check — MISREAD.** `verifyInjection` runs
  IN-RUN (after the executor, before `cleanupSkillWorktrees`) and is recorded as tamper-evident
  evidence (`integrityOk`), never as a completion gate (R-native-ownership: injection never
  advances/blocks the verdict). There is no post-hoc on-disk re-check by design. Sharpened the
  inject.ts header comment to forestall the misread; no behavior change.

## Real, actionable findings — FIXED this commit

1. **Instruction `targetPath` containment** (claude MAJOR): `targetPath` is operator-catalog data,
   not adapter-fixed like `mcpConfigPath`. A `../escape`/absolute path wrote OUTSIDE the
   executor-owned worktree. Now `resolve`d and rejected unless it stays under the worktree root.
   (`inject.ts` `injectInstructions`; test: "Item A containment".)
2. **Duplicate `targetPath` collision** (agy MAJOR): two instruction modules targeting the same file
   recorded two `InjectedFile` entries with divergent hashes → `verifyInjection` reported a false
   `mutated` absent any tampering. Now the second collision is refused. (test: "Item A collision".)
3. **Latent recompute gap** (agy BLOCKER), as above.

Build clean; suite 385/385 (was 381 → +4 new regression tests).

## Deferred follow-ups (tracked, not blocking)

- **`acceptanceIsPinnedTest` is `Boolean(testFiles?.length)`** (claude MAJOR): proves "≥1 testFile
  declared," not "the command actually grades those files." claude's own analysis: such a spec
  auto-passes regardless of injection (the executor already owns its grader), so injection is not the
  laundering lever — but the comment's "executor-uneditable test" overstates what is enforced.
  Follow-up: assert a `testFiles` path is referenced by `acceptance.command`, or soften the comment.
- **Instruction `content` not secret-scanned** (claude MINOR): MCP modules pass `serverRequiresApproval`;
  instruction content has no equivalent gate. Bounded by `approveInstructions` + operator-authored
  catalog (same trust frame as catalog-trust / secret-heuristic residuals), but the asymmetry
  warrants a guard or a documented carve-out.

## Verdict

**SHIP-WITH-FOLLOWUP.** 2/3 reviewers concur; the dissenting BLOCK was a real-but-unreachable latent
gap (now closed defensively) plus a seed-artifact false positive and a misread. The load-bearing
thesis claim — injection cannot move the completion verdict — is verified by all three lenses and the
forgery fixtures. The two deferred items are operator-trust-bounded and do not touch the gate.

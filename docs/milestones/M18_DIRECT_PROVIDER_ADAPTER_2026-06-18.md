# M18 (Stage D) — direct-provider executor adapter, behind the same evidence contract

**Date:** 2026-06-18
**Plan ref:** roadmap Phase B (M6 direct LLM executor) — explicitly OPTIONAL and *not* the canonical
proof path; the native-executor-over-evidence contract remains canonical.
**Status:** Honest. Build + full suite green (306, +4). The conformance proof runs on a fake
transport; the real Anthropic transport is wired but not exercised in CI (needs a key).

## What this is — and what it deliberately is not

A `HarnessExecutor` turns a prompt into file changes in `cwd`; the slice reads the git diff as
evidence. The direct-provider executor satisfies that contract as a **product-owned single turn**:
the product sends the prompt to a provider, parses the file edits the model declares
(`<<<FILE path … >>>FILE`), and applies them itself.

It is **single-turn by design** — it does not rebuild a multi-tool agent loop. That restraint is the
point: the thesis is "own the layer over a rented loop, *don't rebuild the loop*." A direct executor
can do bounded "write this content" work and prove the contract; it is not a general coding agent.

## The honest labeling consequence

Native CLI executors (codex/claude/agy) run inside a rented loop that owns file/shell authority, so
their runs are `native-harness-assisted`. A direct-provider run is the opposite: **the product owns
the apply loop**, so it is honestly labeled `native-harness-assisted = false`. This falls out of the
existing detector — `adapterForLabel('…-direct') → 'direct_provider'`, which is deliberately NOT in
`NATIVE_SESSION_ADAPTERS`, so `deriveNativeHarnessAssisted` returns false (and the
`assertLabelMatchesObservation` check agrees, since both read the same detector).

## What shipped

- `src/harness/direct-provider.ts`: `DirectProviderTransport` (injectable — fake in tests, real
  provider HTTP in prod), `parseFileDirectives`, `makeDirectProviderExecutor` (never throws — a
  refusal or transport error yields a non-zero result with no edits → no diff → verifier `unproven`),
  and `anthropicDirectTransport` (fetch-based, behind `ANTHROPIC_API_KEY`).
- `adapterForLabel` / `eventSourceForLabel` map `*-direct` labels to the non-native
  `direct_provider` adapter / `direct-adapter` source; `RuntimeEventSource` gained `direct-adapter`.
- `warden harness run --executor anthropic-direct [--model M]` makes it a real shipped option.

## Phase-B exit proof (the reason this exists)

`src/harness/direct-provider.test.ts`:
- a direct run that declares an edit produces a real git diff that **the SAME `runHarnessSlice`
  verifier supports** → `state: completed`, and the run is labeled `nativeHarnessAssisted: false`;
- a **refusal** yields no edits → no diff → the verifier does not report a forged success;
- directives with traversal/absolute paths are skipped — nothing is written outside `cwd`;
- `parseFileDirectives` extracts FILE blocks and ignores surrounding prose.

So the same acceptance contract judges a direct provider exactly as it judges a native CLI — the
Phase B exit condition — without rebuilding an agent loop.

## Independent review

Critic (separate lane): **REVISE → one Critical (C1) fixed before commit.**
- **C1 (Critical): the non-native label was not authoritative.** `deriveNativeHarnessAssisted` reads
  the whole observation, so a `CLAUDE.md`/`AGENTS.md` in the repo (or native words in the model's
  prose) would have flipped a product-owned direct run to `assisted = true` — and the first tests
  passed only because the temp repo was clean. Fix: `buildRunObservation` is now executor-aware — a
  direct run (which provably loads no instruction files and whose transcript is mere model output)
  omits `existingInstructionPaths` and the transcript from its observation, so
  `native-harness-assisted = false` holds regardless of repo contents. Regression-tested with
  `CLAUDE.md`/`AGENTS.md` present.
- **M1 (evidence-forgery boundary):** `applyDirectives` now denies any edit whose top segment is
  `.git` (a planted hook) or `.agent` (the evidence/ledger store — a model writing there would forge
  the verifier's own inputs). Tested.
- **m2 (blast radius):** a single turn applies at most 200 directives.
- **m1 (delimiter collision):** a content line equal to `>>>FILE` truncates the block; documented in
  the edit instructions rather than adding a nonce protocol.

## Honest residue

- The real `anthropicDirectTransport` is not exercised in CI (no key); only the contract is proven.
  A live smoke needs `ANTHROPIC_API_KEY`.
- Single-turn only: no iterative tool use, so it cannot do work that needs reading the repo first.
- The binding-revision split `ExecutorResult → ExecutorTurn/ExecutorRun` with a first-class `refused`
  status, and byte-recorded per-provider conformance fixtures, are deferred — refusal is currently
  represented as a non-zero `CodexExecResult` with no edits.

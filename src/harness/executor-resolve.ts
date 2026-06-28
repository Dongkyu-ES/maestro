import { makeCliExecutor } from './compare.js';
import type { HarnessExecutor } from './harness-run.js';
import { defaultExecutorRegistry } from './orchestrator-server.js';

// Honest support tiers for a resolved executor:
// - native-codex: the built-in codex path (full lifecycle proof lives in the runtime adapter).
// - builtin-cli: a shipped headless CLI (claude/agy) — runs + acceptance-graded, no lifecycle proof.
// - byo-cli: any other headless CLI the operator brings via --executor / --executor-bin.
//   Same completion authority as builtin-cli (acceptance is re-run over the diff; the executor
//   is never trusted), just without a shipped, maintained adapter.
export type ExecutorTier = 'native-codex' | 'builtin-cli' | 'byo-cli';

export interface ResolvedHarnessExecutor {
  label: string;
  // undefined === native codex default inside runHarnessSlice (kept for back-compat).
  executor: HarnessExecutor | undefined;
  tier: ExecutorTier;
}

// Resolve `--executor <kind> [--executor-bin <path>]` for `harness run`.
//
// Built-ins (codex/claude/agy) resolve through the deterministic registry. ANY other name is
// treated as a bring-your-own headless CLI invoked as `<bin> -p "<prompt>"` (the same convention
// claude/agy use), with `bin = executorBin ?? kind`. This does NOT weaken the evidence contract:
// completion is still graded by re-running acceptance over the produced diff, so an arbitrary
// executor is never trusted — it just lacks codex's deeper lifecycle proof, which is stated, not hidden.
//
// `detect` answers "does this binary exist?" and is injected so the decision is unit-testable
// without touching PATH or the filesystem.
export function resolveHarnessExecutor(
  kind: string,
  executorBin: string | undefined,
  detect: (bin: string) => boolean,
): ResolvedHarnessExecutor {
  const registry = defaultExecutorRegistry();
  if (registry.has(kind)) {
    return {
      label: kind,
      executor: registry.resolve(kind),
      tier: kind === 'codex' ? 'native-codex' : 'builtin-cli',
    };
  }
  const bin = executorBin ?? kind;
  if (!detect(bin)) {
    throw new Error(
      `unknown executor '${kind}' and binary '${bin}' not found. ` +
        `Built-ins: codex|claude|agy|anthropic-direct. For any other headless CLI, pass ` +
        `--executor-bin <path> (it is invoked as '<bin> -p "<prompt>"').`,
    );
  }
  return {
    label: kind,
    executor: makeCliExecutor({ name: kind, bin, buildArgs: (prompt) => ['-p', prompt] }),
    tier: 'byo-cli',
  };
}

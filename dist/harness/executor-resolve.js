import { makeCliExecutor } from './compare.js';
import { defaultExecutorRegistry } from './orchestrator-server.js';
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
export function resolveHarnessExecutor(kind, executorBin, detect) {
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
        throw new Error(`unknown executor '${kind}' and binary '${bin}' not found. ` +
            `Built-ins: codex|claude|agy|anthropic-direct. For any other headless CLI, pass ` +
            `--executor-bin <path> (it is invoked as '<bin> -p "<prompt>"').`);
    }
    return {
        label: kind,
        executor: makeCliExecutor({ name: kind, bin, buildArgs: (prompt) => ['-p', prompt] }),
        tier: 'byo-cli',
    };
}

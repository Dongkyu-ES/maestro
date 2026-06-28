import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { removeWorktreeAndBranch, runIsolatedWorker } from '../harness/orchestrator.js';
import { recomputeInjectionFromLedger, recordInjectionEvent } from './inject-ledger.js';
import { applyCompositionToWorktree, verifyInjection, } from './inject.js';
import { canaryConfigForWorktree, canaryModule, withCanaryProbe } from './smoke-probe.js';
export function magicRunDir(root, magicRunId) {
    return join(root, '.agent', 'magic-runs', magicRunId);
}
export async function runMagicInjectionRun(opts) {
    const runDir = magicRunDir(opts.root, opts.magicRunId);
    mkdirSync(runDir, { recursive: true });
    // The hook fires after evidence materialization and before the executor — so the executor runs
    // in a worktree that ALREADY contains the injected `.mcp.json`. Captured for post-run evidence.
    let manifest;
    // In --prove mode the canary config (with an ABSOLUTE worktree sentinel) is only knowable once the
    // worktree exists, so it is built inside beforeExecute and reused for the post-run probe.
    let proveCfg;
    try {
        const worker = await runIsolatedWorker({
            root: opts.root,
            workerId: opts.magicRunId,
            goal: opts.goal,
            executor: opts.executor,
            executorLabel: opts.executorLabel,
            beforeExecute: (worktreePath) => {
                let modules = opts.mcpModules;
                if (opts.prove) {
                    proveCfg = canaryConfigForWorktree(worktreePath, opts.prove.token);
                    modules = [...opts.mcpModules, canaryModule(proveCfg)];
                }
                manifest = applyCompositionToWorktree({
                    worktree: worktreePath,
                    mcpModules: modules,
                    adapter: opts.adapter,
                    approveSecrets: opts.approveSecrets,
                });
            },
        });
        if (!manifest)
            throw new Error('magic run: beforeExecute did not produce an injection manifest');
        // Post-exec integrity + (when proving) consumption via the canary's absolute sentinel.
        const verifyAdapter = proveCfg ? withCanaryProbe(opts.adapter, proveCfg) : opts.adapter;
        const verification = verifyInjection(worker.worktreePath, manifest, { adapter: verifyAdapter });
        recordInjectionEvent(runDir, opts.magicRunId, manifest);
        const ledgerCheck = recomputeInjectionFromLedger(runDir, {
            mcpModules: opts.mcpModules,
            adapter: opts.adapter,
            approveSecrets: opts.approveSecrets,
        });
        return {
            magicRunId: opts.magicRunId,
            manifest,
            verification,
            ledgerCheck,
            worker: { state: worker.state, verifierStatus: worker.verifierStatus, outputRef: worker.outputRef },
        };
    }
    finally {
        // Always clean up the run worktree — even on an early throw — so a failed run never leaks a
        // worktree/branch (evidence is content-addressed / ledgered already).
        try {
            removeWorktreeAndBranch(opts.root, opts.magicRunId, { force: true });
        }
        catch {
            // a leftover worktree must not fail the run or hide the verdict
        }
    }
}

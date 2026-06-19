import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessExecutor } from '../harness/harness-run.js';
import { removeWorktreeAndBranch, runIsolatedWorker } from '../harness/orchestrator.js';
import type { CatalogModule } from './catalog.js';
import { type InjectionLedgerCheck, recomputeInjectionFromLedger, recordInjectionEvent } from './inject-ledger.js';
import {
  type InjectionAdapter,
  type InjectionManifest,
  type InjectionVerification,
  applyCompositionToWorktree,
  verifyInjection,
} from './inject.js';
import { type CanaryConfig, canaryConfigForWorktree, canaryModule, withCanaryProbe } from './smoke-probe.js';

/**
 * Slice 4 — `warden magic run`: a standalone run that INJECTS the resolved capability into the
 * executor's worktree BEFORE the executor runs (via runIsolatedWorker's opt-in `beforeExecute`
 * hook), then records `composition.injected` into a persistent, hash-chained magic-run ledger. This
 * is the end-to-end payoff: the spawned executor actually runs with the injected `.mcp.json`.
 *
 * It does NOT modify any existing run caller (orchestrator-skill / fan-out are untouched); it is a
 * NEW caller of runIsolatedWorker. Honest scope is unchanged from slice 2/3: injection guarantees
 * integrity + replay of what Warden wrote; consumption is never asserted (no live smokeProbe).
 */
export interface MagicRunResult {
  magicRunId: string;
  manifest: InjectionManifest;
  verification: InjectionVerification;
  ledgerCheck: InjectionLedgerCheck;
  worker: { state: string; verifierStatus: string | null; outputRef: string | null };
}

export function magicRunDir(root: string, magicRunId: string): string {
  return join(root, '.agent', 'magic-runs', magicRunId);
}

export async function runMagicInjectionRun(opts: {
  root: string;
  goal: string;
  magicRunId: string;
  executor?: HarnessExecutor;
  executorLabel: string;
  mcpModules: CatalogModule[];
  adapter: InjectionAdapter;
  approveSecrets?: boolean;
  /** Slice 6: when set, also inject the consumption canary and prove consumption from its sentinel.
   *  The absolute sentinel path is resolved against the run worktree (cwd-independent). */
  prove?: { token: string };
}): Promise<MagicRunResult> {
  const runDir = magicRunDir(opts.root, opts.magicRunId);
  mkdirSync(runDir, { recursive: true });

  // The hook fires after evidence materialization and before the executor — so the executor runs
  // in a worktree that ALREADY contains the injected `.mcp.json`. Captured for post-run evidence.
  let manifest: InjectionManifest | undefined;
  // In --prove mode the canary config (with an ABSOLUTE worktree sentinel) is only knowable once the
  // worktree exists, so it is built inside beforeExecute and reused for the post-run probe.
  let proveCfg: CanaryConfig | undefined;
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
    if (!manifest) throw new Error('magic run: beforeExecute did not produce an injection manifest');

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
  } finally {
    // Always clean up the run worktree — even on an early throw — so a failed run never leaks a
    // worktree/branch (evidence is content-addressed / ledgered already).
    try {
      removeWorktreeAndBranch(opts.root, opts.magicRunId, { force: true });
    } catch {
      // a leftover worktree must not fail the run or hide the verdict
    }
  }
}

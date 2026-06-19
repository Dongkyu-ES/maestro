import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogModule } from './catalog.js';
import type { InjectionAdapter } from './inject.js';

/**
 * Slice 5 — the HONEST consumption proof (B2). `consumptionProven` was always false because proving
 * a CLI loaded the injected `.mcp.json` from prose would be self-deception. Instead: inject a canary
 * MCP server (`resources/warden-canary-mcp.mjs`) whose tool, WHEN CALLED, writes a sentinel file
 * with a token. A `smokeProbe` then proves consumption by the SENTINEL existing with that token — a
 * real side effect, never the model's word. No sentinel ⇒ unproven (the honest default).
 *
 * Deterministic here: the canary server + the probe are unit-tested directly. The live end (a real
 * claude run loading the canary and calling its tool) is a documented dogfood.
 */

export interface CanaryConfig {
  /** Token the canary writes and the probe checks — make it per-run-unique to avoid stale sentinels. */
  token: string;
  /** Worktree-relative sentinel path the canary writes and the probe reads. */
  sentinelRelPath: string;
}

/** Absolute path to the bundled canary MCP server script. */
export function canaryServerPath(): string {
  return fileURLToPath(new URL('../../resources/warden-canary-mcp.mjs', import.meta.url));
}

/**
 * A smokeProbe that proves consumption iff the canary wrote its sentinel with the expected token.
 * This is the only function permitted to assert consumption, and it does so from a real artifact.
 */
export function makeCanarySmokeProbe(cfg: CanaryConfig): (worktree: string) => boolean {
  return (worktree: string) => {
    const p = join(worktree, cfg.sentinelRelPath);
    if (!existsSync(p)) return false;
    try {
      return readFileSync(p, 'utf8') === cfg.token;
    } catch {
      return false;
    }
  };
}

/**
 * A catalog module that injects the canary MCP server. Token + sentinel are passed as argv so they
 * travel through the existing `{ server, command }` descriptor (no env-injection path needed). The
 * canary server reads them from argv/env; here we use argv-compatible env via the command wrapper.
 */
export function canaryModule(cfg: CanaryConfig): CatalogModule {
  return {
    id: 'warden-canary',
    kind: 'mcp',
    tags: [],
    origin: 'declared',
    description: 'Warden consumption canary (proves injected MCP config was loaded)',
    mcp: {
      server: 'warden-canary',
      // node -e wrapper sets the canary env then execs the server, so token/sentinel travel in argv.
      command: [
        'node',
        '-e',
        `process.env.WARDEN_CANARY_TOKEN=${JSON.stringify(cfg.token)};process.env.WARDEN_CANARY_SENTINEL=${JSON.stringify(cfg.sentinelRelPath)};import(${JSON.stringify(canaryServerPath())})`,
      ],
    },
  };
}

/** Wrap an adapter with the canary smokeProbe so verifyInjection can prove consumption from the sentinel. */
export function withCanaryProbe(adapter: InjectionAdapter, cfg: CanaryConfig): InjectionAdapter {
  return { ...adapter, smokeProbe: makeCanarySmokeProbe(cfg) };
}

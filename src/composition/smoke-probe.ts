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
 *
 * HONEST CEILING (R-native-ownership): the sentinel proves the canary tool was called by a
 * COOPERATIVE executor — confirming the injected MCP config genuinely loaded. It is NOT an
 * adversarial proof: an executor that owns the worktree could write the sentinel directly without
 * ever loading the MCP. So `consumptionProven` means "consumption confirmed for a non-adversarial
 * executor", not "the executor could not have faked it". Defeating a malicious executor would need
 * the canary to leave a trace only Warden (not the executor) can produce — out of scope here.
 */

export interface CanaryConfig {
  /**
   * Token the canary writes and the probe checks. MUST be per-run-unique (the CLI uses the
   * magicRunId) — this is the STRUCTURAL defense against a stale-sentinel replay: a leftover
   * sentinel from another run carries a different token and so does not prove consumption.
   */
  token: string;
  /**
   * ABSOLUTE sentinel path (slice 6 — cwd-independent). The canary server writes
   * `WARDEN_CANARY_SENTINEL` verbatim and the probe reads this exact path, so server and probe agree
   * regardless of the MCP host's cwd. Build it with `canaryConfigForWorktree(worktree, token)`.
   */
  sentinelPath: string;
}

/** Build a per-worktree canary config with an ABSOLUTE sentinel path (cwd-independent). */
export function canaryConfigForWorktree(worktree: string, token: string): CanaryConfig {
  return { token, sentinelPath: join(worktree, '.warden-canary') };
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
  // Uses the ABSOLUTE cfg.sentinelPath directly (cwd-independent); the worktree arg is ignored.
  return () => {
    if (!existsSync(cfg.sentinelPath)) return false;
    try {
      return readFileSync(cfg.sentinelPath, 'utf8') === cfg.token;
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
        `process.env.WARDEN_CANARY_TOKEN=${JSON.stringify(cfg.token)};process.env.WARDEN_CANARY_SENTINEL=${JSON.stringify(cfg.sentinelPath)};import(${JSON.stringify(canaryServerPath())})`,
      ],
    },
  };
}

/** Wrap an adapter with the canary smokeProbe so verifyInjection can prove consumption from the sentinel. */
export function withCanaryProbe(adapter: InjectionAdapter, cfg: CanaryConfig): InjectionAdapter {
  return { ...adapter, smokeProbe: makeCanarySmokeProbe(cfg) };
}

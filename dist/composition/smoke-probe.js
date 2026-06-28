import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Build a per-worktree canary config with an ABSOLUTE sentinel path (cwd-independent). */
export function canaryConfigForWorktree(worktree, token) {
    return { token, sentinelPath: join(worktree, '.warden-canary') };
}
/** Absolute path to the bundled canary MCP server script. */
export function canaryServerPath() {
    return fileURLToPath(new URL('../../resources/warden-canary-mcp.mjs', import.meta.url));
}
/**
 * A smokeProbe that proves consumption iff the canary wrote its sentinel with the expected token.
 * This is the only function permitted to assert consumption, and it does so from a real artifact.
 */
export function makeCanarySmokeProbe(cfg) {
    // Uses the ABSOLUTE cfg.sentinelPath directly (cwd-independent); the worktree arg is ignored.
    return () => {
        if (!existsSync(cfg.sentinelPath))
            return false;
        try {
            return readFileSync(cfg.sentinelPath, 'utf8') === cfg.token;
        }
        catch {
            return false;
        }
    };
}
/**
 * A catalog module that injects the canary MCP server. Token + sentinel are passed as argv so they
 * travel through the existing `{ server, command }` descriptor (no env-injection path needed). The
 * canary server reads them from argv/env; here we use argv-compatible env via the command wrapper.
 */
export function canaryModule(cfg) {
    return {
        id: 'warden-canary',
        kind: 'mcp',
        tags: [],
        origin: 'declared',
        description: 'maestro consumption canary (proves injected MCP config was loaded)',
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
export function withCanaryProbe(adapter, cfg) {
    return { ...adapter, smokeProbe: makeCanarySmokeProbe(cfg) };
}

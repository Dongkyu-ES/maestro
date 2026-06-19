import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogModule } from './catalog.js';

/**
 * Slice 2 — active injection of resolved CAPABILITY modules (MCP only) into a run worktree,
 * recorded as a tamper-evident, replayable manifest.
 *
 * HONEST SCOPE (the slice-2 code panel forced this narrowing; WARDEN_MAGIC_DESIGN.md §7
 * "slice-2 corrections"): Warden does NOT own the in-loop worktree — the native executor owns it
 * (CORRECTED_PLAN §10, R-native-ownership). So this module guarantees ONLY what it can enforce:
 *   - what INJECTION itself wrote is closed BY CONSTRUCTION — apply writes exactly the adapter's
 *     `mcpConfigPath` (+ a `.warden-bak` of any pre-existing config) and records every byte. There
 *     is no runtime "scan the whole worktree for AI surfaces" closure, because that is an
 *     unwinnable denylist over an executor-owned tree (nested CLAUDE.md/GEMINI.md/.cursorrules/…).
 *   - integrity of those written files is re-checkable from disk (catches post-exec tampering).
 *   - the manifest is reproducible from the ledgered inputs (replay).
 *   - consumption is NEVER asserted (B2): there is no `proven` status; `consumptionProven` is only
 *     flipped by a LIVE `smokeProbe` (interface present, live impl deferred). `applied-unproven`
 *     must never be read as "the CLI loaded it".
 *   - B6: secret-bearing servers are skipped unless explicitly approved.
 *   - B1: MCP is capability-only; injection never writes an acceptance bar.
 */

export type McpInjectionStatus = 'applied-unproven' | 'unsupported' | 'none';

/** A file written into the worktree, hashed from its on-disk bytes (not the intended buffer). */
export interface InjectedFile {
  path: string; // worktree-relative POSIX path
  sha256: string;
}

export interface InjectionManifest {
  schema_version: 1;
  executor: string;
  mcp_injection: McpInjectionStatus;
  /** Every file injection wrote, hashed from disk. The closed set of injection's own writes. */
  files: InjectedFile[];
  /** MCP servers skipped for carrying secret-like fields without approval (B6). */
  skipped_secret_servers: string[];
  /** Pre-existing files backed up before overwrite, hashed so the backup is itself tamper-evident. */
  backed_up: { path: string; backup: string; sha256: string }[];
  note: string;
}

export interface InjectionAdapter {
  label: string;
  /** Honest static capability (B2): does this executor load a project-local `.mcp.json` from cwd? */
  supportsLocalMcp: boolean;
  /** Worktree-relative path of the MCP config this adapter writes when supported. */
  mcpConfigPath: string;
  /**
   * LIVE consumption probe (B2). Returns true only if a real run of this executor demonstrably
   * loaded the injected config. Deferred — no adapter ships one yet, so consumption stays unproven.
   */
  smokeProbe?: (worktree: string) => boolean;
}

export const INJECTION_ADAPTERS: Record<string, InjectionAdapter> = {
  // Claude Code reads a project-scoped `.mcp.json` (the CLI still approval-gates loading it, so
  // `applied-unproven` never implies the servers ran — only a live smokeProbe could prove that).
  claude: { label: 'claude', supportsLocalMcp: true, mcpConfigPath: '.mcp.json' },
  // Codex reads ~/.codex/config.toml + `-c` overrides, NOT a cwd `.mcp.json` → unsupported (B2).
  codex: { label: 'codex', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
  agy: { label: 'agy', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
};

export function adapterFor(label: string): InjectionAdapter {
  return INJECTION_ADAPTERS[label] ?? { label, supportsLocalMcp: false, mcpConfigPath: '.mcp.json' };
}

// Secret detection (B6): keyword set + connection-string (user:pass@host) + known token prefixes.
const SECRET_KEY_RE =
  /(secret|token|password|passwd|passphrase|auth|jwt|bearer|session|credential|api[-_]?key|access[-_]?key|connection[-_]?string|db[-_]?uri|dsn|\bkey\b)/i;
const CONNSTRING_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/;
// Token prefixes allow hyphens/underscores so e.g. Anthropic `sk-ant-...` is caught (was bypassed).
const TOKEN_PREFIX_RE =
  /(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})/;

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function serverRequiresApproval(module: CatalogModule): boolean {
  const text = JSON.stringify(module.mcp ?? {});
  return SECRET_KEY_RE.test(text) || CONNSTRING_RE.test(text) || TOKEN_PREFIX_RE.test(text);
}

function buildMcpConfigJson(modules: CatalogModule[]): string {
  // Sort by server name so the serialized bytes (and the manifest hash) are order-independent (B3).
  const sorted = [...modules]
    .filter((m) => m.mcp)
    .sort((a, b) => (a.mcp as { server: string }).server.localeCompare((b.mcp as { server: string }).server));
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const m of sorted) {
    if (!m.mcp) continue;
    const cmd = m.mcp.command ?? [];
    mcpServers[m.mcp.server] = { command: cmd[0] ?? m.mcp.server, args: cmd.slice(1) };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

function partitionBySecret(
  mcpModules: CatalogModule[],
  approveSecrets: boolean,
): { safe: CatalogModule[]; skipped: string[] } {
  const safe: CatalogModule[] = [];
  const skipped: string[] = [];
  for (const m of mcpModules) {
    // A malformed module (mcp present but no server name) is not injectable — skip it rather than
    // crash the sort comparator / config builder downstream.
    if (!m.mcp?.server) continue;
    if (serverRequiresApproval(m) && !approveSecrets) skipped.push(m.mcp.server);
    else safe.push(m);
  }
  return { safe, skipped };
}

/**
 * Write the resolved MCP set into the worktree and return a manifest hashed from the ACTUAL on-disk
 * bytes. Writes exactly the adapter's `mcpConfigPath` (+ a hashed backup of any pre-existing config)
 * and nothing else — injection's own write surface is closed by construction. Status is honest:
 * unsupported executor ⇒ `unsupported`, no safe servers ⇒ `none`, else `applied-unproven`.
 */
export function applyCompositionToWorktree(opts: {
  worktree: string;
  mcpModules: CatalogModule[];
  adapter: InjectionAdapter;
  approveSecrets?: boolean;
}): InjectionManifest {
  const { worktree, adapter } = opts;
  if (!adapter.supportsLocalMcp) {
    return {
      schema_version: 1,
      executor: adapter.label,
      mcp_injection: 'unsupported',
      files: [],
      skipped_secret_servers: [],
      backed_up: [],
      note: `${adapter.label} does not load a project-local .mcp.json from cwd — nothing injected (B2: no false claim)`,
    };
  }
  const { safe, skipped } = partitionBySecret(opts.mcpModules, opts.approveSecrets ?? false);
  if (safe.length === 0) {
    return {
      schema_version: 1,
      executor: adapter.label,
      mcp_injection: 'none',
      files: [],
      skipped_secret_servers: skipped,
      backed_up: [],
      note: skipped.length ? 'all candidate MCP servers require approval (--approve-secrets)' : 'no MCP modules to inject',
    };
  }
  const target = join(worktree, adapter.mcpConfigPath);
  mkdirSync(dirname(target), { recursive: true });
  const backed_up: { path: string; backup: string; sha256: string }[] = [];
  if (existsSync(target)) {
    const existing = readFileSync(target);
    const existingSha = sha256Hex(existing);
    const backupRel = `${adapter.mcpConfigPath}.warden-bak.${existingSha.slice(0, 12)}`;
    copyFileSync(target, join(worktree, backupRel));
    backed_up.push({ path: adapter.mcpConfigPath, backup: backupRel, sha256: existingSha });
  }
  writeFileSync(target, buildMcpConfigJson(safe));
  const onDisk = readFileSync(target); // B3: hash what LANDED on disk, not the intended buffer.
  return {
    schema_version: 1,
    executor: adapter.label,
    mcp_injection: 'applied-unproven',
    files: [{ path: adapter.mcpConfigPath, sha256: sha256Hex(onDisk) }],
    skipped_secret_servers: skipped,
    backed_up,
    note: 'applied; consumption NOT proven (no live smokeProbe) — treat applied-unproven as NOT-yet-consumed',
  };
}

/** Pure replay (B3): re-derive the intended injected files from ledgered inputs. */
export function recomputeInjectionFiles(opts: {
  mcpModules: CatalogModule[];
  adapter: InjectionAdapter;
  approveSecrets?: boolean;
}): InjectedFile[] {
  if (!opts.adapter.supportsLocalMcp) return [];
  const { safe } = partitionBySecret(opts.mcpModules, opts.approveSecrets ?? false);
  if (safe.length === 0) return [];
  return [{ path: opts.adapter.mcpConfigPath, sha256: sha256Hex(Buffer.from(buildMcpConfigJson(safe))) }];
}

export function manifestReproducible(manifest: InjectionManifest, recomputed: InjectedFile[]): boolean {
  if (manifest.files.length !== recomputed.length) return false;
  const byPath = new Map(recomputed.map((f) => [f.path, f.sha256]));
  return manifest.files.every((f) => byPath.get(f.path) === f.sha256);
}

/**
 * LIVE consumption proof (B2). Calls the adapter's `smokeProbe` if one exists; absent a probe,
 * consumption is unproven by construction. No adapter ships a probe yet, so this returns false —
 * the honest default. This is the ONLY path that may ever assert an executor loaded the config.
 */
export function proveConsumption(worktree: string, adapter: InjectionAdapter): boolean {
  return adapter.smokeProbe ? adapter.smokeProbe(worktree) === true : false;
}

export interface InjectionVerification {
  /** Every manifest file (and every backup) exists and its on-disk hash matches (intact). */
  integrityOk: boolean;
  /** Consumption is proven ONLY by a live smokeProbe (deferred). False unless a probe confirmed it. */
  consumptionProven: boolean;
  /** Manifest files whose current on-disk hash differs (post-exec tampering, surfaced not silent). */
  mutated: InjectedFile[];
  /** Manifest files (or backups) no longer on disk. */
  missing: string[];
}

/**
 * Re-read the worktree and check INJECTION'S OWN writes against the manifest: every recorded file
 * and backup must exist with the recorded hash. This is the enforceable guarantee — it does NOT
 * police arbitrary files the executor may add to the worktree (that is executor-owned,
 * R-native-ownership; injection makes no closure claim over it). Optionally runs a live consumption
 * probe; absent one, `consumptionProven` stays false.
 */
export function verifyInjection(
  worktree: string,
  manifest: InjectionManifest,
  opts: { adapter?: InjectionAdapter } = {},
): InjectionVerification {
  const mutated: InjectedFile[] = [];
  const missing: string[] = [];
  const checks: InjectedFile[] = [
    ...manifest.files,
    ...manifest.backed_up.map((b) => ({ path: b.backup, sha256: b.sha256 })),
  ];
  for (const f of checks) {
    const fp = join(worktree, f.path);
    if (!existsSync(fp)) {
      missing.push(f.path);
      continue;
    }
    // Read defensively: a path replaced by a directory (EISDIR) or otherwise unreadable is treated
    // as tampered/mutated, never an uncaught crash of the verification run.
    let cur: string | null;
    try {
      cur = sha256Hex(readFileSync(fp));
    } catch {
      cur = null;
    }
    if (cur === null || cur !== f.sha256) mutated.push({ path: f.path, sha256: cur ?? 'UNREADABLE' });
  }
  return {
    integrityOk: mutated.length === 0 && missing.length === 0,
    consumptionProven: opts.adapter ? proveConsumption(worktree, opts.adapter) : false,
    mutated,
    missing,
  };
}

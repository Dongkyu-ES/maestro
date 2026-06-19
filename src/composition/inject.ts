import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { CatalogModule } from './catalog.js';

/**
 * Slice 2 — active injection of resolved capability modules into a run worktree, recorded as a
 * tamper-evident, replayable manifest. Critic-panel constraints (WARDEN_MAGIC_DESIGN.md §7):
 *  B2 — no "auto-load by convention" claim: each executor declares whether it loads a project-local
 *       `.mcp.json`; an executor that does not yields `mcp_injection: 'unsupported'`, never a false
 *       claim. Consumption is NEVER asserted by this module — there is no `proven` status and
 *       `InjectionVerification` separates integrity from consumption (`consumptionProven` is always
 *       false here; only a future LIVE smoke probe can flip it). Nothing may read injection as
 *       "succeeded/consumed" from this module's output.
 *  B3 — `composition.injected` is the hash of the ACTUAL post-write bytes re-read from disk; the
 *       closure check is a BASELINE DIFF (what THIS injection created/modified vs a pre-injection
 *       snapshot must equal the manifest) so it catches a smuggled file without false-positiving on
 *       a repo's pre-existing CLAUDE.md/.claude. recomputeInjectionFiles proves the manifest is a
 *       pure function of the ledgered inputs.
 *  B6 — no exec-time installs; secret-bearing servers are skipped unless explicitly approved.
 *  B1 — MCP is a CAPABILITY kind only; injection never writes an acceptance bar.
 */

export type McpInjectionStatus = 'applied-unproven' | 'unsupported' | 'none';

/** A file written into the worktree, hashed from its on-disk bytes (not the intended buffer). */
export interface InjectedFile {
  /** Worktree-relative POSIX path. */
  path: string;
  sha256: string;
}

export interface InjectionManifest {
  schema_version: 1;
  executor: string;
  mcp_injection: McpInjectionStatus;
  files: InjectedFile[];
  /** MCP servers skipped because they carry secret-like fields and were not approved (B6). */
  skipped_secret_servers: string[];
  /** Pre-existing files this injection backed up before overwriting (path → backup path). */
  backed_up: { path: string; backup: string }[];
  note: string;
}

export interface InjectionAdapter {
  label: string;
  /** Honest static capability (B2): does this executor load a project-local `.mcp.json` from cwd? */
  supportsLocalMcp: boolean;
  /** Worktree-relative path of the MCP config this adapter writes when supported. */
  mcpConfigPath: string;
}

export const INJECTION_ADAPTERS: Record<string, InjectionAdapter> = {
  // Claude Code reads a project-scoped `.mcp.json` at the worktree root (the CLI still approval-gates
  // it, so `applied-unproven` never implies the servers were actually loaded — only a live smoke can).
  claude: { label: 'claude', supportsLocalMcp: true, mcpConfigPath: '.mcp.json' },
  // Codex reads ~/.codex/config.toml + `-c` overrides, NOT a cwd `.mcp.json` → unsupported (B2).
  codex: { label: 'codex', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
  agy: { label: 'agy', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
};

export function adapterFor(label: string): InjectionAdapter {
  return INJECTION_ADAPTERS[label] ?? { label, supportsLocalMcp: false, mcpConfigPath: '.mcp.json' };
}

/**
 * Closed set of AI-surface locations injection scans for the baseline diff / closure check. Broad on
 * purpose (B3): it must include every surface an executor auto-loads so a smuggled file is caught.
 * Closure is computed as a DELTA vs the pre-injection baseline, so listing a surface here never
 * false-positives on a file that already existed.
 */
const AI_SURFACE_FILES = [
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'soul.md',
  '.codex/config.toml',
  '.cursor/mcp.json',
];
const AI_SURFACE_DIRS = ['.claude/skills', '.claude/commands', '.codex/skills', '.codex/prompts'];

// Secret detection (B6): keyword set + connection-string (user:pass@host) + known token prefixes.
const SECRET_KEY_RE = /(secret|token|password|passwd|passphrase|auth|jwt|bearer|session|credential|api[-_]?key|access[-_]?key|connection[-_]?string|db[-_]?uri|dsn|\bkey\b)/i;
const CONNSTRING_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/; // scheme://user:pass@host
const TOKEN_PREFIX_RE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/;

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Conservative (fail-safe) secret detection over an MCP module's descriptor. */
function serverRequiresApproval(module: CatalogModule): boolean {
  const text = JSON.stringify(module.mcp ?? {});
  return SECRET_KEY_RE.test(text) || CONNSTRING_RE.test(text) || TOKEN_PREFIX_RE.test(text);
}

function buildMcpConfigJson(modules: CatalogModule[]): string {
  // Sort servers by name so serialization (and thus the manifest hash) is order-independent — B3
  // replay must not spuriously fail because the input module order differed.
  const sorted = [...modules].filter((m) => m.mcp).sort((a, b) => (a.mcp as { server: string }).server.localeCompare((b.mcp as { server: string }).server));
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
    if (!m.mcp) continue;
    if (serverRequiresApproval(m) && !approveSecrets) skipped.push(m.mcp.server);
    else safe.push(m);
  }
  return { safe, skipped };
}

/** Snapshot of injection-scope files present BEFORE injection — the closure diff's reference point. */
export interface InjectionBaseline {
  files: InjectedFile[];
}

function scanInjectionScope(worktree: string): string[] {
  const found: string[] = [];
  for (const rel of AI_SURFACE_FILES) {
    if (existsSync(join(worktree, rel))) found.push(rel);
  }
  for (const relDir of AI_SURFACE_DIRS) {
    const abs = join(worktree, relDir);
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isDirectory()) continue; // guard: a same-named FILE must not crash the walk
    } catch {
      continue;
    }
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const fp = join(dir, entry);
        try {
          if (statSync(fp).isDirectory()) walk(fp);
          else found.push(relative(worktree, fp).split(sep).join('/'));
        } catch {
          // unreadable entry contributes nothing
        }
      }
    };
    walk(abs);
  }
  return found.sort();
}

/** Capture the pre-injection baseline so the closure check is a DELTA, not an absolute denylist. */
export function captureInjectionBaseline(worktree: string): InjectionBaseline {
  return {
    files: scanInjectionScope(worktree).map((path) => ({
      path,
      sha256: sha256Hex(readFileSync(join(worktree, path))),
    })),
  };
}

/**
 * Write the resolved MCP capability set into the worktree and return a manifest hashed from the
 * ACTUAL on-disk bytes. Never claims more than it can: unsupported executor ⇒ `unsupported`, no safe
 * servers ⇒ `none`, otherwise `applied-unproven` (consumption is NOT proven). A pre-existing target
 * is backed up (never silently destroyed) and recorded in `backed_up`.
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
  const backed_up: { path: string; backup: string }[] = [];
  if (existsSync(target)) {
    // Never silently destroy an operator's existing config — back it up by content hash.
    const existing = readFileSync(target);
    const backupRel = `${adapter.mcpConfigPath}.warden-bak.${sha256Hex(existing).slice(0, 12)}`;
    copyFileSync(target, join(worktree, backupRel));
    backed_up.push({ path: adapter.mcpConfigPath, backup: backupRel });
  }
  writeFileSync(target, buildMcpConfigJson(safe));
  // B3: hash the bytes that actually LANDED on disk, not the buffer we intended to write.
  const onDisk = readFileSync(target);
  return {
    schema_version: 1,
    executor: adapter.label,
    mcp_injection: 'applied-unproven',
    files: [{ path: adapter.mcpConfigPath, sha256: sha256Hex(onDisk) }],
    skipped_secret_servers: skipped,
    backed_up,
    note: 'applied; consumption NOT proven without a live executor smoke probe (treat applied-unproven as NOT-yet-consumed)',
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

/** True iff every manifest file hash is reproduced by the pure recompute (and counts match). */
export function manifestReproducible(manifest: InjectionManifest, recomputed: InjectedFile[]): boolean {
  if (manifest.files.length !== recomputed.length) return false;
  const byPath = new Map(recomputed.map((f) => [f.path, f.sha256]));
  return manifest.files.every((f) => byPath.get(f.path) === f.sha256);
}

export interface InjectionVerification {
  /** Every manifest file exists and its on-disk hash matches (what we wrote is intact). */
  integrityOk: boolean;
  /** Post-write only: what injection created/modified vs the baseline equals the manifest (no smuggle). */
  closureOk: boolean;
  /** Consumption is NEVER proven by this module — only a live smoke probe (deferred) can. Always false. */
  consumptionProven: false;
  /** Manifest files whose current on-disk hash differs (post-exec mutation, surfaced not silent). */
  mutated: InjectedFile[];
  /** Files injection created/modified (vs baseline) that are NOT in the manifest — a smuggle. */
  extraneous: string[];
  /** Manifest files no longer on disk. */
  missing: string[];
}

/**
 * Verify the manifest against reality. Integrity (manifest files intact) is always checked. Closure
 * is checked ONLY at `phase: 'post-write'` (the default) and ONLY against a baseline: the set of
 * injection-scope files this run created or modified must equal the manifest — pre-existing user
 * files are ignored (fixes the false-positive on a repo's own CLAUDE.md/.claude). At
 * `phase: 'post-exec'` closure is skipped (the executor may legitimately create AI-surface files);
 * only integrity/mutation of the injected files is checked. `consumptionProven` is always false.
 */
export function verifyInjection(
  worktree: string,
  manifest: InjectionManifest,
  opts: { baseline?: InjectionBaseline; phase?: 'post-write' | 'post-exec' } = {},
): InjectionVerification {
  const phase = opts.phase ?? 'post-write';
  const declared = new Set(manifest.files.map((f) => f.path));

  const mutated: InjectedFile[] = [];
  const missing: string[] = [];
  for (const f of manifest.files) {
    const fp = join(worktree, f.path);
    if (!existsSync(fp)) {
      missing.push(f.path);
      continue;
    }
    const cur = sha256Hex(readFileSync(fp));
    if (cur !== f.sha256) mutated.push({ path: f.path, sha256: cur });
  }
  const integrityOk = mutated.length === 0 && missing.length === 0;

  let extraneous: string[] = [];
  let closureOk = true;
  if (phase === 'post-write') {
    const baseSha = new Map((opts.baseline?.files ?? []).map((f) => [f.path, f.sha256]));
    const current = scanInjectionScope(worktree);
    // Delta = files injection created (not in baseline) or modified (hash changed from baseline).
    const delta = current.filter((p) => {
      if (!baseSha.has(p)) return true;
      try {
        return sha256Hex(readFileSync(join(worktree, p))) !== baseSha.get(p);
      } catch {
        return true;
      }
    });
    extraneous = delta.filter((p) => !declared.has(p));
    closureOk = extraneous.length === 0;
  }

  return { integrityOk, closureOk, consumptionProven: false, mutated, extraneous, missing };
}

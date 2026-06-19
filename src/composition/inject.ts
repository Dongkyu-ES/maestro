import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { CatalogModule } from './catalog.js';

/**
 * Slice 2 — active injection of resolved capability modules into a run worktree, recorded as a
 * tamper-evident, replayable manifest. Critic-panel constraints (WARDEN_MAGIC_DESIGN.md §7):
 *  B2 — no "auto-load by convention" claim: each executor declares whether it loads a project-local
 *       `.mcp.json`; an executor that does not yields `mcp_injection: 'unsupported'`, never a false
 *       injection claim, and consumption is `applied-unproven` until a LIVE smoke probe confirms it.
 *  B3 — `composition.injected` is the hash of the ACTUAL post-write bytes re-read from disk, plus a
 *       closure check (no AI-surface file outside the manifest) and a pure replay re-derivation from
 *       the ledgered inputs. `verifyInjection` re-checks pre/post-exec.
 *  B6 — no exec-time installs; secret-bearing servers are skipped unless explicitly approved.
 *  B1 — MCP is a CAPABILITY kind only; injection never writes an acceptance bar (enforced upstream
 *       in resolveMagicPlan; this module only handles `kind: 'mcp'`).
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
  // Claude Code reads a project-scoped `.mcp.json` at the worktree root (the CLI still approval-gates it).
  claude: { label: 'claude', supportsLocalMcp: true, mcpConfigPath: '.mcp.json' },
  // Codex reads ~/.codex/config.toml + `-c` overrides, NOT a cwd `.mcp.json` → unsupported (B2).
  codex: { label: 'codex', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
  agy: { label: 'agy', supportsLocalMcp: false, mcpConfigPath: '.mcp.json' },
};

export function adapterFor(label: string): InjectionAdapter {
  return INJECTION_ADAPTERS[label] ?? { label, supportsLocalMcp: false, mcpConfigPath: '.mcp.json' };
}

/** Closed set of AI-surface locations injection may touch — the basis for the closure check. */
const AI_SURFACE_FILES = ['.mcp.json', 'CLAUDE.md', 'soul.md'];
const AI_SURFACE_DIRS = [join('.claude', 'skills'), join('.codex', 'skills')];

const SECRET_KEY_RE = /(secret|token|key|password|passwd|authorization|api[-_]?key|credential)/i;

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Conservative (fail-safe) secret detection over an MCP module's descriptor. */
function serverRequiresApproval(module: CatalogModule): boolean {
  return SECRET_KEY_RE.test(JSON.stringify(module.mcp ?? {}));
}

function buildMcpConfigJson(modules: CatalogModule[]): string {
  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const m of modules) {
    if (!m.mcp) continue;
    const cmd = m.mcp.command ?? [];
    mcpServers[m.mcp.server] = { command: cmd[0] ?? m.mcp.server, args: cmd.slice(1) };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** Partition selected MCP modules into injectable vs skipped-for-approval (B6). Pure. */
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

/**
 * Write the resolved MCP capability set into the worktree and return a manifest hashed from the
 * ACTUAL on-disk bytes. Never claims more than it can: unsupported executor ⇒ `unsupported`, no
 * safe servers ⇒ `none`, otherwise `applied-unproven` (consumption is not proven without a live smoke).
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
      note: skipped.length ? 'all candidate MCP servers require approval (--approve-secrets)' : 'no MCP modules to inject',
    };
  }
  const target = join(worktree, adapter.mcpConfigPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buildMcpConfigJson(safe));
  // B3: hash the bytes that actually LANDED on disk, not the buffer we intended to write.
  const onDisk = readFileSync(target);
  return {
    schema_version: 1,
    executor: adapter.label,
    mcp_injection: 'applied-unproven',
    files: [{ path: adapter.mcpConfigPath, sha256: sha256Hex(onDisk) }],
    skipped_secret_servers: skipped,
    note: 'applied; consumption NOT proven without a live executor smoke probe',
  };
}

/**
 * Pure replay (B3): re-derive the intended injected files from the ledgered inputs (modules +
 * adapter), so a verifier can confirm `composition.injected` is a function of recorded inputs and
 * not a self-reported value. Returns [] for unsupported/no-safe cases, matching apply.
 */
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

function scanAiSurface(worktree: string): string[] {
  const found: string[] = [];
  for (const rel of AI_SURFACE_FILES) {
    if (existsSync(join(worktree, rel))) found.push(rel);
  }
  for (const relDir of AI_SURFACE_DIRS) {
    const abs = join(worktree, relDir);
    if (!existsSync(abs)) continue;
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

export interface InjectionVerification {
  ok: boolean;
  /** No AI-surface file exists outside the manifest (catches a smuggled SKILL.md, etc.). */
  closureOk: boolean;
  /** Manifest files whose current on-disk hash differs (post-exec mutation, surfaced not silent). */
  mutated: InjectedFile[];
  /** AI-surface files present but absent from the manifest. */
  extraneous: string[];
  /** Manifest files no longer on disk. */
  missing: string[];
}

/**
 * Re-read the worktree and check the manifest against reality: closure (no AI-surface file outside
 * the manifest) + per-file hash match. Run right after injection (must be `ok`) and again post-exec
 * (mutation is recorded as evidence, never silently accepted).
 */
export function verifyInjection(worktree: string, manifest: InjectionManifest): InjectionVerification {
  const declared = new Set(manifest.files.map((f) => f.path));
  const scanned = scanAiSurface(worktree);
  const extraneous = scanned.filter((p) => !declared.has(p));
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
  const closureOk = extraneous.length === 0;
  return { ok: closureOk && mutated.length === 0 && missing.length === 0, closureOk, mutated, extraneous, missing };
}

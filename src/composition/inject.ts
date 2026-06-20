import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { CatalogModule } from './catalog.js';

/**
 * Slice 2 — active injection of resolved CAPABILITY modules (MCP only) into a run worktree,
 * recorded as a tamper-evident, replayable manifest.
 *
 * HONEST SCOPE (the slice-2 code panel forced this narrowing; docs/milestones/archive/WARDEN_MAGIC_DESIGN.md §7
 * "slice-2 corrections"): Warden does NOT own the in-loop worktree — the native executor owns it
 * (CORRECTED_PLAN §10, R-native-ownership). So this module guarantees ONLY what it can enforce:
 *   - what INJECTION itself wrote is closed BY CONSTRUCTION — apply writes exactly the adapter's
 *     `mcpConfigPath` (+ a `.warden-bak` of any pre-existing config) and records every byte. There
 *     is no runtime "scan the whole worktree for AI surfaces" closure, because that is an
 *     unwinnable denylist over an executor-owned tree (nested CLAUDE.md/GEMINI.md/.cursorrules/…).
 *   - integrity of those written files is re-checked from disk IN-RUN — after the executor finishes
 *     and BEFORE the ephemeral worktree is cleaned up — and recorded as tamper-evident evidence
 *     (`integrityOk`), NEVER as a completion gate (injection never advances/blocks the verdict;
 *     R-native-ownership). There is no post-hoc on-disk re-check: the worktree is gone by then.
 *   - the manifest is reproducible from the ledgered inputs (replay).
 *   - consumption is NEVER asserted (B2): there is no `proven` status; `consumptionProven` is only
 *     flipped by a LIVE `smokeProbe` (the built-in adapters here ship none; slice 5's
 *     `withCanaryProbe` supplies one that proves consumption from a real sentinel). `applied-unproven`
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
  /** Slice-7 Item A: instruction files written (also included in `files` for integrity). Audit detail. */
  instruction_files: { path: string; sha256: string; base_sha256?: string; injected_sha256: string; merged: boolean }[];
  /** Instruction modules NOT injected (approval missing / acceptance not pinned-test), with reason. */
  skipped_instructions: { id: string; reason: string }[];
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
   * loaded the injected config. The built-in adapters ship none (consumption stays unproven); slice
   * 5's `withCanaryProbe` (smoke-probe.ts) supplies a canary probe that proves it from a real sentinel.
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

// Secret detection (B6) is a BEST-EFFORT HEURISTIC, not a security boundary. Catalog modules are
// operator-authored (repo `warden.modules.json` / `~/.warden/catalog`), so this gate's job is to
// warn the operator before their OWN secret is copied into a worktree `.mcp.json` (where it could
// be committed/leaked) — not to defend against a malicious author (who is the operator). A complete
// secret-pattern denylist is unwinnable; we cover the obvious formats and document the rest as
// operator responsibility (use `--approve-secrets` deliberately).
const SECRET_KEY_RE =
  /(secret|token|password|passwd|passphrase|\bpass\b|\bpwd\b|\bcreds?\b|auth|jwt|bearer|session|credential|api[-_]?key|access[-_]?key|connection[-_]?string|db[-_]?uri|dsn|\bkey\b)/i;
const CONNSTRING_RE = /\/\/[^/\s:@]+:[^/\s:@]+@/;
const TOKEN_PREFIX_RE =
  /(gh[pousr]_[A-Za-z0-9]{16,}|sk[_-][A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/;

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

interface InstructionResult {
  files: InjectedFile[];
  instruction_files: InjectionManifest['instruction_files'];
  backed_up: InjectionManifest['backed_up'];
  skipped: { id: string; reason: string }[];
}

/**
 * Slice-7 Item A: write instruction-kind modules (CLAUDE.md / soul / AGENTS.md) into the worktree.
 * MECHANICALLY GATED (design-panel claude BLOCKER): instruction injection happens ONLY when
 * `approveInstructions` AND `acceptanceIsPinnedTest` are both true — instruction content is a
 * teaching-to-the-test channel, safe to inject only when completion is judged by a pinned,
 * executor-uneditable test. Otherwise every instruction module is recorded in `skipped` with the
 * reason and nothing is written. Written files land in `files` (integrity-checked) and `backed_up`
 * preserves any pre-existing target (hashed).
 */
function injectInstructions(
  worktree: string,
  modules: CatalogModule[],
  gate: { approveInstructions: boolean; acceptanceIsPinnedTest: boolean },
): InstructionResult {
  const out: InstructionResult = { files: [], instruction_files: [], backed_up: [], skipped: [] };
  if (modules.length === 0) return out;
  if (!gate.approveInstructions) {
    for (const m of modules) out.skipped.push({ id: m.id, reason: 'instruction injection requires approveInstructions (teaching-to-the-test channel)' });
    return out;
  }
  if (!gate.acceptanceIsPinnedTest) {
    for (const m of modules) out.skipped.push({ id: m.id, reason: 'instruction injection requires pinned-test acceptance (artifact/diff acceptance is trivially injectable)' });
    return out;
  }
  const root = resolve(worktree);
  const claimed = new Set<string>();
  for (const m of modules) {
    if (!m.instruction) {
      out.skipped.push({ id: m.id, reason: 'no instruction descriptor' });
      continue;
    }
    const { targetPath, content, merge } = m.instruction;
    const abs = resolve(worktree, targetPath);
    // Containment (claude slice-7 MAJOR): `targetPath` is operator-catalog data, not adapter-fixed
    // like mcpConfigPath. A `../escape` or absolute path would write OUTSIDE the executor-owned
    // worktree. Reject anything that does not resolve under the worktree root — assumed, now enforced.
    if (abs !== root && !abs.startsWith(root + sep)) {
      out.skipped.push({ id: m.id, reason: `instruction targetPath escapes the worktree: ${targetPath}` });
      continue;
    }
    // Duplicate targetPath (agy slice-7 MAJOR): two modules writing the same file would record two
    // InjectedFile entries with divergent hashes (the first captured pre-overwrite), making
    // verifyInjection report a false `mutated` even absent any executor tampering. Reject the collision.
    if (claimed.has(abs)) {
      out.skipped.push({ id: m.id, reason: `instruction targetPath already injected by another module: ${targetPath}` });
      continue;
    }
    if (existsSync(abs) && !statSync(abs).isFile()) {
      out.skipped.push({ id: m.id, reason: `${targetPath} exists but is not a file` });
      continue;
    }
    claimed.add(abs);
    mkdirSync(dirname(abs), { recursive: true });
    let base_sha: string | undefined;
    let existing = '';
    if (existsSync(abs)) {
      existing = readFileSync(abs, 'utf8');
      base_sha = sha256Hex(existing);
      const backupRel = `${targetPath}.warden-bak.${base_sha.slice(0, 12)}`;
      copyFileSync(abs, join(worktree, backupRel));
      out.backed_up.push({ path: targetPath, backup: backupRel, sha256: base_sha });
    }
    const fragment = `\n<!-- warden-injected -->\n${content}\n<!-- /warden-injected -->\n`;
    const merged = Boolean(merge && existing);
    writeFileSync(abs, merge ? existing + fragment : content);
    const sha = sha256Hex(readFileSync(abs));
    out.files.push({ path: targetPath, sha256: sha });
    out.instruction_files.push({ path: targetPath, sha256: sha, base_sha256: base_sha, injected_sha256: sha256Hex(Buffer.from(content)), merged });
  }
  return out;
}

/**
 * Write the resolved capability (MCP) + (gated) instruction set into the worktree and return a
 * manifest hashed from the ACTUAL on-disk bytes. MCP writes exactly the adapter's `mcpConfigPath`;
 * instruction kinds are approval+pinned-test gated (Item A). `mcp_injection` reports the capability
 * outcome honestly (unsupported/none/applied-unproven); instruction outcomes are in
 * `instruction_files`/`skipped_instructions`.
 */
export function applyCompositionToWorktree(opts: {
  worktree: string;
  mcpModules: CatalogModule[];
  adapter: InjectionAdapter;
  approveSecrets?: boolean;
  instructionModules?: CatalogModule[];
  approveInstructions?: boolean;
  acceptanceIsPinnedTest?: boolean;
}): InjectionManifest {
  const { worktree, adapter } = opts;
  const instr = injectInstructions(worktree, opts.instructionModules ?? [], {
    approveInstructions: opts.approveInstructions ?? false,
    acceptanceIsPinnedTest: opts.acceptanceIsPinnedTest ?? false,
  });
  const base = {
    schema_version: 1 as const,
    executor: adapter.label,
    instruction_files: instr.instruction_files,
    skipped_instructions: instr.skipped,
  };
  if (!adapter.supportsLocalMcp) {
    return {
      ...base,
      mcp_injection: 'unsupported',
      files: instr.files,
      skipped_secret_servers: [],
      backed_up: instr.backed_up,
      note: `${adapter.label} does not load a project-local .mcp.json from cwd — no MCP injected (B2: no false claim)`,
    };
  }
  const { safe, skipped } = partitionBySecret(opts.mcpModules, opts.approveSecrets ?? false);
  const target = join(worktree, adapter.mcpConfigPath);
  if (safe.length === 0) {
    return {
      ...base,
      mcp_injection: 'none',
      files: instr.files,
      skipped_secret_servers: skipped,
      backed_up: instr.backed_up,
      note: skipped.length ? 'all candidate MCP servers require approval (--approve-secrets)' : 'no MCP modules to inject',
    };
  }
  // A path collision where the config path is a directory is a broken worktree, not something to
  // crash on (EISDIR). Refuse the MCP write gracefully (instructions already handled above).
  if (existsSync(target) && !statSync(target).isFile()) {
    return {
      ...base,
      mcp_injection: 'none',
      files: instr.files,
      skipped_secret_servers: skipped,
      backed_up: instr.backed_up,
      note: `${adapter.mcpConfigPath} exists but is not a file — refusing MCP injection (no crash)`,
    };
  }
  mkdirSync(dirname(target), { recursive: true });
  const backed_up = [...instr.backed_up];
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
    ...base,
    mcp_injection: 'applied-unproven',
    files: [...instr.files, { path: adapter.mcpConfigPath, sha256: sha256Hex(onDisk) }],
    skipped_secret_servers: skipped,
    backed_up,
    note: 'applied; consumption NOT proven (no live smokeProbe) — treat applied-unproven as NOT-yet-consumed',
  };
}

/**
 * Pure replay (B3): re-derive the injected files whose bytes are a PURE function of the ledgered
 * inputs — the MCP config and any NON-merge instruction files (`sha256(content)`). MERGE instruction
 * files are deliberately excluded: their merged bytes depend on the pre-existing worktree file (base),
 * which is not a catalog input, so they are not purely reproducible — they are covered by
 * `verifyInjection` on-disk integrity instead (see manifestReproducible).
 */
export function recomputeInjectionFiles(opts: {
  mcpModules: CatalogModule[];
  adapter: InjectionAdapter;
  approveSecrets?: boolean;
  instructionModules?: CatalogModule[];
  approveInstructions?: boolean;
  acceptanceIsPinnedTest?: boolean;
}): InjectedFile[] {
  const files: InjectedFile[] = [];
  if (opts.adapter.supportsLocalMcp) {
    const { safe } = partitionBySecret(opts.mcpModules, opts.approveSecrets ?? false);
    if (safe.length > 0) files.push({ path: opts.adapter.mcpConfigPath, sha256: sha256Hex(Buffer.from(buildMcpConfigJson(safe))) });
  }
  if (opts.approveInstructions && opts.acceptanceIsPinnedTest) {
    for (const m of opts.instructionModules ?? []) {
      // Only non-merge (write) instruction files are purely reproducible from inputs.
      if (m.instruction && !m.instruction.merge) {
        files.push({ path: m.instruction.targetPath, sha256: sha256Hex(Buffer.from(m.instruction.content)) });
      }
    }
  }
  return files;
}

/**
 * The manifest is reproducible iff every PURELY-reproducible written file (MCP + non-merge
 * instruction) matches the pure recompute. Merge instruction files (base-dependent) are excluded
 * from this check — their tamper-evidence is `verifyInjection`'s on-disk integrity, not pure replay.
 */
export function manifestReproducible(manifest: InjectionManifest, recomputed: InjectedFile[]): boolean {
  const mergePaths = new Set(manifest.instruction_files.filter((f) => f.merged).map((f) => f.path));
  const pureFiles = manifest.files.filter((f) => !mergePaths.has(f.path));
  if (pureFiles.length !== recomputed.length) return false;
  const byPath = new Map(recomputed.map((f) => [f.path, f.sha256]));
  return pureFiles.every((f) => byPath.get(f.path) === f.sha256);
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
  /** Consumption is proven ONLY by a live smokeProbe (e.g. slice 5's canary). False unless one confirmed it. */
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
  // Integrity is over injection's CAPABILITY writes only. Backups are recovery artifacts (a
  // cleaned/removed `.warden-bak` via `git clean` must not fail verification); their hash stays in
  // the manifest for audit but their presence is not integrity-required.
  for (const f of manifest.files) {
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

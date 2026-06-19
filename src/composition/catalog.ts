import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ModuleKind = 'skill' | 'harness' | 'agent' | 'soul' | 'mcp' | 'agents_md';

/**
 * One composable LLM-dependency "module" in the catalog (the Tuist-style module graph node).
 * Matching is by flat tag subset only (critic-panel B5). The injection descriptor fields
 * (`mcp`, `source`) are recorded for slice 2 (injection) and unused by slice-1 dry-run resolve.
 *
 * INVARIANT (critic-panel B1): a module MUST NOT carry an `acceptance` field. Acceptance is
 * operator-owned and frozen before composition runs; a catalog module that supplies its own
 * acceptance bar would let `declared`/`discovered` provenance self-certify completion. Resolve
 * rejects any acceptance-bearing module (see resolveMagicPlan).
 */
export interface CatalogModule {
  id: string;
  kind: ModuleKind;
  /** Module is selectable iff these tags are a subset of the detected project tags. Empty = never auto-selected. */
  tags: string[];
  origin: 'declared' | 'discovered';
  description?: string;
  /** Slice-2 injection descriptor for kind 'mcp' (local, no-secret, pre-installed binary). */
  mcp?: { server: string; command?: string[] };
  /** Slice-2 injection source path for file-backed kinds. */
  source?: string;
  /**
   * Slice-7 (Item A) instruction descriptor for kinds 'agents_md' | 'soul' | 'skill'. `targetPath`
   * is worktree-relative (e.g. CLAUDE.md, AGENTS.md, soul.md); `merge:true` appends after a marker
   * (preserving a pre-existing file), else it writes. Instruction injection is approval-gated AND
   * mechanically restricted to pinned-test acceptance (a teaching-to-the-test channel).
   */
  instruction?: { targetPath: string; content: string; merge?: boolean };
  /** FORBIDDEN by B1 — present only so resolve can detect and reject it. */
  acceptance?: unknown;
}

export interface ModuleCatalog {
  modules: CatalogModule[];
  /** Files/dirs the catalog was assembled from, for `magic plan` transparency. */
  sources: string[];
}

function readDeclaredFile(path: string, origin: 'declared'): CatalogModule[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { modules?: Partial<CatalogModule>[] };
    if (!parsed || !Array.isArray(parsed.modules)) return [];
    return parsed.modules
      .filter((m): m is Partial<CatalogModule> => Boolean(m?.id && m?.kind))
      .map((m) => ({
        id: String(m.id),
        kind: m.kind as ModuleKind,
        tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
        origin,
        description: m.description,
        mcp: m.mcp,
        source: m.source,
        // Carry acceptance through ONLY so resolve can reject it (B1); never act on it here.
        acceptance: (m as { acceptance?: unknown }).acceptance,
      }));
  } catch {
    return [];
  }
}

/** Discover installed CLI skills as untagged catalog entries (listed, never auto-selected — they
 *  carry no warden tags, so their empty-but-present listing is informational). Read-only. */
function discoverInstalledSkills(home: string): CatalogModule[] {
  const skillsDir = join(home, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];
  const modules: CatalogModule[] = [];
  try {
    for (const name of readdirSync(skillsDir)) {
      const dir = join(skillsDir, name);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'))) {
          modules.push({ id: `installed:${name}`, kind: 'skill', tags: [], origin: 'discovered', source: dir });
        }
      } catch {
        // skip unreadable entry
      }
    }
  } catch {
    // unreadable skills dir contributes nothing — safe direction
  }
  return modules;
}

/**
 * Assemble the module catalog from declared sources (repo `warden.modules.json` + global
 * `~/.warden/catalog/*.json`) and discovered installed skills. Declared entries are the
 * tag-bearing, auto-selectable ones; discovered entries are listed but untagged (informational
 * until a declared entry tags them). Pure read; never throws on a bad file (fails open per source).
 */
export function loadModuleCatalog(opts: { root: string; home?: string }): ModuleCatalog {
  const home = opts.home ?? homedir();
  const modules: CatalogModule[] = [];
  const sources: string[] = [];

  const repoCatalog = join(opts.root, 'warden.modules.json');
  if (existsSync(repoCatalog)) {
    modules.push(...readDeclaredFile(repoCatalog, 'declared'));
    sources.push(repoCatalog);
  }

  const globalDir = join(home, '.warden', 'catalog');
  if (existsSync(globalDir)) {
    try {
      for (const name of readdirSync(globalDir)) {
        if (!name.endsWith('.json')) continue;
        const path = join(globalDir, name);
        modules.push(...readDeclaredFile(path, 'declared'));
        sources.push(path);
      }
    } catch {
      // unreadable global catalog dir contributes nothing
    }
  }

  const discovered = discoverInstalledSkills(home);
  if (discovered.length) {
    modules.push(...discovered);
    sources.push(join(home, '.claude', 'skills'));
  }

  // De-dup by id with precedence = assembly order (repo declared > global declared > discovered):
  // the FIRST occurrence of an id wins, so a repo/global declaration overrides a discovered entry
  // (and resolve never emits the same module twice). Critic-panel agy follow-up.
  const deduped: CatalogModule[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    if (seen.has(module.id)) continue;
    seen.add(module.id);
    deduped.push(module);
  }
  return { modules: deduped, sources };
}

/** A module matches a project iff it has at least one tag and all its tags are detected. */
export function moduleMatchesTags(module: CatalogModule, detectedTags: string[]): boolean {
  if (module.tags.length === 0) return false; // untagged ⇒ never auto-selected
  const detected = new Set(detectedTags);
  return module.tags.every((tag) => detected.has(tag));
}

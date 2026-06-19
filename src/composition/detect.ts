import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A single deterministic detection signal: a flat tag plus the file/heuristic that produced it.
 * Flat tags ONLY — no predicate DSL (critic-panel B5). A catalog module matches a project iff the
 * module's tag set is a subset of the detected tag set; there is no boolean/version/nested logic.
 */
export interface ProjectSignal {
  tag: string;
  source: string;
}

export interface ProjectSignals {
  root: string;
  /** Sorted, de-duplicated flat tags. The only basis catalog matching reads. */
  tags: string[];
  /** Provenance: which file/heuristic produced each tag (for `magic plan` transparency + replay). */
  signals: ProjectSignal[];
}

/** Manifest/marker file (or directory) → the flat tags its presence implies. Deterministic. */
const MANIFEST_TAGS: { path: string; tags: string[] }[] = [
  { path: 'Project.swift', tags: ['swift', 'tuist'] },
  { path: 'Workspace.swift', tags: ['swift', 'tuist'] },
  { path: 'Tuist', tags: ['swift', 'tuist'] },
  { path: 'Package.swift', tags: ['swift', 'swiftpm'] },
  { path: 'Cargo.toml', tags: ['rust', 'cargo'] },
  { path: 'package.json', tags: ['node'] },
  { path: 'pnpm-lock.yaml', tags: ['node', 'pnpm'] },
  { path: 'pnpm-workspace.yaml', tags: ['node', 'pnpm', 'monorepo'] },
  { path: 'go.mod', tags: ['go'] },
  { path: 'pyproject.toml', tags: ['python'] },
  { path: 'requirements.txt', tags: ['python'] },
  { path: 'Gemfile', tags: ['ruby'] },
];

/** Existing AI-surface markers → flat tags (advisory presence, not capability proof). */
const SURFACE_TAGS: { path: string; tag: string }[] = [
  { path: '.claude', tag: 'surface:claude' },
  { path: '.codex', tag: 'surface:codex' },
  { path: '.mcp.json', tag: 'surface:mcp' },
  { path: 'soul.md', tag: 'surface:soul' },
  { path: 'AGENTS.md', tag: 'surface:agents-md' },
  { path: 'CLAUDE.md', tag: 'surface:claude-md' },
];

function addSignal(signals: ProjectSignal[], tag: string, source: string): void {
  signals.push({ tag, source });
}

/**
 * Detect a project's identity as a flat tag set from DETERMINISTIC, replayable signals only
 * (manifests, lockfiles, AI-surface markers, a Cargo workspace marker). No LLM, no model trust —
 * the advisory LLM pass is a separate, operator-confirmed path (deferred). Returns sorted unique
 * tags plus per-tag provenance.
 */
export function detectProjectSignals(root: string): ProjectSignals {
  const signals: ProjectSignal[] = [];

  for (const entry of MANIFEST_TAGS) {
    if (existsSync(join(root, entry.path))) {
      for (const tag of entry.tags) addSignal(signals, tag, entry.path);
    }
  }

  for (const entry of SURFACE_TAGS) {
    if (existsSync(join(root, entry.path))) addSignal(signals, entry.tag, entry.path);
  }

  // Cargo workspace = monorepo marker (a `[workspace]` table in the root Cargo.toml).
  const cargoToml = join(root, 'Cargo.toml');
  if (existsSync(cargoToml)) {
    try {
      if (/^\s*\[workspace\]/m.test(readFileSync(cargoToml, 'utf8'))) {
        addSignal(signals, 'monorepo', 'Cargo.toml [workspace]');
      }
    } catch {
      // unreadable manifest contributes no extra tag — safe direction
    }
  }

  const tags = [...new Set(signals.map((s) => s.tag))].sort();
  return { root, tags, signals };
}

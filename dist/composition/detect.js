import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Manifest/marker file (or directory) → the flat tags its presence implies. Deterministic. */
const MANIFEST_TAGS = [
    { path: 'Project.swift', tags: ['swift', 'tuist'] },
    { path: 'Workspace.swift', tags: ['swift', 'tuist'] },
    { path: 'Tuist', tags: ['swift', 'tuist'] },
    { path: 'Package.swift', tags: ['swift', 'swiftpm'] },
    { path: 'Cargo.toml', tags: ['rust', 'cargo'] },
    { path: 'package.json', tags: ['node'] },
    { path: 'package-lock.json', tags: ['node', 'npm'] },
    { path: 'yarn.lock', tags: ['node', 'yarn'] },
    { path: 'pnpm-lock.yaml', tags: ['node', 'pnpm'] },
    { path: 'pnpm-workspace.yaml', tags: ['node', 'pnpm', 'monorepo'] },
    { path: 'go.mod', tags: ['go'] },
    { path: 'pyproject.toml', tags: ['python'] },
    { path: 'requirements.txt', tags: ['python'] },
    { path: 'Gemfile', tags: ['ruby'] },
];
/** Existing AI-surface markers → flat tags (advisory presence, not capability proof). */
const SURFACE_TAGS = [
    { path: '.claude', tag: 'surface:claude' },
    { path: '.codex', tag: 'surface:codex' },
    { path: '.mcp.json', tag: 'surface:mcp' },
    { path: 'soul.md', tag: 'surface:soul' },
    { path: 'AGENTS.md', tag: 'surface:agents-md' },
    { path: 'CLAUDE.md', tag: 'surface:claude-md' },
];
function addSignal(signals, tag, source) {
    signals.push({ tag, source });
}
/**
 * Detect a project's identity as a flat tag set from DETERMINISTIC, replayable signals only
 * (manifests, lockfiles, AI-surface markers, a Cargo workspace marker). No LLM, no model trust —
 * the advisory LLM pass is a separate, operator-confirmed path (deferred). Returns sorted unique
 * tags plus per-tag provenance.
 */
export function detectProjectSignals(root) {
    const signals = [];
    for (const entry of MANIFEST_TAGS) {
        if (existsSync(join(root, entry.path))) {
            for (const tag of entry.tags)
                addSignal(signals, tag, entry.path);
        }
    }
    for (const entry of SURFACE_TAGS) {
        if (existsSync(join(root, entry.path)))
            addSignal(signals, entry.tag, entry.path);
    }
    // Cargo workspace = monorepo marker (a `[workspace]` table in the root Cargo.toml).
    const cargoToml = join(root, 'Cargo.toml');
    if (existsSync(cargoToml)) {
        try {
            if (/^\s*\[workspace\]/m.test(readFileSync(cargoToml, 'utf8'))) {
                addSignal(signals, 'monorepo', 'Cargo.toml [workspace]');
            }
        }
        catch {
            // unreadable manifest contributes no extra tag — safe direction
        }
    }
    const tags = [...new Set(signals.map((s) => s.tag))].sort();
    return { root, tags, signals };
}

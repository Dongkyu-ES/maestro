import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function readDeclaredFile(path, origin) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || !Array.isArray(parsed.modules))
            return [];
        return parsed.modules
            .filter((m) => Boolean(m?.id && m?.kind))
            .map((m) => ({
            id: String(m.id),
            kind: m.kind,
            tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
            origin,
            description: m.description,
            mcp: m.mcp,
            source: m.source,
            // Slice-7 Item A: carry the instruction descriptor so declared instruction modules actually
            // load (without this the allowlist silently dropped it → instruction injection was a no-op).
            instruction: m.instruction,
            // Carry acceptance through ONLY so resolve can reject it (B1); never act on it here.
            acceptance: m.acceptance,
        }));
    }
    catch {
        return [];
    }
}
/** Discover installed CLI skills as untagged catalog entries (listed, never auto-selected — they
 *  carry no maestro tags, so their empty-but-present listing is informational). Read-only. */
function discoverInstalledSkills(home) {
    const skillsDir = join(home, '.claude', 'skills');
    if (!existsSync(skillsDir))
        return [];
    const modules = [];
    try {
        for (const name of readdirSync(skillsDir)) {
            const dir = join(skillsDir, name);
            try {
                if (statSync(dir).isDirectory() && existsSync(join(dir, 'SKILL.md'))) {
                    modules.push({ id: `installed:${name}`, kind: 'skill', tags: [], origin: 'discovered', source: dir });
                }
            }
            catch {
                // skip unreadable entry
            }
        }
    }
    catch {
        // unreadable skills dir contributes nothing — safe direction
    }
    return modules;
}
/**
 * Assemble the module catalog from declared sources (repo `maestro.modules.json` + global
 * `~/.maestro/catalog/*.json`) and discovered installed skills. Declared entries are the
 * tag-bearing, auto-selectable ones; discovered entries are listed but untagged (informational
 * until a declared entry tags them). Pure read; never throws on a bad file (fails open per source).
 */
export function loadModuleCatalog(opts) {
    const home = opts.home ?? homedir();
    const modules = [];
    const sources = [];
    const repoCatalog = join(opts.root, 'maestro.modules.json');
    if (existsSync(repoCatalog)) {
        modules.push(...readDeclaredFile(repoCatalog, 'declared'));
        sources.push(repoCatalog);
    }
    const globalDir = join(home, '.maestro', 'catalog');
    if (existsSync(globalDir)) {
        try {
            for (const name of readdirSync(globalDir)) {
                if (!name.endsWith('.json'))
                    continue;
                const path = join(globalDir, name);
                modules.push(...readDeclaredFile(path, 'declared'));
                sources.push(path);
            }
        }
        catch {
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
    const deduped = [];
    const seen = new Set();
    for (const module of modules) {
        if (seen.has(module.id))
            continue;
        seen.add(module.id);
        deduped.push(module);
    }
    return { modules: deduped, sources };
}
/** A module matches a project iff it has at least one tag and all its tags are detected. */
export function moduleMatchesTags(module, detectedTags) {
    if (module.tags.length === 0)
        return false; // untagged ⇒ never auto-selected
    const detected = new Set(detectedTags);
    return module.tags.every((tag) => detected.has(tag));
}

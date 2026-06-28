import { loadModuleCatalog, moduleMatchesTags } from './catalog.js';
import { detectProjectSignals } from './detect.js';
/**
 * Resolve the dry-run composition. Selection is by flat tag subset only (B5). Critic-panel B1 is
 * enforced here: any catalog module carrying an `acceptance` field is REJECTED, not selected —
 * acceptance is operator-owned and must never arrive via `declared`/`discovered`/`learned`
 * provenance (that would let a module self-certify the completion bar). This function is pure and
 * side-effect-free; it injects nothing and changes no run state.
 */
export function resolveMagicPlan(opts) {
    const detection = opts.signals ?? detectProjectSignals(opts.root);
    const catalog = opts.catalog ?? loadModuleCatalog({ root: opts.root, home: opts.home });
    const selected = [];
    const rejected = [];
    for (const module of catalog.modules) {
        if (isAcceptanceBearing(module)) {
            // B1: acceptance is operator-owned and frozen before composition; a module cannot supply it.
            rejected.push({
                moduleId: module.id,
                reason: 'carries an acceptance field — composition modules may contribute capability/guidance, never an AcceptanceContract (B1)',
            });
            continue;
        }
        if (moduleMatchesTags(module, detection.tags)) {
            selected.push({
                moduleId: module.id,
                kind: module.kind,
                selectedBecause: module.origin, // 'declared' | 'discovered'
                matchedTags: module.tags,
            });
        }
    }
    return {
        schema_version: 1,
        root: opts.root,
        goal: opts.goal,
        detection,
        selected,
        rejected,
        catalogSources: catalog.sources,
    };
}
function isAcceptanceBearing(module) {
    return module.acceptance !== undefined && module.acceptance !== null;
}
/** Render a MagicPlan as plain text for `maestro magic plan`. */
export function formatMagicPlan(plan) {
    const lines = [];
    lines.push(`magic plan for ${plan.root}`);
    lines.push(`goal: ${plan.goal}`);
    lines.push(`detected tags: ${plan.detection.tags.length ? plan.detection.tags.join(', ') : '(none)'}`);
    lines.push('');
    lines.push(`selected modules (${plan.selected.length}):`);
    if (plan.selected.length === 0)
        lines.push('  (none — no catalog module\'s tags are a subset of the detected tags)');
    for (const s of plan.selected) {
        lines.push(`  - ${s.moduleId} [${s.kind}] via ${s.selectedBecause} (tags: ${s.matchedTags.join(', ')})`);
    }
    if (plan.rejected.length) {
        lines.push('');
        lines.push(`rejected modules (${plan.rejected.length}):`);
        for (const r of plan.rejected)
            lines.push(`  - ${r.moduleId}: ${r.reason}`);
    }
    lines.push('');
    lines.push(`catalog sources: ${plan.catalogSources.length ? plan.catalogSources.join(', ') : '(none)'}`);
    lines.push('NOTE: dry-run only — slice 1 resolves and prints; it injects nothing and changes no run.');
    return lines.join('\n');
}

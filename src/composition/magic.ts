import { type CatalogModule, loadModuleCatalog, type ModuleCatalog, type ModuleKind, moduleMatchesTags } from './catalog.js';
import { detectProjectSignals, type ProjectSignals } from './detect.js';

export type SelectedBecause = 'declared' | 'discovered' | 'learned' | 'operator';

export interface MagicSelection {
  moduleId: string;
  kind: ModuleKind;
  selectedBecause: SelectedBecause;
  matchedTags: string[];
}

export interface MagicRejection {
  moduleId: string;
  reason: string;
}

/**
 * The resolved dry-run composition for a project + goal. This is the slice-1 "magic plan": detect →
 * resolve, NO injection and NO change to the run lifecycle. It records what WOULD be composed and
 * why, so an operator can inspect before slice-2 injection ever touches a worktree.
 */
export interface MagicPlan {
  schema_version: 1;
  root: string;
  goal: string;
  detection: ProjectSignals;
  selected: MagicSelection[];
  /** Modules excluded for a principled reason (esp. B1 acceptance-bearing). Surfaced, never silent. */
  rejected: MagicRejection[];
  catalogSources: string[];
}

/**
 * Resolve the dry-run composition. Selection is by flat tag subset only (B5). Critic-panel B1 is
 * enforced here: any catalog module carrying an `acceptance` field is REJECTED, not selected —
 * acceptance is operator-owned and must never arrive via `declared`/`discovered`/`learned`
 * provenance (that would let a module self-certify the completion bar). This function is pure and
 * side-effect-free; it injects nothing and changes no run state.
 */
export function resolveMagicPlan(opts: {
  root: string;
  goal: string;
  signals?: ProjectSignals;
  catalog?: ModuleCatalog;
  home?: string;
}): MagicPlan {
  const detection = opts.signals ?? detectProjectSignals(opts.root);
  const catalog = opts.catalog ?? loadModuleCatalog({ root: opts.root, home: opts.home });

  const selected: MagicSelection[] = [];
  const rejected: MagicRejection[] = [];

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

function isAcceptanceBearing(module: CatalogModule): boolean {
  return module.acceptance !== undefined && module.acceptance !== null;
}

/** Render a MagicPlan as plain text for `warden magic plan`. */
export function formatMagicPlan(plan: MagicPlan): string {
  const lines: string[] = [];
  lines.push(`magic plan for ${plan.root}`);
  lines.push(`goal: ${plan.goal}`);
  lines.push(`detected tags: ${plan.detection.tags.length ? plan.detection.tags.join(', ') : '(none)'}`);
  lines.push('');
  lines.push(`selected modules (${plan.selected.length}):`);
  if (plan.selected.length === 0) lines.push('  (none — no catalog module\'s tags are a subset of the detected tags)');
  for (const s of plan.selected) {
    lines.push(`  - ${s.moduleId} [${s.kind}] via ${s.selectedBecause} (tags: ${s.matchedTags.join(', ')})`);
  }
  if (plan.rejected.length) {
    lines.push('');
    lines.push(`rejected modules (${plan.rejected.length}):`);
    for (const r of plan.rejected) lines.push(`  - ${r.moduleId}: ${r.reason}`);
  }
  lines.push('');
  lines.push(`catalog sources: ${plan.catalogSources.length ? plan.catalogSources.join(', ') : '(none)'}`);
  lines.push('NOTE: dry-run only — slice 1 resolves and prints; it injects nothing and changes no run.');
  return lines.join('\n');
}

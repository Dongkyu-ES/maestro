// core.ts — thin re-export façade (critique #5). The run-lifecycle engine now lives in
// ./run/lifecycle.ts; project/run/index domains live under ./project and ./run. This file only
// re-exports the public API so every existing importer (cli.ts, view.ts, harness/*, tests) keeps
// working unchanged. No logic lives here.
export { AGENT_DIR, ensureDir, frontmatter, git, isSecretPath, nowIso, parseFrontmatter, projectRoot, readYaml, redact, registryPath, safeJoin, slug, uniqueId, writeIfMissing, yaml, } from './util.js';
export { loadRegistry, saveRegistry, addProject, listProjects, removeProject, initProject, } from './project/registry.js';
export { addTask, listTasks, taskPath, updateTaskStatus, updateTask } from './project/task.js';
export { createApproval, listApprovals, resolveApproval } from './project/approvals.js';
export { classifyRunPromotions, listPromotions, resolvePromotion, applyApprovedPromotion } from './project/promotions.js';
export { rebuildIndex, rebuildRuntimeProjectionStore, listFilesRecursive, loadIndex } from './project/index-builder.js';
export { proposeApply, applyApprovedProposal } from './project/apply.js';
export { runProcessJsonFiles, readRunProcessSummary, normalizeRunMeta, activeStatus, cleanupWorktrees, } from './run/run-utils.js';
export { createRun, latestRunId, runPath, startRun, collectRun, cancelRun, runtimeTruthForRun, extractFilesChanged, reconcileRuns, } from './run/lifecycle.js';

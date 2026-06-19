import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { rebuildIndex } from './index-builder.js';
import {
  AGENT_DIR,
  type ProjectRecord,
  ensureDir,
  nowIso,
  projectRoot,
  readYaml,
  registryPath,
  safeJoin,
  slug,
  writeIfMissing,
  yaml,
} from '../util.js';

export function loadRegistry(): ProjectRecord[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectRecord[];
}

export function saveRegistry(records: ProjectRecord[]): void {
  const p = registryPath();
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(records, null, 2));
}

export function listProjects(): ProjectRecord[] {
  return loadRegistry();
}

export function removeProject(id: string): void {
  saveRegistry(loadRegistry().filter((p) => p.id !== id));
}

export function initProject(cwd = process.cwd()): string[] {
  const root = projectRoot(cwd);
  const created: string[] = [];
  const agent = safeJoin(root, AGENT_DIR);
  ensureDir(agent);
  const ts = nowIso();
  const projectId = slug(basename(root));
  const files: [string, string][] = [
    [
      'project.yaml',
      yaml({
        schema_version: 1,
        id: projectId,
        name: basename(root),
        root_path: root,
        agent_dir: AGENT_DIR,
        default_executor: 'command',
        created_at: ts,
        updated_at: ts,
      }),
    ],
    [
      'policies/tool-policy.yaml',
      `defaults:\n  max_workers: 3\n  require_approval_for_writes: true\n  require_approval_for_network: true\n  require_approval_for_shell_mutation: true\n\ntools:\n  filesystem.read:\n    default: allow\n  filesystem.write:\n    default: require_approval\n  shell.readonly:\n    default: allow\n  shell.mutating:\n    default: require_approval\n  git.status:\n    default: allow\n  git.diff:\n    default: allow\n  git.commit:\n    default: require_approval\n  git.push:\n    default: require_approval\n`,
    ],
    [
      'policies/approval-policy.yaml',
      `approvals:\n  file_write:\n    required: true\n    auto_approve_paths:\n      - ".agent/runs/"\n  apply_patch:\n    required: true\n  package_install:\n    required: true\n  git_commit:\n    required: true\n  git_push:\n    required: true\n`,
    ],
    [
      'evals/rubric.md',
      `# Agent Run Review Rubric\n\n- Goal Fit: 0-2\n- Artifact Boundary: 0-2\n- Tool Discipline: 0-2\n- Reviewability: 0-2\n- Reusability: 0-2\n\nPass: score >= 8 and no blocking issue.\n`,
    ],
  ];
  for (const [rel, content] of files)
    if (writeIfMissing(safeJoin(root, AGENT_DIR, rel), content)) created.push(`${AGENT_DIR}/${rel}`);
  for (const dir of ['tasks', 'runs', 'logs', 'cache', 'approvals', 'promotions', 'worktrees'])
    ensureDir(safeJoin(root, AGENT_DIR, dir));
  rebuildIndex(root);
  return created;
}

export function addProject(rootPath = process.cwd()): ProjectRecord {
  const root = projectRoot(rootPath);
  initProject(root);
  const ts = nowIso();
  const existing = loadRegistry().filter((p) => p.root_path !== root);
  const rec: ProjectRecord = {
    schema_version: 1,
    id: slug(basename(root)),
    name: basename(root),
    root_path: root,
    agent_dir: AGENT_DIR,
    created_at: ts,
    updated_at: ts,
    last_opened_at: ts,
  };
  saveRegistry([...existing, rec]);
  return rec;
}

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebuildIndex } from './index-builder.js';
import { initProject } from './registry.js';
import {
  AGENT_DIR,
  type TaskMeta,
  type TaskStatus,
  frontmatter,
  nowIso,
  parseFrontmatter,
  projectRoot,
  safeJoin,
  uniqueId,
} from '../util.js';

const TASK_STATUSES = new Set([
  'inbox',
  'scoped',
  'ready',
  'running',
  'review',
  'changes_requested',
  'done',
  'blocked',
  'cancelled',
  'abandoned',
]);

export function taskPath(taskId: string, cwd = process.cwd()): string {
  return safeJoin(projectRoot(cwd), AGENT_DIR, 'tasks', `${taskId}.md`);
}

export function listTasks(cwd = process.cwd()): TaskMeta[] {
  const root = projectRoot(cwd);
  const dir = safeJoin(root, AGENT_DIR, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const meta = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
      return {
        schema_version: Number(meta.schema_version || 1),
        id: meta.id || f.replace(/\.md$/, ''),
        title: meta.title || meta.id || f,
        status: (meta.status || 'ready') as TaskStatus,
        priority: (meta.priority || 'normal') as 'normal',
        created_at: meta.created_at || '',
        updated_at: meta.updated_at || '',
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function addTask(title: string, cwd = process.cwd()): TaskMeta {
  initProject(cwd);
  const root = projectRoot(cwd);
  const ts = nowIso();
  const id = uniqueId('task', title);
  const meta: TaskMeta = {
    schema_version: 1,
    id,
    title,
    status: 'ready',
    priority: 'normal',
    created_at: ts,
    updated_at: ts,
  };
  const body = `# Task: ${title}\n\n## Goal\n${title}\n\n## Context\n\n## Constraints\n\n## Done Means\n\n## Preferred Executor\ncommand\n\n## Notes\n`;
  writeFileSync(
    safeJoin(root, AGENT_DIR, 'tasks', `${id}.md`),
    frontmatter(meta as unknown as Record<string, unknown>, body),
  );
  rebuildIndex(root);
  return meta;
}

export function updateTaskStatus(taskId: string, status: TaskStatus, cwd = process.cwd()): void {
  if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
  const p = taskPath(taskId, cwd);
  const text = readFileSync(p, 'utf8');
  const meta = { ...parseFrontmatter(text), status, updated_at: nowIso() };
  const body = text.slice(text.indexOf('\n---', 4) + 4).trim();
  writeFileSync(p, frontmatter(meta, body));
  rebuildIndex(cwd);
}

export function updateTask(
  taskId: string,
  fields: Partial<Pick<TaskMeta, 'title' | 'status' | 'priority'>>,
  cwd = process.cwd(),
): TaskMeta {
  if (fields.status !== undefined && !TASK_STATUSES.has(fields.status))
    throw new Error(`invalid task status: ${fields.status}`);
  const p = taskPath(taskId, cwd);
  const text = readFileSync(p, 'utf8');
  const old = parseFrontmatter(text);
  const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const meta = { ...old, ...cleanFields, updated_at: nowIso() };
  const body = text.slice(text.indexOf('\n---', 4) + 4).trim();
  writeFileSync(p, frontmatter(meta, body));
  rebuildIndex(cwd);
  return listTasks(cwd).find((t) => t.id === taskId)!;
}

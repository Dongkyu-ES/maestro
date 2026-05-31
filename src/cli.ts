#!/usr/bin/env node
import { createServer } from 'node:http';
import { addTask, collectRun, createRun, initProject, latestRunId, listTasks, renderHtml, renderRun, taskPath } from './core.js';
import { existsSync, readFileSync } from 'node:fs';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function has(name: string): boolean { return process.argv.includes(name); }

async function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  try {
    if (cmd === 'init') {
      const created = initProject();
      console.log(created.length ? `created:\n${created.join('\n')}` : '.agent already initialized');
      return;
    }
    if (cmd === 'task' && sub === 'add') {
      const title = rest.join(' ').trim();
      if (!title) throw new Error('usage: agent task add "title"');
      const task = addTask(title);
      console.log(`${task.id}\t${task.title}`);
      return;
    }
    if (cmd === 'task' && sub === 'list') {
      for (const t of listTasks()) console.log(`${t.id}\t${t.status}\t${t.title}`);
      return;
    }
    if (cmd === 'task' && sub === 'show') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task show <task-id>');
      const p = taskPath(id);
      if (!existsSync(p)) throw new Error(`task not found: ${id}`);
      console.log(readFileSync(p, 'utf8'));
      return;
    }
    if (cmd === 'run' && sub === 'create') {
      const id = rest.find((x) => !x.startsWith('--'));
      if (!id) throw new Error('usage: agent run create <task-id> [--mode roles|multi] [--max-workers N]');
      const mode = (arg('--mode', has('--multi') ? 'multi' : has('--roles') ? 'roles' : 'basic') || 'basic') as 'basic' | 'roles' | 'multi';
      const maxWorkers = Number(arg('--max-workers', '2'));
      const run = createRun(id, { mode, maxWorkers });
      console.log(`run: ${run.id}`);
      console.log(`prompt: ${run.run_dir}/prompt.md`);
      console.log(`handoff: omx --prompt-file ${run.run_dir}/prompt.md`);
      return;
    }
    if (cmd === 'run' && sub === 'collect') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run collect <run-id>');
      const run = collectRun(id);
      console.log(`collected: ${run.id}\nstatus: ${run.status}`);
      return;
    }
    if (cmd === 'run' && sub === 'latest') {
      console.log(latestRunId() || 'no runs');
      return;
    }
    if (cmd === 'review' && sub === 'latest') {
      const id = latestRunId();
      if (!id) throw new Error('no runs');
      console.log(readFileSync(`.agent/runs/${id}/review.md`, 'utf8'));
      return;
    }
    if (cmd === 'web') {
      const port = Number(arg('--port', '4317'));
      const host = arg('--host', '127.0.0.1')!;
      const unsafeHost = has('--unsafe-host');
      if (!['127.0.0.1', 'localhost'].includes(host) && !unsafeHost) {
        throw new Error('agent web only binds loopback hosts by default; pass --unsafe-host to acknowledge local evidence exposure risk');
      }
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://${host}:${port}`);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (url.pathname.startsWith('/run/')) res.end(renderRun(decodeURIComponent(url.pathname.slice(5))));
        else res.end(renderHtml());
      });
      server.listen(port, host, () => console.log(`agent web listening at http://${host}:${port}`));
      return;
    }
    console.log(`usage:\n  agent init\n  agent task add|list|show\n  agent run create|collect|latest\n  agent review latest\n  agent web [--host 127.0.0.1] [--port 4317] [--unsafe-host]`);
  } catch (err: any) {
    console.error(`error: ${err.message || err}`);
    process.exitCode = 1;
  }
}

main();

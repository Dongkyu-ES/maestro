#!/usr/bin/env node
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parse as parseQuery } from 'node:querystring';
import {
  addProject,
  addTask,
  applyApprovedPromotion,
  applyApprovedProposal,
  cancelRun,
  cleanupWorktrees,
  collectRun,
  createApproval,
  createRun,
  initProject,
  latestRunId,
  listApprovals,
  listPromotions,
  listProjects,
  listTasks,
  loadIndex,
  proposeApply,
  rebuildIndex,
  rebuildRuntimeProjectionStore,
  reconcileRuns,
  removeProject,
  resolveApproval,
  resolvePromotion,
  runPath,
  startRun,
  taskPath,
  updateTask,
} from './core.js';
import { readRuntimeEvents } from './events/ledger.js';
import { exerciseCodexAppServerLifecycle } from './harness/codex-lifecycle-exercise.js';
import { writeFullTargetGateArtifact } from './harness/full-target-gate.js';
import { verifyFullTargetGateArtifact } from './harness/full-target-verifier.js';
import { appendM8BoundaryEvidence } from './harness/m8-boundary-evidence.js';
import { writeUiAgreementSmoke } from './harness/ui-agreement.js';
import { runProductGate } from './product-gate.js';
import { renderHtml, renderRun } from './view.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function firstNonFlag(items: string[]): string | undefined {
  return items.find((x) => !x.startsWith('--'));
}
async function readBody(req: any): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return parseQuery(Buffer.concat(chunks).toString()) as Record<string, string>;
}
function redirect(res: any, path = '/') {
  res.statusCode = 303;
  res.setHeader('location', path);
  res.end('redirect');
}
function cookieValue(req: any, name: string): string {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function usage(): string {
  return `usage:
  agent --help|--version
  agent init
  agent project add|list|show|remove
  agent index rebuild|show
  agent task add|list|show|status|update|archive
  agent run create|start|collect|cancel|latest
  agent runtime projection
  agent runtime full-target-gate <run-id> [--append-pass-event]
  agent runtime m8-boundary-evidence <run-id>
  agent runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>
  agent runtime ui-agreement <run-id>
  agent runtime verify-full-target <run-id> [--append-verified-event]
  agent review latest
  agent approvals
  agent approval request|approve|reject
  agent apply propose|approved
  agent promotions
  agent promotion approve|reject|apply <id>
  agent worktrees cleanup
  agent maintenance reconcile-runs
  agent quality gate [--write]
  agent web [--host 127.0.0.1] [--port 4317] [--unsafe-host]`;
}

async function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  try {
    if (cmd === '--version' || cmd === 'version') {
      console.log('dominic-orchestration 0.1.0');
      return;
    }
    if (cmd === '--help' || cmd === 'help' || !cmd) {
      console.log(usage());
      return;
    }
    if (cmd === 'init') {
      const created = initProject();
      console.log(created.length ? `created:\n${created.join('\n')}` : '.agent already initialized');
      return;
    }
    if (cmd === 'project' && sub === 'add') {
      const rec = addProject(rest[0] || process.cwd());
      console.log(`${rec.id}\t${rec.root_path}`);
      return;
    }
    if (cmd === 'project' && sub === 'list') {
      for (const p of listProjects()) console.log(`${p.id}\t${p.root_path}`);
      return;
    }
    if (cmd === 'project' && sub === 'show') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent project show <id>');
      const project = listProjects().find((p) => p.id === id);
      if (!project) throw new Error(`project not found: ${id}`);
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    if (cmd === 'project' && sub === 'remove') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent project remove <id>');
      removeProject(id);
      return;
    }
    if (cmd === 'index' && sub === 'rebuild') {
      console.log(JSON.stringify(rebuildIndex(), null, 2));
      return;
    }
    if (cmd === 'index' && sub === 'show') {
      console.log(JSON.stringify(loadIndex(), null, 2));
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
    if (cmd === 'task' && sub === 'status') {
      const id = rest[0];
      const status = rest[1] as any;
      if (!id || !status) throw new Error('usage: agent task status <task-id> <status>');
      console.log(JSON.stringify(updateTask(id, { status }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'update') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task update <task-id> [--title title] [--status status]');
      console.log(JSON.stringify(updateTask(id, { title: arg('--title'), status: arg('--status') as any }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'archive') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task archive <task-id>');
      console.log(JSON.stringify(updateTask(id, { status: 'abandoned' }), null, 2));
      return;
    }
    if (cmd === 'run' && sub === 'create') {
      const id = firstNonFlag(rest);
      if (!id)
        throw new Error(
          'usage: agent run create <task-id> [--mode roles|multi] [--executor command|codex|omx|agy] [--max-workers N] [--command cmd]',
        );
      const mode = (arg('--mode', has('--multi') ? 'multi' : has('--roles') ? 'roles' : 'basic') || 'basic') as any;
      const maxWorkers = Number(arg('--max-workers', '2'));
      const command = arg('--command');
      const executor = (arg('--executor', 'command') || 'command') as any;
      const run = createRun(id, { mode, executor, maxWorkers, command });
      console.log(`run: ${run.id}`);
      console.log(`prompt: ${run.run_dir}/prompt.md`);
      return;
    }
    if (cmd === 'run' && sub === 'start') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run start <run-id> [--command cmd]');
      const run = await startRun(id, { command: arg('--command'), timeoutMs: Number(arg('--timeout-ms', '30000')) });
      console.log(`started: ${run.id}\nstatus: ${run.status}`);
      return;
    }
    if (cmd === 'run' && sub === 'collect') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run collect <run-id>');
      const run = collectRun(id);
      console.log(`collected: ${run.id}\nstatus: ${run.status}\ndecision: ${run.decision}`);
      return;
    }
    if (cmd === 'run' && sub === 'cancel') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run cancel <run-id>');
      cancelRun(id);
      console.log(`cancelled: ${id}`);
      return;
    }
    if (cmd === 'run' && sub === 'latest') {
      console.log(latestRunId() || 'no runs');
      return;
    }
    if (cmd === 'runtime' && sub === 'projection') {
      console.log(JSON.stringify(rebuildRuntimeProjectionStore(), null, 2));
      return;
    }
    if (cmd === 'runtime' && sub === 'full-target-gate') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime full-target-gate <run-id> [--append-pass-event]');
      const report = writeFullTargetGateArtifact({
        root: process.cwd(),
        agentDir: '.agent',
        runId: id,
        appendPassEvent: has('--append-pass-event'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'm8-boundary-evidence') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime m8-boundary-evidence <run-id>');
      console.log(
        JSON.stringify(appendM8BoundaryEvidence({ root: process.cwd(), agentDir: '.agent', runId: id }), null, 2),
      );
      return;
    }
    if (cmd === 'runtime' && sub === 'codex-lifecycle-proof') {
      const id = firstNonFlag(rest) || latestRunId();
      const threadId = arg('--thread-id');
      if (!id || !threadId)
        throw new Error('usage: agent runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>');
      const report = await exerciseCodexAppServerLifecycle({
        root: process.cwd(),
        agentDir: '.agent',
        runId: id,
        threadId,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'ui-agreement') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime ui-agreement <run-id>');
      const report = writeUiAgreementSmoke({ root: process.cwd(), agentDir: '.agent', runId: id });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'verify-full-target') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime verify-full-target <run-id> [--append-verified-event]');
      const report = verifyFullTargetGateArtifact({
        agentDir: '.agent',
        runId: id,
        appendVerifiedEvent: has('--append-verified-event'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'review' && sub === 'latest') {
      const id = latestRunId();
      if (!id) throw new Error('no runs');
      console.log(readFileSync(`.agent/runs/${id}/review.md`, 'utf8'));
      return;
    }
    if (cmd === 'approvals' && !sub) {
      for (const a of listApprovals()) console.log(`${a.id}\t${a.status}\t${a.risk}\t${a.type}\t${a.summary}`);
      return;
    }
    if (cmd === 'approval' && (sub === 'approve' || sub === 'reject')) {
      const id = rest[0];
      if (!id) throw new Error(`usage: agent approval ${sub} <id>`);
      console.log(JSON.stringify(resolveApproval(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'approval' && sub === 'request') {
      const runId = rest[0] || latestRunId();
      if (!runId) throw new Error('usage: agent approval request <run-id>');
      console.log(
        JSON.stringify(
          createApproval(runId, arg('--type', 'manual')!, 'medium', arg('--summary', 'manual approval request')!),
          null,
          2,
        ),
      );
      return;
    }
    if (cmd === 'apply' && sub === 'propose') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent apply propose <run-id>');
      console.log(JSON.stringify(proposeApply(id), null, 2));
      return;
    }
    if (cmd === 'apply' && sub === 'approved') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent apply approved <approval-id>');
      console.log(JSON.stringify(applyApprovedProposal(id), null, 2));
      return;
    }
    if (cmd === 'promotions' && !sub) {
      for (const p of listPromotions()) console.log(`${p.id}\t${p.status}\t${p.target_type}\t${p.reason}`);
      return;
    }
    if (cmd === 'promotion' && (sub === 'approve' || sub === 'reject')) {
      const id = rest[0];
      if (!id) throw new Error(`usage: agent promotion ${sub} <id>`);
      console.log(JSON.stringify(resolvePromotion(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'promotion' && sub === 'apply') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent promotion apply <id>');
      console.log(JSON.stringify(applyApprovedPromotion(id), null, 2));
      return;
    }
    if (cmd === 'worktrees' && sub === 'cleanup') {
      cleanupWorktrees();
      console.log('worktrees cleaned');
      return;
    }
    if (cmd === 'maintenance' && sub === 'reconcile-runs') {
      console.log(JSON.stringify(reconcileRuns(), null, 2));
      return;
    }
    if (cmd === 'quality' && sub === 'gate') {
      reconcileRuns();
      const report = runProductGate(process.cwd(), { write: has('--write') });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'web') {
      await serveWeb();
      return;
    }
    console.log(usage());
  } catch (err: any) {
    console.error(`error: ${err.message || err}`);
    process.exitCode = 1;
  }
}

async function serveWeb(): Promise<void> {
  const csrfToken = randomBytes(24).toString('hex');
  const port = Number(arg('--port', '4317'));
  const host = arg('--host', '127.0.0.1')!;
  const unsafeHost = has('--unsafe-host');
  if (!['127.0.0.1', 'localhost'].includes(host) && !unsafeHost)
    throw new Error(
      'agent web only binds loopback hosts by default; pass --unsafe-host with --auth-token to acknowledge remote command/control risk',
    );
  const authToken = arg('--auth-token') || process.env.AGENT_WEB_TOKEN || '';
  if (unsafeHost && !authToken)
    throw new Error(
      '--unsafe-host requires --auth-token or AGENT_WEB_TOKEN because web controls can execute local commands',
    );
  const allowedOrigins = new Set([`http://${host}:${port}`]);
  if (host === '127.0.0.1' || host === 'localhost') {
    allowedOrigins.add(`http://127.0.0.1:${port}`);
    allowedOrigins.add(`http://localhost:${port}`);
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    try {
      const providedAuth = () =>
        url.searchParams.get('auth') || String(req.headers['x-agent-auth'] || '') || cookieValue(req, 'agent_auth');
      const requireRemoteAuth = (provided: string): void => {
        if (!authToken) return;
        const ok =
          provided.length === authToken.length && timingSafeEqual(Buffer.from(provided), Buffer.from(authToken));
        if (!ok) throw new Error('invalid auth token');
      };
      const requirePageAuth = (): void => {
        if (!authToken) return;
        const provided = providedAuth();
        requireRemoteAuth(provided);
        if (url.searchParams.get('auth') === authToken)
          res.setHeader('set-cookie', `agent_auth=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/`);
      };
      const requirePostAuth = async (): Promise<Record<string, string>> => {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(String(origin))) throw new Error('invalid origin');
        const body = await readBody(req);
        requireRemoteAuth(body.auth || String(req.headers['x-agent-auth'] || '') || cookieValue(req, 'agent_auth'));
        const token = body.csrf || '';
        const ok = token.length === csrfToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken));
        if (!ok) throw new Error('invalid csrf token');
        return body;
      };
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await requirePostAuth();
        addTask(body.title || 'Untitled task');
        redirect(res);
        return;
      }
      const taskUpdateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/update$/);
      if (req.method === 'POST' && taskUpdateMatch) {
        const body = await requirePostAuth();
        updateTask(taskUpdateMatch[1], { title: body.title || undefined, status: (body.status as any) || undefined });
        redirect(res);
        return;
      }
      const taskArchiveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (req.method === 'POST' && taskArchiveMatch) {
        await requirePostAuth();
        updateTask(taskArchiveMatch[1], { status: 'abandoned' });
        redirect(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const body = await requirePostAuth();
        createRun(body.taskId, { mode: (body.mode || 'basic') as any, source: 'web' });
        redirect(res);
        return;
      }
      const startMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/start$/);
      if (req.method === 'POST' && startMatch) {
        const body = await requirePostAuth();
        await startRun(startMatch[1], {
          command: body.confirmCommand === 'yes' ? body.command || undefined : undefined,
        });
        redirect(res, `/run/${startMatch[1]}`);
        return;
      }
      const collectMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/collect$/);
      if (req.method === 'POST' && collectMatch) {
        await requirePostAuth();
        collectRun(collectMatch[1]);
        redirect(res, `/run/${collectMatch[1]}`);
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        await requirePostAuth();
        cancelRun(cancelMatch[1]);
        redirect(res, `/run/${cancelMatch[1]}`);
        return;
      }
      const proposeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/apply-proposal$/);
      if (req.method === 'POST' && proposeMatch) {
        await requirePostAuth();
        proposeApply(proposeMatch[1]);
        redirect(res, `/run/${proposeMatch[1]}`);
        return;
      }
      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        await requirePostAuth();
        resolveApproval(approveMatch[1], 'approved');
        redirect(res);
        return;
      }
      const rejectMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectMatch) {
        await requirePostAuth();
        resolveApproval(rejectMatch[1], 'rejected');
        redirect(res);
        return;
      }
      const applyMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/apply$/);
      if (req.method === 'POST' && applyMatch) {
        await requirePostAuth();
        applyApprovedProposal(applyMatch[1]);
        redirect(res);
        return;
      }
      const eventStreamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === 'GET' && eventStreamMatch) {
        requirePageAuth();
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        let sent = 0;
        const send = () => {
          const events = readRuntimeEvents(runPath(eventStreamMatch[1]));
          for (const event of events.slice(sent)) res.write(`event: runtime\\ndata: ${JSON.stringify(event)}\\n\\n`);
          sent = events.length;
        };
        send();
        const timer = setInterval(send, 500);
        const end = setTimeout(() => {
          clearInterval(timer);
          res.end();
        }, 30000);
        req.on('close', () => {
          clearInterval(timer);
          clearTimeout(end);
        });
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      requirePageAuth();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname.startsWith('/run/')) res.end(renderRun(decodeURIComponent(url.pathname.slice(5))));
      else if (url.pathname === '/') res.end(renderHtml(process.cwd(), csrfToken));
      else {
        res.statusCode = 404;
        res.end('not found');
      }
    } catch (err: any) {
      res.statusCode = 500;
      res.end(String(err.message || err));
    }
  });
  server.listen(port, host, () => console.log(`agent web listening at http://${host}:${port}`));
}

main();

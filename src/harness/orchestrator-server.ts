import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { readRuntimeEvents } from '../events/ledger.js';
import { makeCliExecutor } from './compare.js';
import type { HarnessExecutor } from './harness-run.js';
import { type GraphNode, reconcileWorkers, runTaskGraph } from './orchestrator.js';

// A long-running orchestrator daemon (A-option): accepts a STRUCTURED task DAG over HTTP,
// routes each node to an executor by a THIN DETERMINISTIC rule (declared kind/purpose — no
// model in the control plane), runs it through the verifier-gated graph, and optionally
// reconciles. The ledger stays the SSOT; the server is a front-end over it.

export type ExecutorKind = 'codex' | 'claude' | 'agy';

export interface ExecutorRegistry {
  resolve(kind: ExecutorKind): HarnessExecutor | undefined; // undefined = native codex (runHarnessSlice default)
  has(kind: string): kind is ExecutorKind;
}

// Static, declarative purpose→executor map. Deterministic by design — routing must never
// depend on an LLM classifying intent (that would drift toward owning the agent loop).
const PURPOSE_MAP: Record<string, ExecutorKind> = {
  'code-edit': 'codex',
  implement: 'codex',
  research: 'claude',
  review: 'claude',
  visual: 'agy',
};

export function defaultExecutorRegistry(): ExecutorRegistry {
  const claude = makeCliExecutor({
    name: 'claude',
    bin: 'claude',
    buildArgs: (p) => ['-p', p, '--permission-mode', 'acceptEdits'],
  });
  const agy = makeCliExecutor({
    name: 'agy',
    bin: 'agy',
    buildArgs: (p) => ['-p', p, '--dangerously-skip-permissions'],
  });
  const table: Record<ExecutorKind, HarnessExecutor | undefined> = { codex: undefined, claude, agy };
  return {
    resolve: (kind) => table[kind],
    has: (kind): kind is ExecutorKind => kind === 'codex' || kind === 'claude' || kind === 'agy',
  };
}

interface SubmittedNode {
  id: string;
  goal: string;
  deps?: string[];
  executor?: string;
  purpose?: string;
}

// The deterministic router: declared executor wins, else purpose map, else codex default.
function routeNode(
  node: SubmittedNode,
  registry: ExecutorRegistry,
): { kind: ExecutorKind; executor: HarnessExecutor | undefined } {
  const kind =
    node.executor && registry.has(node.executor)
      ? (node.executor as ExecutorKind)
      : node.purpose && PURPOSE_MAP[node.purpose]
        ? PURPOSE_MAP[node.purpose]
        : 'codex';
  return { kind, executor: registry.resolve(kind) };
}

export async function runSubmittedGraph(options: {
  root: string;
  registry: ExecutorRegistry;
  goal?: string;
  nodes: SubmittedNode[];
  reconcileVerifyCmd?: string;
  reconcile?: boolean;
  concurrency?: number;
  maxNodes?: number;
  runId?: string;
}) {
  const routed: GraphNode[] = options.nodes.map((n) => ({
    id: n.id,
    goal: n.goal,
    deps: n.deps,
    executor: routeNode(n, options.registry).executor,
  }));
  const routing = options.nodes.map((n) => ({ id: n.id, kind: routeNode(n, options.registry).kind }));
  const graph = await runTaskGraph({
    root: options.root,
    goal: options.goal,
    nodes: routed,
    concurrency: options.concurrency,
    maxNodes: options.maxNodes,
    runId: options.runId,
  });
  let reconcile: ReturnType<typeof reconcileWorkers> | undefined;
  if (options.reconcile) {
    const supported = graph.nodes
      .filter((n) => n.nodeState === 'supported')
      .map((n) => ({ workerId: n.workerId, branch: n.branch, worktreePath: n.worktreePath }));
    reconcile = reconcileWorkers({
      root: options.root,
      reconId: `recon-${graph.parentRunId.slice(-8)}`,
      order: supported,
      verifyCmd: options.reconcileVerifyCmd,
      parentRunDir: graph.parentRunDir,
    });
  }
  return { routing, graph, reconcile };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createOrchestratorServer(options: {
  root: string;
  registry?: ExecutorRegistry;
  authToken?: string;
  host?: string;
}): Server {
  const root = resolve(options.root);
  const registry = options.registry ?? defaultExecutorRegistry();
  const host = options.host ?? '127.0.0.1';
  const authToken = options.authToken ?? process.env.AGENT_ORCH_TOKEN ?? '';

  // In-memory job projection over the ledger SSOT: a graph runs in the background and its
  // result is referenced by jobId == parentRunId, so /jobs/:id and the SSE event stream
  // share one id. Lost on restart, but the run dirs (the real evidence) persist.
  type Job = { status: 'running' | 'done' | 'error'; submittedAt: string; result?: unknown; error?: string };
  const jobs = new Map<string, Job>();

  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authed = () => {
      if (!authToken) return true;
      const provided = String(req.headers['x-agent-auth'] || url.searchParams.get('auth') || '');
      return constantTimeEqual(provided, authToken);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health')
        return json(200, { ok: true, kinds: ['codex', 'claude', 'agy'] });

      if (!authed()) return json(401, { error: 'invalid auth token' });

      if (req.method === 'POST' && url.pathname === '/graph') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        let body: {
          goal?: string;
          nodes?: SubmittedNode[];
          reconcile?: boolean;
          verifyCmd?: string;
          concurrency?: number;
          maxNodes?: number;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch {
          return json(400, { error: 'invalid JSON body' });
        }
        if (!Array.isArray(body.nodes) || body.nodes.length === 0) return json(400, { error: 'nodes[] required' });
        // Async: return a jobId immediately; the graph runs in the background so long
        // fan-outs don't hold the connection. Poll /jobs/:id, stream /runs/:id/events.
        const jobId = `graph-${randomUUID()}`;
        jobs.set(jobId, { status: 'running', submittedAt: new Date().toISOString() });
        const submitted = { ...body };
        const settle = (job: Job) => {
          jobs.set(jobId, job);
          // Persist the outcome into the run dir (the ledger SSOT location) so a restarted
          // daemon can recover job status from disk rather than 404 on a finished job.
          try {
            writeFileSync(
              join(root, '.agent', 'runs', jobId, 'job-result.json'),
              `${JSON.stringify({ jobId, ...job }, null, 2)}\n`,
            );
          } catch {
            /* run dir may be absent on very early failure */
          }
        };
        void runSubmittedGraph({
          root,
          registry,
          goal: submitted.goal,
          nodes: submitted.nodes as SubmittedNode[],
          reconcile: submitted.reconcile === true,
          reconcileVerifyCmd: submitted.verifyCmd,
          concurrency: submitted.concurrency,
          maxNodes: submitted.maxNodes,
          runId: jobId,
        })
          .then((result) => settle({ ...(jobs.get(jobId) as Job), status: 'done', result }))
          .catch((err) =>
            settle({
              ...(jobs.get(jobId) as Job),
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        return json(202, { jobId, status: 'running' });
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([\w-]+)$/);
      if (req.method === 'GET' && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (job) return json(200, { jobId: jobMatch[1], ...job });
        // Recovery: a restarted daemon has an empty in-memory map; read the persisted
        // outcome from the run dir (ledger SSOT). A run dir with no result = still running.
        const resultPath = join(root, '.agent', 'runs', jobMatch[1], 'job-result.json');
        if (existsSync(resultPath)) {
          try {
            return json(200, { recovered: true, ...JSON.parse(readFileSync(resultPath, 'utf8')) });
          } catch {
            /* fall through */
          }
        }
        if (existsSync(join(root, '.agent', 'runs', jobMatch[1])))
          return json(200, { jobId: jobMatch[1], status: 'running', recovered: true });
        return json(404, { error: 'unknown job' });
      }

      const eventsMatch = url.pathname.match(/^\/runs\/([\w-]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const runDir = resolve(root, '.agent', 'runs', eventsMatch[1]);
        // Real SSE: stream new ledger events as they append; end when the job settles.
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        let sent = 0;
        const tick = () => {
          for (const event of readRuntimeEvents(runDir).slice(sent))
            res.write(`event: runtime\ndata: ${JSON.stringify(event)}\n\n`);
          sent = readRuntimeEvents(runDir).length;
          const job = jobs.get(eventsMatch[1]);
          if (job && job.status !== 'running') {
            res.write(`event: end\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
            cleanup();
            res.end();
          }
        };
        const timer = setInterval(tick, 300);
        const deadline = setTimeout(() => {
          cleanup();
          res.end();
        }, 120000);
        function cleanup() {
          clearInterval(timer);
          clearTimeout(deadline);
        }
        req.on('close', cleanup);
        tick();
        return;
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

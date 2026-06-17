import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
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
        const result = await runSubmittedGraph({
          root,
          registry,
          goal: body.goal,
          nodes: body.nodes,
          reconcile: body.reconcile === true,
          reconcileVerifyCmd: body.verifyCmd,
          concurrency: body.concurrency,
          maxNodes: body.maxNodes,
        });
        return json(200, result);
      }

      const eventsMatch = url.pathname.match(/^\/runs\/([\w-]+)\/events$/);
      if (req.method === 'GET' && eventsMatch) {
        const runDir = resolve(root, '.agent', 'runs', eventsMatch[1]);
        return json(200, { runId: eventsMatch[1], events: readRuntimeEvents(runDir) });
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

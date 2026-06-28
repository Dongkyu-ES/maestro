import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { readRuntimeEvents } from '../events/ledger.js';
import { makeCliExecutor } from './compare.js';
import { reconcileWorkers, runTaskGraph } from './orchestrator.js';
// Static, declarative purpose→executor map. Deterministic by design — routing must never
// depend on an LLM classifying intent (that would drift toward owning the agent loop).
const PURPOSE_MAP = {
    'code-edit': 'codex',
    implement: 'codex',
    research: 'claude',
    review: 'claude',
    visual: 'agy',
};
export function defaultExecutorRegistry() {
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
    const table = { codex: undefined, claude, agy };
    return {
        resolve: (kind) => table[kind],
        has: (kind) => kind === 'codex' || kind === 'claude' || kind === 'agy',
    };
}
// The deterministic router: declared executor wins, else purpose map, else codex default.
function routeNode(node, registry) {
    const explicitKind = node.executor?.trim();
    if (explicitKind) {
        if (!registry.has(explicitKind))
            throw new Error(`unknown executor: ${node.executor}`);
        return { kind: explicitKind, executor: registry.resolve(explicitKind) };
    }
    const kind = node.purpose && PURPOSE_MAP[node.purpose] ? PURPOSE_MAP[node.purpose] : 'codex';
    return { kind, executor: registry.resolve(kind) };
}
function routeSubmittedNodes(nodes, registry) {
    const routed = [];
    const routing = [];
    for (const n of nodes) {
        const route = routeNode(n, registry);
        const acceptObject = n.accept && typeof n.accept === 'object' ? n.accept : null;
        const accept = n.accept === undefined
            ? undefined
            : acceptObject &&
                typeof acceptObject.artifactPath === 'string' &&
                typeof acceptObject.sha256 === 'string' &&
                /^[a-fA-F0-9]{64}$/.test(acceptObject.sha256)
                ? { artifactPath: acceptObject.artifactPath, sha256: acceptObject.sha256 }
                : null;
        if (accept === null)
            throw new Error(`invalid accept for node ${n.id}`);
        routed.push({
            id: n.id,
            goal: n.goal,
            deps: n.deps,
            executor: route.executor,
            accept,
        });
        routing.push({ id: n.id, kind: route.kind });
    }
    return { routed, routing };
}
export async function runSubmittedGraph(options) {
    const { routed, routing } = routeSubmittedNodes(options.nodes, options.registry);
    const graph = await runTaskGraph({
        root: options.root,
        goal: options.goal,
        nodes: routed,
        concurrency: options.concurrency,
        maxNodes: options.maxNodes,
        runId: options.runId,
    });
    let reconcile;
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
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function createOrchestratorServer(options) {
    const root = resolve(options.root);
    const registry = options.registry ?? defaultExecutorRegistry();
    const host = options.host ?? '127.0.0.1';
    const remoteBind = !['127.0.0.1', 'localhost'].includes(host);
    const authToken = options.authToken ?? process.env.AGENT_ORCH_TOKEN ?? '';
    const reconcileVerifyCmd = options.reconcileVerifyCmd;
    const jobs = new Map();
    return createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://${host}`);
        const json = (code, body) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const authed = () => {
            const provided = String(req.headers['x-agent-auth'] || url.searchParams.get('auth') || '');
            return constantTimeEqual(provided, authToken);
        };
        try {
            if (req.method === 'GET' && url.pathname === '/health')
                return json(200, { ok: true, kinds: ['codex', 'claude', 'agy'] });
            if (req.method === 'POST' && url.pathname === '/graph') {
                if (!authToken)
                    return json(401, {
                        error: 'graph submission requires an auth token; start orchestrate serve with --auth-token or AGENT_ORCH_TOKEN',
                    });
                if (!authed())
                    return json(401, { error: 'invalid auth token' });
                const chunks = [];
                for await (const c of req)
                    chunks.push(Buffer.from(c));
                let body;
                try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                    if (parsed && typeof parsed === 'object' && 'verifyCmd' in parsed)
                        return json(400, {
                            error: 'verifyCmd is not accepted from requests; configure it at serve start via --verify-cmd / AGENT_ORCH_VERIFY_CMD',
                        });
                    body = parsed;
                }
                catch {
                    return json(400, { error: 'invalid JSON body' });
                }
                if (!Array.isArray(body.nodes) || body.nodes.length === 0)
                    return json(400, { error: 'nodes[] required' });
                try {
                    routeSubmittedNodes(body.nodes, registry);
                }
                catch (err) {
                    return json(400, { error: err instanceof Error ? err.message : String(err) });
                }
                // Async: return a jobId immediately; the graph runs in the background so long
                // fan-outs don't hold the connection. Poll /jobs/:id, stream /runs/:id/events.
                const jobId = `graph-${randomUUID()}`;
                const submittedAt = new Date().toISOString();
                jobs.set(jobId, { status: 'running', submittedAt });
                const runDir = join(root, '.agent', 'runs', jobId);
                mkdirSync(runDir, { recursive: true });
                writeFileSync(join(runDir, 'job-result.json'), `${JSON.stringify({ jobId, status: 'running', submittedAt }, null, 2)}\n`);
                const submitted = { ...body };
                const settle = (job) => {
                    jobs.set(jobId, job);
                    // Persist the outcome into the run dir (the ledger SSOT location) so a restarted
                    // daemon can recover job status from disk rather than 404 on a finished job.
                    try {
                        mkdirSync(join(root, '.agent', 'runs', jobId), { recursive: true });
                        writeFileSync(join(root, '.agent', 'runs', jobId, 'job-result.json'), `${JSON.stringify({ jobId, ...job }, null, 2)}\n`);
                    }
                    catch {
                        /* run dir may be absent on very early failure */
                    }
                };
                void runSubmittedGraph({
                    root,
                    registry,
                    goal: submitted.goal,
                    nodes: submitted.nodes,
                    reconcile: submitted.reconcile === true,
                    reconcileVerifyCmd,
                    concurrency: submitted.concurrency,
                    maxNodes: submitted.maxNodes,
                    runId: jobId,
                })
                    .then((result) => settle({ ...jobs.get(jobId), status: 'done', result }))
                    .catch((err) => settle({
                    ...jobs.get(jobId),
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                }));
                return json(202, { jobId, status: 'running' });
            }
            const jobMatch = url.pathname.match(/^\/jobs\/([\w-]+)$/);
            if (req.method === 'GET' && jobMatch) {
                if (remoteBind && !authed())
                    return json(401, { error: 'invalid auth token' });
                const job = jobs.get(jobMatch[1]);
                if (job)
                    return json(200, { jobId: jobMatch[1], ...job });
                // Recovery: a restarted daemon has an empty in-memory map; read the persisted
                // outcome from the run dir (ledger SSOT). A run dir with no result = still running.
                const resultPath = join(root, '.agent', 'runs', jobMatch[1], 'job-result.json');
                if (existsSync(resultPath)) {
                    try {
                        return json(200, { recovered: true, ...JSON.parse(readFileSync(resultPath, 'utf8')) });
                    }
                    catch {
                        /* fall through */
                    }
                }
                if (existsSync(join(root, '.agent', 'runs', jobMatch[1])))
                    return json(200, { jobId: jobMatch[1], status: 'running', recovered: true });
                return json(404, { error: 'unknown job' });
            }
            const eventsMatch = url.pathname.match(/^\/runs\/([\w-]+)\/events$/);
            if (req.method === 'GET' && eventsMatch) {
                if (remoteBind && !authed())
                    return json(401, { error: 'invalid auth token' });
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
        }
        catch (err) {
            return json(500, { error: err instanceof Error ? err.message : String(err) });
        }
    });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeCliExecutor } from './compare.js';
import { createOrchestratorServer, type ExecutorRegistry } from './orchestrator-server.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orch-server-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fakeCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-srv-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const cwd=args.includes('-C')?args[args.indexOf('-C')+1]:process.cwd();
const prompt=args.at(-1)||'';
const m=prompt.match(/write ([\\w.-]+\\.txt)/);
if(m) fs.writeFileSync(path.join(cwd,m[1]),'work\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

// All kinds resolve to the same fake executor — keeps the test offline/deterministic.
function fakeRegistry(): ExecutorRegistry {
  const exec = makeCliExecutor({ name: 'fake', bin: fakeCodexBin(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  return { resolve: () => exec, has: (k): k is 'codex' | 'claude' | 'agy' => ['codex', 'claude', 'agy'].includes(k) };
}

class MockRequest extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string>;
  private chunks: Buffer[];

  constructor(method: string, url: string, chunks: Buffer[], headers: Record<string, string>) {
    super();
    this.method = method;
    this.url = url;
    this.chunks = chunks;
    this.headers = headers;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    for (const chunk of this.chunks) yield chunk;
  }
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (err: unknown) => void;

  constructor() {
    this.done = new Promise((resolveDone, rejectDone) => {
      this.resolveDone = resolveDone;
      this.rejectDone = rejectDone;
    });
  }

  writeHead(code: number, headers: Record<string, string>) {
    this.statusCode = code;
    this.headers = headers;
    return this;
  }

  write(chunk: unknown) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    return true;
  }

  end(chunk?: unknown) {
    if (chunk !== undefined) this.write(chunk);
    this.resolveDone();
    return this;
  }

  fail(err: unknown) {
    this.rejectDone(err);
  }
}

type JsonObject = Record<string, unknown>;
type MockHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

function asObject(value: unknown): JsonObject {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  return value as JsonObject;
}

function asString(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

function listen(server: Server): Promise<Server> {
  return Promise.resolve(server);
}

async function dispatch(
  server: Server,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const handler = server.listeners('request')[0];
  if (typeof handler !== 'function') throw new Error('server has no request handler');
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = new MockRequest(method, path, chunks, headers);
  const res = new MockResponse();
  try {
    const result = (handler as MockHandler)(req, res);
    Promise.resolve(result).catch((err) => res.fail(err));
  } catch (err) {
    res.fail(err);
  }
  await res.done;
  return { status: res.statusCode, text: res.chunks.join('') };
}

function post(
  server: Server,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: JsonObject }> {
  return dispatch(server, 'POST', path, body, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(JSON.stringify(body))),
    ...headers,
  }).then((res) => ({ status: res.status, json: asObject(JSON.parse(res.text || '{}')) }));
}

function get(
  server: Server,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: JsonObject }> {
  return dispatch(server, 'GET', path, undefined, headers).then((res) => ({
    status: res.status,
    json: asObject(JSON.parse(res.text || '{}')),
  }));
}

async function pollJob(server: Server, jobId: string, headers: Record<string, string> = {}): Promise<JsonObject> {
  for (let i = 0; i < 200; i += 1) {
    const r = await get(server, `/jobs/${jobId}`, headers);
    if (r.json.status !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job did not settle');
}

// Collect an SSE stream until the server emits its `end` event (job settled).
function sse(server: Server, path: string, headers: Record<string, string> = {}): Promise<string> {
  return dispatch(server, 'GET', path, undefined, headers).then((res) => res.text);
}

test('SERVER: async job routes a DAG, settles done, and streams ledger events over SSE', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry(), authToken: 'secret' });
  const port = await listen(server);
  try {
    const submit = await post(
      port,
      '/graph',
      {
        goal: 'server dag',
        reconcile: true,
        nodes: [
          { id: 'schema', goal: 'write schema.txt', executor: 'codex' },
          { id: 'api', goal: 'write api.txt', deps: ['schema'], purpose: 'research' }, // purpose→claude
        ],
      },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(submit.status, 202);
    const jobId = asString(submit.json.jobId);
    assert.ok(jobId);

    const job = await pollJob(port, jobId);
    const result = asObject(job.result);
    const graph = asObject(result.graph);
    const reconcile = asObject(result.reconcile);
    assert.equal(job.status, 'done');
    assert.equal(graph.supportedCount, 2);
    assert.equal(graph.waves, 2);
    assert.deepEqual(result.routing, [
      { id: 'schema', kind: 'codex' },
      { id: 'api', kind: 'claude' },
    ]);
    assert.deepEqual((reconcile.merged as string[]).sort(), ['api', 'schema']);

    // SSE replays the parent ledger and ends when the job settled.
    const stream = await sse(port, `/runs/${jobId}/events`);
    assert.ok(stream.includes('orchestration.fanin'), 'SSE carries ledger events');
    assert.ok(stream.includes('event: end'), 'SSE ends on settle');
  } finally {
    server.close();
  }
});

test('SERVER: a restarted daemon recovers a finished job from disk (ledger SSOT)', async () => {
  const root = tmpRepo();
  const reg = fakeRegistry();
  const s1 = createOrchestratorServer({ root, registry: reg, authToken: 'secret' });
  const p1 = await listen(s1);
  let jobId: string;
  try {
    const submit = await post(
      p1,
      '/graph',
      { nodes: [{ id: 'x', goal: 'write x.txt', executor: 'codex' }] },
      { 'x-agent-auth': 'secret' },
    );
    jobId = asString(submit.json.jobId);
    const job = await pollJob(p1, jobId);
    assert.equal(job.status, 'done');
  } finally {
    s1.close();
  }
  // Fresh server, empty in-memory job map, same root → recovers from the persisted outcome.
  const s2 = createOrchestratorServer({ root, registry: reg });
  const p2 = await listen(s2);
  try {
    const recovered = await get(p2, `/jobs/${jobId}`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.status, 'done');
    assert.equal(recovered.json.recovered, true);
    assert.equal(asObject(asObject(recovered.json.result).graph).supportedCount, 1);
    const unknown = await get(p2, '/jobs/graph-does-not-exist');
    assert.equal(unknown.status, 404);
  } finally {
    s2.close();
  }
});

test('SERVER: invalid graph is recoverable, not a durable 404', async () => {
  const root = tmpRepo();
  const reg = fakeRegistry();
  const s1 = createOrchestratorServer({ root, registry: reg, authToken: 'secret' });
  const p1 = await listen(s1);
  let jobId: string;
  try {
    const submit = await post(
      p1,
      '/graph',
      {
        nodes: [
          { id: 'a', goal: 'write a.txt', deps: ['b'], executor: 'codex' },
          { id: 'b', goal: 'write b.txt', deps: ['a'], executor: 'codex' },
        ],
      },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(submit.status, 202);
    jobId = asString(submit.json.jobId);
    const job = await pollJob(p1, jobId);
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'graph has a cycle');
  } finally {
    s1.close();
  }

  const s2 = createOrchestratorServer({ root, registry: reg });
  const p2 = await listen(s2);
  try {
    const recovered = await get(p2, `/jobs/${jobId}`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.recovered, true);
    assert.equal(recovered.json.status, 'error');
    assert.equal(recovered.json.error, 'graph has a cycle');

    const unknown = await get(p2, '/jobs/graph-never-submitted');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'unknown job');
  } finally {
    s2.close();
  }
});

test('SERVER: read routes require auth under remote bind', async () => {
  const remoteRoot = tmpRepo();
  const remote = createOrchestratorServer({
    root: remoteRoot,
    registry: fakeRegistry(),
    authToken: 'secret',
    host: '0.0.0.0',
  });
  const remotePort = await listen(remote);
  let jobId: string;
  try {
    const submit = await post(
      remotePort,
      '/graph',
      { nodes: [{ id: 'x', goal: 'write x.txt', executor: 'codex' }] },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(submit.status, 202);
    jobId = asString(submit.json.jobId);
    const settled = await pollJob(remotePort, jobId, { 'x-agent-auth': 'secret' });
    assert.equal(settled.status, 'done');

    const deniedJob = await get(remotePort, `/jobs/${jobId}`);
    assert.equal(deniedJob.status, 401);
    assert.equal(deniedJob.json.error, 'invalid auth token');
    const authedJob = await get(remotePort, `/jobs/${jobId}`, { 'x-agent-auth': 'secret' });
    assert.equal(authedJob.status, 200);
    assert.equal(authedJob.json.status, 'done');

    const deniedEvents = await get(remotePort, `/runs/${jobId}/events`);
    assert.equal(deniedEvents.status, 401);
    assert.equal(deniedEvents.json.error, 'invalid auth token');
    const authedEvents = await sse(remotePort, `/runs/${jobId}/events`, { 'x-agent-auth': 'secret' });
    assert.ok(authedEvents.includes('event: end'), 'remote SSE succeeds with auth');

    const health = await get(remotePort, '/health');
    assert.equal(health.status, 200);
  } finally {
    remote.close();
  }

  const loopbackRoot = tmpRepo();
  const loopback = createOrchestratorServer({
    root: loopbackRoot,
    registry: fakeRegistry(),
    authToken: 'secret',
    host: '127.0.0.1',
  });
  const loopbackPort = await listen(loopback);
  try {
    const submit = await post(
      loopbackPort,
      '/graph',
      { nodes: [{ id: 'x', goal: 'write x.txt', executor: 'codex' }] },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(submit.status, 202);
    const loopbackJobId = asString(submit.json.jobId);
    const settled = await pollJob(loopbackPort, loopbackJobId);
    assert.equal(settled.status, 'done');

    const openJob = await get(loopbackPort, `/jobs/${loopbackJobId}`);
    assert.equal(openJob.status, 200);
    assert.equal(openJob.json.status, 'done');
    const openEvents = await sse(loopbackPort, `/runs/${loopbackJobId}/events`);
    assert.ok(openEvents.includes('event: end'), 'loopback SSE remains open without auth');
  } finally {
    loopback.close();
  }
});

test('SERVER: /health is open; /graph requires the auth token when configured', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry(), authToken: 'secret' });
  const port = await listen(server);
  try {
    const denied = await post(port, '/graph', { nodes: [{ id: 'x', goal: 'write x.txt' }] });
    assert.equal(denied.status, 401);
    const ok = await post(port, '/graph', { nodes: [{ id: 'x', goal: 'write x.txt' }] }, { 'x-agent-auth': 'secret' });
    assert.equal(ok.status, 202);
    const job = await pollJob(port, asString(ok.json.jobId), { 'x-agent-auth': 'secret' });
    assert.equal(job.status, 'done');
    assert.equal(asObject(asObject(job.result).graph).supportedCount, 1);
  } finally {
    server.close();
  }
});

test('SERVER: configured reconcile verifier is trusted daemon config, not request input', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({
    root,
    registry: fakeRegistry(),
    authToken: 'secret',
    reconcileVerifyCmd: 'test -f secure.txt',
  });
  const port = await listen(server);
  try {
    const submit = await post(
      port,
      '/graph',
      {
        goal: 'server verifier',
        reconcile: true,
        nodes: [{ id: 'secure', goal: 'write secure.txt', executor: 'codex' }],
      },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(submit.status, 202);
    const job = await pollJob(port, asString(submit.json.jobId));
    assert.equal(job.status, 'done');
    assert.equal(asObject(asObject(job.result).reconcile).verifyPassed, true);
  } finally {
    server.close();
  }
});

test('SERVER: request verifyCmd is rejected and cannot forge reconciliation', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry(), authToken: 'secret' });
  const port = await listen(server);
  try {
    const rejected = await post(
      port,
      '/graph',
      {
        reconcile: true,
        verifyCmd: 'true',
        nodes: [{ id: 'x', goal: 'write x.txt', executor: 'codex' }],
      },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(rejected.status, 400);
    assert.equal(
      rejected.json.error,
      'verifyCmd is not accepted from requests; configure it at serve start via --verify-cmd / AGENT_ORCH_VERIFY_CMD',
    );
  } finally {
    server.close();
  }
});

test('SERVER: graph submission is closed when no auth token is configured', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry() });
  const port = await listen(server);
  try {
    const health = await get(port, '/health');
    assert.equal(health.status, 200);
    const denied = await post(port, '/graph', { nodes: [{ id: 'x', goal: 'write x.txt', executor: 'codex' }] });
    assert.equal(denied.status, 401);
    assert.equal(
      denied.json.error,
      'graph submission requires an auth token; start orchestrate serve with --auth-token or AGENT_ORCH_TOKEN',
    );
  } finally {
    server.close();
  }
});

test('SERVER: unknown explicit executor is rejected before scheduling', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry(), authToken: 'secret' });
  const port = await listen(server);
  try {
    const rejected = await post(
      port,
      '/graph',
      { nodes: [{ id: 'x', goal: 'write x.txt', executor: 'claud' }] },
      { 'x-agent-auth': 'secret' },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, 'unknown executor: claud');
  } finally {
    server.close();
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

function listen(server: Server): Promise<number> {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res((server.address() as AddressInfo).port)));
}

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolveReq, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolveReq({ status: res.statusCode || 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }),
        );
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolveReq, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () =>
        resolveReq({ status: res.statusCode || 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function pollJob(port: number, jobId: string, headers: Record<string, string> = {}): Promise<any> {
  for (let i = 0; i < 200; i += 1) {
    const r = await get(port, `/jobs/${jobId}`, headers);
    if (r.json.status !== 'running') return r.json;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job did not settle');
}

// Collect an SSE stream until the server emits its `end` event (job settled).
function sse(port: number, path: string): Promise<string> {
  return new Promise((resolveReq, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: end')) {
          res.destroy();
          resolveReq(buf);
        }
      });
      res.on('end', () => resolveReq(buf));
    });
    req.on('error', reject);
    req.end();
  });
}

test('SERVER: async job routes a DAG, settles done, and streams ledger events over SSE', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry() });
  const port = await listen(server);
  try {
    const submit = await post(port, '/graph', {
      goal: 'server dag',
      reconcile: true,
      nodes: [
        { id: 'schema', goal: 'write schema.txt', executor: 'codex' },
        { id: 'api', goal: 'write api.txt', deps: ['schema'], purpose: 'research' }, // purpose→claude
      ],
    });
    assert.equal(submit.status, 202);
    assert.ok(submit.json.jobId);

    const job = await pollJob(port, submit.json.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.graph.supportedCount, 2);
    assert.equal(job.result.graph.waves, 2);
    assert.deepEqual(job.result.routing, [
      { id: 'schema', kind: 'codex' },
      { id: 'api', kind: 'claude' },
    ]);
    assert.deepEqual(job.result.reconcile.merged.sort(), ['api', 'schema']);

    // SSE replays the parent ledger and ends when the job settled.
    const stream = await sse(port, `/runs/${submit.json.jobId}/events`);
    assert.ok(stream.includes('orchestration.fanin'), 'SSE carries ledger events');
    assert.ok(stream.includes('event: end'), 'SSE ends on settle');
  } finally {
    server.close();
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
    const job = await pollJob(port, ok.json.jobId, { 'x-agent-auth': 'secret' });
    assert.equal(job.status, 'done');
    assert.equal(job.result.graph.supportedCount, 1);
  } finally {
    server.close();
  }
});

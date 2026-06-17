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

test('SERVER: routes a structured DAG to executors and runs it verifier-gated', async () => {
  const root = tmpRepo();
  const server = createOrchestratorServer({ root, registry: fakeRegistry() });
  const port = await listen(server);
  try {
    const res = await post(port, '/graph', {
      goal: 'server dag',
      reconcile: true,
      nodes: [
        { id: 'schema', goal: 'write schema.txt', executor: 'codex' },
        { id: 'api', goal: 'write api.txt', deps: ['schema'], purpose: 'research' }, // purpose→claude
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.graph.supportedCount, 2);
    assert.equal(res.json.graph.waves, 2);
    // deterministic routing: explicit kind, then purpose map.
    assert.deepEqual(res.json.routing, [
      { id: 'schema', kind: 'codex' },
      { id: 'api', kind: 'claude' },
    ]);
    assert.deepEqual(res.json.reconcile.merged.sort(), ['api', 'schema']);
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
    assert.equal(ok.status, 200);
    assert.equal(ok.json.graph.supportedCount, 1);
  } finally {
    server.close();
  }
});

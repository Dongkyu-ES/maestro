#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'do-codex-web-e2e-'));
const fakeBinDir = mkdtempSync(join(tmpdir(), 'do-fake-codex-'));
const fakeCodex = join(fakeBinDir, 'codex');
writeFileSync(
  fakeCodex,
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const msg = 'fake codex completed web task';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'web-fake-thread-001' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
fs.writeFileSync(path.join(cwd, 'codex-web-result.txt'), 'changed by web codex executor\\n');
`,
  { mode: 0o755 },
);
execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'codex-web@example.local'], { cwd: tmp });
execFileSync('git', ['config', 'user.name', 'Codex Web'], { cwd: tmp });
writeFileSync(join(tmp, 'README.md'), '# codex web e2e\n');
execFileSync('git', ['add', 'README.md'], { cwd: tmp });
execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });
const cli = join(root, 'dist', 'cli.js');
execFileSync(process.execPath, [cli, 'init'], { cwd: tmp, stdio: 'ignore' });
const port = 23000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: tmp,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_CODEX_BIN: fakeCodex },
});
try {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const base = `http://127.0.0.1:${port}`;
  const homeRes = await fetch(`${base}/`);
  const home = await homeRes.text();
  const csrf = home.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('missing csrf');
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ csrf, ...body }),
    });
  let res = await post('/api/tasks', { title: 'create codex-web-result.txt' });
  if (res.status !== 303) throw new Error(`task create status ${res.status}`);
  const taskId = execFileSync(process.execPath, [cli, 'task', 'list'], { cwd: tmp, encoding: 'utf8' }).match(/^(task-\S+)/m)?.[1];
  if (!taskId) throw new Error('missing task id');
  const board = await (await fetch(`${base}/`)).text();
  if (!board.includes('<option>codex</option>')) throw new Error('codex executor option missing');
  res = await post('/api/runs', { taskId, mode: 'basic', executor: 'codex' });
  if (res.status !== 303) throw new Error(`run create status ${res.status}`);
  const runId = execFileSync(process.execPath, [cli, 'run', 'latest'], { cwd: tmp, encoding: 'utf8' }).trim();
  const ready = await (await fetch(`${base}/`)).text();
  if (!ready.includes('Start codex executor')) throw new Error('codex start button missing');
  if (ready.includes('command executor needs an explicit command')) throw new Error('codex run incorrectly requires command');
  res = await post(`/api/runs/${runId}/start`, {});
  if (res.status !== 303) throw new Error(`run start status ${res.status}`);
  res = await post(`/api/runs/${runId}/collect`, {});
  if (res.status !== 303) throw new Error(`run collect status ${res.status}`);
  const runYaml = readFileSync(join(tmp, '.agent', 'runs', runId, 'run.yaml'), 'utf8');
  if (!runYaml.includes('status: "completed"') || !runYaml.includes('decision: "pass"')) throw new Error('codex run did not pass');
  const processJson = JSON.parse(readFileSync(join(tmp, '.agent', 'runs', runId, 'executor.process.json'), 'utf8'));
  if (processJson.session_id !== 'web-fake-thread-001') throw new Error('codex session id missing');
  if (!readFileSync(join(tmp, 'codex-web-result.txt'), 'utf8').includes('changed by web codex executor'))
    throw new Error('codex executor did not edit file');
  const detail = await (await fetch(`${base}/run/${runId}`)).text();
  if (!detail.includes('Run result') || !detail.includes('codex-events.jsonl')) throw new Error('codex run detail missing evidence');
  console.log(`OPERATOR_CODEX_WEB_E2E_PASS root=${tmp} run=${runId}`);
} finally {
  child.kill('SIGTERM');
}

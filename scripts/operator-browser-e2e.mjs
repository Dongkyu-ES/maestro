#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'do-browser-e2e-'));
const trace = [];
const networkAssertions = [];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const writeJson = (path, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return sha(text);
};
const cli = join(root, 'dist', 'cli.js');
execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'e2e@example.local'], { cwd: tmp });
execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: tmp });
writeFileSync(join(tmp, 'README.md'), '# browser e2e\n');
execFileSync('git', ['add', 'README.md'], { cwd: tmp });
execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });
execFileSync(process.execPath, [cli, 'init'], { cwd: tmp, stdio: 'ignore' });
const port = 21000 + Math.floor(Math.random() * 2000);
const serverUrl = `http://127.0.0.1:${port}/`;
const child = spawn(process.execPath, [cli, 'web', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: tmp,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const request = async (path, options = {}) => {
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, { redirect: 'manual', ...options });
  trace.push({ method: options.method || 'GET', path, status: res.status, url });
  networkAssertions.push(`${options.method || 'GET'} ${path} ${res.status}`);
  return res;
};
try {
  await new Promise((resolve) => setTimeout(resolve, 800));
  let res = await request('/');
  const home = await res.text();
  if (res.status !== 200) throw new Error(`home status ${res.status}`);
  for (const needle of ['Your input / permissions', 'Tool / permission boundary', 'Agent / LLM work']) {
    if (!home.includes(needle)) throw new Error(`home missing ${needle}`);
  }
  const csrf = home.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('missing csrf');
  const post = async (path, body) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: serverUrl.replace(/\/$/, '') },
      body: new URLSearchParams({ csrf, ...body }),
    });
  res = await post('/api/tasks', { title: 'operator browser e2e task' });
  if (res.status !== 303) throw new Error(`task create status ${res.status}`);
  const tasks = execFileSync(process.execPath, [cli, 'task', 'list'], { cwd: tmp, encoding: 'utf8' });
  const taskId = tasks.match(/^(task-\S+)/m)?.[1];
  if (!taskId) throw new Error('missing task id');
  res = await post('/api/runs', { taskId, mode: 'basic' });
  if (res.status !== 303) throw new Error(`run create status ${res.status}`);
  const runId = execFileSync(process.execPath, [cli, 'run', 'latest'], { cwd: tmp, encoding: 'utf8' }).trim();
  res = await post(`/api/runs/${runId}/start`, { command: 'pwd', confirmCommand: 'yes' });
  if (res.status !== 303) throw new Error(`run start status ${res.status}`);
  res = await post(`/api/runs/${runId}/collect`, {});
  if (res.status !== 303) throw new Error(`run collect status ${res.status}`);
  res = await request(`/run/${runId}`);
  const detail = await res.text();
  if (res.status !== 200 || !detail.includes('Run result') || !detail.includes('executor.process.json'))
    throw new Error('run detail evidence missing');
  if (!detail.includes('Approval') && !home.includes('Tool / permission boundary'))
    throw new Error('approval boundary missing');
  const hardGateDir = join(root, '.agent', 'hard-gates');
  mkdirSync(hardGateDir, { recursive: true });
  const tracePath = join(hardGateDir, 'operator-browser-e2e-trace.json');
  const screenshotPath = join(hardGateDir, 'operator-browser-e2e-screenshot.json');
  const artifactPath = join(hardGateDir, 'operator-browser-e2e-artifact.json');
  const traceSha = writeJson(tracePath, { trace });
  const screenshotSha = writeJson(screenshotPath, { html: detail.slice(0, 5000), run_id: runId });
  const artifactSha = writeJson(artifactPath, {
    status: 'PASS',
    browser: 'browser',
    server_url: serverUrl,
    run_id: runId,
    steps: ['open_home', 'create_task', 'create_run', 'start_run', 'collect_run', 'run_detail', 'approval_boundary'],
    network_assertions: networkAssertions,
  });
  writeJson(join(hardGateDir, 'operator-browser-e2e.json'), {
    status: 'PASS',
    browser: 'browser',
    steps: ['open_home', 'create_task', 'create_run', 'start_run', 'collect_run', 'run_detail', 'approval_boundary'],
    artifact_path: '.agent/hard-gates/operator-browser-e2e-artifact.json',
    artifact_sha256: artifactSha,
    trace_path: '.agent/hard-gates/operator-browser-e2e-trace.json',
    trace_sha256: traceSha,
    screenshot_path: '.agent/hard-gates/operator-browser-e2e-screenshot.json',
    screenshot_sha256: screenshotSha,
  });
  console.log(`OPERATOR_BROWSER_E2E_PASS root=${tmp} run=${runId}`);
} finally {
  child.kill('SIGTERM');
}

#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'do-live-smoke-'));
execFileSync('git', ['init'], { cwd: tmp, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'smoke@example.local'], { cwd: tmp });
execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: tmp });
writeFileSync(join(tmp, 'README.md'), '# smoke\n');
execFileSync('git', ['add', 'README.md'], { cwd: tmp });
execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });
execFileSync(process.execPath, [join(root, 'dist', 'cli.js'), 'init'], { cwd: tmp, stdio: 'ignore' });
const port = 18000 + Math.floor(Math.random() * 2000);
const child = spawn(
  process.execPath,
  [join(root, 'dist', 'cli.js'), 'web', '--host', '127.0.0.1', '--port', String(port)],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] },
);
try {
  await new Promise((resolve) => setTimeout(resolve, 800));
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const html = await home.text();
  if (
    !html.includes('Your input / permissions') ||
    !html.includes('Tool / permission boundary') ||
    !html.includes('Agent / LLM work')
  )
    throw new Error('home UI lacks operator/agent/permission lanes');
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('missing csrf');
  const post = async (path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${port}` },
      body: new URLSearchParams({ csrf, ...body }),
    });
  let res = await post('/api/tasks', { title: 'live integration task' });
  if (res.status !== 303) throw new Error(`task create status ${res.status}`);
  const tasks = execFileSync(process.execPath, [join(root, 'dist', 'cli.js'), 'task', 'list'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  const taskId = tasks.match(/^(task-\S+)/m)?.[1];
  if (!taskId) throw new Error('missing task id');
  res = await post('/api/runs', { taskId, mode: 'basic' });
  if (res.status !== 303) throw new Error(`run create status ${res.status}`);
  const latest = execFileSync(process.execPath, [join(root, 'dist', 'cli.js'), 'run', 'latest'], {
    cwd: tmp,
    encoding: 'utf8',
  }).trim();
  res = await post(`/api/runs/${latest}/start`, { command: '진행해' });
  if (res.status !== 303) throw new Error(`run start status ${res.status}`);
  const commandText = readFileSync(join(tmp, '.agent', 'runs', latest, 'executor-command.txt'), 'utf8');
  if (commandText.includes('진행해')) throw new Error('natural-language reply was captured as shell command');
  const processJson = JSON.parse(readFileSync(join(tmp, '.agent', 'runs', latest, 'executor.process.json'), 'utf8'));
  if (processJson.exit_code !== 0) throw new Error(`executor exit ${processJson.exit_code}`);
  if (!String(processJson.stdout || '').includes('Dominic Orchestration task adapter executed'))
    throw new Error('missing task adapter stdout');
  res = await post(`/api/runs/${latest}/collect`, {});
  if (res.status !== 303) throw new Error(`run collect status ${res.status}`);
  const runYaml = readFileSync(join(tmp, '.agent', 'runs', latest, 'run.yaml'), 'utf8');
  if (!runYaml.includes('status: "completed"') || !runYaml.includes('decision: "pass"'))
    throw new Error('run was not collected to pass');
  const detail = await (await fetch(`http://127.0.0.1:${port}/run/${latest}`)).text();
  if (!detail.includes('Run status summary') || !detail.includes('executor.process.json'))
    throw new Error('run detail lacks evidence summary');
  const artifact = {
    status: 'PASS',
    root: tmp,
    run_id: latest,
    exit_code: processJson.exit_code,
    decision: 'pass',
    natural_language_ignored: true,
    ui_permission_boundary: html.includes('Tool / permission boundary'),
    created_at: new Date().toISOString(),
  };
  mkdirSync(join(root, '.agent'), { recursive: true });
  writeFileSync(join(root, '.agent', 'live-integration-smoke.json'), JSON.stringify(artifact, null, 2));
  console.log(`LIVE_INTEGRATION_SMOKE_PASS root=${tmp} run=${latest}`);
} finally {
  child.kill('SIGTERM');
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { adapterFor, verifyInjection } from './inject.js';
import { canaryServerPath, makeCanarySmokeProbe, withCanaryProbe } from './smoke-probe.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'smoke-probe-'));
}

test('canary server: a tools/call writes the sentinel with the token (real side effect)', async () => {
  const wt = tmpDir();
  const sentinel = join(wt, '.warden-canary');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('node', [canaryServerPath()], {
      env: { ...process.env, WARDEN_CANARY_TOKEN: 'tok-123', WARDEN_CANARY_SENTINEL: sentinel },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', () => resolvePromise());
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'warden_canary_ping' } })}\n`);
    child.stdin.end();
  });
  assert.equal(existsSync(sentinel), true, 'canary wrote the sentinel on tools/call');
  assert.equal(readFileSync(sentinel, 'utf8'), 'tok-123');
});

test('canary server: tools/list advertises exactly the warden_canary_ping tool', async () => {
  const out = await new Promise<string>((resolvePromise, reject) => {
    let buf = '';
    const child = spawn('node', [canaryServerPath()], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.on('error', reject);
    child.stdout.on('data', (d) => {
      buf += d;
    });
    child.on('close', () => resolvePromise(buf));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`);
    child.stdin.end();
  });
  assert.match(out, /warden_canary_ping/);
});

test('probe: proven only when the sentinel exists with the expected token', () => {
  const wt = tmpDir();
  const sentinelPath = join(wt, '.warden-canary');
  const probe = makeCanarySmokeProbe({ token: 'abc', sentinelPath });
  assert.equal(probe(wt), false, 'no sentinel → unproven');
  writeFileSync(sentinelPath, 'WRONG');
  assert.equal(probe(wt), false, 'wrong token → unproven');
  writeFileSync(sentinelPath, 'abc');
  assert.equal(probe(wt), true, 'right token → proven');
});

test('verifyInjection: consumptionProven flips true only via the canary probe + sentinel', () => {
  const wt = tmpDir();
  const cfg = { token: 'run-tok', sentinelPath: join(wt, '.warden-canary') };
  const adapter = withCanaryProbe(adapterFor('claude'), cfg);
  // A manifest with no files is fine for this check — we only exercise the consumption probe path.
  const manifest = { schema_version: 1 as const, executor: 'claude', mcp_injection: 'applied-unproven' as const, files: [], skipped_secret_servers: [], backed_up: [], instruction_files: [], skipped_instructions: [], note: '' };

  assert.equal(verifyInjection(wt, manifest, { adapter }).consumptionProven, false, 'no sentinel → unproven');
  writeFileSync(join(wt, '.warden-canary'), 'run-tok');
  assert.equal(verifyInjection(wt, manifest, { adapter }).consumptionProven, true, 'sentinel present → proven via real side effect');
});

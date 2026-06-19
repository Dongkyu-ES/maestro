import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { HarnessExecutor } from '../harness/harness-run.js';
import type { CatalogModule } from './catalog.js';
import { adapterFor } from './inject.js';
import { runMagicInjectionRun } from './magic-run.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'magic-run-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function mcpModule(id: string, server: string, command: string[]): CatalogModule {
  return { id, kind: 'mcp', tags: ['rust'], origin: 'declared', mcp: { server, command } };
}

function fakeResult(cwd: string, label?: string) {
  return {
    label: label ?? 'fake',
    cwd,
    command: 'fake executor',
    started_at: new Date(0).toISOString(),
    ended_at: new Date(0).toISOString(),
    exit_code: 0,
    signal: null,
    timed_out: false,
    cancelled: false,
    last_message: 'done',
    event_count: 1,
    stdout: '',
    stderr: '',
  };
}

test('magic run: the executor runs in a worktree that ALREADY contains the injected .mcp.json', async () => {
  const root = tmpRepo();
  let sawMcp: string | null = null;
  const executor: HarnessExecutor = async (o) => {
    // Proof of injection-before-execution: the executor reads its own cwd at run time.
    const p = join(o.cwd, '.mcp.json');
    sawMcp = existsSync(p) ? readFileSync(p, 'utf8') : null;
    writeFileSync(join(o.cwd, 'out.txt'), 'done\n');
    return fakeResult(o.cwd, o.label);
  };
  const res = await runMagicInjectionRun({
    root,
    goal: 'do work',
    magicRunId: 'magic-test-1',
    executor,
    executorLabel: 'claude',
    mcpModules: [mcpModule('ra', 'rust-analyzer', ['ra-mcp'])],
    adapter: adapterFor('claude'),
  });

  assert.equal(res.manifest.mcp_injection, 'applied-unproven');
  assert.match(sawMcp ?? '', /"rust-analyzer"/, 'executor saw the injected .mcp.json at execution time');
  assert.equal(res.ledgerCheck.found, true);
  assert.equal(res.ledgerCheck.reproduced, true);
  // consumption is never proven by the run itself (no live smokeProbe).
  assert.equal(res.verification.consumptionProven, false);
});

test('magic run: an executor that tampers the injected .mcp.json is caught (integrityOk false)', async () => {
  const root = tmpRepo();
  const executor: HarnessExecutor = async (o) => {
    // The executor (untrusted, owns the worktree) overwrites the injected config mid-run.
    writeFileSync(join(o.cwd, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x","args":[]}}}\n');
    return fakeResult(o.cwd, o.label);
  };
  const res = await runMagicInjectionRun({
    root,
    goal: 'tamper',
    magicRunId: 'magic-test-3',
    executor,
    executorLabel: 'claude',
    mcpModules: [mcpModule('ra', 'rust-analyzer', ['ra-mcp'])],
    adapter: adapterFor('claude'),
  });
  assert.equal(res.verification.integrityOk, false, 'post-exec tampering of the injected file is caught');
  assert.equal(res.verification.mutated.length, 1);
});

test('magic run: an unsupported executor (codex) injects nothing — executor sees no .mcp.json', async () => {
  const root = tmpRepo();
  let sawMcp: string | null = 'unset';
  const executor: HarnessExecutor = async (o) => {
    sawMcp = existsSync(join(o.cwd, '.mcp.json')) ? 'present' : null;
    writeFileSync(join(o.cwd, 'out.txt'), 'done\n');
    return fakeResult(o.cwd, o.label);
  };
  const res = await runMagicInjectionRun({
    root,
    goal: 'do work',
    magicRunId: 'magic-test-2',
    executor,
    executorLabel: 'codex',
    mcpModules: [mcpModule('ra', 'rust-analyzer', ['ra-mcp'])],
    adapter: adapterFor('codex'),
  });
  assert.equal(res.manifest.mcp_injection, 'unsupported');
  assert.equal(sawMcp, null, 'codex worktree has no injected .mcp.json');
});

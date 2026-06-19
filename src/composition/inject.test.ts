import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CatalogModule } from './catalog.js';
import {
  adapterFor,
  applyCompositionToWorktree,
  captureInjectionBaseline,
  manifestReproducible,
  recomputeInjectionFiles,
  verifyInjection,
} from './inject.js';

function tmpWorktree(): string {
  return mkdtempSync(join(tmpdir(), 'inject-'));
}

function mcpModule(id: string, server: string, command: string[], extra: Partial<CatalogModule> = {}): CatalogModule {
  return { id, kind: 'mcp', tags: ['rust'], origin: 'declared', mcp: { server, command }, ...extra };
}

test('inject: claude writes .mcp.json; integrity+closure ok; consumption NEVER proven (B2/B3)', () => {
  const wt = tmpWorktree();
  const baseline = captureInjectionBaseline(wt);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('ra', 'rust-analyzer', ['ra-mcp'])], adapter: adapterFor('claude') });

  assert.equal(manifest.mcp_injection, 'applied-unproven');
  assert.deepEqual(manifest.files.map((f) => f.path), ['.mcp.json']);
  assert.match(readFileSync(join(wt, '.mcp.json'), 'utf8'), /"rust-analyzer"/);

  const v = verifyInjection(wt, manifest, { baseline, phase: 'post-write' });
  assert.equal(v.integrityOk, true);
  assert.equal(v.closureOk, true);
  assert.equal(v.consumptionProven, false); // structural: injection never claims consumption
});

test('inject B2: codex/agy do NOT load cwd .mcp.json → unsupported, nothing written, no false claim', () => {
  for (const label of ['codex', 'agy']) {
    const wt = tmpWorktree();
    const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('x', 'x', ['x'])], adapter: adapterFor(label) });
    assert.equal(manifest.mcp_injection, 'unsupported', `${label} must be unsupported`);
    assert.deepEqual(manifest.files, []);
    assert.equal(existsSync(join(wt, '.mcp.json')), false);
    assert.match(manifest.note, /no false claim/);
  }
});

test('inject B3 closure: NO false-positive on a repo that already has CLAUDE.md/.claude/skills', () => {
  const wt = tmpWorktree();
  // Pre-existing operator surfaces — must be ignored by the baseline-diff closure.
  writeFileSync(join(wt, 'CLAUDE.md'), '# user instructions\n');
  mkdirSync(join(wt, '.claude', 'skills', 'foo'), { recursive: true });
  writeFileSync(join(wt, '.claude', 'skills', 'foo', 'SKILL.md'), '# user skill\n');

  const baseline = captureInjectionBaseline(wt);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  const v = verifyInjection(wt, manifest, { baseline, phase: 'post-write' });
  assert.equal(v.closureOk, true, 'pre-existing user files must not be flagged extraneous');
  assert.deepEqual(v.extraneous, []);
  assert.equal(v.integrityOk, true);
});

test('inject B3 forgery: a file smuggled into .claude/skills DURING the run fails closure (baseline diff)', () => {
  const wt = tmpWorktree();
  const baseline = captureInjectionBaseline(wt); // empty scope
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  // Smuggle a NEW AI-surface file not in the manifest (created after baseline).
  mkdirSync(join(wt, '.claude', 'skills', 'evil'), { recursive: true });
  writeFileSync(join(wt, '.claude', 'skills', 'evil', 'SKILL.md'), 'bad\n');

  const v = verifyInjection(wt, manifest, { baseline, phase: 'post-write' });
  assert.equal(v.closureOk, false);
  assert.ok(v.extraneous.some((p) => p.includes('evil/SKILL.md')));
});

test('inject: post-exec phase skips closure (executor may create files) but still surfaces mutation', () => {
  const wt = tmpWorktree();
  const baseline = captureInjectionBaseline(wt);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  // Executor legitimately creates its own AGENTS.md AND tampers the injected config.
  writeFileSync(join(wt, 'AGENTS.md'), '# executor output\n');
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x","args":[]}}}\n');

  const v = verifyInjection(wt, manifest, { baseline, phase: 'post-exec' });
  assert.equal(v.closureOk, true, 'post-exec does not flag executor-created files');
  assert.equal(v.integrityOk, false, 'but mutation of an injected file is still caught');
  assert.equal(v.mutated.length, 1);
});

test('inject B6: secret-bearing servers (keyword, conn-string, token-prefix) need approval', () => {
  const cases: CatalogModule[] = [
    mcpModule('a', 'kw', ['srv', '--auth', 'X']), // keyword "auth"
    mcpModule('b', 'cs', ['srv', 'postgres://u:p@host/db']), // connection string user:pass@host
    mcpModule('c', 'tok', ['srv', 'ghp_abcdefghij0123456789']), // token prefix
  ];
  for (const mod of cases) {
    const wt = tmpWorktree();
    const blocked = applyCompositionToWorktree({ worktree: wt, mcpModules: [mod], adapter: adapterFor('claude') });
    assert.equal(blocked.mcp_injection, 'none', `${mod.id} must be gated`);
    assert.equal(blocked.skipped_secret_servers.length, 1);
  }
  // With approval it injects.
  const wt = tmpWorktree();
  const ok = applyCompositionToWorktree({ worktree: wt, mcpModules: [cases[0]], adapter: adapterFor('claude'), approveSecrets: true });
  assert.equal(ok.mcp_injection, 'applied-unproven');
});

test('inject: a pre-existing .mcp.json is backed up, never silently destroyed', () => {
  const wt = tmpWorktree();
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"mine":{"command":"keep","args":[]}}}\n');
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  assert.equal(manifest.backed_up.length, 1);
  assert.equal(manifest.backed_up[0].path, '.mcp.json');
  const backup = readFileSync(join(wt, manifest.backed_up[0].backup), 'utf8');
  assert.match(backup, /"mine"/, 'the original config survives in the backup');
});

test('inject B3 replay: manifest reproducible from ledgered inputs AND order-independent', () => {
  const wt = tmpWorktree();
  const a = mcpModule('a', 'alpha', ['alpha-mcp']);
  const b = mcpModule('b', 'beta', ['beta-mcp', '--flag']);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [a, b], adapter: adapterFor('claude') });
  // Same servers, REVERSED order → must reproduce the same hash (servers sorted before serialize).
  const recomputed = recomputeInjectionFiles({ mcpModules: [b, a], adapter: adapterFor('claude') });
  assert.equal(manifestReproducible(manifest, recomputed), true);
  // Different inputs must NOT reproduce.
  const tampered = recomputeInjectionFiles({ mcpModules: [mcpModule('a', 'alpha', ['DIFFERENT'])], adapter: adapterFor('claude') });
  assert.equal(manifestReproducible(manifest, tampered), false);
});

test('inject: scanInjectionScope does not crash when an AI-surface dir path is a file', () => {
  const wt = tmpWorktree();
  // `.claude/skills` exists as a FILE, not a directory.
  mkdirSync(join(wt, '.claude'), { recursive: true });
  writeFileSync(join(wt, '.claude', 'skills'), 'not a dir\n');
  // Must not throw.
  const baseline = captureInjectionBaseline(wt);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  const v = verifyInjection(wt, manifest, { baseline, phase: 'post-write' });
  assert.equal(v.integrityOk, true);
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CatalogModule } from './catalog.js';
import {
  adapterFor,
  applyCompositionToWorktree,
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

test('inject: claude adapter writes .mcp.json; manifest hash matches on-disk bytes (B3)', () => {
  const wt = tmpWorktree();
  const mod = mcpModule('rust-analyzer', 'rust-analyzer', ['rust-analyzer-mcp']);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mod], adapter: adapterFor('claude') });

  assert.equal(manifest.mcp_injection, 'applied-unproven');
  assert.deepEqual(manifest.files.map((f) => f.path), ['.mcp.json']);
  const onDisk = readFileSync(join(wt, '.mcp.json'), 'utf8');
  assert.match(onDisk, /"rust-analyzer"/);
  // hash is of the actual disk bytes, and verify passes immediately after write.
  const v = verifyInjection(wt, manifest);
  assert.equal(v.ok, true);
  assert.equal(v.closureOk, true);
});

test('inject B2: codex/agy do NOT load cwd .mcp.json → unsupported, nothing written, no false claim', () => {
  for (const label of ['codex', 'agy']) {
    const wt = tmpWorktree();
    const manifest = applyCompositionToWorktree({
      worktree: wt,
      mcpModules: [mcpModule('x', 'x', ['x'])],
      adapter: adapterFor(label),
    });
    assert.equal(manifest.mcp_injection, 'unsupported', `${label} must be unsupported`);
    assert.deepEqual(manifest.files, []);
    assert.equal(existsSync(join(wt, '.mcp.json')), false, `${label} must not write a config`);
    assert.match(manifest.note, /no false claim/);
  }
});

test('inject B6: a secret-bearing MCP server is skipped without approval, injected with --approve-secrets', () => {
  const wt1 = tmpWorktree();
  const secretMod = mcpModule('gh', 'github', ['gh-mcp', '--token', 'ENV']); // "token" → secret-like
  const noApprove = applyCompositionToWorktree({ worktree: wt1, mcpModules: [secretMod], adapter: adapterFor('claude') });
  assert.equal(noApprove.mcp_injection, 'none');
  assert.deepEqual(noApprove.skipped_secret_servers, ['github']);
  assert.equal(existsSync(join(wt1, '.mcp.json')), false);

  const wt2 = tmpWorktree();
  const approved = applyCompositionToWorktree({ worktree: wt2, mcpModules: [secretMod], adapter: adapterFor('claude'), approveSecrets: true });
  assert.equal(approved.mcp_injection, 'applied-unproven');
  assert.equal(existsSync(join(wt2, '.mcp.json')), true);
});

test('inject forgery: a smuggled .claude/skills file (not in manifest) fails the closure check (B3)', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  assert.equal(verifyInjection(wt, manifest).ok, true);

  // Smuggle an AI-surface file the manifest never recorded.
  const evil = join(wt, '.claude', 'skills', 'evil');
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, 'SKILL.md'), 'do bad things\n');

  const v = verifyInjection(wt, manifest);
  assert.equal(v.closureOk, false, 'closure must catch a surface file outside the manifest');
  assert.equal(v.ok, false);
  assert.ok(v.extraneous.some((p) => p.includes('evil/SKILL.md')));
});

test('inject forgery: post-write tampering of an injected file is surfaced as mutated (not silent)', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  // Tamper the injected config after the manifest was recorded.
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x","args":[]}}}\n');

  const v = verifyInjection(wt, manifest);
  assert.equal(v.ok, false);
  assert.equal(v.mutated.length, 1);
  assert.equal(v.mutated[0].path, '.mcp.json');
});

test('inject B3 replay: the manifest is reproducible from ledgered inputs (pure recompute matches)', () => {
  const wt = tmpWorktree();
  const mods = [mcpModule('a', 'alpha', ['alpha-mcp']), mcpModule('b', 'beta', ['beta-mcp', '--flag'])];
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: mods, adapter: adapterFor('claude') });
  const recomputed = recomputeInjectionFiles({ mcpModules: mods, adapter: adapterFor('claude') });
  assert.equal(manifestReproducible(manifest, recomputed), true);

  // A different input set must NOT reproduce the recorded manifest.
  const tampered = recomputeInjectionFiles({ mcpModules: [mcpModule('a', 'alpha', ['DIFFERENT'])], adapter: adapterFor('claude') });
  assert.equal(manifestReproducible(manifest, tampered), false);
});

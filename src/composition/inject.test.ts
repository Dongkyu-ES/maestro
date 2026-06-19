import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CatalogModule } from './catalog.js';
import {
  adapterFor,
  applyCompositionToWorktree,
  type InjectionAdapter,
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

test('inject: claude writes .mcp.json; integrity ok; consumption NEVER proven (B2/B3)', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('ra', 'rust-analyzer', ['ra-mcp'])], adapter: adapterFor('claude') });
  assert.equal(manifest.mcp_injection, 'applied-unproven');
  assert.deepEqual(manifest.files.map((f) => f.path), ['.mcp.json']);
  assert.match(readFileSync(join(wt, '.mcp.json'), 'utf8'), /"rust-analyzer"/);

  const v = verifyInjection(wt, manifest, { adapter: adapterFor('claude') });
  assert.equal(v.integrityOk, true);
  assert.equal(v.consumptionProven, false); // no live smokeProbe ⇒ never proven
});

test('inject: integrity check does NOT police pre-existing/executor files (R-native-ownership)', () => {
  const wt = tmpWorktree();
  // Pre-existing operator surfaces — injection must NOT flag these; it only owns its own writes.
  writeFileSync(join(wt, 'CLAUDE.md'), '# user instructions\n');
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  const v = verifyInjection(wt, manifest, { adapter: adapterFor('claude') });
  assert.equal(v.integrityOk, true, 'a repo with its own CLAUDE.md must verify clean');
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

test('inject forgery: post-write tampering of an injected file is surfaced as mutated (integrity fails)', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"evil":{"command":"x","args":[]}}}\n');
  const v = verifyInjection(wt, manifest, { adapter: adapterFor('claude') });
  assert.equal(v.integrityOk, false);
  assert.equal(v.mutated.length, 1);
  assert.equal(v.mutated[0].path, '.mcp.json');
});

test('inject B6: secret-bearing servers (keyword, conn-string, token-prefix) need approval', () => {
  const cases: CatalogModule[] = [
    mcpModule('a', 'kw', ['srv', '--auth', 'X']),
    mcpModule('b', 'cs', ['srv', 'postgres://u:p@host/db']),
    mcpModule('c', 'tok', ['srv', 'ghp_abcdefghij0123456789']),
  ];
  for (const mod of cases) {
    const wt = tmpWorktree();
    const blocked = applyCompositionToWorktree({ worktree: wt, mcpModules: [mod], adapter: adapterFor('claude') });
    assert.equal(blocked.mcp_injection, 'none', `${mod.id} must be gated`);
    assert.equal(blocked.skipped_secret_servers.length, 1);
  }
  const wt = tmpWorktree();
  const ok = applyCompositionToWorktree({ worktree: wt, mcpModules: [cases[0]], adapter: adapterFor('claude'), approveSecrets: true });
  assert.equal(ok.mcp_injection, 'applied-unproven');
});

test('inject: a pre-existing .mcp.json is backed up (hashed), never silently destroyed', () => {
  const wt = tmpWorktree();
  writeFileSync(join(wt, '.mcp.json'), '{"mcpServers":{"mine":{"command":"keep","args":[]}}}\n');
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  assert.equal(manifest.backed_up.length, 1);
  assert.equal(manifest.backed_up[0].path, '.mcp.json');
  assert.match(readFileSync(join(wt, manifest.backed_up[0].backup), 'utf8'), /"mine"/);
  assert.ok(manifest.backed_up[0].sha256, 'backup hash recorded for audit');
  // Backups are recovery artifacts, NOT integrity-required: removing one (e.g. `git clean`) must
  // not fail verification of injection's capability writes.
  rmSync(join(wt, manifest.backed_up[0].backup));
  assert.equal(verifyInjection(wt, manifest, { adapter: adapterFor('claude') }).integrityOk, true, 'a cleaned backup does not fail integrity');
});

test('inject robustness: apply refuses gracefully (no EISDIR crash) when the config path is a directory', () => {
  const wt = tmpWorktree();
  mkdirSync(join(wt, '.mcp.json')); // collision: a directory named like the config
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  assert.equal(manifest.mcp_injection, 'none');
  assert.match(manifest.note, /not a file/);
});

test('inject B6: broadened formats gated (sk_live_ underscore, AWS AKIA, --pass)', () => {
  const cases: [string, string[]][] = [
    ['stripe', ['srv', 'sk_live_abcdefghij0123456789']],
    ['aws', ['srv', 'AKIAIOSFODNN7EXAMPLE']],
    ['passflag', ['srv', '--pass', 'hunter2hunter2']],
  ];
  for (const [id, command] of cases) {
    const wt = tmpWorktree();
    const m = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule(id, 'srv', command)], adapter: adapterFor('claude') });
    assert.equal(m.mcp_injection, 'none', `${id} must be gated`);
  }
});

test('inject B3 replay: manifest reproducible from ledgered inputs AND order-independent', () => {
  const wt = tmpWorktree();
  const a = mcpModule('a', 'alpha', ['alpha-mcp']);
  const b = mcpModule('b', 'beta', ['beta-mcp', '--flag']);
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [a, b], adapter: adapterFor('claude') });
  assert.equal(manifestReproducible(manifest, recomputeInjectionFiles({ mcpModules: [b, a], adapter: adapterFor('claude') })), true);
  assert.equal(manifestReproducible(manifest, recomputeInjectionFiles({ mcpModules: [mcpModule('a', 'alpha', ['DIFFERENT'])], adapter: adapterFor('claude') })), false);
});

test('inject B2: consumptionProven only flips via a live smokeProbe (else always false)', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  // Default claude adapter ships no probe → unproven.
  assert.equal(verifyInjection(wt, manifest, { adapter: adapterFor('claude') }).consumptionProven, false);
  // A hypothetical adapter WITH a probe is the only thing that can assert consumption.
  const probed: InjectionAdapter = { label: 'claude', supportsLocalMcp: true, mcpConfigPath: '.mcp.json', smokeProbe: () => true };
  assert.equal(verifyInjection(wt, manifest, { adapter: probed }).consumptionProven, true);
});

test('inject robustness: a malformed module (mcp without server) is skipped, never crashes the sort', () => {
  const wt = tmpWorktree();
  const malformed = { id: 'bad', kind: 'mcp', tags: ['rust'], origin: 'declared', mcp: { command: ['x'] } } as unknown as CatalogModule;
  const good = mcpModule('ok', 'alpha', ['alpha-mcp']);
  // Must not throw even with the malformed module present alongside a valid one.
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [malformed, good], adapter: adapterFor('claude') });
  assert.equal(manifest.mcp_injection, 'applied-unproven');
  assert.match(readFileSync(join(wt, '.mcp.json'), 'utf8'), /"alpha"/);
  assert.doesNotMatch(readFileSync(join(wt, '.mcp.json'), 'utf8'), /"bad"/);
});

test('inject B6: hyphenated/Google token formats are gated (sk-ant-, AIza)', () => {
  for (const tok of ['sk-ant-api03-abcdefghijklmnop', 'AIzaSyA1234567890abcdefghij']) {
    const wt = tmpWorktree();
    const m = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('t', 'srv', ['srv', tok])], adapter: adapterFor('claude') });
    assert.equal(m.mcp_injection, 'none', `${tok} must be gated`);
  }
});

test('inject robustness: a manifest path replaced by a directory is reported mutated, not a crash', () => {
  const wt = tmpWorktree();
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: [mcpModule('m', 'm', ['m'])], adapter: adapterFor('claude') });
  // Replace the injected file with a directory (EISDIR on read).
  rmSync(join(wt, '.mcp.json'));
  mkdirSync(join(wt, '.mcp.json'));
  const v = verifyInjection(wt, manifest, { adapter: adapterFor('claude') }); // must not throw
  assert.equal(v.integrityOk, false);
  assert.equal(v.mutated.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Slice 7 Item A — instruction-kind injection (CLAUDE.md/soul) + mechanical gate
// ─────────────────────────────────────────────────────────────────────────────

function instrModule(id: string, targetPath: string, content: string, merge = false): CatalogModule {
  return { id, kind: 'agents_md', tags: [], origin: 'declared', instruction: { targetPath, content, merge } };
}

test('Item A: instruction injected ONLY when approved AND acceptance is pinned-test', () => {
  const wt = tmpWorktree();
  const mod = instrModule('guide', 'CLAUDE.md', '# project guidance\n');
  const ok = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [mod], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  assert.equal(existsSync(join(wt, 'CLAUDE.md')), true);
  assert.match(readFileSync(join(wt, 'CLAUDE.md'), 'utf8'), /project guidance/);
  assert.equal(ok.instruction_files.length, 1);
  assert.ok(ok.files.some((f) => f.path === 'CLAUDE.md'), 'instruction file is integrity-tracked in files[]');
});

test('Item A gate: instruction skipped (not written) without approveInstructions', () => {
  const wt = tmpWorktree();
  const m = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [instrModule('g', 'CLAUDE.md', 'x\n')], approveInstructions: false, acceptanceIsPinnedTest: true,
  });
  assert.equal(existsSync(join(wt, 'CLAUDE.md')), false);
  assert.equal(m.skipped_instructions.length, 1);
  assert.match(m.skipped_instructions[0].reason, /approveInstructions/);
});

test('Item A gate: instruction skipped when acceptance is NOT pinned-test (teaching-to-the-test guard)', () => {
  const wt = tmpWorktree();
  const m = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [instrModule('g', 'CLAUDE.md', 'x\n')], approveInstructions: true, acceptanceIsPinnedTest: false,
  });
  assert.equal(existsSync(join(wt, 'CLAUDE.md')), false);
  assert.match(m.skipped_instructions[0].reason, /pinned-test/);
});

test('Item A merge: a pre-existing CLAUDE.md is preserved (backed up) and appended after a marker', () => {
  const wt = tmpWorktree();
  writeFileSync(join(wt, 'CLAUDE.md'), '# user rules\n');
  const m = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [instrModule('g', 'CLAUDE.md', '# injected\n', true)], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  const merged = readFileSync(join(wt, 'CLAUDE.md'), 'utf8');
  assert.match(merged, /# user rules/);
  assert.match(merged, /warden-injected/);
  assert.match(merged, /# injected/);
  assert.equal(m.backed_up.some((b) => b.path === 'CLAUDE.md'), true, 'original backed up');
  assert.equal(m.instruction_files[0].merged, true);
});

test('Item A replay: non-merge instruction file is purely reproducible; merge file excluded but integrity-caught', () => {
  const wt = tmpWorktree();
  const writeMod = instrModule('w', 'soul.md', '# soul\n', false);
  const manifest = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [writeMod], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  const recomputed = recomputeInjectionFiles({
    mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [writeMod], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  assert.equal(manifestReproducible(manifest, recomputed), true, 'non-merge instruction reproduces from inputs');

  // A merge instruction file (base-dependent) is excluded from pure replay but caught by integrity.
  const wt2 = tmpWorktree();
  writeFileSync(join(wt2, 'CLAUDE.md'), '# base\n');
  const mergeMod = instrModule('m', 'CLAUDE.md', '# add\n', true);
  const m2 = applyCompositionToWorktree({
    worktree: wt2, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [mergeMod], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  const r2 = recomputeInjectionFiles({ mcpModules: [], adapter: adapterFor('claude'), instructionModules: [mergeMod], approveInstructions: true, acceptanceIsPinnedTest: true });
  assert.equal(manifestReproducible(m2, r2), true, 'merge file excluded from pure replay → reproducible holds');
  writeFileSync(join(wt2, 'CLAUDE.md'), 'tampered\n');
  assert.equal(verifyInjection(wt2, m2, { adapter: adapterFor('claude') }).integrityOk, false, 'merge file tamper caught by integrity');
});

test('Item A containment: an instruction targetPath escaping the worktree is refused (not written outside)', () => {
  const wt = tmpWorktree();
  const escape = instrModule('evil', '../escape.md', '# pwned\n');
  const m = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [escape], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  assert.equal(existsSync(join(wt, '..', 'escape.md')), false, 'nothing written outside the worktree');
  assert.equal(m.instruction_files.length, 0);
  assert.match(m.skipped_instructions[0].reason, /escapes the worktree/);
});

test('Item A collision: two instruction modules targeting the same path → second refused, integrity stays true', () => {
  const wt = tmpWorktree();
  const a = instrModule('a', 'CLAUDE.md', '# first\n');
  const b = instrModule('b', 'CLAUDE.md', '# second\n');
  const m = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [a, b], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  // Only the first module's write is recorded; the collision is rejected rather than double-recorded
  // (which would make verifyInjection report a false `mutated`).
  assert.equal(m.instruction_files.filter((f) => f.path === 'CLAUDE.md').length, 1);
  assert.match(m.skipped_instructions[0].reason, /already injected by another module/);
  assert.equal(verifyInjection(wt, m, { adapter: adapterFor('claude') }).integrityOk, true, 'no false mutated from a collision');
});

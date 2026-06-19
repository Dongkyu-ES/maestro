import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRuntimeEvents } from '../events/ledger.js';
import type { CatalogModule } from './catalog.js';
import { recomputeInjectionFromLedger, recordInjectionEvent } from './inject-ledger.js';
import { adapterFor, applyCompositionToWorktree } from './inject.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'inject-ledger-'));
}
function mcpModule(id: string, server: string, command: string[]): CatalogModule {
  return { id, kind: 'mcp', tags: ['rust'], origin: 'declared', mcp: { server, command } };
}

test('inject-ledger: a recorded composition.injected event reproduces from the same inputs', () => {
  const runDir = tmpDir();
  const wt = tmpDir();
  const mods = [mcpModule('a', 'alpha', ['alpha-mcp'])];
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: mods, adapter: adapterFor('claude') });
  recordInjectionEvent(runDir, 'magic-1', manifest);

  const check = recomputeInjectionFromLedger(runDir, { mcpModules: mods, adapter: adapterFor('claude') });
  assert.equal(check.ledgerValid, true);
  assert.equal(check.found, true);
  assert.equal(check.reproduced, true);
});

test('inject-ledger: a forged HEAD event (different files) fails re-derivation even with an intact chain', () => {
  const runDir = tmpDir();
  const wt = tmpDir();
  const mods = [mcpModule('a', 'alpha', ['alpha-mcp'])];
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: mods, adapter: adapterFor('claude') });
  // Forge the manifest's recorded file hash before recording it into the ledger.
  const forged = { ...manifest, files: [{ path: '.mcp.json', sha256: 'f'.repeat(64) }] };
  recordInjectionEvent(runDir, 'magic-2', forged);

  // The chain is intact (single head event) but the recorded files do not match re-derivation.
  const check = recomputeInjectionFromLedger(runDir, { mcpModules: mods, adapter: adapterFor('claude') });
  assert.equal(check.ledgerValid, true);
  assert.equal(check.reproduced, false);
  assert.match(check.reason, /forged|does NOT match/i);
});

test('inject-ledger: a tampered MIDDLE event fails the hash chain (validateRuntimeLedger throws)', () => {
  const runDir = tmpDir();
  const wt = tmpDir();
  const mods = [mcpModule('a', 'alpha', ['alpha-mcp'])];
  const manifest = applyCompositionToWorktree({ worktree: wt, mcpModules: mods, adapter: adapterFor('claude') });
  recordInjectionEvent(runDir, 'magic-3', manifest);
  recordInjectionEvent(runDir, 'magic-3', manifest); // a second event so the first is a MIDDLE event

  // Tamper the first event's payload + its own payload_sha256, leaving the chain links unrepaired.
  const path = join(runDir, 'events.jsonl');
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.payload.executor = 'tampered';
  // Recompute only this event's payload hash (the realistic forgery); prev_event_sha256 of the NEXT
  // event still commits to the original first envelope, so the chain must break.
  first.payload_sha256 = createHash('sha256').update(JSON.stringify(first.payload)).digest('hex');
  lines[0] = JSON.stringify(first);
  writeFileSync(path, `${lines.join('\n')}\n`);

  assert.throws(() => recomputeInjectionFromLedger(runDir, { mcpModules: mods, adapter: adapterFor('claude') }));
});

test('inject-ledger: a genuinely empty ledger → found false', () => {
  const runDir = tmpDir(); // no events at all
  const check = recomputeInjectionFromLedger(runDir, { mcpModules: [], adapter: adapterFor('claude') });
  assert.equal(check.found, false);
  assert.equal(check.status, null);
  assert.equal(check.reproduced, false);
});

test('inject-ledger: an unsupported record carries its status so empty-reproduced is not misread', () => {
  const runDir = tmpDir();
  recordInjectionEvent(runDir, 'm', applyCompositionToWorktree({ worktree: tmpDir(), mcpModules: [], adapter: adapterFor('codex') }));
  const check = recomputeInjectionFromLedger(runDir, { mcpModules: [], adapter: adapterFor('codex') });
  assert.equal(check.found, true);
  assert.equal(check.status, 'unsupported'); // distinguishes "nothing injected" from a real applied match
  assert.equal(check.reproduced, true); // empty matches empty — but `status` tells the reader why
  assert.equal(readRuntimeEvents(runDir).filter((e) => e.type === 'composition.injected').length, 1);
});

function instrModule(id: string, targetPath: string, content: string, merge = false): CatalogModule {
  return { id, kind: 'agents_md', tags: [], origin: 'declared', instruction: { targetPath, content, merge } };
}

// Slice-7 latent gap (agy impl-panel BLOCKER): recomputeInjectionFromLedger did not forward the
// instruction inputs, so once an instruction-injected run reached this path it would record
// instruction files the re-derivation omitted → a FALSE contradiction. Forwarding closes it.
test('inject-ledger: a non-merge instruction file reproduces ONLY when instruction inputs are forwarded', () => {
  const runDir = tmpDir();
  const instr = instrModule('guide', 'soul.md', '# guidance\n');
  const manifest = applyCompositionToWorktree({
    worktree: tmpDir(), mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [instr], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  recordInjectionEvent(runDir, 'skill-x', manifest);

  const ok = recomputeInjectionFromLedger(runDir, {
    mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [instr], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  assert.equal(ok.reproduced, true, 'forwarded instruction inputs reproduce the recorded soul.md');

  // The pre-fix call shape (no instruction inputs) would treat the recorded instruction file as
  // unexplained — the regression this test pins shut.
  const gap = recomputeInjectionFromLedger(runDir, { mcpModules: [], adapter: adapterFor('claude') });
  assert.equal(gap.reproduced, false, 'omitting instruction inputs → recorded file has no counterpart');
});

test('inject-ledger: a MERGE instruction file is excluded from pure replay (base-dependent) → no false contradiction', () => {
  const runDir = tmpDir();
  const wt = tmpDir();
  writeFileSync(join(wt, 'CLAUDE.md'), '# base\n');
  const merge = instrModule('m', 'CLAUDE.md', '# add\n', true);
  const manifest = applyCompositionToWorktree({
    worktree: wt, mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [merge], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  recordInjectionEvent(runDir, 'skill-y', manifest);
  const check = recomputeInjectionFromLedger(runDir, {
    mcpModules: [], adapter: adapterFor('claude'),
    instructionModules: [merge], approveInstructions: true, acceptanceIsPinnedTest: true,
  });
  // merge CLAUDE.md is excluded on BOTH sides (recorded via its `merged` flag, expected via recompute)
  // so the comparison is empty-vs-empty → reproduced, not a spurious mismatch.
  assert.equal(check.reproduced, true);
});

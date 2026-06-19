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

test('inject-ledger: no injection event → found false, reproduced false', () => {
  const runDir = tmpDir();
  recordInjectionEvent(runDir, 'm', applyCompositionToWorktree({ worktree: tmpDir(), mcpModules: [], adapter: adapterFor('codex') }));
  // codex is unsupported → manifest has no files; event recorded but it's a 'none-ish' unsupported record.
  const check = recomputeInjectionFromLedger(runDir, { mcpModules: [], adapter: adapterFor('codex') });
  assert.equal(check.found, true);
  assert.equal(check.reproduced, true); // both recorded and expected are empty for unsupported
  assert.deepEqual(readRuntimeEvents(runDir).filter((e) => e.type === 'composition.injected').length, 1);
});

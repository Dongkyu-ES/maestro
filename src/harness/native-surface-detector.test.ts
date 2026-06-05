import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLabelMatchesObservation, deriveNativeHarnessAssisted, detectNativeSurfaces } from './native-surface-detector.js';

test('T11 derives native-harness-assisted from AGENTS.md reads', () => {
  const result = deriveNativeHarnessAssisted({ readPaths: ['/repo/AGENTS.md'] });

  assert.equal(result.nativeHarnessAssisted, true);
  assert.equal(result.surfaces.includes('native_instructions'), true);
});

test('T11 derives native-harness-assisted from codex_cli adapter', () => {
  const result = deriveNativeHarnessAssisted({ adapter: 'codex_cli' });

  assert.equal(result.nativeHarnessAssisted, true);
  assert.deepEqual(result.surfaces, ['native_session']);
});

test('T11 leaves clean direct runs unassisted', () => {
  const result = deriveNativeHarnessAssisted({
    readPaths: ['/repo/src/direct-runner.ts'],
    transcript: 'plain process output with no native markers',
    adapter: 'direct_node',
  });

  assert.equal(result.nativeHarnessAssisted, false);
  assert.deepEqual(result.surfaces, []);
});

test('T11 blocks forged omission of native-harness-assisted label', () => {
  assert.throws(() => assertLabelMatchesObservation(false, { readPaths: ['/repo/AGENTS.md'] }), /native_instructions/);
});

test('T11 native surface detection is deterministic and stably sorted', () => {
  const obs = {
    readPaths: ['/repo/.codex/memories/MEMORY.md', '/repo/AGENTS.md', '/repo/AGENTS.md'],
    transcript: 'spawn_agent used a codex-session after context compaction',
    adapter: 'codex_cli',
    sessionIds: ['session-123'],
  };

  const first = detectNativeSurfaces(obs);
  const second = detectNativeSurfaces({
    transcript: obs.transcript,
    adapter: obs.adapter,
    readPaths: [...obs.readPaths].reverse(),
    sessionIds: [...obs.sessionIds],
  });

  assert.deepEqual(first, ['native_instructions', 'native_memory', 'native_subagents', 'native_compaction', 'native_session']);
  assert.deepEqual(first, second);
});

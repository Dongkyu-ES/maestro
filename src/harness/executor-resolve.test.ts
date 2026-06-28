import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHarnessExecutor } from './executor-resolve.js';

const detectYes = () => true;
const detectNo = () => false;

test('built-in codex resolves to the native default (undefined executor)', () => {
  const r = resolveHarnessExecutor('codex', undefined, detectNo);
  assert.equal(r.tier, 'native-codex');
  assert.equal(r.executor, undefined);
  assert.equal(r.label, 'codex');
});

test('built-in claude/agy resolve to a shipped CLI executor', () => {
  for (const kind of ['claude', 'agy']) {
    const r = resolveHarnessExecutor(kind, undefined, detectNo);
    assert.equal(r.tier, 'builtin-cli');
    assert.equal(typeof r.executor, 'function');
    assert.equal(r.label, kind);
  }
});

test('unknown executor name + present binary resolves as bring-your-own (no throw)', () => {
  const r = resolveHarnessExecutor('mycli', '/opt/tools/mycli', detectYes);
  assert.equal(r.tier, 'byo-cli');
  assert.equal(typeof r.executor, 'function');
  assert.equal(r.label, 'mycli');
});

test('unknown executor name defaults bin to the name itself', () => {
  let seen = '';
  const detect = (bin: string) => {
    seen = bin;
    return true;
  };
  const r = resolveHarnessExecutor('opencode', undefined, detect);
  assert.equal(seen, 'opencode'); // bin defaulted to the kind
  assert.equal(r.tier, 'byo-cli');
});

test('unknown executor with a missing binary throws a helpful error', () => {
  assert.throws(() => resolveHarnessExecutor('typo', undefined, detectNo), /unknown executor 'typo'.*--executor-bin/s);
});

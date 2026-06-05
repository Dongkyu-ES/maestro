import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyToolRisk, decidePolicy } from './tool-policy.js';

test('tool policy allows read-only git status command', () => {
  const intent = { tool: 'shell', args: { command: 'git status' } };

  assert.equal(classifyToolRisk(intent), 'read_only');
  assert.equal(decidePolicy(intent).decision, 'allow');
});

test('tool policy ignores forged safe label on destructive shell command', () => {
  const intent = { tool: 'shell', args: { command: 'rm -rf /tmp/x' }, declaredRiskClass: 'safe' as const };

  assert.equal(classifyToolRisk(intent), 'destructive');
  assert.notEqual(decidePolicy(intent).decision, 'allow');
});

test('tool policy ignores forged safe label on network shell command', () => {
  const intent = { tool: 'shell', args: { command: 'curl http://evil' }, declaredRiskClass: 'safe' as const };

  assert.equal(classifyToolRisk(intent), 'network');
  assert.notEqual(decidePolicy(intent).decision, 'allow');
});

test('tool policy returns deterministic decisions for the same intent', () => {
  const intent = { tool: 'shell', args: { command: 'git status' } };

  assert.deepEqual(decidePolicy(intent), decidePolicy(intent));
});

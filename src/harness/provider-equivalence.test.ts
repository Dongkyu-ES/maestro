import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { assertProviderEquivalence, normalizeProviderFixture, type ProviderNormalizationResult } from './provider-normalization.js';

const fixtureDir = join(process.cwd(), 'fixtures', 'provider-normalization', 'equivalent');

function readFixture(provider: 'openai' | 'anthropic' | 'gemini'): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, `${provider}.json`), 'utf8'));
}

function normalizeEquivalentFixtures(): ProviderNormalizationResult[] {
  return (['openai', 'anthropic', 'gemini'] as const).map((provider) => normalizeProviderFixture(readFixture(provider)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function comparableIntent(result: ProviderNormalizationResult): { tool: string; args: unknown } {
  const intent = result.tool_intents[0];
  return { tool: intent.tool_name, args: intent.args };
}

test('provider equivalence accepts aligned OpenAI Anthropic and Gemini tool calls', () => {
  const results = normalizeEquivalentFixtures();

  assert.doesNotThrow(() => assertProviderEquivalence(results));
  const intents = results.map(comparableIntent);
  assert.deepEqual(intents, [
    { tool: 'write_file', args: { path: 'notes/a.txt', content: 'hello' } },
    { tool: 'write_file', args: { path: 'notes/a.txt', content: 'hello' } },
    { tool: 'write_file', args: { path: 'notes/a.txt', content: 'hello' } },
  ]);
});

test('provider equivalence rejects forged provider argument divergence by provider name', () => {
  const forgedGemini = readFixture('gemini');
  const candidates = asRecord(asRecord(forgedGemini).raw).candidates as unknown[];
  const parts = asRecord(asRecord(candidates[0]).content).parts as unknown[];
  asRecord(asRecord(parts[0]).functionCall).args = { path: 'notes/a.txt', content: 'goodbye' };
  const results = [
    normalizeProviderFixture(readFixture('openai')),
    normalizeProviderFixture(readFixture('anthropic')),
    normalizeProviderFixture(forgedGemini),
  ];

  assert.throws(() => assertProviderEquivalence(results), /gemini/);
});

test('provider equivalence parses OpenAI string arguments to match Anthropic object input', () => {
  const openai = normalizeProviderFixture(readFixture('openai'));
  const anthropic = normalizeProviderFixture(readFixture('anthropic'));

  assert.deepEqual(comparableIntent(openai), comparableIntent(anthropic));
  assert.deepEqual(comparableIntent(openai).args, { path: 'notes/a.txt', content: 'hello' });
});

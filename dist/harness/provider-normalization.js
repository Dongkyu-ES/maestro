import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
function asRecord(value) {
    return value && typeof value === 'object' ? value : {};
}
function parseArgs(value) {
    if (typeof value !== 'string')
        return value ?? {};
    try {
        return JSON.parse(value);
    }
    catch {
        return { __invalid_json_arguments: value };
    }
}
function providerFromFixture(fixture) {
    const value = asRecord(fixture).provider;
    return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'local' ? value : undefined;
}
export function normalizeProviderFixture(fixture) {
    const provider = providerFromFixture(fixture);
    if (!provider) {
        return { provider: 'local', status: 'unsupported', tool_intents: [], reason: 'missing or unknown provider' };
    }
    const raw = asRecord(asRecord(fixture).raw || fixture);
    if (provider === 'openai') {
        const message = asRecord(asRecord(raw.choices?.[0]).message);
        if (typeof message.refusal === 'string' && message.refusal) {
            return { provider, status: 'refusal', tool_intents: [], refusal_reason: message.refusal, reason: 'OpenAI refusal field' };
        }
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        const toolIntents = calls
            .map((call) => asRecord(call))
            .filter((call) => asRecord(call.function).name)
            .map((call) => ({
            provider,
            call_id: String(call.id || ''),
            tool_name: String(asRecord(call.function).name),
            args: parseArgs(asRecord(call.function).arguments),
            provider_raw_kind: 'openai.tool_calls',
        }));
        return toolIntents.length
            ? { provider, status: 'tool_intent', tool_intents: toolIntents, reason: 'normalized OpenAI tool_calls' }
            : { provider, status: 'unsupported', tool_intents: [], reason: 'OpenAI fixture has no schema-valid tool_calls or refusal' };
    }
    if (provider === 'anthropic') {
        const content = Array.isArray(raw.content) ? raw.content.map(asRecord) : [];
        const refusal = content.find((item) => item.type === 'refusal' || raw.stop_reason === 'refusal');
        if (refusal) {
            return { provider, status: 'refusal', tool_intents: [], refusal_reason: String(refusal.text || raw.stop_reason || 'refusal'), reason: 'Anthropic refusal content' };
        }
        const toolIntents = content
            .filter((item) => item.type === 'tool_use' && item.name)
            .map((item) => ({
            provider,
            call_id: String(item.id || ''),
            tool_name: String(item.name),
            args: item.input ?? {},
            provider_raw_kind: 'anthropic.tool_use',
        }));
        return toolIntents.length
            ? { provider, status: 'tool_intent', tool_intents: toolIntents, reason: 'normalized Anthropic tool_use' }
            : { provider, status: 'unsupported', tool_intents: [], reason: 'Anthropic fixture has no schema-valid tool_use or refusal' };
    }
    if (provider === 'gemini') {
        const candidate = asRecord(raw.candidates?.[0]);
        const finishReason = String(candidate.finishReason || '');
        if (/SAFETY|RECITATION|BLOCKLIST|PROHIBITED/i.test(finishReason)) {
            return { provider, status: 'refusal', tool_intents: [], refusal_reason: finishReason, reason: 'Gemini blocking finishReason' };
        }
        const parts = Array.isArray(asRecord(asRecord(candidate.content).parts).parts)
            ? asRecord(asRecord(candidate.content).parts).parts
            : Array.isArray(asRecord(candidate.content).parts)
                ? asRecord(candidate.content).parts
                : [];
        const toolIntents = parts
            .map(asRecord)
            .map((part) => asRecord(part.functionCall))
            .filter((call) => call.name)
            .map((call, index) => ({
            provider,
            call_id: String(call.id || `gemini-call-${index + 1}`),
            tool_name: String(call.name),
            args: call.args ?? {},
            provider_raw_kind: 'gemini.functionCall',
        }));
        return toolIntents.length
            ? { provider, status: 'tool_intent', tool_intents: toolIntents, reason: 'normalized Gemini functionCall' }
            : { provider, status: 'unsupported', tool_intents: [], reason: 'Gemini fixture has no schema-valid functionCall or refusal' };
    }
    if (raw.refusal === true || typeof raw.refusal === 'string') {
        return { provider, status: 'refusal', tool_intents: [], refusal_reason: String(raw.reason || raw.refusal), reason: 'local refusal field' };
    }
    const tool = asRecord(raw.tool || raw.tool_calls?.[0]);
    if (tool.name) {
        return {
            provider,
            status: 'tool_intent',
            tool_intents: [{ provider, call_id: String(tool.id || 'local-call-1'), tool_name: String(tool.name), args: tool.args ?? {}, provider_raw_kind: 'local.tool' }],
            reason: 'normalized local tool call',
        };
    }
    return { provider, status: 'unsupported', tool_intents: [], reason: 'local fixture has no schema-valid tool call or refusal' };
}
function comparableToolIntent(result) {
    const intent = result.tool_intents[0];
    return { tool: intent?.tool_name || '', args: intent?.args ?? {} };
}
export function assertProviderEquivalence(results) {
    let expected;
    for (const result of results) {
        if (result.status !== 'tool_intent') {
            throw new Error(`Provider equivalence failed for ${result.provider}: status ${result.status}`);
        }
        if (!result.tool_intents[0]) {
            throw new Error(`Provider equivalence failed for ${result.provider}: missing first tool_intent`);
        }
        const actual = comparableToolIntent(result);
        expected ??= actual;
        if (!isDeepStrictEqual(actual, expected)) {
            throw new Error(`Provider equivalence failed for ${result.provider}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
        }
    }
}
export function runProviderConformance(options) {
    const fixtureDir = options.fixtureDir || join(options.root, 'fixtures', 'provider-normalization');
    const fixtures = existsSync(fixtureDir)
        ? readdirSync(fixtureDir)
            .filter((file) => file.endsWith('.json'))
            .sort()
            .map((file) => JSON.parse(readFileSync(join(fixtureDir, file), 'utf8')))
        : [];
    const results = fixtures.map(normalizeProviderFixture);
    const providers = new Set(results.map((result) => result.provider));
    const hasRequiredProviders = ['openai', 'anthropic', 'gemini', 'local'].every((provider) => providers.has(provider));
    const hasToolIntent = results.some((result) => result.status === 'tool_intent');
    const hasRefusal = results.some((result) => result.status === 'refusal');
    const noUnsupported = results.every((result) => result.status !== 'unsupported');
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        decision: hasRequiredProviders && hasToolIntent && hasRefusal && noUnsupported ? 'PASS' : 'FAIL',
        phase_a_proof_allowed: false,
        checked_fixture_count: fixtures.length,
        results,
    };
    const reportPath = options.reportPath || join(options.root, '.agent', 'hard-gates', 'provider-conformance.json');
    mkdirSync(join(options.root, '.agent', 'hard-gates'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
}

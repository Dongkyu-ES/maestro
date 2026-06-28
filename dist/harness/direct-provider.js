import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
const DEFAULT_EDIT_INSTRUCTIONS = [
    'You are a single-turn code executor. Make the requested change by emitting the FULL new content of',
    'each file you create or modify, each wrapped EXACTLY as:',
    '<<<FILE relative/path/to/file',
    '...full file content...',
    '>>>FILE',
    'Emit nothing outside these blocks except a short rationale. Use repo-relative paths only.',
    'A file content must not itself contain a line equal to >>>FILE (it would end the block early).',
    'Never write into .git or .agent.',
    'If you cannot or should not do the task, reply with the single line: REFUSE: <reason> and no FILE blocks.',
].join('\n');
const FILE_BLOCK_RE = /<<<FILE[ \t]+([^\n\r]+)\r?\n([\s\S]*?)\r?\n?>>>FILE/g;
/**
 * Parse the product-owned single-turn edit protocol out of a model response. The product (not the
 * model's loop) is what applies these — that is the whole point of "direct" mode.
 */
export function parseFileDirectives(text) {
    const directives = [];
    for (const match of text.matchAll(FILE_BLOCK_RE)) {
        const path = match[1].trim();
        if (path)
            directives.push({ path, content: match[2] });
    }
    return directives;
}
// Top-level dirs a direct edit must never touch: `.git` (a malicious model could plant a git hook)
// and `.agent` (the evidence/ledger store — letting the model write there would forge the very
// evidence the verifier trusts). This guard is part of the anti-laundering boundary, not just hygiene.
const DENIED_TOP_SEGMENTS = new Set(['.git', '.agent']);
// Bound the blast radius of a single turn: a runaway response cannot write an unbounded number of files.
const MAX_DIRECTIVES_APPLIED = 200;
/** A repo-relative path with no traversal, no absolute escape, and no write into .git/.agent. */
function isSafeRelPath(path) {
    if (!path || isAbsolute(path))
        return false;
    const segments = path.split(/[\\/]/);
    if (segments.some((seg) => seg === '..' || seg === ''))
        return false;
    return !DENIED_TOP_SEGMENTS.has(segments[0]);
}
function applyDirectives(cwd, directives) {
    const applied = [];
    for (const directive of directives.slice(0, MAX_DIRECTIVES_APPLIED)) {
        if (!isSafeRelPath(directive.path))
            continue; // skip unsafe paths rather than write outside cwd / into evidence
        const full = join(cwd, directive.path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, directive.content.endsWith('\n') ? directive.content : `${directive.content}\n`);
        applied.push(directive.path);
    }
    return applied;
}
/**
 * Build a HarnessExecutor backed by a direct provider transport. The returned executor never throws:
 * a transport failure or a refusal yields a non-zero result with no edits, so the slice's verifier
 * reports `unproven` (no diff) rather than a false success.
 */
export function makeDirectProviderExecutor(opts) {
    return async (o) => {
        const started = new Date().toISOString();
        const base = {
            label: o.label ?? opts.name,
            cwd: o.cwd,
            command: `direct:${opts.name}`,
            started_at: started,
            signal: null,
            timed_out: false,
            cancelled: false,
            event_count: 1,
            stdout: '',
            stderr: '',
        };
        let response;
        try {
            response = await opts.transport({
                prompt: `${opts.instructions ?? DEFAULT_EDIT_INSTRUCTIONS}\n\n${o.prompt}`,
                timeoutMs: o.timeoutMs,
            });
        }
        catch (error) {
            return {
                ...base,
                ended_at: new Date().toISOString(),
                exit_code: 1,
                last_message: `direct provider transport error: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        const directives = response.refused ? [] : parseFileDirectives(response.text);
        const applied = applyDirectives(o.cwd, directives);
        return {
            ...base,
            ended_at: new Date().toISOString(),
            // Refusal, a transport that produced no parseable/appliable edits → non-zero, so the verifier
            // sees no diff and reports unproven instead of a forged success.
            exit_code: response.refused || applied.length === 0 ? 1 : 0,
            last_message: response.text,
            token_usage: response.usage,
        };
    };
}
/**
 * Real Anthropic direct transport (behind ANTHROPIC_API_KEY). Single message turn, no tools — the
 * product applies the declared edits. Not exercised in CI (needs a key); the fake transport proves
 * the contract. Kept minimal and dependency-free (uses fetch).
 */
export function anthropicDirectTransport(opts = {}) {
    return async ({ prompt }) => {
        const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error('anthropicDirectTransport requires ANTHROPIC_API_KEY');
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: opts.model ?? 'claude-sonnet-4-6',
                max_tokens: opts.maxTokens ?? 8192,
                messages: [{ role: 'user', content: prompt }],
            }),
        });
        if (!res.ok)
            throw new Error(`anthropic direct transport HTTP ${res.status}`);
        const data = (await res.json());
        const text = (data.content ?? [])
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
        return { text, refused: /^REFUSE:/m.test(text), usage: data.usage };
    };
}

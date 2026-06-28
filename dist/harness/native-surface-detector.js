const SURFACE_ORDER = [
    'native_instructions',
    'native_memory',
    'native_hooks',
    'native_subagents',
    'native_compaction',
    'native_session',
];
const NATIVE_SESSION_ADAPTERS = new Set(['codex_cli', 'claude_code', 'omx', 'agy']);
function normalizePath(path) {
    return path.replaceAll('\\', '/').toLowerCase();
}
function pathEndsWith(path, suffix) {
    return path === suffix || path.endsWith(`/${suffix}`);
}
function pathContainsSegment(path, segment) {
    return path === segment || path.includes(`/${segment}/`) || path.startsWith(`${segment}/`) || path.endsWith(`/${segment}`);
}
function detectPathSurface(path) {
    const normalizedPath = normalizePath(path);
    const surfaces = [];
    if (pathEndsWith(normalizedPath, 'agents.md') ||
        pathEndsWith(normalizedPath, 'claude.md') ||
        pathEndsWith(normalizedPath, 'claude.local.md') ||
        pathContainsSegment(normalizedPath, '.claude')) {
        surfaces.push('native_instructions');
    }
    if (pathContainsSegment(normalizedPath, '.codex/memories') ||
        pathContainsSegment(normalizedPath, '.codex/memory') ||
        pathEndsWith(normalizedPath, 'memory_summary.md') ||
        pathEndsWith(normalizedPath, 'codex-memory.md') ||
        pathEndsWith(normalizedPath, 'claude-memory.md')) {
        surfaces.push('native_memory');
    }
    if (pathContainsSegment(normalizedPath, '.codex/hooks') ||
        pathContainsSegment(normalizedPath, '.claude/hooks') ||
        pathEndsWith(normalizedPath, 'hooks.json')) {
        surfaces.push('native_hooks');
    }
    if (pathContainsSegment(normalizedPath, '.codex/agents') ||
        pathContainsSegment(normalizedPath, '.claude/agents') ||
        pathContainsSegment(normalizedPath, '.agents')) {
        surfaces.push('native_subagents');
    }
    return surfaces;
}
function detectTranscriptSurfaces(transcript) {
    const surfaces = [];
    if (/thread_id|codex-session|claude-session|session[_ -]?id/i.test(transcript)) {
        surfaces.push('native_session');
    }
    if (/compaction|compacted|context summary|summary of prior conversation/i.test(transcript)) {
        surfaces.push('native_compaction');
    }
    if (/subagent|sub-agent|spawn_agent|agent_type|native child agent/i.test(transcript)) {
        surfaces.push('native_subagents');
    }
    if (/userpromptsubmit|stop-hook|pretooluse|posttooluse|native hook/i.test(transcript)) {
        surfaces.push('native_hooks');
    }
    return surfaces;
}
export function detectNativeSurfaces(obs) {
    const surfaces = new Set();
    for (const readPath of obs.readPaths ?? []) {
        for (const surface of detectPathSurface(readPath)) {
            surfaces.add(surface);
        }
    }
    if (obs.adapter && NATIVE_SESSION_ADAPTERS.has(obs.adapter)) {
        surfaces.add('native_session');
    }
    if ((obs.sessionIds ?? []).some((sessionId) => sessionId.trim().length > 0)) {
        surfaces.add('native_session');
    }
    if (obs.transcript) {
        for (const surface of detectTranscriptSurfaces(obs.transcript)) {
            surfaces.add(surface);
        }
    }
    return SURFACE_ORDER.filter((surface) => surfaces.has(surface));
}
export function deriveNativeHarnessAssisted(obs) {
    const surfaces = detectNativeSurfaces(obs);
    return { nativeHarnessAssisted: surfaces.length > 0, surfaces };
}
export function assertLabelMatchesObservation(declaredAssisted, obs) {
    const surfaces = detectNativeSurfaces(obs);
    if (!declaredAssisted && surfaces.length > 0) {
        throw new Error(`silent native harness detected; observed surfaces: ${surfaces.join(', ')}`);
    }
}

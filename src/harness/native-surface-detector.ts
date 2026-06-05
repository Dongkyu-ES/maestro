export type NativeSurface =
  | 'native_instructions'
  | 'native_memory'
  | 'native_hooks'
  | 'native_subagents'
  | 'native_compaction'
  | 'native_session';

export interface RunObservation {
  readPaths?: string[];
  transcript?: string;
  adapter?: string;
  sessionIds?: string[];
}

const SURFACE_ORDER: NativeSurface[] = [
  'native_instructions',
  'native_memory',
  'native_hooks',
  'native_subagents',
  'native_compaction',
  'native_session',
];

const NATIVE_SESSION_ADAPTERS = new Set(['codex_cli', 'claude_code', 'omx', 'agy']);

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

function pathEndsWith(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`);
}

function pathContainsSegment(path: string, segment: string): boolean {
  return path === segment || path.includes(`/${segment}/`) || path.startsWith(`${segment}/`) || path.endsWith(`/${segment}`);
}

function detectPathSurface(path: string): NativeSurface[] {
  const normalizedPath = normalizePath(path);
  const surfaces: NativeSurface[] = [];

  if (
    pathEndsWith(normalizedPath, 'agents.md') ||
    pathEndsWith(normalizedPath, 'claude.md') ||
    pathEndsWith(normalizedPath, 'claude.local.md') ||
    pathContainsSegment(normalizedPath, '.claude')
  ) {
    surfaces.push('native_instructions');
  }

  if (
    pathContainsSegment(normalizedPath, '.codex/memories') ||
    pathContainsSegment(normalizedPath, '.codex/memory') ||
    pathEndsWith(normalizedPath, 'memory_summary.md') ||
    pathEndsWith(normalizedPath, 'codex-memory.md') ||
    pathEndsWith(normalizedPath, 'claude-memory.md')
  ) {
    surfaces.push('native_memory');
  }

  if (
    pathContainsSegment(normalizedPath, '.codex/hooks') ||
    pathContainsSegment(normalizedPath, '.claude/hooks') ||
    pathEndsWith(normalizedPath, 'hooks.json')
  ) {
    surfaces.push('native_hooks');
  }

  if (
    pathContainsSegment(normalizedPath, '.codex/agents') ||
    pathContainsSegment(normalizedPath, '.claude/agents') ||
    pathContainsSegment(normalizedPath, '.agents')
  ) {
    surfaces.push('native_subagents');
  }

  return surfaces;
}

function detectTranscriptSurfaces(transcript: string): NativeSurface[] {
  const surfaces: NativeSurface[] = [];

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

export function detectNativeSurfaces(obs: RunObservation): NativeSurface[] {
  const surfaces = new Set<NativeSurface>();

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

export function deriveNativeHarnessAssisted(obs: RunObservation): { nativeHarnessAssisted: boolean; surfaces: NativeSurface[] } {
  const surfaces = detectNativeSurfaces(obs);
  return { nativeHarnessAssisted: surfaces.length > 0, surfaces };
}

export function assertLabelMatchesObservation(declaredAssisted: boolean, obs: RunObservation): void {
  const surfaces = detectNativeSurfaces(obs);
  if (!declaredAssisted && surfaces.length > 0) {
    throw new Error(`silent native harness detected; observed surfaces: ${surfaces.join(', ')}`);
  }
}

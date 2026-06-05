export interface MemoryEntry {
  id: string;
  category: 'preference' | 'project_fact' | 'runtime_fact' | 'prior_result' | 'hypothesis' | 'rejected';
  claim: string;
  scope: string;
  source: string;
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
  lastVerifiedAt?: string;
}

export type InjectionLabel = 'confirmed_fact' | 'unverified' | 'stale' | 'excluded';

export interface MemoryInjectionOptions {
  now: string;
  freshnessWindowMs: number;
}

export interface MemoryAssertionOptions extends MemoryInjectionOptions {
  injectedFactIds?: string[];
}

export interface MemoryContextSection {
  id: string;
  text: string;
  label: InjectionLabel;
}

function millisecondsSinceVerification(entry: MemoryEntry, now: string): number | undefined {
  if (!entry.lastVerifiedAt) {
    return undefined;
  }
  return new Date(now).getTime() - new Date(entry.lastVerifiedAt).getTime();
}

export function classifyMemoryForInjection(entry: MemoryEntry, opts: MemoryInjectionOptions): InjectionLabel {
  if (entry.category === 'rejected') {
    return 'excluded';
  }

  if (entry.category === 'hypothesis') {
    return 'unverified';
  }

  const verifiedAgeMs = millisecondsSinceVerification(entry, opts.now);
  if (verifiedAgeMs === undefined) {
    return 'unverified';
  }

  if (Number.isFinite(verifiedAgeMs) && verifiedAgeMs <= opts.freshnessWindowMs) {
    return 'confirmed_fact';
  }

  return 'stale';
}

function formatMemorySection(entry: MemoryEntry, label: InjectionLabel): string {
  return `[${label}] ${entry.claim} (scope: ${entry.scope}; source: ${entry.source}; confidence: ${entry.confidence})`;
}

export function buildMemoryContextSections(
  entries: MemoryEntry[],
  opts: MemoryInjectionOptions,
): { sections: MemoryContextSection[]; injectedFactIds: string[] } {
  const sections = [...entries]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => {
      const label = classifyMemoryForInjection(entry, opts);
      return {
        id: entry.id,
        text: formatMemorySection(entry, label),
        label,
      };
    });

  return {
    sections,
    injectedFactIds: sections.filter((section) => section.label === 'confirmed_fact').map((section) => section.id),
  };
}

export function assertNoStaleAsFact(entries: MemoryEntry[], opts: MemoryAssertionOptions): void {
  const labelsById = new Map(entries.map((entry) => [entry.id, classifyMemoryForInjection(entry, opts)]));

  for (const id of opts.injectedFactIds ?? []) {
    const label = labelsById.get(id);
    if (label !== 'confirmed_fact') {
      throw new Error(`memory entry ${id} cannot be injected as confirmed_fact; classified as ${label ?? 'missing'}`);
    }
  }
}

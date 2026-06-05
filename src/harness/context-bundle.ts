import { createHash } from 'node:crypto';
import { stableJson } from '../events/ledger.js';

export type ContextSectionKind =
  | 'goal'
  | 'rule'
  | 'memory'
  | 'repo'
  | 'artifact'
  | 'policy'
  | 'acceptance'
  | 'provider_hint';

export interface ContextSection {
  id: string;
  kind: ContextSectionKind;
  text: string;
  sourceRef: string;
}

export interface ContextBundleInput {
  role: 'manager' | 'worker' | 'reviewer' | 'verifier' | 'critic' | 'generic';
  providerProfile: string;
  sections: ContextSection[];
  includedRuleIds: string[];
  includedMemoryIds: string[];
  toolPolicyId: string;
  acceptanceContractId: string;
}

export interface ContextBundleSection extends ContextSection {
  sha256: string;
}

export interface ContextBundle {
  id: string;
  sha256: string;
  role: ContextBundleInput['role'];
  providerProfile: string;
  sections: ContextBundleSection[];
  includedRuleIds: string[];
  includedMemoryIds: string[];
  toolPolicyId: string;
  acceptanceContractId: string;
}

function sha256Stable(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function compareSections(left: ContextSection, right: ContextSection): number {
  const kindOrder = left.kind.localeCompare(right.kind);
  return kindOrder === 0 ? left.id.localeCompare(right.id) : kindOrder;
}

function buildSection(section: ContextSection): ContextBundleSection {
  return {
    ...section,
    sha256: sha256Stable({
      kind: section.kind,
      id: section.id,
      sourceRef: section.sourceRef,
      text: section.text,
    }),
  };
}

export function buildContextBundle(input: ContextBundleInput): ContextBundle {
  const sections = [...input.sections].sort(compareSections).map(buildSection);
  const includedRuleIds = [...input.includedRuleIds].sort();
  const includedMemoryIds = [...input.includedMemoryIds].sort();
  const sha256 = sha256Stable({
    role: input.role,
    providerProfile: input.providerProfile,
    sections: sections.map((section) => section.sha256),
    includedRuleIds,
    includedMemoryIds,
    toolPolicyId: input.toolPolicyId,
    acceptanceContractId: input.acceptanceContractId,
  });

  return {
    id: `context-bundle:${sha256}`,
    sha256,
    role: input.role,
    providerProfile: input.providerProfile,
    sections,
    includedRuleIds,
    includedMemoryIds,
    toolPolicyId: input.toolPolicyId,
    acceptanceContractId: input.acceptanceContractId,
  };
}

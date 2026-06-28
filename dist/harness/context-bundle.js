import { createHash } from 'node:crypto';
import { stableJson } from '../events/ledger.js';
function sha256Stable(value) {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}
function compareSections(left, right) {
    const kindOrder = left.kind.localeCompare(right.kind);
    return kindOrder === 0 ? left.id.localeCompare(right.id) : kindOrder;
}
function buildSection(section) {
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
export function buildContextBundle(input) {
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

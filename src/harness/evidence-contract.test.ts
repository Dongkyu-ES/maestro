import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTRACT_STATUSES,
  EVIDENCE_CONTRACT,
  type ContractTypeName,
  type EvidenceContractDefinition,
  assertEvidenceContractValid,
  validateEvidenceContract,
} from './evidence-contract.js';

test('M0 evidence contract validates one provisional surface for run event verifier context memory promotion and status', () => {
  assertEvidenceContractValid();
  const names = new Set(EVIDENCE_CONTRACT.types.map((type) => type.name));
  const requiredTypes: ContractTypeName[] = [
    'RunContract',
    'EventContract',
    'VerifierContract',
    'ContextContract',
    'MemoryContract',
    'PromotionContract',
    'StatusContract',
  ];
  for (const required of requiredTypes) {
    assert.equal(names.has(required), true, `missing ${required}`);
  }
  assert.deepEqual(EVIDENCE_CONTRACT.statusVocabulary, CONTRACT_STATUSES);
});

test('M0 contract rejects missing referenced types instead of allowing phantom schema dependencies', () => {
  const broken: EvidenceContractDefinition = {
    ...EVIDENCE_CONTRACT,
    types: EVIDENCE_CONTRACT.types.map((type) =>
      type.name === 'RunContract'
        ? {
            ...type,
            fields: [...type.fields, { name: 'phantom', type: 'MissingContract', stability: 'stable', references: ['MissingContract' as never] }],
          }
        : type,
    ),
  };
  assert.match(validateEvidenceContract(broken).join('\n'), /references missing type MissingContract/);
});

test('M0 contract keeps direct provider and tool intent fields unstable until real adapter evidence exists', () => {
  const broken: EvidenceContractDefinition = {
    ...EVIDENCE_CONTRACT,
    types: EVIDENCE_CONTRACT.types.map((type) =>
      type.name === 'ExecutorContract' ? { ...type, stability: 'stable' } : type,
    ),
  };
  assert.match(validateEvidenceContract(broken).join('\n'), /ExecutorContract must remain unstable/);
});

test('M0 contract rejects status vocabulary expansion that would reopen completion laundering', () => {
  const broken = {
    ...EVIDENCE_CONTRACT,
    statusVocabulary: [...EVIDENCE_CONTRACT.statusVocabulary, 'looks-good-from-claude'],
  } as unknown as EvidenceContractDefinition;
  assert.match(validateEvidenceContract(broken).join('\n'), /unknown status: looks-good-from-claude/);
});

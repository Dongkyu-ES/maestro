export const CONTRACT_STATUSES = [
  'supported',
  'degraded',
  'unproven',
  'unsupported',
  'native-harness-assisted',
  'soft-by-decision',
  'blocked',
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type Stability = 'stable' | 'unstable: pending evidence';

export type ContractTypeName =
  | 'RunContract'
  | 'EventContract'
  | 'VerifierContract'
  | 'ContextContract'
  | 'MemoryContract'
  | 'PromotionContract'
  | 'StatusContract'
  | 'ExecutorContract'
  | 'ToolIntentContract';

export interface ContractFieldDefinition {
  readonly name: string;
  readonly type: string;
  readonly stability: Stability;
  readonly references?: readonly ContractTypeName[];
}

export interface ContractTypeDefinition {
  readonly name: ContractTypeName;
  readonly purpose: string;
  readonly stability: Stability;
  readonly fields: readonly ContractFieldDefinition[];
}

export interface EvidenceContractDefinition {
  readonly schemaVersion: 1;
  readonly statusVocabulary: readonly ContractStatus[];
  readonly types: readonly ContractTypeDefinition[];
}

export const EVIDENCE_CONTRACT: EvidenceContractDefinition = {
  schemaVersion: 1,
  statusVocabulary: CONTRACT_STATUSES,
  types: [
    {
      name: 'StatusContract',
      purpose: 'Closed status vocabulary; absence of evidence defaults to unproven.',
      stability: 'stable',
      fields: [
        { name: 'status', type: 'ContractStatus', stability: 'stable' },
        { name: 'reason', type: 'string', stability: 'stable' },
      ],
    },
    {
      name: 'EventContract',
      purpose: 'Append-only run fact with hash-chain and current-run freshness binding.',
      stability: 'stable',
      fields: [
        { name: 'eventId', type: 'string', stability: 'stable' },
        { name: 'runId', type: 'string', stability: 'stable' },
        { name: 'type', type: 'string', stability: 'stable' },
        { name: 'payloadSha256', type: 'string', stability: 'stable' },
        { name: 'prevEventSha256', type: 'string | null', stability: 'stable' },
        { name: 'status', type: 'StatusContract', stability: 'stable', references: ['StatusContract'] },
      ],
    },
    {
      name: 'ContextContract',
      purpose: 'Hash-addressed context bundle assembled from task, rules, memory, policy, and artifacts.',
      stability: 'stable',
      fields: [
        { name: 'contextHash', type: 'string', stability: 'stable' },
        { name: 'sourceEventIds', type: 'string[]', stability: 'stable' },
        { name: 'memoryRefs', type: 'MemoryContract[]', stability: 'stable', references: ['MemoryContract'] },
      ],
    },
    {
      name: 'MemoryContract',
      purpose: 'Memory fact keyed by provenance and verification recency, not ungrounded drift labels.',
      stability: 'stable',
      fields: [
        { name: 'factId', type: 'string', stability: 'stable' },
        { name: 'sourceEventIds', type: 'string[]', stability: 'stable' },
        { name: 'lastVerifiedAt', type: 'string | null', stability: 'stable' },
        { name: 'authority', type: 'goal | project | global', stability: 'stable' },
      ],
    },
    {
      name: 'ToolIntentContract',
      purpose: 'Provider-normalized tool intent; provisional until a direct provider adapter proves byte fixtures.',
      stability: 'unstable: pending evidence',
      fields: [
        { name: 'toolName', type: 'string', stability: 'stable' },
        { name: 'args', type: 'unknown', stability: 'unstable: pending evidence' },
        { name: 'providerRaw', type: 'unknown', stability: 'unstable: pending evidence' },
      ],
    },
    {
      name: 'ExecutorContract',
      purpose: 'Lower-level executor request/result envelope across native and future direct-provider modes.',
      stability: 'unstable: pending evidence',
      fields: [
        { name: 'mode', type: 'native_harness | direct_model | deterministic', stability: 'stable' },
        { name: 'toolIntents', type: 'ToolIntentContract[]', stability: 'unstable: pending evidence', references: ['ToolIntentContract'] },
        { name: 'parsedOutput', type: 'unknown', stability: 'unstable: pending evidence' },
        { name: 'nativeHarnessSurfaces', type: 'string[]', stability: 'stable' },
      ],
    },
    {
      name: 'VerifierContract',
      purpose: 'Recompute-from-raw verifier result with explicit evidence inputs and negative fixture coverage.',
      stability: 'stable',
      fields: [
        { name: 'verifierType', type: 'artifact | test | ledger | diff | review_custody', stability: 'stable' },
        { name: 'evidenceInputs', type: 'string[]', stability: 'stable' },
        { name: 'status', type: 'StatusContract', stability: 'stable', references: ['StatusContract'] },
        { name: 'forgeryFixtureId', type: 'string', stability: 'stable' },
      ],
    },
    {
      name: 'PromotionContract',
      purpose: 'Approved change plus later effect proof under recorded determinism.',
      stability: 'stable',
      fields: [
        { name: 'proposalRunId', type: 'string', stability: 'stable' },
        { name: 'approvalEventId', type: 'string', stability: 'stable' },
        { name: 'effectRunId', type: 'string', stability: 'stable' },
        { name: 'determinismMode', type: 'temperature0 | replay_majority | deterministic_fixture', stability: 'stable' },
      ],
    },
    {
      name: 'RunContract',
      purpose: 'Top-level run envelope tying executor, events, context, verifier, and promotion facts together.',
      stability: 'stable',
      fields: [
        { name: 'runId', type: 'string', stability: 'stable' },
        { name: 'events', type: 'EventContract[]', stability: 'stable', references: ['EventContract'] },
        { name: 'context', type: 'ContextContract', stability: 'stable', references: ['ContextContract'] },
        { name: 'executor', type: 'ExecutorContract', stability: 'unstable: pending evidence', references: ['ExecutorContract'] },
        { name: 'verifiers', type: 'VerifierContract[]', stability: 'stable', references: ['VerifierContract'] },
        { name: 'promotions', type: 'PromotionContract[]', stability: 'stable', references: ['PromotionContract'] },
      ],
    },
  ],
};

export function validateEvidenceContract(definition: EvidenceContractDefinition = EVIDENCE_CONTRACT): string[] {
  const errors: string[] = [];
  const allowedStatuses = new Set<string>(CONTRACT_STATUSES);
  for (const status of definition.statusVocabulary) {
    if (!allowedStatuses.has(status)) errors.push(`unknown status: ${status}`);
  }
  for (const status of CONTRACT_STATUSES) {
    if (!definition.statusVocabulary.includes(status)) errors.push(`missing status: ${status}`);
  }

  const typeNames = new Set(definition.types.map((type) => type.name));
  for (const type of definition.types) {
    for (const field of type.fields) {
      for (const ref of field.references ?? []) {
        if (!typeNames.has(ref)) errors.push(`${type.name}.${field.name} references missing type ${ref}`);
      }
    }
  }

  for (const typeName of ['ExecutorContract', 'ToolIntentContract'] as const) {
    const type = definition.types.find((item) => item.name === typeName);
    if (!type) {
      errors.push(`missing ${typeName}`);
    } else if (type.stability !== 'unstable: pending evidence') {
      errors.push(`${typeName} must remain unstable until direct-provider evidence exists`);
    }
  }

  return errors;
}

export function assertEvidenceContractValid(definition: EvidenceContractDefinition = EVIDENCE_CONTRACT): void {
  const errors = validateEvidenceContract(definition);
  if (errors.length > 0) throw new Error(`invalid evidence contract:\n${errors.join('\n')}`);
}

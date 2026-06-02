export type MemoryScope =
  | 'global'
  | 'project'
  | 'goal'
  | 'task'
  | 'agent_scratchpad'
  | 'blackboard'
  | 'handoff'
  | 'experiment'
  | 'module_learning';
export type MemoryAuthority = 'automatic_sandbox' | 'operator_approved' | 'system_imported';
export type MemoryMergePolicy =
  | 'append'
  | 'last_writer_wins_with_event_order'
  | 'manual_resolution_required'
  | 'score_update';

export interface MemoryWriteRecord {
  schema_version: 1;
  memory_id: string;
  scope: MemoryScope;
  authority: MemoryAuthority;
  source_event_ids: string[];
  artifact_refs: string[];
  key: string;
  value: unknown;
  merge_policy: MemoryMergePolicy;
  created_at: string;
  writer: string;
}

export function validateMemoryWrite(record: MemoryWriteRecord): void {
  if (record.schema_version !== 1 || !record.memory_id || !record.key || !record.writer)
    throw new Error('memory write missing required fields');
  if (!record.source_event_ids.length && !record.artifact_refs.length)
    throw new Error('memory write requires event or artifact provenance');
  if (
    (record.scope === 'global' || record.scope === 'project') &&
    record.authority !== 'operator_approved' &&
    record.authority !== 'system_imported'
  )
    throw new Error('upper-scope behavior memory requires approval or imported authority');
}

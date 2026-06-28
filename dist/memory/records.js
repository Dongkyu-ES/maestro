export function validateMemoryWrite(record) {
    if (record.schema_version !== 1 || !record.memory_id || !record.key || !record.writer)
        throw new Error('memory write missing required fields');
    if (!record.source_event_ids.length && !record.artifact_refs.length)
        throw new Error('memory write requires event or artifact provenance');
    if ((record.scope === 'global' || record.scope === 'project') &&
        record.authority !== 'operator_approved' &&
        record.authority !== 'system_imported')
        throw new Error('upper-scope behavior memory requires approval or imported authority');
}

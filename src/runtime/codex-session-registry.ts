import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type CodexSessionStatus =
  | 'planned'
  | 'detected'
  | 'launched_unproven'
  | 'attached_unproven'
  | 'unsupported'
  | 'supported';

export interface CodexSessionRecord {
  schema_version: 1;
  session_id: string;
  run_id: string;
  status: CodexSessionStatus;
  cwd: string;
  created_at: string;
  updated_at: string;
  codex_path?: string;
  codex_version?: string;
  transcript_path?: string;
  transcript_sha256?: string;
  evidence_status: 'unsupported' | 'unproven' | 'supported';
  notes: string[];
}

export interface CodexSessionRegistry {
  schema_version: 1;
  sessions: CodexSessionRecord[];
}

export function codexSessionRegistryPath(agentDir: string): string {
  return join(agentDir, 'runtime', 'codex-sessions.json');
}

export function readCodexSessionRegistry(agentDir: string): CodexSessionRegistry {
  const path = codexSessionRegistryPath(agentDir);
  if (!existsSync(path)) return { schema_version: 1, sessions: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as CodexSessionRegistry;
}

export function writeCodexSessionRegistry(agentDir: string, registry: CodexSessionRegistry): void {
  const path = codexSessionRegistryPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2));
}

export function upsertCodexSession(
  agentDir: string,
  record: Omit<CodexSessionRecord, 'schema_version' | 'session_id' | 'created_at' | 'updated_at'> & {
    session_id?: string;
  },
): CodexSessionRecord {
  const now = new Date().toISOString();
  const registry = readCodexSessionRegistry(agentDir);
  const existing = record.session_id
    ? registry.sessions.find((session) => session.session_id === record.session_id)
    : undefined;
  const next: CodexSessionRecord = {
    schema_version: 1,
    session_id: record.session_id || `codex-${record.run_id}-${randomUUID()}`,
    run_id: record.run_id,
    status: record.status,
    cwd: record.cwd,
    created_at: existing?.created_at || now,
    updated_at: now,
    codex_path: record.codex_path,
    codex_version: record.codex_version,
    transcript_path: record.transcript_path,
    transcript_sha256: record.transcript_sha256,
    evidence_status: record.evidence_status,
    notes: record.notes,
  };
  const sessions = registry.sessions.filter((session) => session.session_id !== next.session_id);
  sessions.push(next);
  writeCodexSessionRegistry(agentDir, {
    schema_version: 1,
    sessions: sessions.sort((a, b) => a.session_id.localeCompare(b.session_id)),
  });
  return next;
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

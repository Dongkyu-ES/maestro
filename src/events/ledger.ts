import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redact } from '../util.js';

export type RuntimeEventSource =
  | 'web'
  | 'runtime-manager'
  | 'codex-adapter'
  | 'claude-adapter'
  | 'omx-adapter'
  | 'agy-adapter'
  | 'shell-adapter'
  | 'permission-broker'
  | 'harness'
  | 'memory';

export interface RuntimeEventEnvelope {
  schema_version: 1;
  event_id: string;
  run_id: string;
  session_id?: string;
  parent_event_id?: string;
  causation_id?: string;
  correlation_id: string;
  timestamp: string;
  source: RuntimeEventSource;
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
  artifact_refs: string[];
  payload_sha256: string;
  prev_event_sha256: string;
}

export interface AppendRuntimeEventInput {
  runId: string;
  sessionId?: string;
  source: RuntimeEventSource;
  type: string;
  payload?: Record<string, unknown>;
  artifactRefs?: string[];
  correlationId?: string;
  causationId?: string;
  parentEventId?: string;
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeJsonValue).filter((item) => item !== undefined);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const clean = sanitizeJsonValue(item);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

export function redactJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactJsonValue);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactJsonValue(item);
  return out;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

export function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export const GENESIS_EVENT_HASH = '0'.repeat(64);

export function envelopeHash(event: RuntimeEventEnvelope): string {
  return createHash('sha256').update(stableJson(event)).digest('hex');
}

export function eventLedgerPath(runDir: string): string {
  return join(runDir, 'events.jsonl');
}

export function readRuntimeEvents(runDir: string): RuntimeEventEnvelope[] {
  const path = eventLedgerPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEventEnvelope);
}

export function appendRuntimeEvent(runDir: string, input: AppendRuntimeEventInput): RuntimeEventEnvelope {
  mkdirSync(runDir, { recursive: true });
  const existing = readRuntimeEvents(runDir);
  const payload = redactJsonValue(sanitizeJsonValue(input.payload || {})) as Record<string, unknown>;
  const previous = existing.at(-1);
  const event: RuntimeEventEnvelope = {
    schema_version: 1,
    event_id: randomUUID(),
    run_id: input.runId,
    session_id: input.sessionId,
    parent_event_id: input.parentEventId,
    causation_id: input.causationId,
    correlation_id: input.correlationId || input.runId,
    timestamp: new Date().toISOString(),
    source: input.source,
    type: input.type,
    sequence: existing.length + 1,
    payload,
    artifact_refs: input.artifactRefs || [],
    payload_sha256: payloadHash(payload),
    prev_event_sha256: previous ? envelopeHash(previous) : GENESIS_EVENT_HASH,
  };
  validateRuntimeEvent(event, previous);
  const path = eventLedgerPath(runDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(event)}\n`, { flag: 'a' });
  return event;
}

export function validateRuntimeEvent(event: RuntimeEventEnvelope, previous?: RuntimeEventEnvelope): void {
  if (event.schema_version !== 1) throw new Error('invalid event schema_version');
  if (
    !event.event_id ||
    !event.run_id ||
    !event.correlation_id ||
    !event.timestamp ||
    !event.source ||
    !event.type ||
    typeof event.prev_event_sha256 !== 'string'
  )
    throw new Error('runtime event missing required envelope fields');
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error('invalid event sequence');
  if (previous && event.sequence !== previous.sequence + 1)
    throw new Error(`non-contiguous event sequence: ${previous.sequence} -> ${event.sequence}`);
  if (previous) {
    if (event.prev_event_sha256 !== envelopeHash(previous)) throw new Error('broken event hash chain');
  } else if (event.prev_event_sha256 !== GENESIS_EVENT_HASH) {
    throw new Error('first event must chain to genesis');
  }
  if (event.payload_sha256 !== payloadHash(event.payload)) throw new Error('payload hash mismatch');
  if (!Array.isArray(event.artifact_refs)) throw new Error('artifact_refs must be an array');
}

export interface RuntimeLedgerHeadBinding {
  run_id: string;
  event_count: number;
  ledger_head_sha256: string;
}

export function runtimeLedgerHeadHash(events: RuntimeEventEnvelope[]): string {
  validateRuntimeLedger(events);
  const last = events.at(-1);
  return last ? envelopeHash(last) : GENESIS_EVENT_HASH;
}

export function createRuntimeLedgerHeadBinding(events: RuntimeEventEnvelope[]): RuntimeLedgerHeadBinding {
  validateRuntimeLedger(events);
  const last = events.at(-1);
  return {
    run_id: last?.run_id || '',
    event_count: events.length,
    ledger_head_sha256: runtimeLedgerHeadHash(events),
  };
}

export function assertEvidenceBoundToLedgerHead(
  binding: RuntimeLedgerHeadBinding,
  events: RuntimeEventEnvelope[],
): void {
  const current = createRuntimeLedgerHeadBinding(events);
  if (binding.run_id !== current.run_id) throw new Error('evidence bound to different run ledger');
  if (binding.event_count !== current.event_count) throw new Error('stale evidence event count does not match ledger head');
  if (binding.ledger_head_sha256 !== current.ledger_head_sha256) throw new Error('stale evidence ledger head mismatch');
}

export function validateRuntimeLedger(events: RuntimeEventEnvelope[]): void {
  let previous: RuntimeEventEnvelope | undefined;
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(`${event.run_id}:${event.sequence}`))
      throw new Error(`duplicate event sequence for ${event.run_id}:${event.sequence}`);
    validateRuntimeEvent(event, previous);
    seen.add(`${event.run_id}:${event.sequence}`);
    previous = event;
  }
}

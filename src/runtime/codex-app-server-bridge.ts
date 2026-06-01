import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRuntimeEvent, type RuntimeEventEnvelope } from '../events/ledger.js';

export interface JsonRpcTransport {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface CodexLifecycleTarget {
  runId: string;
  runDir: string;
  threadId: string;
  sessionId?: string;
  turnId?: string;
  forkEphemeral?: boolean;
}

export interface CodexLifecycleProofResult {
  verb: 'resume' | 'fork' | 'interrupt';
  status: 'supported' | 'unproven';
  event?: RuntimeEventEnvelope;
  artifactRef: string;
  reason: string;
  targetThreadId: string;
  responseThreadId?: string;
  turnId?: string;
}

export class CodexAppServerJsonRpcBridge {
  constructor(private readonly transport: JsonRpcTransport) {}

  async proveResume(target: CodexLifecycleTarget): Promise<CodexLifecycleProofResult> {
    const response = await this.transport.request('thread/resume', { threadId: target.threadId });
    const thread = threadFromResponse(response);
    const ok = thread?.id === target.threadId;
    return writeProof(target, 'resume', { method: 'thread/resume', params: { threadId: target.threadId }, response }, ok, ok ? `resumed thread ${thread?.id}` : 'thread/resume response did not match target thread');
  }

  async proveFork(target: CodexLifecycleTarget): Promise<CodexLifecycleProofResult> {
    const response = await this.transport.request('thread/fork', { threadId: target.threadId, ephemeral: target.forkEphemeral || undefined });
    const thread = threadFromResponse(response);
    const ok = Boolean(thread?.id && thread.id !== target.threadId && thread.forkedFromId === target.threadId);
    return writeProof(target, 'fork', { method: 'thread/fork', params: { threadId: target.threadId, ephemeral: target.forkEphemeral || undefined }, response }, ok, ok ? `forked ${target.threadId} -> ${thread?.id}` : 'thread/fork response did not prove forkedFromId linkage');
  }

  async proveInterrupt(target: CodexLifecycleTarget): Promise<CodexLifecycleProofResult> {
    if (!target.turnId) return writeProof(target, 'interrupt', { method: 'turn/interrupt', params: { threadId: target.threadId, turnId: null }, response: null }, false, 'interrupt requires target turnId');
    const response = await this.transport.request('turn/interrupt', { threadId: target.threadId, turnId: target.turnId });
    const readResponse = await this.transport.request('thread/read', { threadId: target.threadId, includeTurns: true });
    const interrupted = hasTurnStatus(readResponse, target.turnId, 'interrupted');
    return writeProof(target, 'interrupt', { method: 'turn/interrupt', params: { threadId: target.threadId, turnId: target.turnId }, response, verification: { method: 'thread/read', params: { threadId: target.threadId, includeTurns: true }, response: readResponse } }, interrupted, interrupted ? `interrupted turn ${target.turnId}` : 'thread/read verification did not show requested turn as interrupted');
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}

export class CodexAppServerStdioTransport implements JsonRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }>();
  private buffer = '';

  constructor(command = 'codex', args = ['app-server', '--listen', 'stdio://'], private readonly requestTimeoutMs = 30000) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => this.onData(chunk.toString()));
    this.child.stderr.on('data', (chunk) => {
      if (process.env.DEBUG_CODEX_APP_SERVER_BRIDGE) process.stderr.write(chunk);
    });
    this.child.on('exit', (code, signal) => {
      const err = new Error(`codex app-server exited code=${code} signal=${signal}`);
      for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(err); }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }

  private onData(text: string): void {
    this.buffer += text;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg.id !== 'number') continue;
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
      else pending.resolve(msg.result);
    }
  }
}

function threadFromResponse(response: unknown): { id?: string; forkedFromId?: string } | undefined {
  const value = response as any;
  return value?.thread && typeof value.thread === 'object' ? value.thread : undefined;
}

function hasTurnStatus(response: unknown, turnId: string, status: string): boolean {
  const turns = (response as any)?.thread?.turns;
  return Array.isArray(turns) && turns.some((turn) => turn?.id === turnId && turn?.status === status);
}

function writeProof(target: CodexLifecycleTarget, verb: CodexLifecycleProofResult['verb'], raw: Record<string, unknown>, ok: boolean, reason: string): CodexLifecycleProofResult {
  mkdirSync(target.runDir, { recursive: true });
  const artifactRef = `codex-app-server-${verb}-proof.json`;
  const artifact = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
      verb,
      target: { run_id: target.runId, thread_id: target.threadId, turn_id: target.turnId, session_id: target.sessionId },
      response_thread_id: threadFromResponse(raw.response)?.id,
      response_forked_from_id: threadFromResponse(raw.response)?.forkedFromId,
      status: ok ? 'supported' : 'unproven',
      reason,
      raw,
  };
  writeFileSync(join(target.runDir, artifactRef), JSON.stringify(artifact, null, 2));
  const sha256 = createHash('sha256').update(readFileSync(join(target.runDir, artifactRef))).digest('hex');
  if (!ok) return { verb, status: 'unproven', artifactRef, reason, targetThreadId: target.threadId, responseThreadId: threadFromResponse(raw.response)?.id, turnId: target.turnId };
  const event = appendRuntimeEvent(target.runDir, {
    runId: target.runId,
    sessionId: target.sessionId,
    source: 'codex-adapter',
    type: 'runtime.lifecycle.supported',
    payload: {
      verb,
      adapter_kind: 'codex',
      runtime_label: 'codex_app_server',
      evidence_status: 'supported',
      thread_id: target.threadId,
      response_thread_id: threadFromResponse(raw.response)?.id,
      response_forked_from_id: threadFromResponse(raw.response)?.forkedFromId,
      turn_id: target.turnId,
      artifact_sha256: sha256,
      reason,
    },
    artifactRefs: [artifactRef],
  });
  return { verb, status: 'supported', event, artifactRef, reason, targetThreadId: target.threadId, responseThreadId: threadFromResponse(raw.response)?.id, turnId: target.turnId };
}

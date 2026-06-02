import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AgentRuntimeAdapter,
  ApprovalDecision,
  ForkRequest,
  LaunchRequest,
  ResumeRequest,
  RuntimeCapabilities,
  RuntimeCommandResult,
  RuntimeEvent,
} from './types.js';

export function detectCodexCli(cwd = process.cwd()): {
  available: boolean;
  path?: string;
  version?: string;
  help?: string;
  error?: string;
} {
  try {
    const path = execFileSync('command -v codex', { cwd, shell: true, encoding: 'utf8' }).trim();
    const version = execFileSync('codex --version', { cwd, shell: true, encoding: 'utf8' }).trim();
    const help = execFileSync('codex --help', { cwd, shell: true, encoding: 'utf8' });
    return { available: Boolean(path), path, version, help };
  } catch (err: any) {
    return { available: false, error: String(err.stderr || err.message || err) };
  }
}

function discoverCurrentTranscript(cwd: string): { path?: string; sha256?: string } {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId || cwd !== process.cwd() || !/^[A-Za-z0-9-]+$/.test(threadId)) return {};
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const matches: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) matches.push(path);
    }
  };
  walk(root);
  matches.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
  const path = matches.at(-1);
  if (!path || !existsSync(path)) return {};
  return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export class CodexCliAdapter implements AgentRuntimeAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly cwd = process.cwd()) {}
  capabilities(): RuntimeCapabilities {
    const detected = detectCodexCli(this.cwd);
    const transcript = detected.available ? discoverCurrentTranscript(this.cwd) : {};
    const hasResumeFork = Boolean(detected.help && detected.help.includes('resume') && detected.help.includes('fork'));
    const transcriptSupported = Boolean(transcript.path && transcript.sha256);
    return {
      kind: 'codex',
      label: 'codex_cli',
      firstClass: transcriptSupported,
      lifecycle: {
        launch: transcriptSupported ? 'supported' : detected.available ? 'unproven' : 'unsupported',
        attach: transcriptSupported ? 'supported' : detected.available ? 'unproven' : 'unsupported',
        stream: transcriptSupported ? 'supported' : detected.available ? 'unproven' : 'unsupported',
        approve: detected.available ? 'unproven' : 'unsupported',
        interrupt: detected.available ? 'unproven' : 'unsupported',
        resume: detected.available && hasResumeFork ? 'unproven' : 'unsupported',
        fork: detected.available && hasResumeFork ? 'unproven' : 'unsupported',
      },
      evidence: detected.available
        ? [
            `codex path: ${detected.path}`,
            `codex version: ${detected.version}`,
            ...(transcriptSupported
              ? [`current transcript: ${transcript.path}`, `current transcript sha256: ${transcript.sha256}`]
              : ['current transcript: not attached']),
          ]
        : [`codex unavailable: ${detected.error || 'not found'}`],
    };
  }
  async *launch(request: LaunchRequest): AsyncIterable<RuntimeEvent> {
    const detected = detectCodexCli(request.cwd || this.cwd);
    const artifactRefs: string[] = [];
    if (request.metadata?.evidenceDir && typeof request.metadata.evidenceDir === 'string') {
      mkdirSync(request.metadata.evidenceDir, { recursive: true });
      const rel = 'codex-lifecycle-evidence.json';
      writeFileSync(
        join(request.metadata.evidenceDir, rel),
        JSON.stringify(
          {
            schema_version: 1,
            verb: 'launch',
            adapter_kind: 'codex',
            detected,
            status: detected.available ? 'unproven' : 'unsupported',
            note: 'Codex CLI binary was detected without starting an interactive LLM session; lifecycle remains unproven until a real session transcript is attached.',
          },
          null,
          2,
        ),
      );
      artifactRefs.push(rel);
    }
    yield {
      runId: request.runId,
      sessionId: detected.available ? `codex-detected-${request.runId}` : undefined,
      source: 'codex-adapter',
      type: detected.available ? 'runtime.lifecycle.unproven' : 'runtime.lifecycle.unsupported',
      payload: {
        verb: 'launch',
        adapter_kind: 'codex',
        runtime_label: 'codex_cli',
        available: detected.available,
        version: detected.version,
        path: detected.path,
        evidence_status: detected.available ? 'unproven' : 'unsupported',
      },
      artifactRefs,
    };
  }
  async *attach(sessionId: string): AsyncIterable<RuntimeEvent> {
    yield lifecycleEvent(sessionId, 'attach');
  }
  async *stream(sessionId: string): AsyncIterable<RuntimeEvent> {
    yield lifecycleEvent(sessionId, 'stream');
  }
  approve(_sessionId: string, approval: ApprovalDecision): Promise<RuntimeCommandResult> {
    return Promise.resolve({
      status: 'unproven',
      evidence: [`approval ${approval.approvalId} recorded outside Codex CLI session`],
      message: 'Codex approve requires a live session bridge; unproven until implemented.',
    });
  }
  interrupt(_sessionId: string, reason: string): Promise<RuntimeCommandResult> {
    return Promise.resolve({
      status: 'unproven',
      evidence: [reason],
      message: 'Codex interrupt requires a live session bridge; unproven until implemented.',
    });
  }
  async *resume(sessionId: string, _request?: ResumeRequest): AsyncIterable<RuntimeEvent> {
    yield lifecycleEvent(sessionId, 'resume');
  }
  async *fork(sessionId: string, _request: ForkRequest): AsyncIterable<RuntimeEvent> {
    yield lifecycleEvent(sessionId, 'fork');
  }
}

function lifecycleEvent(sessionId: string, verb: string): RuntimeEvent {
  return {
    runId: sessionId,
    sessionId,
    source: 'codex-adapter',
    type: 'runtime.lifecycle.unproven',
    payload: { verb, adapter_kind: 'codex', evidence_status: 'unproven' },
    artifactRefs: [],
  };
}

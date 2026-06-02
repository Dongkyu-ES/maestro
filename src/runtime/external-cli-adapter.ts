import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentRuntimeAdapter,
  type ApprovalDecision,
  type ForkRequest,
  type LaunchRequest,
  type RuntimeCapabilities,
  type RuntimeEvent,
  unsupportedResult,
} from './types.js';

export interface ExternalCliDetection {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export function detectExternalCli(binary: string, cwd = process.cwd()): ExternalCliDetection {
  try {
    if (!/^[A-Za-z0-9._-]+$/.test(binary)) throw new Error(`invalid binary name: ${binary}`);
    const path = execFileSync(`command -v ${binary}`, {
      cwd,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    let version = '';
    try {
      version = execFileSync(binary, ['--version'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
    } catch (err: any) {
      version = String(err.stdout || err.stderr || err.message || '').trim();
    }
    return { available: true, path, version };
  } catch (err: any) {
    return { available: false, error: String(err.stderr || err.message || err).trim() };
  }
}

function hasCurrentOmxRuntime(kind: 'omx' | 'agy', cwd: string): boolean {
  return kind === 'omx' && cwd === process.cwd() && Boolean(process.env.OMX_SESSION_ID || process.env.TMUX_PANE);
}

export class ExternalCliAdapter implements AgentRuntimeAdapter {
  kind: 'omx' | 'agy';
  private binary: string;
  private label: string;
  private cwd: string;

  constructor(kind: 'omx' | 'agy', cwd = process.cwd()) {
    this.kind = kind;
    this.binary = kind;
    this.label = `${kind}_cli`;
    this.cwd = cwd;
  }

  capabilities(): RuntimeCapabilities {
    const detected = detectExternalCli(this.binary, this.cwd);
    const status = hasCurrentOmxRuntime(this.kind, this.cwd)
      ? 'supported'
      : detected.available
        ? 'unproven'
        : 'unsupported';
    return {
      kind: this.kind,
      label: this.label,
      firstClass: hasCurrentOmxRuntime(this.kind, this.cwd),
      lifecycle: {
        launch: status,
        attach: status,
        stream: status,
        approve: detected.available ? 'unproven' : 'unsupported',
        interrupt: detected.available ? 'unproven' : 'unsupported',
        resume: detected.available ? 'unproven' : 'unsupported',
        fork: detected.available ? 'unproven' : 'unsupported',
      },
      evidence: hasCurrentOmxRuntime(this.kind, this.cwd)
        ? [
            `OMX runtime session: ${process.env.OMX_SESSION_ID || 'unknown'}`,
            `tmux pane: ${process.env.TMUX_PANE || 'unknown'}`,
            `${this.binary} detected at ${detected.path}`,
          ]
        : detected.available
          ? [`${this.binary} detected at ${detected.path}`, detected.version || 'version unavailable']
          : [`${this.binary} unavailable: ${detected.error || 'not found'}`],
    };
  }

  async *launch(request: LaunchRequest): AsyncIterable<RuntimeEvent> {
    const evidenceDir = String(request.metadata?.evidenceDir || request.cwd);
    mkdirSync(evidenceDir, { recursive: true });
    const detected = detectExternalCli(this.binary, request.cwd);
    const runtimeAttached = hasCurrentOmxRuntime(this.kind, request.cwd);
    const status = runtimeAttached ? 'supported' : detected.available ? 'unproven' : 'unsupported';
    const evidencePath = join(evidenceDir, `${this.kind}-lifecycle-evidence.json`);
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          schema_version: 1,
          adapter_kind: this.kind,
          run_id: request.runId,
          status,
          detected,
          prompt_present: Boolean(request.prompt),
          omx_session_id: this.kind === 'omx' ? process.env.OMX_SESSION_ID : undefined,
          tmux_pane: this.kind === 'omx' ? process.env.TMUX_PANE : undefined,
          note: runtimeAttached
            ? 'Existing OMX/tmux runtime context attached as launch/attach/stream evidence.'
            : detected.available
              ? `${this.kind} binary detected but no managed first-class session bridge is proven.`
              : `${this.kind} binary unavailable.`,
        },
        null,
        2,
      ),
    );
    yield {
      runId: request.runId,
      sessionId: runtimeAttached ? `${this.kind}-${process.env.OMX_SESSION_ID || request.runId}` : undefined,
      type: runtimeAttached ? 'runtime.session.started' : 'runtime.lifecycle.unproven',
      source: `${this.kind}-adapter`,
      payload: {
        adapter_kind: this.kind,
        runtime_label: this.label,
        first_class: runtimeAttached,
        evidence_status: status,
        binary_path: detected.path,
        version: detected.version,
        omx_session_id: this.kind === 'omx' ? process.env.OMX_SESSION_ID : undefined,
        tmux_pane: this.kind === 'omx' ? process.env.TMUX_PANE : undefined,
      },
      artifactRefs: [evidencePath],
    };
  }

  async *attach(sessionId: string): AsyncIterable<RuntimeEvent> {
    yield {
      runId: sessionId,
      sessionId,
      type: 'runtime.lifecycle.unproven',
      source: `${this.kind}-adapter`,
      payload: { adapter_kind: this.kind, runtime_label: this.label, first_class: false, verb: 'attach' },
      artifactRefs: [],
    };
  }
  async *stream(sessionId: string): AsyncIterable<RuntimeEvent> {
    yield {
      runId: sessionId,
      sessionId,
      type: 'runtime.lifecycle.unproven',
      source: `${this.kind}-adapter`,
      payload: { adapter_kind: this.kind, runtime_label: this.label, first_class: false, verb: 'stream' },
      artifactRefs: [],
    };
  }
  approve(_sessionId: string, _approval: ApprovalDecision) {
    return Promise.resolve(unsupportedResult('approve', this.kind));
  }
  interrupt(_sessionId: string, _reason: string) {
    return Promise.resolve(unsupportedResult('interrupt', this.kind));
  }
  async *resume(sessionId: string): AsyncIterable<RuntimeEvent> {
    yield {
      runId: sessionId,
      sessionId,
      type: 'runtime.lifecycle.unproven',
      source: `${this.kind}-adapter`,
      payload: { adapter_kind: this.kind, runtime_label: this.label, first_class: false, verb: 'resume' },
      artifactRefs: [],
    };
  }
  async *fork(sessionId: string, _request: ForkRequest): AsyncIterable<RuntimeEvent> {
    yield {
      runId: sessionId,
      sessionId,
      type: 'runtime.lifecycle.unproven',
      source: `${this.kind}-adapter`,
      payload: { adapter_kind: this.kind, runtime_label: this.label, first_class: false, verb: 'fork' },
      artifactRefs: [],
    };
  }
}

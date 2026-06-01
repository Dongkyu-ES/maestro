import type { AgentRuntimeAdapter, ApprovalDecision, ForkRequest, LaunchRequest, RuntimeCapabilities, RuntimeCommandResult, RuntimeEvent, ResumeRequest } from './types.js';
import { unsupportedResult } from './types.js';

export class ShellPrimitiveAdapter implements AgentRuntimeAdapter {
  readonly kind = 'shell' as const;
  capabilities(): RuntimeCapabilities {
    return {
      kind: 'shell',
      label: 'primitive_shell',
      firstClass: false,
      lifecycle: { launch: 'supported', attach: 'unsupported', stream: 'unproven', approve: 'unsupported', interrupt: 'unproven', resume: 'unsupported', fork: 'unsupported' },
      evidence: ['Shell is a primitive compatibility adapter and cannot satisfy Codex/OMX/agy first-class runtime gates.'],
    };
  }
  async *launch(request: LaunchRequest): AsyncIterable<RuntimeEvent> {
    yield { runId: request.runId, sessionId: `shell-${request.runId}`, source: 'shell-adapter', type: 'runtime.launch.requested', payload: { adapter_kind: 'shell', runtime_label: 'primitive_shell', first_class: false }, artifactRefs: [] };
  }
  async *attach(sessionId: string): AsyncIterable<RuntimeEvent> { yield { runId: sessionId, sessionId, source: 'shell-adapter', type: 'runtime.lifecycle.unsupported', payload: { verb: 'attach', adapter_kind: 'shell' }, artifactRefs: [] }; }
  async *stream(sessionId: string): AsyncIterable<RuntimeEvent> { yield { runId: sessionId, sessionId, source: 'shell-adapter', type: 'runtime.lifecycle.unproven', payload: { verb: 'stream', adapter_kind: 'shell' }, artifactRefs: [] }; }
  approve(_sessionId: string, _approval: ApprovalDecision): Promise<RuntimeCommandResult> { return Promise.resolve(unsupportedResult('approve', 'shell')); }
  interrupt(_sessionId: string, _reason: string): Promise<RuntimeCommandResult> { return Promise.resolve({ status: 'unproven', evidence: [], message: 'shell interrupt is process-level only and not a first-class agent lifecycle proof' }); }
  async *resume(sessionId: string, _request?: ResumeRequest): AsyncIterable<RuntimeEvent> { yield { runId: sessionId, sessionId, source: 'shell-adapter', type: 'runtime.lifecycle.unsupported', payload: { verb: 'resume', adapter_kind: 'shell' }, artifactRefs: [] }; }
  async *fork(sessionId: string, _request: ForkRequest): AsyncIterable<RuntimeEvent> { yield { runId: sessionId, sessionId, source: 'shell-adapter', type: 'runtime.lifecycle.unsupported', payload: { verb: 'fork', adapter_kind: 'shell' }, artifactRefs: [] }; }
}

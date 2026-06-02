export type RuntimeKind = 'codex' | 'omx' | 'agy' | 'shell';
export type RuntimeCapabilityStatus = 'supported' | 'unsupported' | 'unproven';
export type RuntimeLifecycleVerb = 'launch' | 'attach' | 'stream' | 'approve' | 'interrupt' | 'resume' | 'fork';

export interface RuntimeCapabilities {
  kind: RuntimeKind;
  label: string;
  lifecycle: Record<RuntimeLifecycleVerb, RuntimeCapabilityStatus>;
  evidence: string[];
  firstClass: boolean;
}

export interface LaunchRequest {
  runId: string;
  cwd: string;
  prompt?: string;
  contextRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResumeRequest {
  reason?: string;
  cursor?: string;
}
export interface ForkRequest {
  reason: string;
  branchLabel?: string;
}
export interface ApprovalDecision {
  approvalId: string;
  decision: 'approved' | 'rejected';
  operator?: string;
  reason?: string;
}
export interface RuntimeCommandResult {
  status: RuntimeCapabilityStatus | 'accepted' | 'rejected';
  evidence: string[];
  message: string;
}

export interface RuntimeEvent {
  runId: string;
  sessionId?: string;
  type: string;
  source: string;
  payload: Record<string, unknown>;
  artifactRefs: string[];
}

export interface AgentRuntimeAdapter {
  kind: RuntimeKind;
  capabilities(): RuntimeCapabilities;
  launch(request: LaunchRequest): AsyncIterable<RuntimeEvent>;
  attach(sessionId: string): AsyncIterable<RuntimeEvent>;
  stream(sessionId: string): AsyncIterable<RuntimeEvent>;
  approve(sessionId: string, approval: ApprovalDecision): Promise<RuntimeCommandResult>;
  interrupt(sessionId: string, reason: string): Promise<RuntimeCommandResult>;
  resume(sessionId: string, request?: ResumeRequest): AsyncIterable<RuntimeEvent>;
  fork(sessionId: string, request: ForkRequest): AsyncIterable<RuntimeEvent>;
}

export function unsupportedResult(
  verb: RuntimeLifecycleVerb,
  kind: RuntimeKind,
  evidence: string[] = [],
): RuntimeCommandResult {
  return { status: 'unsupported', evidence, message: `${kind} adapter does not yet prove ${verb}` };
}

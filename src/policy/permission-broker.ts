export type PermissionActionKind = 'sandbox_local' | 'general_tool' | 'specific_unusual_tool' | 'module_composition' | 'upper_scope_memory' | 'system_config' | 'destructive' | 'costly' | 'external_deploy' | 'secret_sensitive' | 'git_commit' | 'git_push';
export interface PermissionRequest { runId: string; action: PermissionActionKind; scope: 'sandbox' | 'task' | 'project' | 'global' | 'system' | 'external'; summary: string; tool?: string; target?: string; }
export interface PermissionDecision { status: 'allow' | 'requires_approval' | 'deny'; risk: 'low' | 'medium' | 'high'; reason: string; eventType: 'permission.allowed' | 'approval.requested' | 'permission.denied'; }

export function evaluatePermission(request: PermissionRequest): PermissionDecision {
  if (request.action === 'sandbox_local' || request.action === 'general_tool') return { status: 'allow', risk: 'low', reason: 'sandbox-local/common tool work may proceed automatically', eventType: 'permission.allowed' };
  if (request.scope === 'system' || request.scope === 'global' || request.scope === 'external') return { status: 'requires_approval', risk: 'high', reason: 'upper-scope/system/external action requires operator approval', eventType: 'approval.requested' };
  if (['specific_unusual_tool', 'upper_scope_memory', 'system_config', 'destructive', 'costly', 'external_deploy', 'secret_sensitive', 'git_commit', 'git_push'].includes(request.action)) return { status: 'requires_approval', risk: 'high', reason: `${request.action} requires operator approval`, eventType: 'approval.requested' };
  if (request.action === 'module_composition' && request.scope !== 'sandbox' && request.scope !== 'task') return { status: 'requires_approval', risk: 'medium', reason: 'module composition outside sandbox/task can affect parent behavior', eventType: 'approval.requested' };
  return { status: 'allow', risk: 'low', reason: 'local task-scoped action allowed', eventType: 'permission.allowed' };
}

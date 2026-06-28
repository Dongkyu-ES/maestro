const KNOWN_ACTIONS = new Set([
    'sandbox_local',
    'general_tool',
    'specific_unusual_tool',
    'module_composition',
    'upper_scope_memory',
    'system_config',
    'destructive',
    'costly',
    'external_deploy',
    'secret_sensitive',
    'git_commit',
    'git_push',
]);
function mediationFor(request) {
    return request.nativeMediation || /codex exec|claude code|native executor/i.test(`${request.tool || ''} ${request.summary}`)
        ? 'external/unowned'
        : 'dominic_owned';
}
function commandRequiresApproval(command) {
    const text = command.trim();
    if (!text)
        return undefined;
    if (/[;&|<>`$(){}[\]\n\r]/.test(text))
        return 'shell metacharacters make command effects non-local';
    const parts = text.split(/\s+/);
    const [cmd, sub, ...args] = parts;
    const lowered = parts.map((part) => part.toLowerCase());
    if (['rm', 'rmdir', 'mv', 'chmod', 'chown', 'sudo', 'kill', 'pkill', 'launchctl'].includes(cmd))
        return `destructive command ${cmd} requires approval`;
    if (cmd === 'git' && ['commit', 'push', 'reset', 'clean', 'checkout', 'switch', 'merge', 'rebase', 'branch'].includes(sub || ''))
        return `git ${sub} can mutate repository or remote state`;
    if (['npm', 'pnpm', 'yarn'].includes(cmd) && ['publish', 'install', 'add', 'remove', 'update'].includes(sub || ''))
        return `${cmd} ${sub} can change dependencies, network, or published state`;
    if (['curl', 'wget', 'ssh', 'scp', 'rsync'].includes(cmd))
        return `${cmd} can cross the network or external boundary`;
    if (lowered.some((part) => part.includes('--force') || part === '-f'))
        return 'force flag changes command risk';
    if (args.some((arg) => arg.startsWith('/etc') || arg.startsWith('/System') || arg.startsWith('/Library')))
        return 'system path target requires approval';
    return undefined;
}
function approval(reason, risk, mediation) {
    return { status: 'requires_approval', risk, reason, eventType: 'approval.requested', mediation };
}
function allow(reason, mediation) {
    return { status: 'allow', risk: 'low', reason, eventType: 'permission.allowed', mediation };
}
export function evaluatePermission(request) {
    const mediation = mediationFor(request);
    const commandRisk = request.command ? commandRequiresApproval(request.command) : undefined;
    if (commandRisk)
        return approval(`actual command risk overrides caller label: ${commandRisk}`, 'high', mediation);
    if (!KNOWN_ACTIONS.has(String(request.action)))
        return approval(`unknown action ${String(request.action)} defaults to operator approval`, 'medium', mediation);
    if (request.scope === 'system' || request.scope === 'global' || request.scope === 'external')
        return approval('upper-scope/system/external action requires operator approval', 'high', mediation);
    if ([
        'specific_unusual_tool',
        'upper_scope_memory',
        'system_config',
        'destructive',
        'costly',
        'external_deploy',
        'secret_sensitive',
        'git_commit',
        'git_push',
    ].includes(request.action))
        return approval(`${request.action} requires operator approval`, 'high', mediation);
    if (request.action === 'module_composition' && request.scope !== 'sandbox' && request.scope !== 'task')
        return approval('module composition outside sandbox/task can affect parent behavior', 'medium', mediation);
    if (request.action === 'sandbox_local' || request.action === 'general_tool')
        return allow('sandbox-local/common tool work may proceed automatically when actual inputs are low risk', mediation);
    return approval(`unhandled action ${String(request.action)} defaults to operator approval`, 'medium', mediation);
}

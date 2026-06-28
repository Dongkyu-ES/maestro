const shellToolNames = new Set([
    'bash',
    'exec',
    'exec_command',
    'functions.exec_command',
    'run_shell',
    'shell',
    'sh',
    'terminal',
]);
const safeToolNames = new Set(['get_goal', 'time']);
const readOnlyToolNames = new Set([
    'find',
    'functions.get_goal',
    'functions.list_mcp_resource_templates',
    'functions.list_mcp_resources',
    'functions.read_mcp_resource',
    'functions.view_image',
    'open',
    'read_file',
    'rg',
    'search',
    'view_image',
    'web.open',
    'web.search_query',
]);
const commandKeys = ['cmd', 'command', 'script', 'input', 'code', 'query'];
export function classifyToolRisk(intent) {
    const toolName = normalizeToolName(intent.tool);
    const command = extractCommandString(intent.args);
    const inspectionText = normalizeText([toolName, command, stringifyForInspection(intent.args)].join(' '));
    if (isShellTool(toolName)) {
        return classifyShellCommand(command, inspectionText);
    }
    if (hasCredentialSignal(inspectionText)) {
        return 'credentialed';
    }
    if (readOnlyToolNames.has(toolName)) {
        return 'read_only';
    }
    if (safeToolNames.has(toolName)) {
        return 'safe';
    }
    return 'mutating';
}
export function decidePolicy(intent) {
    const classifiedRisk = classifyToolRisk(intent);
    if (classifiedRisk === 'destructive' || classifiedRisk === 'credentialed') {
        return {
            decision: 'deny',
            classifiedRisk,
            reason: `${classifiedRisk} tool intent requires policy denial`,
        };
    }
    if (classifiedRisk === 'network' || classifiedRisk === 'mutating') {
        return {
            decision: 'ask',
            classifiedRisk,
            reason: `${classifiedRisk} tool intent requires explicit approval`,
        };
    }
    return {
        decision: 'allow',
        classifiedRisk,
        reason: `${classifiedRisk} tool intent is allowlisted`,
    };
}
export function assertNotAutoAllowedWhenRisky(intent) {
    const policy = decidePolicy(intent);
    if (policy.decision === 'allow' && isRisky(policy.classifiedRisk)) {
        throw new Error(`Risky ${policy.classifiedRisk} tool intent was auto-allowed`);
    }
}
function classifyShellCommand(command, inspectionText) {
    const normalizedCommand = normalizeText(command);
    if (hasDestructiveShellSignal(normalizedCommand)) {
        return 'destructive';
    }
    if (hasCredentialSignal(inspectionText)) {
        return 'credentialed';
    }
    if (hasNetworkShellSignal(normalizedCommand)) {
        return 'network';
    }
    if (hasMutatingShellSignal(normalizedCommand)) {
        return 'mutating';
    }
    if (hasReadOnlyShellSignal(normalizedCommand)) {
        return 'read_only';
    }
    return 'mutating';
}
function isShellTool(toolName) {
    return shellToolNames.has(toolName) || toolName.endsWith('.exec_command') || toolName.endsWith('.shell');
}
function hasDestructiveShellSignal(command) {
    return [
        /\brm\s+(?:-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/,
        /\bgit\s+push\b[^;&|]*\s--force(?:-with-lease)?\b/,
        /\bmkfs(?:\.[a-z0-9]+)?\b/,
        /\bdd\s+/,
        /:\s*\(\s*\)\s*\{/,
        /\bdrop\s+table\b/,
        />\s*\/dev\/sd[a-z]/,
        /\bshutdown\b/,
        /\breboot\b/,
        /\bdiskutil\s+(?:erase|partition|apfs\s+delete)/,
    ].some((pattern) => pattern.test(command));
}
function hasCredentialSignal(text) {
    return [
        /\b(?:credential|credentials|secret|secrets|token|tokens|password|passwd|api[_-]?key|private[_-]?key)\b/,
        /(?:^|[/\s])\.ssh(?:[/\s]|$)/,
        /(?:^|[/\s])id_rsa\b/,
        /(?:^|[/\s])id_ed25519\b/,
        /(?:^|[/\s])\.env(?:\.[a-z0-9_-]+)?\b/,
        /\b(?:aws|gcloud|gh|npm)\s+(?:login|auth)\b/,
    ].some((pattern) => pattern.test(text));
}
function hasNetworkShellSignal(command) {
    return [
        /\b(?:curl|wget|fetch)\b/,
        /\bnpm\s+(?:install|i|add|ci)\b/,
        /\b(?:pnpm|yarn|bun)\s+(?:install|add)\b/,
        /\b(?:pip|pip3|uv)\s+install\b/,
        /\b(?:brew|apt|apt-get|dnf|yum)\s+install\b/,
        /\bhttps?:\/\//,
    ].some((pattern) => pattern.test(command));
}
function hasReadOnlyShellSignal(command) {
    return [
        /^\s*(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)|ls|cat|grep|rg|find|pwd|sed\s+-n|wc|head|tail|nl|stat)\b/,
    ].some((pattern) => pattern.test(command));
}
function hasMutatingShellSignal(command) {
    return [
        /(?:^|[^>])>\s*[^&\s]/,
        />>\s*[^&\s]/,
        /\b(?:touch|mkdir|cp|mv|chmod|chown|tee|truncate)\b/,
        /\bsed\s+-i\b/,
        /\b(?:git\s+(?:add|commit|merge|rebase|push|clean|reset|checkout|switch|restore)|npm\s+run\s+format)\b/,
    ].some((pattern) => pattern.test(command));
}
function isRisky(risk) {
    return risk === 'mutating' || risk === 'destructive' || risk === 'network' || risk === 'credentialed';
}
function extractCommandString(args) {
    if (typeof args === 'string') {
        return args;
    }
    if (Array.isArray(args)) {
        return args.map((value) => (typeof value === 'string' ? value : stringifyForInspection(value))).join(' ');
    }
    if (args && typeof args === 'object') {
        const record = args;
        for (const key of commandKeys) {
            const value = record[key];
            if (typeof value === 'string') {
                return value;
            }
        }
        if (Array.isArray(record.args)) {
            return record.args.map((value) => (typeof value === 'string' ? value : stringifyForInspection(value))).join(' ');
        }
    }
    return stringifyForInspection(args);
}
function stringifyForInspection(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return '';
    }
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return String(value);
    }
}
function normalizeToolName(tool) {
    return tool.trim().toLowerCase();
}
function normalizeText(text) {
    return text.toLowerCase();
}

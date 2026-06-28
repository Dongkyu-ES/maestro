import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
function fileHash(files) {
    const digest = createHash('sha256');
    for (const file of files.sort()) {
        digest.update(file);
        if (existsSync(file))
            digest.update(readFileSync(file));
        else
            digest.update('missing');
    }
    return digest.digest('hex');
}
export function resolveAgentsMdStack(root, cwd = root) {
    const resolvedRoot = resolve(root);
    let current = resolve(cwd);
    const stack = [];
    while (current.startsWith(resolvedRoot)) {
        const candidate = join(current, 'AGENTS.md');
        if (existsSync(candidate))
            stack.unshift(candidate);
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return stack;
}
export function buildCompositionPlan(options) {
    const agentsStack = resolveAgentsMdStack(options.root);
    const contextFiles = [
        join(options.runDir, 'task.md'),
        join(options.runDir, 'context.md'),
        join(options.runDir, 'prompt.md'),
        ...agentsStack,
    ].filter((file) => existsSync(file));
    const runtime = options.preferredRuntime === 'command' ? 'primitive_shell' : `${options.preferredRuntime}_adapter_unproven`;
    const plan = {
        schema_version: 1,
        run_id: options.runId,
        task_id: options.taskId,
        created_at: new Date().toISOString(),
        project: { root_path: options.root, name: basename(options.root) },
        sandbox: { path: options.root, mode: 'project-local' },
        context_pack: {
            files: contextFiles.map((file) => (file.startsWith(options.root) ? file.slice(options.root.length + 1) : file)),
            sha256: fileHash(contextFiles),
        },
        modules: {
            skills: options.mode === 'multi' ? ['team', 'ultragoal'] : ['ultragoal'],
            harnesses: ['runtime-hard-gate', 'product-gate'],
            agents: options.mode === 'roles'
                ? ['manager', 'worker', 'reviewer']
                : options.mode === 'multi'
                    ? ['parallel-workers', 'reviewer']
                    : ['executor'],
            soul: 'default-operator-truth-boundary',
            agents_md_stack: agentsStack.map((file) => file.startsWith(options.root) ? file.slice(options.root.length + 1) : file),
            runtime_adapter: runtime,
        },
        approval_policy: {
            upper_scope_changes_require_approval: true,
            destructive_external_secret_requires_approval: true,
        },
        selection_rationale: [
            `Runtime ${runtime} selected from requested executor ${options.preferredRuntime}.`,
            `Mode ${options.mode} selected agents ${options.mode === 'multi' ? 'parallel-workers/reviewer' : options.mode === 'roles' ? 'manager/worker/reviewer' : 'executor'}.`,
            `Context pack hash records task/context/prompt plus AGENTS.md stack for replay.`,
            'runtime-hard-gate and product-gate selected to preserve non-reduction and false-completion boundaries.',
        ],
    };
    mkdirSync(options.runDir, { recursive: true });
    writeFileSync(join(options.runDir, 'composition.json'), JSON.stringify(plan, null, 2));
    return plan;
}

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { validateRuntimeLedger, readRuntimeEvents } from '../events/ledger.js';
import { rebuildIndex } from './index-builder.js';
import { createApprovalInternal } from './approvals.js';
import { AGENT_DIR, ensureDir, git, gitNoIndexPatch, isSecretPath, normalizeNoIndexPatch, nowIso, patchTouchedFiles, projectRoot, readYaml, safeJoin, } from '../util.js';
function runPath(runId, cwd = process.cwd()) {
    return safeJoin(projectRoot(cwd), AGENT_DIR, 'runs', runId);
}
function collectChangedFilesFromWorkspace(workspace) {
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: workspace, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim().split(' -> ').pop() || '')
        .filter(Boolean);
    return [...new Set([...tracked, ...status])].sort();
}
export function proposeApply(runId, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const rDir = runPath(runId, cwd);
    const run = readYaml(join(rDir, 'run.yaml'));
    const events = readRuntimeEvents(rDir);
    try {
        validateRuntimeLedger(events);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`run ${runId} is not eligible for apply: ledger failed validation: ${msg}`);
    }
    const lifecycleEvents = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === 'run.completed' || event.type === 'run.failed');
    const lastLifecycle = lifecycleEvents.at(-1);
    const verifierCompleted = lastLifecycle
        ? events
            .slice(0, lastLifecycle.index)
            .filter((event) => event.type === 'verifier.completed')
            .at(-1)
        : undefined;
    if (lastLifecycle?.event.type !== 'run.completed' || verifierCompleted?.payload.status !== 'supported')
        throw new Error(`run ${runId} is not eligible for apply: no verifier-backed completion in the ledger`);
    if (run.status !== 'completed' || run.decision !== 'pass')
        throw new Error(`run ${runId} is not eligible for apply proposal; collect a passing run first`);
    if (run.mode === 'multi') {
        const conflictPath = join(rDir, 'conflict-report.generated.md');
        if (!existsSync(conflictPath) || !/Status: clear/.test(readFileSync(conflictPath, 'utf8')))
            throw new Error(`run ${runId} has no clear multi-worker conflict report`);
    }
    const proposalDir = join(rDir, 'apply-proposal');
    ensureDir(proposalDir);
    const patches = [];
    if (run.mode === 'multi') {
        const workOrdersDir = join(rDir, 'work-orders');
        for (const file of readdirSync(workOrdersDir)
            .filter((f) => f.endsWith('.yaml'))
            .sort()) {
            const workerId = file.replace(/\.yaml$/, '');
            const order = readYaml(join(workOrdersDir, file));
            const workspace = String(order.isolated_workspace || '');
            if (!workspace || workspace.startsWith('worktree_unavailable:') || !existsSync(workspace))
                throw new Error(`cannot create apply proposal: ${workerId} isolated workspace unavailable`);
            const files = collectChangedFilesFromWorkspace(workspace);
            const denied = files.filter(isSecretPath);
            if (denied.length)
                throw new Error(`refusing apply proposal with denied paths from ${workerId}: ${denied.join(', ')}`);
            const patch = git(['diff', '--binary', 'HEAD'], workspace) +
                git(['diff', '--binary', '--cached'], workspace) +
                git(['ls-files', '--others', '--exclude-standard'], workspace)
                    .split('\n')
                    .filter(Boolean)
                    .map((file) => normalizeNoIndexPatch(gitNoIndexPatch(workspace, file)))
                    .join('\n');
            const patchPath = join(proposalDir, `${workerId}.patch`);
            writeFileSync(patchPath, patch);
            patches.push(patchPath);
        }
    }
    else {
        throw new Error(`apply proposal requires isolated multi-worker run; ${run.mode} runs mutate the live workspace directly`);
    }
    if (!patches.some((patchPath) => readFileSync(patchPath, 'utf8').trim()))
        throw new Error(`apply proposal for ${runId} has no patch content`);
    const digest = createHash('sha256');
    for (const patchPath of patches)
        digest.update(readFileSync(patchPath));
    const proposalSha = digest.digest('hex');
    const manifest = {
        schema_version: 1,
        run_id: runId,
        patches: patches.map((x) => relative(proposalDir, x)),
        sha256: proposalSha,
        created_at: nowIso(),
    };
    writeFileSync(join(proposalDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(proposalDir, 'README.md'), `# Apply Proposal\n\nRun: ${runId}\n\nThis proposal is approval-gated. Review patch files before applying.\n\nPatches:\n${patches.map((x) => `- ${x}`).join('\n')}\n`);
    return createApprovalInternal(runId, 'apply_proposal', 'high', `Review apply proposal for ${runId}: ${relative(root, proposalDir)}`, cwd, { proposal_sha256: proposalSha, proposal_path: relative(root, proposalDir) });
}
export function applyApprovedProposal(approvalId, cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const approvalPath = safeJoin(root, AGENT_DIR, 'approvals', `${approvalId}.json`);
    const approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
    if (approval.status !== 'approved')
        throw new Error(`approval ${approvalId} is not approved`);
    if (approval.type !== 'apply_proposal')
        throw new Error(`approval ${approvalId} is not an apply_proposal`);
    const rDir = runPath(approval.run_id, cwd);
    const run = readYaml(join(rDir, 'run.yaml'));
    if (run.status !== 'completed' || run.decision !== 'pass')
        throw new Error(`run ${approval.run_id} is not eligible for apply`);
    const proposalDir = join(rDir, 'apply-proposal');
    if (!existsSync(proposalDir))
        throw new Error(`missing apply proposal for ${approval.run_id}`);
    const manifestPath = join(proposalDir, 'manifest.json');
    if (!existsSync(manifestPath))
        throw new Error(`missing apply proposal manifest for ${approval.run_id}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.run_id !== approval.run_id)
        throw new Error(`apply proposal run mismatch for ${approval.run_id}`);
    const manifestPatches = Array.isArray(manifest.patches) ? manifest.patches : [];
    if (!manifestPatches.length)
        throw new Error(`apply proposal manifest has no patches for ${approval.run_id}`);
    const seen = new Set();
    const patches = manifestPatches.map((relPath) => {
        if (typeof relPath !== 'string' || relPath.startsWith('/') || relPath.includes('..'))
            throw new Error(`invalid manifest patch path: ${relPath}`);
        if (seen.has(relPath))
            throw new Error(`duplicate manifest patch path: ${relPath}`);
        seen.add(relPath);
        const full = safeJoin(proposalDir, relPath);
        if (!existsSync(full) || !readFileSync(full, 'utf8').trim())
            throw new Error(`missing manifest patch: ${relPath}`);
        return full;
    });
    const diskPatches = readdirSync(proposalDir)
        .filter((f) => f.endsWith('.patch'))
        .sort();
    const manifestNames = [...seen].map((x) => basename(x)).sort();
    if (JSON.stringify(diskPatches) !== JSON.stringify(manifestNames))
        throw new Error(`apply proposal patch set differs from manifest for ${approval.run_id}`);
    const touched = new Set();
    for (const patch of patches) {
        const content = readFileSync(patch, 'utf8');
        if (!content.trim().startsWith('diff --git '))
            throw new Error(`invalid patch content: ${basename(patch)}`);
        for (const file of patchTouchedFiles(content)) {
            if (touched.has(file))
                throw new Error(`apply proposal has overlapping patch target: ${file}`);
            touched.add(file);
        }
    }
    const digest = createHash('sha256');
    for (const patch of patches)
        digest.update(readFileSync(patch));
    const actualSha = digest.digest('hex');
    if (manifest.sha256 !== actualSha || approval.proposal_sha256 !== actualSha)
        throw new Error(`apply proposal digest mismatch for ${approval.run_id}`);
    try {
        const bundlePath = join(proposalDir, 'bundle.patch');
        writeFileSync(bundlePath, patches.map((patch) => readFileSync(patch, 'utf8')).join('\n'));
        execFileSync('git', ['apply', '--check', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        execFileSync('git', ['apply', bundlePath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (err) {
        approval.status = 'failed_to_apply';
        approval.updated_at = nowIso();
        writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
        throw new Error(String(err.stderr || err.message || err));
    }
    approval.status = 'applied';
    approval.updated_at = nowIso();
    writeFileSync(approvalPath, JSON.stringify(approval, null, 2));
    rebuildIndex(root);
    return approval;
}

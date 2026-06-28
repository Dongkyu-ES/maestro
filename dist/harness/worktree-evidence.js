import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, gitNoIndexPatch, isSecretPath, patchTouchedFiles } from '../util.js';
import { confinedTarget } from './path-confine.js';
/** Hard ceiling on the acceptance command, matching command-acceptance.ts. */
const ACCEPTANCE_TIMEOUT_MS = 120_000;
function sha256Hex(content) {
    return createHash('sha256').update(content).digest('hex');
}
/**
 * Capture the executor worktree's complete change set vs its base commit as one patch. node_modules
 * and other gitignored paths never enter the patch (`--exclude-standard`), so the executor cannot
 * smuggle dependencies or build output through evidence. Throws if a secret-bearing path changed —
 * secret diffs are never stored as evidence (mirrors the `maestro run` apply-proposal denial posture).
 */
export function captureWorktreeDiff(worktreePath) {
    const baseCommit = git(['rev-parse', 'HEAD'], worktreePath).trim();
    const tracked = git(['diff', '--binary', 'HEAD'], worktreePath);
    const untrackedFiles = git(['ls-files', '--others', '--exclude-standard'], worktreePath)
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    const untrackedPatch = untrackedFiles.map((file) => gitNoIndexPatch(worktreePath, file)).join('');
    const patch = `${tracked}${untrackedPatch}`;
    const changedFiles = [...new Set([...patchTouchedFiles(patch), ...untrackedFiles])];
    const denied = changedFiles.filter((f) => isSecretPath(f));
    if (denied.length)
        throw new Error(`refusing to capture evidence with secret-bearing paths: ${denied.join(', ')}`);
    return { patch, baseCommit, changedFiles };
}
/**
 * Deterministically reconstruct the graded tree and run the acceptance command in it.
 * `base@baseCommit` (detached worktree off the repo) → `git apply` the recorded patch → provision
 * deps by symlinking the repo's node_modules (environment, NOT a graded surface; copy fallback) →
 * overlay operator `testFiles` LAST (uneditable grader) → run `command` with cwd in the reconstruction.
 * Fails closed (ran:false) when the base commit is unreachable or the patch does not apply.
 */
export function reconstructAndRun(opts) {
    const { root, baseCommit, patch, command } = opts;
    const cleanParent = mkdtempSync(join(tmpdir(), 'orchestrator-skill-reconstruct-'));
    const reconWt = join(cleanParent, 'tree');
    const fail = (reason) => {
        cleanupReconstruction(root, reconWt, cleanParent);
        return { ran: false, passed: false, exitCode: null, command, outputSha256: sha256Hex(reason), cleanDir: cleanParent, reason };
    };
    // Detached worktree at the pinned base. If the commit was GC'd / its branch deleted, reconstruction
    // is impossible — fail closed with a clear reason, never a silent pass.
    try {
        execFileSync('git', ['worktree', 'add', '--detach', reconWt, baseCommit], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return fail(`base commit ${baseCommit} not reachable for reconstruction: ${reason}`);
    }
    if (patch.trim()) {
        const patchFile = join(cleanParent, 'evidence.patch');
        writeFileSync(patchFile, patch);
        try {
            execFileSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: reconWt, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return fail(`recorded evidence patch did not apply onto ${baseCommit}: ${reason}`);
        }
    }
    // Deps are environment, not graded content: symlink the repo's installed node_modules (copy fallback).
    const nodeModules = join(root, 'node_modules');
    if (existsSync(nodeModules) && !existsSync(join(reconWt, 'node_modules'))) {
        try {
            symlinkSync(nodeModules, join(reconWt, 'node_modules'), 'dir');
        }
        catch {
            try {
                cpSync(nodeModules, join(reconWt, 'node_modules'), { recursive: true });
            }
            catch {
                // proceed without deps; a command that needs them will fail honestly
            }
        }
    }
    // Operator tests overlaid LAST so an executor edit to its own grader is overwritten. Each write is
    // realpath-confined to the reconstruction root (mirrors command-acceptance.ts): a `..`/absolute
    // path, or one whose ancestor is a symlink the diff carried in, is refused rather than followed out.
    const reconRealRoot = realpathSync(reconWt);
    for (const testFile of opts.testFiles ?? []) {
        const testPath = confinedTarget(reconRealRoot, testFile.path);
        if (!testPath)
            return fail(`operator testFile path escapes the reconstruction root: ${testFile.path}`);
        mkdirSync(dirname(testPath), { recursive: true });
        writeFileSync(testPath, testFile.content);
    }
    try {
        const result = spawnSync(command[0], command.slice(1), { cwd: reconWt, encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: ACCEPTANCE_TIMEOUT_MS });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        const reason = result.error
            ? result.error.message
            : result.status === 0
                ? 'acceptance command passed (reconstructed from pinned base + evidence diff)'
                : `acceptance command exited ${result.status ?? 'unknown'}`;
        const outputSha256 = sha256Hex(output);
        cleanupReconstruction(root, reconWt, cleanParent);
        return { ran: true, passed: result.status === 0, exitCode: result.status, command, outputSha256, cleanDir: cleanParent, reason };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        cleanupReconstruction(root, reconWt, cleanParent);
        return { ran: true, passed: false, exitCode: null, command, outputSha256: sha256Hex(reason), cleanDir: cleanParent, reason };
    }
}
function cleanupReconstruction(root, reconWt, cleanParent) {
    try {
        execFileSync('git', ['worktree', 'remove', '--force', reconWt], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch {
        // best effort
    }
    try {
        rmSync(cleanParent, { recursive: true, force: true });
    }
    catch {
        // best effort
    }
}

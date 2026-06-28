import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { confinedTarget } from './path-confine.js';
const ACCEPTANCE_TIMEOUT_MS = 120_000;
function git(worktreePath, args) {
    return execFileSync('git', ['-C', worktreePath, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
/**
 * Parse `git status --porcelain -z` (NUL-separated, no quoting). Each entry is `XY <path>`; a rename
 * or copy (`R`/`C`) is followed by a second NUL field holding the OLD path, which we treat as a
 * deletion so the clean checkout matches the worktree exactly.
 */
function parseStatusZ(out) {
    const parts = out.split('\0');
    const entries = [];
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry || entry.length < 3)
            continue;
        const x = entry[0];
        const y = entry[1];
        const path = entry.slice(3);
        if (x === 'R' || x === 'C') {
            const oldPath = parts[++i];
            entries.push({ path, deleted: false });
            if (oldPath)
                entries.push({ path: oldPath, deleted: true });
            continue;
        }
        entries.push({ path, deleted: x === 'D' || y === 'D' });
    }
    return entries;
}
function stripSymlinks(dir) {
    // Defense in depth: remove any symlink carried in from HEAD so it can never be read/followed.
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let st;
        try {
            st = lstatSync(current);
        }
        catch {
            continue;
        }
        if (st.isSymbolicLink()) {
            rmSync(current, { force: true });
            continue;
        }
        if (st.isDirectory()) {
            for (const name of readdirSync(current))
                stack.push(join(current, name));
        }
    }
}
export function runCommandAcceptance(opts) {
    const cleanDir = mkdtempSync(join(tmpdir(), 'command-acceptance-'));
    const command = opts.acceptance.command;
    const finish = (r) => {
        rmSync(cleanDir, { recursive: true, force: true });
        return { ...r, command };
    };
    const fail = (reason) => finish({ ran: false, passed: false, exitCode: null, reason });
    if (!command.length)
        return fail('acceptance command is empty');
    let cleanRealRoot;
    try {
        // Clean base: the committed HEAD tree only — none of the executor's untracked process state.
        const tarPath = `${cleanDir}.tar`;
        writeFileSync(tarPath, execFileSync('git', ['-C', opts.worktreePath, 'archive', '--format=tar', 'HEAD'], {
            maxBuffer: 256 * 1024 * 1024,
        }));
        execFileSync('tar', ['-xf', tarPath, '-C', cleanDir]);
        rmSync(tarPath, { force: true });
        stripSymlinks(cleanDir);
        cleanRealRoot = realpathSync(cleanDir);
        // Overlay exactly the run's changed files (re-derived robustly), nothing else.
        const status = git(opts.worktreePath, ['-c', 'core.quotepath=false', 'status', '--porcelain', '-z']);
        for (const { path: rel, deleted } of parseStatusZ(status)) {
            const dst = confinedTarget(cleanRealRoot, rel);
            if (!dst)
                continue;
            if (deleted) {
                rmSync(dst, { force: true, recursive: true });
                continue;
            }
            const src = join(opts.worktreePath, rel);
            if (!existsSync(src) || lstatSync(src).isSymbolicLink())
                continue;
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst);
            chmodSync(dst, statSync(src).mode); // preserve the executable bit
        }
        // Operator-declared tests win over anything the executor may have written.
        for (const file of opts.acceptance.testFiles ?? []) {
            const dst = confinedTarget(cleanRealRoot, file.path);
            if (!dst)
                continue;
            mkdirSync(dirname(dst), { recursive: true });
            writeFileSync(dst, file.content);
        }
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    const result = spawnSync(command[0], command.slice(1), {
        cwd: cleanRealRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: ACCEPTANCE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
    });
    if (result.error) {
        const reason = result.error.code === 'ETIMEDOUT'
            ? `acceptance command timed out after ${ACCEPTANCE_TIMEOUT_MS}ms`
            : `acceptance command failed to run: ${result.error.message}`;
        return finish({ ran: false, passed: false, exitCode: null, reason });
    }
    const passed = result.status === 0;
    return finish({
        ran: true,
        passed,
        exitCode: result.status,
        reason: passed
            ? 'acceptance command passed over a clean checkout of the run diff'
            : `acceptance command exited ${result.status}`,
    });
}
/**
 * Read an operator-authored acceptance spec from a JSON file, for `maestro harness run
 * --acceptance-file`. Shape: `{ "command": string[], "testFiles"?: [{ "path", "content" }] }`.
 * Strictly validated so a malformed file fails fast rather than silently degrading the gate to
 * diff-only. This is what makes the honest build/test gate reachable from the harness-run CLI.
 */
export function readCommandAcceptanceFile(path) {
    if (!existsSync(path))
        throw new Error(`acceptance file not found: ${path}`);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (err) {
        throw new Error(`acceptance file is not valid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const obj = (parsed ?? {});
    if (!Array.isArray(obj.command) || obj.command.length === 0 || !obj.command.every((c) => typeof c === 'string'))
        throw new Error(`acceptance file ${path}: "command" must be a non-empty string[]`);
    let testFiles;
    if (obj.testFiles !== undefined) {
        if (!Array.isArray(obj.testFiles))
            throw new Error(`acceptance file ${path}: "testFiles" must be an array`);
        testFiles = obj.testFiles.map((t, i) => {
            const tf = (t ?? {});
            if (typeof tf.path !== 'string' || typeof tf.content !== 'string')
                throw new Error(`acceptance file ${path}: testFiles[${i}] needs string "path" and "content"`);
            return { path: tf.path, content: tf.content };
        });
    }
    return { command: obj.command, testFiles };
}

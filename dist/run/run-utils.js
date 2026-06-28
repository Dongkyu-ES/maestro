import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { nowIso, projectRoot, } from '../util.js';
export function activeStatus(status) {
    return ['planning', 'dispatching', 'workers_running', 'collecting', 'reviewing', 'applying'].includes(String(status));
}
export function runProcessJsonFiles(runDir) {
    return existsSync(runDir)
        ? readdirSync(runDir)
            .filter((f) => f.endsWith('.process.json'))
            .sort()
        : [];
}
export function readRunProcessSummary(runDir) {
    const files = runProcessJsonFiles(runDir);
    if (!files.length)
        return { exitCode: null, stderr: '', stdout: '', valid: 0, invalid: 0, errors: [] };
    let exitCode = 0;
    let stderr = '';
    let stdout = '';
    let valid = 0;
    let invalid = 0;
    const errors = [];
    for (const file of files) {
        try {
            const p = JSON.parse(readFileSync(join(runDir, file), 'utf8'));
            if (typeof p.exit_code !== 'number')
                throw new Error('missing numeric exit_code');
            valid++;
            if (p.exit_code !== 0)
                exitCode = p.exit_code;
            stderr += String(p.stderr || '');
            stdout += String(p.stdout || '');
        }
        catch (err) {
            invalid++;
            errors.push(`${file}: ${String(err.message || err)}`);
        }
    }
    if (valid === 0 || invalid > 0)
        exitCode = 1;
    return { exitCode, stderr, stdout, valid, invalid, errors };
}
export function normalizeRunMeta(meta, runDir) {
    const out = { ...meta };
    const hasCancel = existsSync(join(runDir, 'cancel.requested'));
    const hasEnded = Boolean(out.ended_at);
    const processSummary = readRunProcessSummary(runDir);
    const hasReview = existsSync(join(runDir, 'review.md')) && Boolean(out.decision);
    const processOk = processSummary.valid > 0 && processSummary.invalid === 0 && processSummary.exitCode === 0;
    if (processSummary.invalid > 0)
        writeFileSync(join(runDir, 'process-evidence-errors.json'), JSON.stringify({ status: 'FAIL', errors: processSummary.errors, recorded_at: nowIso() }, null, 2));
    if (processSummary.invalid > 0) {
        out.status = 'failed';
        out.decision = 'blocked';
        out.exit_code = processSummary.exitCode ?? 1;
        out.ended_at = out.ended_at || nowIso();
        out.updated_at = nowIso();
        return out;
    }
    if (hasCancel) {
        out.status = 'cancelled';
        out.ended_at = out.ended_at || nowIso();
        out.updated_at = out.updated_at || out.ended_at;
        return out;
    }
    if (['completed', 'failed', 'timed_out'].includes(String(out.status)) &&
        processSummary.exitCode !== null &&
        !processOk) {
        out.status = 'failed';
        out.exit_code = processSummary.exitCode ?? 1;
        out.updated_at = nowIso();
        return out;
    }
    if (activeStatus(out.status) && hasEnded) {
        out.status = hasReview && processOk ? 'completed' : 'failed';
        out.exit_code = processSummary.exitCode ?? out.exit_code;
        return out;
    }
    if (out.status === 'created' && processSummary.exitCode !== null) {
        out.status = hasReview && processOk ? 'completed' : 'failed';
        out.exit_code = processSummary.exitCode;
        out.ended_at = out.ended_at || nowIso();
        return out;
    }
    return out;
}
export function cleanupWorktrees(cwd = process.cwd()) {
    const root = projectRoot(cwd);
    const base = resolve(dirname(root), `${basename(root)}.agent-worktrees`);
    const failures = [];
    try {
        const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
        for (const line of list.split('\n')) {
            if (!line.startsWith('worktree '))
                continue;
            const worktree = line.slice('worktree '.length).trim();
            if (worktree && worktree.startsWith(base)) {
                try {
                    execFileSync('git', ['worktree', 'remove', '--force', worktree], {
                        cwd: root,
                        stdio: ['ignore', 'pipe', 'pipe'],
                    });
                }
                catch (err) {
                    failures.push(`${worktree}: ${String(err.stderr || err.message || err).trim()}`);
                }
            }
        }
        try {
            execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            failures.push(`prune: ${String(err.stderr || err.message || err).trim()}`);
        }
        const remaining = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
            .split('\n')
            .filter((line) => line.startsWith('worktree ') && line.slice('worktree '.length).trim().startsWith(base));
        if (remaining.length)
            failures.push(`registered worktrees remain: ${remaining.join(', ')}`);
    }
    catch (err) {
        failures.push(String(err.stderr || err.message || err).trim());
    }
    if (existsSync(base))
        rmSync(base, { recursive: true, force: true });
    if (existsSync(base))
        failures.push(`filesystem worktree base remains: ${base}`);
    if (failures.length)
        throw new Error(`worktree cleanup failed: ${failures.join('; ')}`);
}

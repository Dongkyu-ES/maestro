import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { appendRuntimeEvent, createRuntimeLedgerHeadBinding, readRuntimeEvents } from '../events/ledger.js';
import { runCodexExec } from '../runtime/codex-exec-runner.js';
import { redact } from '../util.js';
import { runHarnessSlice } from './harness-run.js';
// Classify an executor/critic failure from its message so the loop can react instead
// of crashing: transient (rate limit, network, timeout) is worth a bounded retry;
// auth (401/credentials) and fatal stop the loop as an incident — neither is silently
// passed (that would be the fail-open-on-a-gate anti-pattern).
export function classifyExecutorError(message) {
    const text = message.toLowerCase();
    if (/\b401\b|unauthor|forbidden|\b403\b|invalid api key|authentication|credential|not logged in/.test(text))
        return 'auth';
    if (/\b429\b|rate.?limit|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|network|temporarily|503|502|504|overloaded/.test(text))
        return 'transient';
    return 'fatal';
}
const EVIDENCE_FILES = [
    'tool-git-diff.patch',
    'tool-git-status.txt',
    'tool-execution-evidence.json',
    'harness-run-report.json',
    'tool-verify-output.txt',
];
function runVerifyCmd(root, cmd, runDir) {
    // Run the operator-supplied verification command and capture its REAL output as
    // objective behavioral evidence for the isolated critic (so completion rests on
    // observed runtime behavior, not on code that merely looks correct). The exit code
    // is recorded as STRUCTURED, digest-bound evidence so the deterministic gate can key
    // on "exit_code passed" (not just "the command ran") — success != ran.
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: root, encoding: 'utf8', timeout: 120000 });
    const exitCode = r.status ?? null;
    const result = { ran: true, exit_code: exitCode, passed: exitCode === 0 };
    writeFileSync(join(runDir, 'tool-verify-output.txt'), redact(`$ ${cmd}\nexit: ${exitCode ?? 'null'}\n--- stdout ---\n${r.stdout || ''}\n--- stderr ---\n${r.stderr || ''}\n`));
    writeFileSync(join(runDir, 'tool-verify-result.json'), `${JSON.stringify({ schema_version: 1, command: redact(cmd), ...result }, null, 2)}\n`);
    return result;
}
function readChangedFiles(runDir) {
    const path = join(runDir, 'tool-execution-evidence.json');
    if (!existsSync(path))
        return [];
    try {
        const evidence = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(evidence.changed_files) ? evidence.changed_files.map(String) : [];
    }
    catch {
        return [];
    }
}
function loopRunDir(root, runId) {
    return join(root, '.agent', 'runs', runId);
}
function readAcceptanceContract(path) {
    return readFileSync(path, 'utf8');
}
function resolveEvidenceDir(root, evidenceDir) {
    return evidenceDir.startsWith('/') ? evidenceDir : join(root, evidenceDir);
}
function seedCodexAuth(codexHome) {
    // Isolate session/history/memory (a fresh CODEX_HOME) but KEEP authentication:
    // copy only auth/config from the real codex home so the isolated critic can
    // authenticate without inheriting sessions/history/memory that would contaminate
    // its judgment. A fully empty CODEX_HOME would make codex fail with 401.
    const sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex');
    for (const file of ['auth.json', 'config.toml']) {
        const src = join(sourceHome, file);
        if (existsSync(src))
            copyFileSync(src, join(codexHome, file));
    }
}
function writeIsolatedInputs(options) {
    const cwd = mkdtempSync(join(tmpdir(), options.prefix));
    const codexHome = mkdtempSync(join(tmpdir(), `${options.prefix}codex-home-`));
    seedCodexAuth(codexHome);
    writeFileSync(join(cwd, 'goal.md'), `${options.goal}\n`);
    if (options.acceptanceContract !== undefined)
        writeFileSync(join(cwd, 'acceptance-contract.md'), `${options.acceptanceContract}\n`);
    if (options.history)
        writeFileSync(join(cwd, 'failure-history.json'), `${JSON.stringify(options.history, null, 2)}\n`);
    if (options.evidenceDir) {
        const target = join(cwd, 'objective-evidence');
        mkdirSync(target, { recursive: true });
        for (const file of EVIDENCE_FILES) {
            const src = join(options.evidenceDir, file);
            if (existsSync(src))
                copyFileSync(src, join(target, basename(file)));
        }
    }
    return { cwd, codexHome };
}
async function withIsolatedCodexHome(codexHome, fn) {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
        return await fn();
    }
    finally {
        if (previous === undefined)
            delete process.env.CODEX_HOME;
        else
            process.env.CODEX_HOME = previous;
    }
}
async function withOptionalCodexBin(codexBin, fn) {
    const previous = process.env.AGENT_CODEX_BIN;
    if (codexBin)
        process.env.AGENT_CODEX_BIN = codexBin;
    try {
        return await fn();
    }
    finally {
        if (codexBin) {
            if (previous === undefined)
                delete process.env.AGENT_CODEX_BIN;
            else
                process.env.AGENT_CODEX_BIN = previous;
        }
    }
}
function parseJsonObject(text) {
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/u, '');
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start)
            return JSON.parse(trimmed.slice(start, end + 1));
        throw new Error(`Codex exec did not return JSON: ${trimmed.slice(0, 200)}`);
    }
}
function normalizeCritic(value) {
    return {
        met: value.met === true,
        theater_found: Array.isArray(value.theater_found) ? value.theater_found.map(String) : [],
        unmet_criteria: Array.isArray(value.unmet_criteria) ? value.unmet_criteria.map(String) : [],
        required_next: Array.isArray(value.required_next) ? value.required_next.map(String) : [],
        confidence: typeof value.confidence === 'number' ? value.confidence : 0,
        drift_suspected: value.drift_suspected === true,
    };
}
function normalizeStrategy(value) {
    const tool = value.tool_to_create;
    return {
        new_strategy: typeof value.new_strategy === 'string' ? value.new_strategy : '',
        tool_to_create: tool && typeof tool.path === 'string' && typeof tool.purpose === 'string'
            ? { path: tool.path, purpose: tool.purpose }
            : null,
    };
}
export async function isolatedCritic(options) {
    const evidenceDir = resolveEvidenceDir(options.root, options.evidenceDir);
    const isolated = writeIsolatedInputs({
        prefix: 'closed-loop-critic-',
        goal: options.goal,
        acceptanceContract: options.acceptanceContract,
        evidenceDir,
    });
    // Split of labor (avoids the over-strict false-negative on correct work): the
    // deterministic gate already decides "does the verification pass". When it passed,
    // the critic's ONLY job is the thing a runtime gate can't see — whether the pass is
    // genuine or the test was subverted. When it failed, the work is simply not done.
    const prompt = `You are an isolated adversarial harness critic.

Read ONLY the files in this temp directory:
- goal.md
- acceptance-contract.md
- objective-evidence/* (includes the code diff tool-git-diff.patch and the verification output tool-verify-output.txt)

A deterministic gate has already run. gate_passed=${options.gatePassed}.

If gate_passed is false: the work is NOT done — set met=false.

If gate_passed is true: the verification already passed, so your ONLY job is to decide whether it passed because the implementation GENUINELY solves the goal, or because it SUBVERTED the test. Set met=false with theater_found if the diff shows any of: monkeypatching or reassigning assert/require, reading the test's own source or the call stack to derive expected values, attaching a debugger/inspector to mutate values, hardcoding the exact expected outputs with no real logic, or process.exit/printing a pass marker before assertions run. Otherwise, if the diff is a genuine solution to the goal, set met=true. Do not re-litigate a genuinely passing solution.

Also set "drift_suspected" true if the change solves a DIFFERENT or narrower problem than the goal, or weakens/deletes the acceptance criteria. drift_suspected is independent of met.

Return ONLY JSON with this exact shape:
{"met":false,"theater_found":[],"unmet_criteria":[],"required_next":[],"confidence":0,"drift_suspected":false}`;
    const result = await withIsolatedCodexHome(isolated.codexHome, () => runCodexExec({
        runDir: isolated.cwd,
        cwd: isolated.cwd,
        prompt,
        sandbox: 'read-only',
        label: 'critic',
    }));
    if (result.exit_code !== 0)
        throw new Error(`isolated critic failed: ${result.stderr || result.last_message}`);
    return normalizeCritic(parseJsonObject(result.last_message));
}
export async function stallStrategist(options) {
    const isolated = writeIsolatedInputs({ prefix: 'closed-loop-strategist-', goal: options.goal, history: options.history });
    const prompt = `You are an isolated stall strategist.

Read goal.md and failure-history.json. The same blocker has repeated. Do NOT repeat the failed approach. Propose a different approach/decomposition, or propose one new tool to create if that is the smallest useful unlock.

Return ONLY JSON with this exact shape:
{"new_strategy":"different strategy","tool_to_create":null}
or:
{"new_strategy":"different strategy","tool_to_create":{"path":"relative/path","purpose":"why this tool unlocks the blocker"}}`;
    const result = await withIsolatedCodexHome(isolated.codexHome, () => runCodexExec({
        runDir: isolated.cwd,
        cwd: isolated.cwd,
        prompt,
        sandbox: 'read-only',
        label: 'strategist',
    }));
    if (result.exit_code !== 0)
        throw new Error(`stall strategist failed: ${result.stderr || result.last_message}`);
    return normalizeStrategy(parseJsonObject(result.last_message));
}
function buildIterationGoal(options) {
    const unmet = options.previousUnmet.length ? options.previousUnmet.map((item) => `- ${item}`).join('\n') : '- none yet';
    return `${options.goal}

Closed-loop controller context:
Current strategy:
${options.strategy}

Previous critic unmet criteria:
${unmet}

Do not rely on self-claims. Produce real tool-effect evidence that can satisfy the deterministic verifier and isolated critic.`;
}
function dominantBlocker(items) {
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort().join('\n');
}
function stalled(history, stall) {
    if (stall <= 0 || history.length < stall)
        return false;
    const recent = history.slice(-stall).map(dominantBlocker);
    return recent[0].length > 0 && recent.every((item) => item === recent[0]);
}
export async function runClosedLoop(options) {
    const root = resolve(options.root);
    const runId = `loop-${randomUUID()}`;
    const runDir = loopRunDir(root, runId);
    const maxIters = options.maxIters ?? 8;
    const stallWindow = options.stall ?? 2;
    mkdirSync(runDir, { recursive: true });
    let strategy = 'Make the smallest real implementation change that satisfies the acceptance contract, then produce objective evidence.';
    let previousUnmet = [];
    const unmetHistory = [];
    const iterations = [];
    const transientRetryBudget = options.transientRetryBudget ?? 2;
    let transientRetries = 0;
    appendRuntimeEvent(runDir, {
        runId,
        source: 'harness',
        type: 'loop.started',
        payload: { goal: options.goal, max_iters: maxIters, stall: stallWindow },
    });
    for (let index = 1; index <= maxIters; index += 1) {
        appendRuntimeEvent(runDir, {
            runId,
            source: 'harness',
            type: 'loop.iteration',
            payload: { iteration: index, strategy, previous_unmet_criteria: previousUnmet },
        });
        let slice;
        let verify;
        let critic;
        let deterministicPass = false;
        try {
            slice = await withOptionalCodexBin(options.executorBin, () => runHarnessSlice({
                root,
                goal: buildIterationGoal({ goal: options.goal, strategy, previousUnmet }),
                executorBin: options.executorBin,
                executor: options.executor,
                runId: `${runId}-iter-${index}`,
            }));
            // slice.runDir is repo-relative; resolve against root (which may differ from cwd).
            const sliceRunDir = join(root, slice.runDir);
            verify = options.verifyCmd
                ? runVerifyCmd(root, options.verifyCmd, sliceRunDir)
                : { ran: false, exit_code: null, passed: true };
            // Decide the deterministic gate BEFORE the critic so the critic can narrow its
            // job to genuine-vs-gamed rather than re-proving an already-passing solution.
            deterministicPass =
                slice.state === 'completed' && slice.verifier.status === 'supported' && (verify.ran ? verify.passed : true);
            critic = await withOptionalCodexBin(options.executorBin, () => isolatedCritic({
                root,
                goal: options.goal,
                acceptanceContract: options.acceptanceContract,
                evidenceDir: slice.runDir,
                gatePassed: deterministicPass,
            }));
        }
        catch (error) {
            // Classify rather than crash: a transient (rate-limit/network) failure earns a
            // bounded retry; auth/fatal stop the loop as a recorded incident. The failure is
            // never silently treated as "work done" (that would be fail-open on a gate).
            const message = error instanceof Error ? error.message : String(error);
            const errorClass = classifyExecutorError(message);
            if (errorClass === 'transient')
                transientRetries += 1;
            const willRetry = errorClass === 'transient' && transientRetries <= transientRetryBudget && index < maxIters;
            appendRuntimeEvent(runDir, {
                runId,
                source: 'harness',
                type: 'loop.executor_error',
                payload: {
                    iteration: index,
                    error_class: errorClass,
                    message: redact(message),
                    will_retry: willRetry,
                    transient_retries: transientRetries,
                },
            });
            if (willRetry)
                continue;
            const incident = `executor ${errorClass} error: ${redact(message)}`;
            appendRuntimeEvent(runDir, {
                runId,
                source: 'harness',
                type: 'loop.blocked',
                payload: { iteration: index, incident: true, error_class: errorClass, reason: incident },
            });
            return finalizeLoopReport({ runDir, runId, goal: options.goal, status: 'blocked', iterations, strategy, persistent: [incident] });
        }
        const changedFiles = readChangedFiles(join(root, slice.runDir));
        const done = deterministicPass && critic.met === true;
        const iteration = {
            iteration: index,
            runId: slice.runId,
            runDir: slice.runDir,
            deterministicStatus: slice.verifier.status,
            deterministicState: slice.state,
            verify,
            changedFiles,
            critic,
            done,
        };
        iterations.push(iteration);
        unmetHistory.push(critic.unmet_criteria);
        appendRuntimeEvent(runDir, {
            runId,
            source: 'harness',
            type: 'loop.verify',
            payload: {
                iteration: index,
                slice_run_id: slice.runId,
                verify,
                changed_files: changedFiles,
                coverage_checked: verify.ran,
                drift_suspected: critic.drift_suspected,
            },
        });
        appendRuntimeEvent(runDir, {
            runId,
            source: 'harness',
            type: 'loop.critic',
            payload: {
                iteration: index,
                slice_run_id: slice.runId,
                deterministic_pass: deterministicPass,
                critic,
                controller_done: done,
            },
            artifactRefs: [join(slice.runDir, 'harness-run-report.json')],
        });
        if (done) {
            appendRuntimeEvent(runDir, {
                runId,
                source: 'harness',
                type: 'loop.done',
                payload: { iteration: index, slice_run_id: slice.runId },
            });
            const report = finalizeLoopReport({ runDir, runId, goal: options.goal, status: 'done', iterations, strategy, persistent: [] });
            return report;
        }
        previousUnmet = critic.unmet_criteria.length > 0 ? critic.unmet_criteria : [slice.verifier.reason];
        if (stalled(unmetHistory, stallWindow)) {
            appendRuntimeEvent(runDir, {
                runId,
                source: 'harness',
                type: 'loop.stalled',
                payload: { iteration: index, dominant_blocker: dominantBlocker(previousUnmet), stall: stallWindow },
            });
            try {
                const strategyResult = await withOptionalCodexBin(options.executorBin, () => stallStrategist({ root, goal: options.goal, history: unmetHistory.flat() }));
                strategy = strategyResult.new_strategy || strategy;
                appendRuntimeEvent(runDir, {
                    runId,
                    source: 'harness',
                    type: 'loop.escalated',
                    payload: { iteration: index, strategy: strategyResult },
                });
                if (strategyResult.tool_to_create) {
                    await withOptionalCodexBin(options.executorBin, () => runHarnessSlice({
                        root,
                        goal: `Create the closed-loop support tool at ${strategyResult.tool_to_create?.path}.

Purpose:
${strategyResult.tool_to_create?.purpose}

Then continue with strategy:
${strategy}`,
                        executorBin: options.executorBin,
                        executor: options.executor,
                        runId: `${runId}-tool-${index}`,
                    }));
                }
            }
            catch (error) {
                // Escalation is best-effort: a strategist failure must not crash the loop. Record
                // it and continue with the previous strategy.
                const message = error instanceof Error ? error.message : String(error);
                appendRuntimeEvent(runDir, {
                    runId,
                    source: 'harness',
                    type: 'loop.executor_error',
                    payload: { iteration: index, error_class: classifyExecutorError(message), message: redact(message), stage: 'escalation' },
                });
            }
        }
    }
    const persistent = unmetHistory.at(-1) ?? [];
    appendRuntimeEvent(runDir, {
        runId,
        source: 'harness',
        type: 'loop.blocked',
        payload: { max_iters: maxIters, persistent_unmet_criteria: persistent },
    });
    return finalizeLoopReport({ runDir, runId, goal: options.goal, status: 'blocked', iterations, strategy, persistent });
}
function finalizeLoopReport(options) {
    const events = readRuntimeEvents(options.runDir);
    const report = {
        schema_version: 1,
        runId: options.runId,
        runDir: options.runDir,
        goal: options.goal,
        status: options.status,
        iterations: options.iterations,
        persistent_unmet_criteria: options.persistent,
        final_strategy: options.strategy,
        ledgerHead: createRuntimeLedgerHeadBinding(events),
    };
    writeFileSync(join(options.runDir, 'closed-loop-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
}
export function readClosedLoopAcceptanceFile(path) {
    return readAcceptanceContract(path);
}

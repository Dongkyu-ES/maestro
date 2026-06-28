import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRuntimeEvents } from '../events/ledger.js';
import { containsLikelySecret } from '../util.js';
const SKIP_DIRS = new Set(['.git', 'node_modules']);
function walkFiles(dir, acc = []) {
    if (!existsSync(dir))
        return acc;
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry))
            continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory())
            walkFiles(full, acc);
        else if (stat.isFile())
            acc.push(full);
    }
    return acc;
}
function readJsonFile(path) {
    if (!existsSync(path))
        return undefined;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function tally(events) {
    const out = {};
    for (const event of events)
        out[event.type] = (out[event.type] ?? 0) + 1;
    return out;
}
function scanLeaks(dirs) {
    const leaked = [];
    for (const dir of dirs) {
        for (const file of walkFiles(dir)) {
            try {
                if (containsLikelySecret(readFileSync(file, 'utf8')))
                    leaked.push(file);
            }
            catch {
                /* unreadable/binary — skip */
            }
        }
    }
    return leaked;
}
function sumTokens(dirs) {
    let tokensIn = 0;
    let tokensOut = 0;
    for (const dir of dirs) {
        for (const file of walkFiles(dir)) {
            if (!file.endsWith('.process.json'))
                continue;
            const proc = readJsonFile(file);
            tokensIn += proc?.token_usage?.input_tokens ?? 0;
            tokensOut += proc?.token_usage?.output_tokens ?? 0;
        }
    }
    return { tokensIn, tokensOut };
}
export function computeRunMetrics(options) {
    const { root, runDir } = options;
    const events = readRuntimeEvents(runDir);
    const eventTypes = tally(events);
    const loopReport = readJsonFile(join(runDir, 'closed-loop-report.json'));
    const sliceReport = readJsonFile(join(runDir, 'harness-run-report.json'));
    const kind = loopReport ? 'loop' : sliceReport ? 'slice' : events.length === 0 ? 'raw' : 'unknown';
    // Loop iteration work happens in sibling run dirs; include them for leak/token scans.
    const iterationDirs = (loopReport?.iterations ?? [])
        .map((it) => (typeof it.runDir === 'string' ? join(root, it.runDir) : ''))
        .filter(Boolean);
    const scanDirs = [runDir, ...iterationDirs];
    const leakedArtifacts = scanLeaks(scanDirs);
    const { tokensIn, tokensOut } = sumTokens(scanDirs);
    const criticRejections = events.filter((e) => e.type === 'loop.critic' && e.payload.controller_done === false).length;
    const selfClaimBlocked = criticRejections > 0 ||
        (eventTypes['run.blocked'] ?? 0) > 0 ||
        (kind === 'loop' && loopReport?.status === 'blocked') ||
        (kind === 'slice' && sliceReport?.state === 'blocked');
    const coverageChecked = events.some((e) => e.type === 'loop.verify' && e.payload.coverage_checked === true) ||
        existsSync(join(runDir, 'tool-verify-result.json'));
    const exitClassified = events.some((e) => e.type === 'loop.executor_error' && typeof e.payload.error_class === 'string');
    const driftSuspected = (loopReport?.iterations ?? []).some((it) => it.critic?.drift_suspected === true) ||
        events.some((e) => e.type === 'loop.verify' && e.payload.drift_suspected === true);
    return {
        runDir,
        kind,
        state: loopReport?.status ?? sliceReport?.state ?? null,
        verifierStatus: sliceReport?.verifier?.status ?? null,
        iterations: kind === 'loop' ? (loopReport?.iterations?.length ?? eventTypes['loop.iteration'] ?? 0) : kind === 'slice' ? 1 : 0,
        selfClaimBlocked,
        secretLeaked: leakedArtifacts.length > 0,
        leakedArtifacts,
        coverageChecked,
        exitClassified,
        stopBlocks: criticRejections + (eventTypes['run.blocked'] ?? 0) + (eventTypes['loop.blocked'] ?? 0),
        escalations: eventTypes['loop.escalated'] ?? 0,
        executorErrors: eventTypes['loop.executor_error'] ?? 0,
        driftSuspected,
        tokensIn,
        tokensOut,
        determinismField: sliceReport?.verifier?.status ?? null,
        eventTypes,
    };
}

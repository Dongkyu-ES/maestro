import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRuntimeEvent, readRuntimeEvents } from '../events/ledger.js';
import { CodexAppServerJsonRpcBridge, CodexAppServerStdioTransport, } from '../runtime/codex-app-server-bridge.js';
export async function exerciseCodexAppServerLifecycle(options) {
    const runDir = join(options.agentDir, 'runs', options.runId);
    mkdirSync(runDir, { recursive: true });
    const transport = options.transport || new CodexAppServerStdioTransport();
    const bridge = new CodexAppServerJsonRpcBridge(transport);
    const results = [];
    const notes = [];
    let forkedThreadId;
    let interruptTurnId;
    try {
        await transport.request('initialize', {
            clientInfo: { name: 'dominic-orchestration-g011', title: null, version: '0.1.0' },
            capabilities: { experimentalApi: true },
        });
        const sessionId = readRuntimeEvents(runDir).find((event) => event.source === 'codex-adapter' && event.type === 'runtime.session.started')?.session_id;
        const base = { runId: options.runId, runDir, threadId: options.threadId, sessionId };
        results.push(await bridge.proveResume(base));
        const fork = await bridge.proveFork({ ...base, forkEphemeral: false });
        results.push(fork);
        forkedThreadId = fork.responseThreadId;
        if (!forkedThreadId) {
            notes.push('thread/fork did not return a forked thread id; interrupt proof cannot target a fork.');
        }
        else {
            const turnStart = await transport.request('turn/start', {
                threadId: forkedThreadId,
                input: [
                    {
                        type: 'text',
                        text: 'Short control turn for lifecycle interrupt proof. Reply OK if not interrupted.',
                        text_elements: [],
                    },
                ],
                cwd: mkdtempSync(join(tmpdir(), 'dominic-codex-lifecycle-proof-')),
                approvalPolicy: 'never',
                sandboxPolicy: { type: 'readOnly', networkAccess: false },
                model: 'gpt-5.3-codex-spark',
                effort: 'low',
            });
            interruptTurnId = turnIdFromResponse(turnStart);
            writeJsonWithDigest(runDir, 'codex-app-server-turn-start-proof.json', {
                schema_version: 1,
                generated_at: new Date().toISOString(),
                run_id: options.runId,
                thread_id: forkedThreadId,
                response: turnStart,
                interrupt_turn_id: interruptTurnId,
            });
            if (!interruptTurnId) {
                results.push(await bridge.proveInterrupt({ ...base, threadId: forkedThreadId }));
            }
            else {
                await sleep(options.interruptDelayMs ?? 3000);
                results.push(await bridge.proveInterrupt({ ...base, threadId: forkedThreadId, turnId: interruptTurnId }));
            }
        }
    }
    catch (err) {
        const message = String(err?.message || err);
        notes.push(`Codex app-server lifecycle exercise stopped: ${message}`);
        appendRuntimeEvent(runDir, {
            runId: options.runId,
            source: 'codex-adapter',
            type: 'runtime.lifecycle.unproven',
            payload: {
                adapter_kind: 'codex',
                runtime_label: 'codex_app_server',
                evidence_status: 'unproven',
                reason: message,
            },
            artifactRefs: [],
        });
    }
    finally {
        await bridge.close();
    }
    const artifactRefs = [
        'codex-app-server-lifecycle-exercise-report.json',
        ...results.map((result) => result.artifactRef),
    ];
    if (existsSync(join(runDir, 'codex-app-server-turn-start-proof.json')))
        artifactRefs.push('codex-app-server-turn-start-proof.json');
    const supported = new Set(results.filter((result) => result.status === 'supported').map((result) => result.verb));
    const decision = ['resume', 'fork', 'interrupt'].every((verb) => supported.has(verb)) ? 'PASS' : 'BLOCKED';
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        run_id: options.runId,
        thread_id: options.threadId,
        forked_thread_id: forkedThreadId,
        interrupt_turn_id: interruptTurnId,
        results,
        decision,
        artifact_refs: [...new Set(artifactRefs)],
        notes,
    };
    writeFileSync(join(runDir, 'codex-app-server-lifecycle-exercise-report.json'), JSON.stringify(report, null, 2));
    return report;
}
function turnIdFromResponse(response) {
    const value = response;
    return typeof value?.turn?.id === 'string' ? value.turn.id : undefined;
}
function writeJsonWithDigest(runDir, artifactRef, value) {
    writeFileSync(join(runDir, artifactRef), JSON.stringify(value, null, 2));
    return createHash('sha256')
        .update(readFileSync(join(runDir, artifactRef)))
        .digest('hex');
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

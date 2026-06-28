import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApproval, resolveApproval } from '../core.js';
import { appendRuntimeEvent, readRuntimeEvents } from '../events/ledger.js';
import { appendMemoryFact } from '../memory/fabric.js';
function codexHelp(cwd, command) {
    try {
        return execFileSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 10000 });
    }
    catch (err) {
        return String(err.stdout || err.stderr || err.message || err);
    }
}
export function appendM8BoundaryEvidence(options) {
    const runDir = join(options.agentDir, 'runs', options.runId);
    const events = readRuntimeEvents(runDir);
    const supportedLifecycleVerbs = new Set(events
        .filter((event) => event.type === 'runtime.lifecycle.supported' && event.payload.evidence_status === 'supported')
        .map((event) => String(event.payload.verb || '')));
    const requiredLifecycleSupported = ['interrupt', 'resume', 'fork'].every((verb) => supportedLifecycleVerbs.has(verb));
    const sourceEventIds = events.map((event) => event.event_id);
    const firstEventId = sourceEventIds[0] || options.runId;
    const codexSession = [...events]
        .reverse()
        .find((event) => event.type === 'runtime.session.started' && event.source === 'codex-adapter');
    const artifact = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        run_id: options.runId,
        codex_help: codexHelp(options.root, 'codex --help'),
        codex_resume_help: codexHelp(options.root, 'codex resume --help'),
        codex_fork_help: codexHelp(options.root, 'codex fork --help'),
        note: 'This records operation-specific boundary evidence without pretending interrupt/resume/fork were actually controlled. Lifecycle verbs remain unproven until a real bridge executes them.',
    };
    writeFileSync(join(runDir, 'm8-boundary-evidence.json'), JSON.stringify(artifact, null, 2));
    const appended = [];
    const append = (...args) => {
        const event = appendRuntimeEvent(...args);
        appended.push(event.event_id);
        return event;
    };
    const runtimeApproval = recordApprovalRequest(options.root, options.agentDir, runDir, options.runId, 'shell_mutation', 'm8 runtime action approval');
    const runtimeApprovalEvent = append(runDir, {
        runId: options.runId,
        source: 'permission-broker',
        type: 'approval.requested',
        payload: {
            approval_id: runtimeApproval.id,
            action: 'shell_mutation',
            risk: 'high',
            runtime_label: 'approval_required',
        },
        artifactRefs: [runtimeApproval.ref],
    });
    snapshotResolvedApproval(options.root, options.agentDir, runDir, runtimeApproval.id);
    append(runDir, {
        runId: options.runId,
        source: 'permission-broker',
        type: 'runtime.action.approved',
        payload: { approval_id: runtimeApproval.id, action: 'shell_mutation', runtime_label: 'approval_chain' },
        artifactRefs: [runtimeApproval.ref],
        causationId: runtimeApprovalEvent.event_id,
    });
    for (const verb of ['interrupt', 'resume', 'fork']) {
        if (supportedLifecycleVerbs.has(verb))
            continue;
        append(runDir, {
            runId: options.runId,
            sessionId: codexSession?.session_id,
            source: 'codex-adapter',
            type: 'runtime.lifecycle.unproven',
            payload: {
                verb,
                adapter_kind: 'codex',
                runtime_label: 'codex_cli',
                evidence_status: 'unproven',
                note: 'CLI/help evidence exists, but this run did not execute a real first-class lifecycle control.',
            },
            artifactRefs: ['m8-boundary-evidence.json'],
        });
    }
    const commitApproval = recordApprovalRequest(options.root, options.agentDir, runDir, options.runId, 'commit', 'm8 commit approval boundary');
    append(runDir, {
        runId: options.runId,
        source: 'permission-broker',
        type: 'approval.requested',
        payload: { approval_id: commitApproval.id, action: 'commit', risk: 'high', runtime_label: 'approval_required' },
        artifactRefs: [commitApproval.ref],
    });
    snapshotResolvedApproval(options.root, options.agentDir, runDir, commitApproval.id);
    const pushApproval = recordApprovalRequest(options.root, options.agentDir, runDir, options.runId, 'push_deploy', 'm8 push/deploy approval boundary');
    append(runDir, {
        runId: options.runId,
        source: 'permission-broker',
        type: 'approval.requested',
        payload: { approval_id: pushApproval.id, action: 'push_deploy', risk: 'high', runtime_label: 'approval_required' },
        artifactRefs: [pushApproval.ref],
    });
    snapshotResolvedApproval(options.root, options.agentDir, runDir, pushApproval.id);
    const memoryIds = [
        appendMemoryFact(options.agentDir, {
            layer: 'blackboard',
            key: `m8:${options.runId}`,
            value: 'parallel blackboard boundary recorded for M8 full-target run',
            run_id: options.runId,
            source_event_ids: [firstEventId],
            artifact_refs: ['m8-boundary-evidence.json'],
        }).id,
        appendMemoryFact(options.agentDir, {
            layer: 'sequential_handoff',
            key: `m8:${options.runId}`,
            value: 'sequential handoff boundary recorded for M8 full-target run',
            run_id: options.runId,
            source_event_ids: [runtimeApprovalEvent.event_id],
            artifact_refs: ['m8-boundary-evidence.json'],
        }).id,
        appendMemoryFact(options.agentDir, {
            layer: 'module_learning',
            key: `m8:${options.runId}`,
            value: requiredLifecycleSupported
                ? 'full-target path proved Codex interrupt/resume/fork bridge'
                : 'full-target path still requires real Codex interrupt/resume/fork bridge',
            run_id: options.runId,
            source_event_ids: [runtimeApprovalEvent.event_id],
            artifact_refs: ['m8-boundary-evidence.json'],
            outcome: requiredLifecycleSupported ? 'success' : 'blocked',
            modules: ['codex', 'full-target-gate', 'm8-boundary-evidence'],
        }).id,
    ];
    const report = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        run_id: options.runId,
        decision: requiredLifecycleSupported ? 'RECORDED_WITH_SUPPORTED_LIFECYCLE' : 'RECORDED_WITH_UNPROVEN_LIFECYCLE',
        appended_events: appended,
        memory_ids: memoryIds,
        artifact_refs: ['m8-boundary-evidence.json'],
        notes: [
            existsSync(join(runDir, 'm8-boundary-evidence.json'))
                ? 'm8-boundary-evidence.json persisted'
                : 'm8-boundary-evidence.json missing',
            'approval and memory boundary evidence is real local persisted evidence',
            requiredLifecycleSupported
                ? 'interrupt/resume/fork already have supported app-server lifecycle evidence'
                : 'interrupt/resume/fork remain unproven and must not satisfy full-target PASS',
        ],
    };
    writeFileSync(join(runDir, 'm8-boundary-evidence-report.json'), JSON.stringify(report, null, 2));
    return report;
}
function recordApprovalRequest(root, agentDir, runDir, runId, action, summary) {
    const approval = createApproval(runId, action, 'high', summary, root);
    const ref = `approvals/${approval.id}.json`;
    mkdirSync(join(runDir, 'approvals'), { recursive: true });
    writeFileSync(join(runDir, ref), JSON.stringify({ ...approval, source: 'createApproval', canonical_path: join(agentDir, 'approvals', `${approval.id}.json`) }, null, 2));
    return { id: approval.id, ref };
}
function snapshotResolvedApproval(root, agentDir, runDir, approvalId) {
    const approved = resolveApproval(approvalId, 'approved', root);
    writeFileSync(join(runDir, 'approvals', `${approvalId}.json`), JSON.stringify({ ...approved, source: 'resolveApproval', canonical_path: join(agentDir, 'approvals', `${approvalId}.json`) }, null, 2));
}

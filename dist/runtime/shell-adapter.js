import { unsupportedResult } from './types.js';
export class ShellPrimitiveAdapter {
    kind = 'shell';
    capabilities() {
        return {
            kind: 'shell',
            label: 'primitive_shell',
            firstClass: false,
            lifecycle: {
                launch: 'supported',
                attach: 'unsupported',
                stream: 'unproven',
                approve: 'unsupported',
                interrupt: 'unproven',
                resume: 'unsupported',
                fork: 'unsupported',
            },
            evidence: [
                'Shell is a primitive compatibility adapter and cannot satisfy Codex/OMX/agy first-class runtime gates.',
            ],
        };
    }
    async *launch(request) {
        yield {
            runId: request.runId,
            sessionId: `shell-${request.runId}`,
            source: 'shell-adapter',
            type: 'runtime.launch.requested',
            payload: { adapter_kind: 'shell', runtime_label: 'primitive_shell', first_class: false },
            artifactRefs: [],
        };
    }
    async *attach(sessionId) {
        yield {
            runId: sessionId,
            sessionId,
            source: 'shell-adapter',
            type: 'runtime.lifecycle.unsupported',
            payload: { verb: 'attach', adapter_kind: 'shell' },
            artifactRefs: [],
        };
    }
    async *stream(sessionId) {
        yield {
            runId: sessionId,
            sessionId,
            source: 'shell-adapter',
            type: 'runtime.lifecycle.unproven',
            payload: { verb: 'stream', adapter_kind: 'shell' },
            artifactRefs: [],
        };
    }
    approve(_sessionId, _approval) {
        return Promise.resolve(unsupportedResult('approve', 'shell'));
    }
    interrupt(_sessionId, _reason) {
        return Promise.resolve({
            status: 'unproven',
            evidence: [],
            message: 'shell interrupt is process-level only and not a first-class agent lifecycle proof',
        });
    }
    async *resume(sessionId, _request) {
        yield {
            runId: sessionId,
            sessionId,
            source: 'shell-adapter',
            type: 'runtime.lifecycle.unsupported',
            payload: { verb: 'resume', adapter_kind: 'shell' },
            artifactRefs: [],
        };
    }
    async *fork(sessionId, _request) {
        yield {
            runId: sessionId,
            sessionId,
            source: 'shell-adapter',
            type: 'runtime.lifecycle.unsupported',
            payload: { verb: 'fork', adapter_kind: 'shell' },
            artifactRefs: [],
        };
    }
}

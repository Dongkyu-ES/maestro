import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCompositionPlan } from './composition/composition.js';
import { addTask, collectRun, createRun, listApprovals, rebuildRuntimeProjectionStore, resolveApproval, startRun } from './core.js';
import {
  appendRuntimeEvent,
  createRuntimeLedgerHeadBinding,
  payloadHash,
  readRuntimeEvents,
  validateRuntimeLedger,
} from './events/ledger.js';
import { exerciseCodexAppServerLifecycle } from './harness/codex-lifecycle-exercise.js';
import { writeFullTargetGateArtifact } from './harness/full-target-gate.js';
import { verifyFullTargetGateArtifact } from './harness/full-target-verifier.js';
import { appendM8BoundaryEvidence } from './harness/m8-boundary-evidence.js';
import { verifyNativeEvidenceRun } from './harness/native-evidence.js';
import { runRuntimeHardGate } from './harness/runtime-gate.js';
import { writeUiAgreementSmoke } from './harness/ui-agreement.js';
import { appendMemoryFact } from './memory/fabric.js';
import { validateMemoryWrite } from './memory/records.js';
import { evaluatePermission } from './policy/permission-broker.js';
import { findProjectedRun, rebuildRuntimeProjection } from './projection/projection.js';
import { readProjectionSqliteSummary } from './projection/sqlite-store.js';
import { CodexCliAdapter, detectCodexCli } from './runtime/codex-adapter.js';
import { CodexAppServerJsonRpcBridge, type JsonRpcTransport } from './runtime/codex-app-server-bridge.js';
import { createCodexLaunchProof } from './runtime/codex-process-bridge.js';
import { ShellPrimitiveAdapter } from './runtime/shell-adapter.js';
import type { RuntimeCapabilities } from './runtime/types.js';
import { renderHtml, renderRun } from './view.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dominic-runtime-'));
}

// Hermetic codex seam: a fake `codex` binary that emits the real JSONL event
// shape, writes the -o last-message file, and makes a real file change so the
// collect/review pipeline sees an actual diff — with no network or model calls.
const FAKE_CODEX_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const msg = 'fake codex executed the task and edited codex-change.txt';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-0001' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: msg } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
if (out) fs.writeFileSync(out, msg + '\\n');
try { fs.writeFileSync(path.join(cwd, 'codex-change.txt'), 'changed by fake codex\\n'); } catch {}
process.exit(0);
`;
const fakeCodexDir = mkdtempSync(join(tmpdir(), 'fake-codex-'));
const fakeCodexPath = join(fakeCodexDir, 'codex');
writeFileSync(fakeCodexPath, FAKE_CODEX_SCRIPT, { mode: 0o755 });
process.env.AGENT_CODEX_BIN = fakeCodexPath;

test('Story 1: runtime contracts expose lifecycle verbs and shell is primitive only', () => {
  const shell = new ShellPrimitiveAdapter();
  const cap = shell.capabilities();
  assert.equal(cap.firstClass, false);
  assert.equal(cap.label, 'primitive_shell');
  for (const verb of ['launch', 'attach', 'stream', 'approve', 'interrupt', 'resume', 'fork'] as const)
    assert.ok(cap.lifecycle[verb]);
  assert.notEqual(cap.lifecycle.attach, 'supported');
});

test('Story 2: canonical event ledger validates hash and ordered append-only sequence', () => {
  const dir = tempDir();
  const one = appendRuntimeEvent(dir, {
    runId: 'run-1',
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { a: 1 },
    artifactRefs: ['prompt.md'],
  });
  const two = appendRuntimeEvent(dir, {
    runId: 'run-1',
    source: 'shell-adapter',
    type: 'runtime.launch.requested',
    payload: { adapter_kind: 'shell', runtime_label: 'primitive_shell' },
  });
  assert.equal(one.sequence, 1);
  assert.equal(two.sequence, 2);
  const events = readRuntimeEvents(dir);
  validateRuntimeLedger(events);
  assert.equal(events[0].payload_sha256, payloadHash({ a: 1 }));
  events[1].payload_sha256 = 'bad';
  assert.throws(() => validateRuntimeLedger(events), /payload hash mismatch/);
});

test('Story 3: projection rebuilds only from event facts and cannot invent runs', () => {
  const dir = tempDir();
  appendRuntimeEvent(dir, {
    runId: 'run-2',
    source: 'runtime-manager',
    type: 'goal.received',
    payload: { task_id: 'task-a' },
  });
  appendRuntimeEvent(dir, {
    runId: 'run-2',
    source: 'shell-adapter',
    type: 'runtime.session.started',
    payload: { adapter_kind: 'shell', runtime_label: 'primitive_shell' },
    artifactRefs: ['executor.process.json'],
  });
  const projection = rebuildRuntimeProjection(readRuntimeEvents(dir));
  assert.equal(projection.runs.length, 1);
  assert.equal(findProjectedRun(projection, 'run-2')?.labels.includes('primitive_shell'), true);
  assert.equal(findProjectedRun(projection, 'missing'), undefined);
});

test('Story 4: UI separates operator approval lane and labels primitive shell truth', async () => {
  const dir = tempDir();
  const task = addTask('ui truth task', dir);
  const run = createRun(task.id, { command: "node -e \"require('fs').writeFileSync('x','y')\"" }, dir);
  await startRun(run.id, {}, dir);
  assert.equal(
    listApprovals(dir).some((a) => a.run_id === run.id && a.status === 'requested'),
    true,
  );
  const html = renderHtml(dir, 'csrf');
  assert.match(html, /Your input \/ permissions/);
  assert.match(html, /Agent \/ LLM work/);
  assert.match(html, /Approval Queue/);
  assert.match(html, /approval_required|primitive_shell/);
});

test('Story 5: Codex lifecycle spike records real binary detection but does not fake support', async () => {
  const dir = tempDir();
  const adapter = new CodexCliAdapter(dir);
  const detected = detectCodexCli(dir);
  const cap = adapter.capabilities();
  assert.equal(cap.kind, 'codex');
  assert.equal(cap.firstClass, false);
  assert.ok(['unsupported', 'unproven'].includes(cap.lifecycle.launch));
  const events = [];
  for await (const event of adapter.launch({ runId: 'run-codex', cwd: dir, metadata: { evidenceDir: dir } }))
    events.push(event);
  assert.equal(events.length, 1);
  assert.match(String(events[0].payload.evidence_status), detected.available ? /unproven/ : /unsupported/);
  assert.equal(existsSync(join(dir, 'codex-lifecycle-evidence.json')), true);
});

test('Story 6: permission broker requires approval for upper-scope and destructive actions', () => {
  assert.equal(
    evaluatePermission({ runId: 'r', action: 'general_tool', scope: 'sandbox', summary: 'read' }).status,
    'allow',
  );
  const destructive = evaluatePermission({ runId: 'r', action: 'destructive', scope: 'project', summary: 'rm' });
  assert.equal(destructive.status, 'requires_approval');
  assert.equal(destructive.eventType, 'approval.requested');
  const globalMemory = evaluatePermission({
    runId: 'r',
    action: 'upper_scope_memory',
    scope: 'global',
    summary: 'learn preference',
  });
  assert.equal(globalMemory.status, 'requires_approval');
});

test('Story 6: memory writes require provenance and upper-scope authority', () => {
  assert.throws(
    () =>
      validateMemoryWrite({
        schema_version: 1,
        memory_id: 'm1',
        scope: 'global',
        authority: 'automatic_sandbox',
        source_event_ids: ['e1'],
        artifact_refs: [],
        key: 'pref',
        value: true,
        merge_policy: 'append',
        created_at: new Date().toISOString(),
        writer: 'agent',
      }),
    /upper-scope/,
  );
  assert.doesNotThrow(() =>
    validateMemoryWrite({
      schema_version: 1,
      memory_id: 'm2',
      scope: 'blackboard',
      authority: 'automatic_sandbox',
      source_event_ids: ['e1'],
      artifact_refs: [],
      key: 'note',
      value: 'x',
      merge_policy: 'append',
      created_at: new Date().toISOString(),
      writer: 'agent',
    }),
  );
});

test('Story 7: hard gate refuses shell-only false completion claims', () => {
  const dir = tempDir();
  appendRuntimeEvent(dir, {
    runId: 'run-shell',
    source: 'shell-adapter',
    type: 'runtime.session.started',
    payload: { adapter_kind: 'shell', runtime_label: 'primitive_shell' },
  });
  const shell = new ShellPrimitiveAdapter().capabilities();
  const codex = new CodexCliAdapter(dir).capabilities();
  const fail = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [shell, codex],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(fail.decision, 'FAIL');
  assert.equal(fail.false_completion_result, 'FAIL');
  appendRuntimeEvent(dir, {
    runId: 'run-shell',
    source: 'codex-adapter',
    type: 'runtime.lifecycle.unproven',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli' },
  });
  const slicePass = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [shell, codex],
    milestoneClaim: 'capability slice',
    artifactRoot: dir,
  });
  assert.equal(slicePass.decision, 'PASS');
  const forgedFull = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [shell, codex],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(forgedFull.decision, 'FAIL');
});

test('startRun writes runtime events and approval decisions as linked evidence', async () => {
  const dir = tempDir();
  const task = addTask('eventful task', dir);
  const run = createRun(task.id, { command: "node -e \"require('fs').writeFileSync('x','y')\"" }, dir);
  await startRun(run.id, {}, dir);
  const approval = listApprovals(dir).find((a) => a.run_id === run.id && a.status === 'requested');
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const types = readRuntimeEvents(runDir).map((event) => event.type);
  assert.ok(types.includes('goal.received'));
  assert.ok(types.includes('runtime.launch.requested'));
  assert.ok(types.includes('approval.requested'));
  assert.ok(types.includes('approval.decided'));
  const projection = rebuildRuntimeProjection(readRuntimeEvents(runDir));
  assert.equal(findProjectedRun(projection, run.id)?.approvals[0].status, 'approved');
});

test('codex executor really runs codex and emits real session evidence, not a shell fallback', async () => {
  const dir = tempDir();
  const task = addTask('codex requested task', dir);
  const run = createRun(task.id, { executor: 'codex' }, dir);
  await startRun(run.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  assert.match(readFileSync(join(runDir, 'executor-command.txt'), 'utf8'), /--sandbox workspace-write/);
  const events = readRuntimeEvents(runDir);
  // The codex executor must not fall back to a primitive shell adapter.
  assert.equal(
    events.some((event) => event.source === 'shell-adapter'),
    false,
  );
  // Real codex session evidence: started, executed, with the real session id.
  const session = [...events]
    .reverse()
    .find((event) => event.source === 'codex-adapter' && event.type === 'runtime.session.started')!;
  assert.ok(session);
  assert.equal(session.payload.adapter_kind, 'codex');
  assert.equal(session.payload.evidence_status, 'executed');
  assert.equal(session.payload.first_class, true);
  assert.equal(session.session_id, 'fake-thread-0001');
  assert.equal(session.artifact_refs.includes('executor.process.json'), true);
  // Real process evidence with a real exit code, plus a real file change.
  const proc = JSON.parse(readFileSync(join(runDir, 'executor.process.json'), 'utf8'));
  assert.equal(proc.exit_code, 0);
  assert.equal(existsSync(join(dir, 'codex-change.txt')), true);
});

test('GitHub-folder PPT codex runs use GUI-capable sandbox by default', async () => {
  const dir = tempDir();
  const task = addTask(
    '깃헙폴더를 읽고 어떤 프로젝트가 있는지, 최근에 진행하던 프로젝트가 뭔지 두괄식으로 요약하고 제일 활성화된 프로젝트를 ppt로 만들어서 보고해',
    dir,
  );
  const run = createRun(task.id, { executor: 'codex' }, dir);
  await startRun(run.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  assert.match(readFileSync(join(runDir, 'executor-command.txt'), 'utf8'), /--sandbox danger-full-access/);
  assert.match(readFileSync(join(runDir, 'codex-prompt.md'), 'utf8'), /PPTX_OPENABLE_PASS/);
});

test('codex prompt routes through local skill registry and collect blocks missing skill evidence', async () => {
  const dir = tempDir();
  const analyzeDir = join(dir, '.codex', 'skills', 'analyze');
  const presentationsDir = join(
    dir,
    '.codex',
    'plugins',
    'cache',
    'openai-primary-runtime',
    'presentations',
    'test-version',
    'skills',
    'presentations',
  );
  mkdirSync(analyzeDir, { recursive: true });
  mkdirSync(presentationsDir, { recursive: true });
  writeFileSync(
    join(analyzeDir, 'SKILL.md'),
    '# Analyze\nUse for ranked repository analysis with explicit local evidence and confidence boundaries.\n',
  );
  writeFileSync(
    join(presentationsDir, 'SKILL.md'),
    '# Presentations\nBuild PowerPoint PPTX decks; verify rendered slides and proof objects.\n',
  );
  const task = addTask('프로젝트를 분석해서 ranked synthesis 보고서를 만들어줘', dir);
  const run = createRun(task.id, { executor: 'codex' }, dir);
  await startRun(run.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const prompt = readFileSync(join(runDir, 'codex-prompt.md'), 'utf8');
  assert.match(prompt, /Skill Routing Candidates/);
  assert.match(prompt, /analyze/i);
  assert.match(prompt, /skill-usage-response\.md/);
  assert.match(readFileSync(join(runDir, 'skill-routing-candidates.md'), 'utf8'), /SKILL\.md/);

  const commandTask = addTask('skill evidence collect gate', dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  const commandRun = createRun(commandTask.id, { command: "node -e \"require('fs').writeFileSync('ok.txt','ok')\"" }, dir);
  await startRun(commandRun.id, {}, dir);
  const approval = listApprovals(dir).find((a) => a.run_id === commandRun.id && a.status === 'requested');
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
  await startRun(commandRun.id, {}, dir);
  const commandRunDir = join(dir, '.agent', 'runs', commandRun.id);
  writeFileSync(
    join(commandRunDir, 'skill-routing-candidates.md'),
    '# Skill Routing Candidates\n\n## Candidates\n1. analyze\n   - path: .codex/skills/analyze/SKILL.md\n   - why: test candidate\n',
  );
  const collected = collectRun(commandRun.id, dir);
  assert.equal(collected.decision, 'changes_requested');
  assert.match(readFileSync(join(commandRunDir, 'review.md'), 'utf8'), /Skill usage/);
  assert.match(readFileSync(join(commandRunDir, 'skill-usage-critique.md'), 'utf8'), /skill-usage-response\.md/);
});

test('review blocker: mode-specific runtime evidence points to actual process artifacts', async () => {
  const dir = tempDir();
  const task = addTask('roles artifact refs task', dir);
  const run = createRun(task.id, { mode: 'roles' }, dir);
  await startRun(run.id, { command: 'node -e "console.log(process.env.ROLE)"' }, dir);
  const approval = listApprovals(dir).find((a) => a.run_id === run.id && a.status === 'requested');
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
  await startRun(run.id, { command: 'node -e "console.log(process.env.ROLE)"' }, dir);
  const events = readRuntimeEvents(join(dir, '.agent', 'runs', run.id));
  const last = [...events].reverse().find((event) => event.source === 'shell-adapter')!;
  assert.deepEqual(
    last.artifact_refs.sort(),
    ['manager.process.json', 'reviewer.process.json', 'worker-001.process.json'].sort(),
  );
});

test('review blocker: hard gate rejects forged supported Codex and missing full-gate artifact', () => {
  const dir = tempDir();
  appendRuntimeEvent(dir, {
    runId: 'run-forged',
    source: 'codex-adapter',
    type: 'runtime.session.started',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli', evidence_status: 'supported' },
    artifactRefs: ['missing-codex-transcript.json'],
  });
  appendRuntimeEvent(dir, {
    runId: 'run-forged',
    source: 'harness',
    type: 'gate.full_target.passed',
    payload: { artifact_sha256: 'not-real' },
    artifactRefs: ['missing-full-gate.json'],
  });
  const shell = new ShellPrimitiveAdapter().capabilities();
  const codex = new CodexCliAdapter(dir).capabilities();
  const forged = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [shell, codex],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(forged.decision, 'FAIL');
  assert.ok(forged.checks.some((c) => c.name === 'Full Target Runtime Proof Gate' && c.status === 'FAIL'));
  assert.ok(forged.checks.some((c) => c.name === 'Milestone Claim Language Gate' && c.status === 'FAIL'));
});

test('review blocker: launch request for unproven omx/agy does not project fake first-class session', async () => {
  for (const executor of ['omx', 'agy'] as const) {
    const dir = tempDir();
    const task = addTask(`${executor} projection task`, dir);
    const run = createRun(task.id, { executor, command: 'node -e "console.log(1)"' }, dir);
    await startRun(run.id, {}, dir);
    const approval = listApprovals(dir).find((a) => a.run_id === run.id && a.status === 'requested');
    assert.ok(approval);
    resolveApproval(approval.id, 'approved', dir);
    await startRun(run.id, {}, dir);
    const events = readRuntimeEvents(join(dir, '.agent', 'runs', run.id));
    const launch = events.find((event) => event.type === 'runtime.launch.requested')!;
    assert.equal(launch.source, 'runtime-manager');
    assert.equal(launch.payload.requested_adapter_kind, executor);
    assert.equal(launch.payload.first_class, false);
    const projection = rebuildRuntimeProjection(events);
    const projected = findProjectedRun(projection, run.id)!;
    assert.equal(
      projected.sessions.some((session) => session.adapter_kind === executor),
      false,
    );
    assert.equal(projected.labels.includes('primitive_shell'), true);
  }
});

test('Priority 3: permission broker links request decision and approved runtime action', async () => {
  const dir = tempDir();
  const task = addTask('approval chain task', dir);
  const command = `node -e "require('fs').writeFileSync('approval-chain.txt','ok')"`;
  const run = createRun(task.id, { command }, dir);
  await startRun(run.id, {}, dir);
  const approval = listApprovals(dir).find((a) => a.run_id === run.id && a.type === 'shell_mutation');
  assert.ok(approval);
  resolveApproval(approval.id, 'approved', dir);
  await startRun(run.id, {}, dir);
  const types = readRuntimeEvents(join(dir, '.agent', 'runs', run.id)).map((event) => event.type);
  assert.ok(types.includes('approval.requested'));
  assert.ok(types.includes('approval.decided'));
  assert.ok(types.includes('runtime.action.approved'));
  assert.ok(types.includes('runtime.session.started'));
});

test('Priority 2: projection replay records completed lifecycle from event ledger', () => {
  const dir = tempDir();
  appendRuntimeEvent(dir, {
    runId: 'run-projected',
    source: 'runtime-manager',
    type: 'runtime.launch.requested',
    payload: { runtime_label: 'adapter_requested_unproven' },
  });
  appendRuntimeEvent(dir, {
    runId: 'run-projected',
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'codex-session-1',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli', evidence_status: 'supported' },
    artifactRefs: ['codex-launch-proof.json'],
  });
  appendRuntimeEvent(dir, {
    runId: 'run-projected',
    source: 'runtime-manager',
    type: 'run.completed',
    payload: { decision: 'pass', runtime_label: 'run_lifecycle' },
    artifactRefs: ['review.md'],
  });
  const projection = rebuildRuntimeProjection(readRuntimeEvents(dir));
  const run = findProjectedRun(projection, 'run-projected')!;
  assert.equal(run.status, 'completed');
  assert.equal(run.sessions[0].adapter_kind, 'codex');
  assert.ok(run.labels.includes('codex_cli'));
});

test('Priority 1: codex executor runs codex for real and never falls back to primitive shell', async () => {
  const dir = tempDir();
  const task = addTask('codex no shell fallback task', dir);
  const run = createRun(task.id, { executor: 'codex' }, dir);
  await startRun(run.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const events = readRuntimeEvents(runDir);
  // Real execution produces real process evidence, not just a binary-detection proof.
  assert.equal(existsSync(join(runDir, 'executor.process.json')), true);
  assert.ok(
    events.some((event) => event.source === 'codex-adapter' && event.type === 'runtime.session.started'),
  );
  assert.equal(
    events.some((event) => event.source === 'shell-adapter'),
    false,
  );
});

test('G005 native evidence smoke verifies raw diff artifacts and exposes unowned native surfaces', async () => {
  const dir = tempDir();
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  const task = addTask('daily native evidence smoke writes a real artifact', dir);
  const run = createRun(task.id, { executor: 'codex', source: 'web' }, dir);
  await startRun(run.id, {}, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const report = verifyNativeEvidenceRun({ root: dir, runId: run.id });
  assert.equal(report.decision, 'PASS', JSON.stringify(report.checks, null, 2));

  const evidence = JSON.parse(readFileSync(join(runDir, 'native-evidence.json'), 'utf8'));
  assert.equal(evidence.status, 'native-harness-assisted');
  assert.ok(evidence.unowned_surfaces.some((surface: string) => surface.includes('in-loop shell/file mediation')));
  assert.ok(evidence.effect_classification.changed_files.includes('codex-change.txt'));
  assert.equal(existsSync(join(runDir, 'native-diff.patch')), true);

  const event = readRuntimeEvents(runDir).find((item) => item.source === 'codex-adapter' && item.type === 'runtime.session.started');
  assert.equal(event?.payload.runtime_label, 'native-harness-assisted');
  assert.equal(event?.payload.native_status, 'native-harness-assisted');
  assert.equal(event?.artifact_refs.includes('native-evidence.json'), true);
});

test('G005 native evidence verifier rejects native completion text without matching diff artifacts', () => {
  const dir = tempDir();
  const runId = 'forged-native-run';
  const runDir = join(dir, '.agent', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'executor.process.json'),
    JSON.stringify({ exit_code: 0, session_id: 'fake-session', last_message: 'native executor says done' }, null, 2),
  );
  writeFileSync(join(runDir, 'executor.stdout.log'), 'native executor says done');
  writeFileSync(join(runDir, 'executor.stderr.log'), '');
  writeFileSync(join(runDir, 'codex-events.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: 'fake-session' })}\n`);
  writeFileSync(join(runDir, 'codex-last-message.txt'), 'native executor says done');
  writeFileSync(
    join(runDir, 'native-evidence.json'),
    JSON.stringify(
      {
        schema_version: 1,
        run_id: runId,
        executor: 'codex',
        status: 'native-harness-assisted',
        unowned_surfaces: ['native harness owns hidden work'],
        raw_artifacts: [],
        diff_ref: 'native-diff.patch',
        diff_sha256: 'not-a-real-diff',
        effect_classification: {
          process_exit_zero: true,
          last_message_present: true,
          session_identifier_present: true,
          diff_present: false,
          changed_files: [],
        },
      },
      null,
      2,
    ),
  );
  appendRuntimeEvent(runDir, {
    runId,
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'fake-session',
    payload: { runtime_label: 'native-harness-assisted', evidence_status: 'executed' },
    artifactRefs: ['native-evidence.json'],
  });
  const report = verifyNativeEvidenceRun({ root: dir, runId });
  assert.equal(report.decision, 'FAIL');
  assert.equal(report.checks.raw_artifact_hashes_match, false);
  assert.equal(report.checks.diff_matches_effect, false);
});

test('Priority 1: Codex transcript evidence upgrades launch attach stream without shell fallback', () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const runDir = join(agentDir, 'runs', 'run-codex-supported');
  const transcript = join(dir, 'codex-session.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-proof' } })}\n${JSON.stringify({ type: 'response_item', payload: { text: 'stream proof' } })}\n`,
  );
  const proof = createCodexLaunchProof({
    runId: 'run-codex-supported',
    cwd: dir,
    agentDir,
    runDir,
    prompt: 'hello',
    liveTranscriptPath: transcript,
  });
  assert.equal(proof.status, 'supported');
  assert.equal(Boolean(proof.transcript_sha256), true);
  const evidence = JSON.parse(readFileSync(join(runDir, 'codex-launch-proof.json'), 'utf8'));
  assert.equal(evidence.status, 'supported');
  assert.equal(evidence.transcript_path, transcript);
  const registry = JSON.parse(readFileSync(join(agentDir, 'runtime', 'codex-sessions.json'), 'utf8'));
  assert.equal(registry.sessions[0].evidence_status, 'supported');
  assert.equal(registry.sessions[0].transcript_path, transcript);
});

test('Phase 1: Codex launch proof persists registry without faking support', () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const runDir = join(agentDir, 'runs', 'run-codex-proof');
  const proof = createCodexLaunchProof({ runId: 'run-codex-proof', cwd: dir, agentDir, runDir, prompt: 'hello' });
  assert.ok(['unsupported', 'unproven'].includes(proof.status));
  assert.equal(existsSync(join(runDir, 'codex-launch-proof.json')), true);
  const registry = JSON.parse(readFileSync(join(agentDir, 'runtime', 'codex-sessions.json'), 'utf8'));
  assert.equal(registry.sessions.length, 1);
  assert.equal(registry.sessions[0].evidence_status, proof.status);
});

test('Phase 2: runtime projection persists JSON and SQLite projection', async () => {
  const dir = tempDir();
  const task = addTask('sqlite projection task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, { command: 'pwd' }, dir);
  const projection = rebuildRuntimeProjectionStore(dir);
  assert.equal(findProjectedRun(projection, run.id)?.labels.includes('primitive_shell'), true);
  assert.equal(existsSync(join(dir, '.agent', 'projection', 'runtime-projection.json')), true);
  const summary = readProjectionSqliteSummary(join(dir, '.agent', 'projection', 'runtime.sqlite'));
  assert.equal(summary.runs >= 1, true);
  assert.equal(summary.artifacts >= 1, true);
});

test('Phase 3: run detail exposes SSE event stream route link', () => {
  const dir = tempDir();
  const task = addTask('event stream ui task', dir);
  const run = createRun(task.id, {}, dir);
  const html = renderRun(run.id, dir);
  assert.match(html, new RegExp(`/api/runs/${run.id}/events`));
  assert.match(html, /Event stream \(SSE\)/);
});

test('Phase 4: composition plan captures sandbox context and module stack', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent rules\n');
  const runDir = join(dir, '.agent', 'runs', 'run-compose');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'task.md'), 'task', { flag: 'w' });
  writeFileSync(join(runDir, 'context.md'), 'context', { flag: 'w' });
  writeFileSync(join(runDir, 'prompt.md'), 'prompt', { flag: 'w' });
  const plan = buildCompositionPlan({
    root: dir,
    runDir,
    runId: 'run-compose',
    taskId: 'task-compose',
    preferredRuntime: 'codex',
    mode: 'multi',
  });
  assert.equal(plan.modules.runtime_adapter, 'codex_adapter_unproven');
  assert.ok(plan.modules.agents_md_stack.includes('AGENTS.md'));
  assert.ok(plan.modules.skills.includes('team'));
  assert.match(plan.context_pack.sha256, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(runDir, 'composition.json')), true);
  assert.ok(plan.selection_rationale.some((line) => line.includes('Runtime')));
});

test('Phase 5: createRun and startRun append composition and permission chain events', async () => {
  const dir = tempDir();
  const task = addTask('permission chain task', dir);
  const run = createRun(task.id, {}, dir);
  await startRun(run.id, { command: 'pwd' }, dir);
  const runDir = join(dir, '.agent', 'runs', run.id);
  const events = readRuntimeEvents(runDir);
  assert.ok(
    events.some((event) => event.type === 'composition.resolved' && event.artifact_refs.includes('composition.json')),
  );
  assert.ok(events.some((event) => event.type === 'permission.allowed'));
  assert.equal(existsSync(join(runDir, 'composition.json')), true);
});

test('Phase 8: web-created run preserves web as goal input event source', () => {
  const dir = tempDir();
  const task = addTask('web source full target task', dir);
  const run = createRun(task.id, { executor: 'codex', source: 'web' }, dir);
  const events = readRuntimeEvents(join(dir, '.agent', 'runs', run.id));
  assert.equal(events[0].type, 'goal.received');
  assert.equal(events[0].source, 'web');
});

test('Phase 6: OMX adapter emits parity-shaped unproven evidence without fake session', async () => {
  const dir = tempDir();
  const { OmxCliAdapter } = await import('./runtime/omx-adapter.js');
  const adapter = new OmxCliAdapter(dir);
  const cap = adapter.capabilities();
  assert.equal(cap.kind, 'omx');
  assert.equal(cap.firstClass, false);
  const events = [];
  for await (const event of adapter.launch({ runId: 'run-omx', cwd: dir, metadata: { evidenceDir: dir } }))
    events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'runtime.lifecycle.unproven');
  assert.equal(events[0].payload.first_class, false);
  assert.equal(existsSync(join(dir, 'omx-lifecycle-evidence.json')), true);
});

test('Phase 7: agy adapter participates in runtime parity gate without bypass', async () => {
  const dir = tempDir();
  const { AgyCliAdapter } = await import('./runtime/agy-adapter.js');
  const { OmxCliAdapter } = await import('./runtime/omx-adapter.js');
  const { runRuntimeParityGate } = await import('./harness/parity-gate.js');
  const report = runRuntimeParityGate([
    new CodexCliAdapter(dir).capabilities(),
    new OmxCliAdapter(dir).capabilities(),
    new AgyCliAdapter(dir).capabilities(),
    new ShellPrimitiveAdapter().capabilities(),
  ]);
  assert.equal(report.decision, 'PASS');
  assert.ok(report.checks.some((check) => check.name === 'Primitive Shell Non-Bypass Gate' && check.status === 'PASS'));
});

test('Phase 5 PRD memory fabric records outcomes and changes later module recommendations', async () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const { appendMemoryFact, recommendModules } = await import('./memory/fabric.js');
  appendMemoryFact(agentDir, {
    layer: 'module_learning',
    key: 'agentic-orchestration',
    value: 'codex worked',
    outcome: 'success',
    modules: ['codex', 'runtime-hard-gate'],
    source_event_ids: ['event-1'],
    artifact_refs: [],
  });
  appendMemoryFact(agentDir, {
    layer: 'module_learning',
    key: 'agentic-orchestration',
    value: 'shell blocked',
    outcome: 'failure',
    modules: ['shell', 'runtime-hard-gate'],
    source_event_ids: ['event-2'],
    artifact_refs: [],
  });
  const recommendations = recommendModules(agentDir, 'agentic-orchestration');
  assert.deepEqual(recommendations[0].modules, ['codex', 'runtime-hard-gate']);
  assert.equal(recommendations[0].score > recommendations[1].score, true);
});

test('Phase 8: full-target hard gate remains failed without supported first-class runtime evidence', () => {
  const dir = tempDir();
  appendRuntimeEvent(dir, {
    runId: 'run-full',
    source: 'omx-adapter',
    type: 'runtime.lifecycle.unproven',
    payload: { adapter_kind: 'omx', runtime_label: 'omx_cli', first_class: false, evidence_status: 'unproven' },
    artifactRefs: ['omx-lifecycle-evidence.json'],
  });
  const report = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [new ShellPrimitiveAdapter().capabilities(), new CodexCliAdapter(dir).capabilities()],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(report.decision, 'FAIL');
});

test('Phase 8: full-target hard gate requires a digest-matched PASS artifact, not just a magic event', () => {
  const dir = tempDir();
  const codexProof = { schema_version: 1, status: 'supported', transcript_sha256: 'abc123' };
  writeFileSync(join(dir, 'codex-launch-proof.json'), JSON.stringify(codexProof, null, 2));
  const session = appendRuntimeEvent(dir, {
    runId: 'run-full-pass',
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'codex-session',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli', evidence_status: 'supported' },
    artifactRefs: ['codex-launch-proof.json'],
  });
  const forged = {
    schema_version: 1,
    decision: 'PASS',
    requirements: [{ name: 'fake', status: 'FAIL' }],
    source_event_ids: [session.event_id],
  };
  writeFileSync(join(dir, 'full-target-gate.json'), JSON.stringify(forged, null, 2));
  const forgedSha = createHash('sha256')
    .update(readFileSync(join(dir, 'full-target-gate.json')))
    .digest('hex');
  appendRuntimeEvent(dir, {
    runId: 'run-full-pass',
    source: 'harness',
    type: 'gate.full_target.passed',
    payload: { artifact_sha256: forgedSha },
    artifactRefs: ['full-target-gate.json'],
  });
  const supportedCodex: RuntimeCapabilities = {
    kind: 'codex',
    label: 'codex_cli',
    firstClass: true,
    lifecycle: {
      launch: 'supported',
      attach: 'supported',
      stream: 'supported',
      approve: 'unproven',
      interrupt: 'unproven',
      resume: 'unproven',
      fork: 'unproven',
    },
    evidence: ['test supported transcript'],
  };
  const forgedReport = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [new ShellPrimitiveAdapter().capabilities(), supportedCodex],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(forgedReport.decision, 'FAIL');

  const passBinding = createRuntimeLedgerHeadBinding(readRuntimeEvents(dir));
  const passArtifact = {
    schema_version: 1,
    run_id: 'run-full-pass',
    decision: 'PASS',
    requirements: [
      'web goal input',
      'sandbox context',
      'composition',
      'codex launch attach stream',
      'approval top lane',
      'interrupt',
      'resume',
      'fork',
      'parallel blackboard',
      'sequential handoff',
      'hard gate',
      'learning memory',
      'review boundary',
      'commit approval boundary',
      'push deploy approval boundary',
      'ledger projection UI render agreement',
    ].map((name) => ({ name, status: 'PASS' })),
    source_event_ids: [session.event_id],
    ledger_head_sha256: passBinding.ledger_head_sha256,
    ledger_event_count: passBinding.event_count,
    projection_status: 'completed',
  };
  writeFileSync(join(dir, 'full-target-gate-v2.json'), JSON.stringify(passArtifact, null, 2));
  const passSha = createHash('sha256')
    .update(readFileSync(join(dir, 'full-target-gate-v2.json')))
    .digest('hex');
  appendRuntimeEvent(dir, {
    runId: 'run-full-pass',
    source: 'harness',
    type: 'gate.full_target.verified',
    payload: {
      artifact_sha256: passSha,
      ledger_head_sha256: passBinding.ledger_head_sha256,
      ledger_event_count: passBinding.event_count,
    },
    artifactRefs: ['full-target-gate-v2.json'],
  });
  const passReport = runRuntimeHardGate({
    events: readRuntimeEvents(dir),
    capabilities: [new ShellPrimitiveAdapter().capabilities(), supportedCodex],
    milestoneClaim: '95% complete runtime',
    artifactRoot: dir,
  });
  assert.equal(passReport.decision, 'PASS');
});

test('Phase 8: full-target artifact writer lists concrete missing requirements and only emits pass event when all pass', () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const runId = 'run-full-artifact';
  const runDir = join(agentDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'run.yaml'),
    `schema_version: 1\nid: ${runId}\ntask_id: t\nstatus: completed\nexecutor: codex\nmode: basic\nrun_dir: .agent/runs/${runId}\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: 2026-01-01T00:00:00.000Z\nended_at: 2026-01-01T00:00:00.000Z\n`,
  );
  writeFileSync(join(runDir, 'context.md'), 'context');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt');
  writeFileSync(join(runDir, 'composition.json'), JSON.stringify({ schema_version: 1 }));
  writeFileSync(join(runDir, 'codex-launch-proof.json'), JSON.stringify({ schema_version: 1, status: 'supported' }));
  writeFileSync(join(runDir, 'review.md'), '# Review\n\nPASS');
  const goal = appendRuntimeEvent(runDir, { runId, source: 'web', type: 'goal.received', payload: { task_id: 't' } });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'runtime-manager',
    type: 'composition.resolved',
    payload: { runtime_label: 'composition_plan' },
    artifactRefs: ['composition.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'codex-session',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli', evidence_status: 'supported' },
    artifactRefs: ['codex-launch-proof.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'runtime-manager',
    type: 'run.completed',
    payload: { decision: 'pass', runtime_label: 'run_lifecycle' },
    artifactRefs: ['review.md'],
  });
  const failedArtifact = writeFullTargetGateArtifact({ root: dir, agentDir, runId, appendPassEvent: true });
  assert.equal(failedArtifact.decision, 'FAIL');
  assert.ok(failedArtifact.requirements.some((item) => item.name === 'interrupt' && item.status === 'FAIL'));
  assert.equal(
    readRuntimeEvents(runDir).some((event) => event.type === 'gate.full_target.passed'),
    false,
  );

  mkdirSync(join(runDir, 'approvals'), { recursive: true });
  for (const id of ['approval-shell', 'commit-approval', 'push-approval'])
    writeFileSync(
      join(runDir, 'approvals', `${id}.json`),
      JSON.stringify({ schema_version: 1, id, run_id: runId, status: 'approved' }),
    );
  const approvalRequested = appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.requested',
    payload: { approval_id: 'approval-shell', action: 'shell_mutation', runtime_label: 'approval_required' },
    artifactRefs: ['approvals/approval-shell.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.decided',
    payload: { approval_id: 'approval-shell', decision: 'approved', runtime_label: 'approval_chain' },
    artifactRefs: ['approvals/approval-shell.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'runtime.action.approved',
    payload: { approval_id: 'wrong-approval', action: 'shell_mutation', runtime_label: 'approval_chain' },
    artifactRefs: ['approvals/approval-shell.json'],
  });
  for (const verb of ['interrupt', 'resume', 'fork'])
    appendRuntimeEvent(runDir, {
      runId,
      source: 'codex-adapter',
      type: 'runtime.lifecycle.supported',
      sessionId: 'codex-session',
      payload: { verb, adapter_kind: 'codex', evidence_status: 'supported' },
    });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.requested',
    payload: { approval_id: 'commit-approval', action: 'commit', runtime_label: 'approval_required' },
    artifactRefs: ['approvals/commit-approval.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.decided',
    payload: { approval_id: 'commit-approval', decision: 'approved', runtime_label: 'approval_chain' },
    artifactRefs: ['approvals/commit-approval.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.requested',
    payload: { approval_id: 'push-approval', action: 'push_deploy', runtime_label: 'approval_required' },
    artifactRefs: ['approvals/push-approval.json'],
  });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'approval.decided',
    payload: { approval_id: 'push-approval', decision: 'approved', runtime_label: 'approval_chain' },
    artifactRefs: ['approvals/push-approval.json'],
  });
  appendMemoryFact(agentDir, {
    layer: 'blackboard',
    key: 'm8',
    value: 'parallel note',
    run_id: runId,
    source_event_ids: [goal.event_id],
    artifact_refs: [],
  });
  appendMemoryFact(agentDir, {
    layer: 'sequential_handoff',
    key: 'm8',
    value: 'handoff note',
    run_id: runId,
    source_event_ids: [approvalRequested.event_id],
    artifact_refs: [],
  });
  appendMemoryFact(agentDir, {
    layer: 'module_learning',
    key: 'm8',
    value: 'codex full-target path',
    run_id: runId,
    source_event_ids: [goal.event_id],
    artifact_refs: [],
    outcome: 'success',
    modules: ['codex', 'full-target-gate'],
  });
  writeFullTargetGateArtifact({ root: dir, agentDir, runId });
  writeUiAgreementSmoke({ root: dir, agentDir, runId });
  const mismatchedActionArtifact = writeFullTargetGateArtifact({ root: dir, agentDir, runId, appendPassEvent: true });
  assert.equal(mismatchedActionArtifact.decision, 'FAIL');
  assert.ok(
    mismatchedActionArtifact.requirements.some((item) => item.name === 'approval top lane' && item.status === 'FAIL'),
  );
  appendRuntimeEvent(runDir, {
    runId,
    source: 'permission-broker',
    type: 'runtime.action.approved',
    payload: { approval_id: 'approval-shell', action: 'shell_mutation', runtime_label: 'approval_chain' },
    artifactRefs: ['approvals/approval-shell.json'],
  });
  const passArtifact = writeFullTargetGateArtifact({ root: dir, agentDir, runId, appendPassEvent: true });
  assert.equal(
    passArtifact.decision,
    'PASS',
    JSON.stringify(passArtifact.requirements.filter((item) => item.status === 'FAIL'), null, 2),
  );
  assert.equal(
    readRuntimeEvents(runDir).some((event) => event.type === 'gate.full_target.passed'),
    true,
  );
  const verified = verifyFullTargetGateArtifact({ agentDir, runId, appendVerifiedEvent: true });
  assert.equal(verified.decision, 'PASS');
  assert.equal(
    readRuntimeEvents(runDir).some((event) => event.type === 'gate.full_target.verified'),
    true,
  );
});

test('Phase 8: M8 boundary evidence fills approval and memory gaps while leaving lifecycle controls unproven', () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const task = addTask('m8 boundary evidence task', dir);
  const run = createRun(task.id, { executor: 'codex', source: 'web' }, dir);
  const runDir = join(agentDir, 'runs', run.id);
  writeFileSync(join(runDir, 'codex-launch-proof.json'), JSON.stringify({ schema_version: 1, status: 'supported' }));
  appendRuntimeEvent(runDir, {
    runId: run.id,
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'codex-session',
    payload: { adapter_kind: 'codex', runtime_label: 'codex_cli', evidence_status: 'supported' },
    artifactRefs: ['codex-launch-proof.json'],
  });
  writeFileSync(join(runDir, 'review.md'), '# Review\n\nPASS');
  appendRuntimeEvent(runDir, {
    runId: run.id,
    source: 'runtime-manager',
    type: 'run.completed',
    payload: { decision: 'pass', runtime_label: 'run_lifecycle' },
    artifactRefs: ['review.md'],
  });
  appendM8BoundaryEvidence({ root: dir, agentDir, runId: run.id });
  const artifact = writeFullTargetGateArtifact({ root: dir, agentDir, runId: run.id, appendPassEvent: true });
  const statusByName = new Map(artifact.requirements.map((item) => [item.name, item.status]));
  assert.equal(statusByName.get('web goal input'), 'PASS');
  assert.equal(statusByName.get('approval top lane'), 'PASS');
  assert.equal(statusByName.get('parallel blackboard'), 'PASS');
  assert.equal(statusByName.get('sequential handoff'), 'PASS');
  assert.equal(statusByName.get('learning memory'), 'PASS');
  assert.equal(statusByName.get('commit approval boundary'), 'PASS');
  assert.equal(statusByName.get('push deploy approval boundary'), 'PASS');
  assert.equal(statusByName.get('interrupt'), 'FAIL');
  assert.equal(statusByName.get('resume'), 'FAIL');
  assert.equal(statusByName.get('fork'), 'FAIL');
  assert.equal(
    readRuntimeEvents(runDir).some((event) => event.type === 'gate.full_target.passed'),
    false,
  );
});

test('Priority G010: Codex app-server bridge emits supported lifecycle events only from matching JSON-RPC responses', async () => {
  const dir = tempDir();
  const runDir = join(dir, '.agent', 'runs', 'run-bridge-proof');
  mkdirSync(runDir, { recursive: true });
  const calls: string[] = [];
  const transport: JsonRpcTransport = {
    async request(method, params) {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === 'thread/resume') return { thread: { id: 'thread-target' } };
      if (method === 'thread/fork') return { thread: { id: 'thread-forked', forkedFromId: 'thread-target' } };
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/read')
        return { thread: { id: 'thread-target', turns: [{ id: 'turn-target', status: 'interrupted' }] } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const bridge = new CodexAppServerJsonRpcBridge(transport);
  const target = {
    runId: 'run-bridge-proof',
    runDir,
    threadId: 'thread-target',
    sessionId: 'codex-session',
    turnId: 'turn-target',
  };
  assert.equal((await bridge.proveResume(target)).status, 'supported');
  assert.equal((await bridge.proveFork(target)).status, 'supported');
  assert.equal((await bridge.proveInterrupt(target)).status, 'supported');
  const events = readRuntimeEvents(runDir);
  assert.deepEqual(
    events.filter((event) => event.type === 'runtime.lifecycle.supported').map((event) => event.payload.verb),
    ['resume', 'fork', 'interrupt'],
  );
  assert.equal(
    calls.some((call) => call.startsWith('thread/resume:')),
    true,
  );
  assert.equal(existsSync(join(runDir, 'codex-app-server-resume-proof.json')), true);
  assert.equal(existsSync(join(runDir, 'codex-app-server-fork-proof.json')), true);
  assert.equal(existsSync(join(runDir, 'codex-app-server-interrupt-proof.json')), true);
});

test('Priority G010: Codex app-server bridge refuses malformed resume fork and missing interrupt target', async () => {
  const dir = tempDir();
  const runDir = join(dir, '.agent', 'runs', 'run-bridge-negative');
  mkdirSync(runDir, { recursive: true });
  const transport: JsonRpcTransport = {
    async request(method) {
      if (method === 'thread/resume') return { thread: { id: 'wrong-thread' } };
      if (method === 'thread/fork') return { thread: { id: 'thread-forked', forkedFromId: 'wrong-parent' } };
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/read')
        return { thread: { id: 'thread-target', turns: [{ id: 'turn-other', status: 'interrupted' }] } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const bridge = new CodexAppServerJsonRpcBridge(transport);
  const target = { runId: 'run-bridge-negative', runDir, threadId: 'thread-target', sessionId: 'codex-session' };
  assert.equal((await bridge.proveResume(target)).status, 'unproven');
  assert.equal((await bridge.proveFork(target)).status, 'unproven');
  assert.equal((await bridge.proveInterrupt(target)).status, 'unproven');
  assert.equal(
    readRuntimeEvents(runDir).some((event) => event.type === 'runtime.lifecycle.supported'),
    false,
  );
});

test('Priority G011: Codex lifecycle exercise initializes app-server then proves resume fork and interrupt on target run ledger', async () => {
  const dir = tempDir();
  const agentDir = join(dir, '.agent');
  const runId = 'run-g011-lifecycle';
  const runDir = join(agentDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  appendRuntimeEvent(runDir, {
    runId,
    source: 'codex-adapter',
    type: 'runtime.session.started',
    sessionId: 'codex-session',
    payload: { adapter_kind: 'codex', evidence_status: 'supported' },
    artifactRefs: ['codex-launch-proof.json'],
  });
  const calls: string[] = [];
  const transport: JsonRpcTransport = {
    async request(method, params) {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (method === 'initialize') return { userAgent: 'test' };
      if (method === 'thread/resume') return { thread: { id: 'thread-target' } };
      if (method === 'thread/fork') return { thread: { id: 'thread-forked', forkedFromId: 'thread-target' } };
      if (method === 'turn/start') return { turn: { id: 'turn-started', status: 'inProgress' } };
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/read')
        return { thread: { id: 'thread-forked', turns: [{ id: 'turn-started', status: 'interrupted' }] } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const report = await exerciseCodexAppServerLifecycle({
    root: dir,
    agentDir,
    runId,
    threadId: 'thread-target',
    transport,
    interruptDelayMs: 0,
  });
  assert.equal(report.decision, 'PASS');
  assert.deepEqual(
    report.results.map((result) => result.verb),
    ['resume', 'fork', 'interrupt'],
  );
  assert.equal(report.forked_thread_id, 'thread-forked');
  assert.equal(report.interrupt_turn_id, 'turn-started');
  assert.equal(calls[0].startsWith('initialize:'), true);
  const events = readRuntimeEvents(runDir).filter((event) => event.type === 'runtime.lifecycle.supported');
  assert.deepEqual(
    events.map((event) => event.payload.verb),
    ['resume', 'fork', 'interrupt'],
  );
  assert.equal(existsSync(join(runDir, 'codex-app-server-lifecycle-exercise-report.json')), true);
  assert.equal(existsSync(join(runDir, 'codex-app-server-turn-start-proof.json')), true);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendRuntimeEvent, readRuntimeEvents, validateRuntimeLedger } from '../events/ledger.js';
import { renderHtml, renderSkillRun } from '../view.js';
import { makeCliExecutor } from './compare.js';
import type { HarnessExecutor } from './harness-run.js';
import { runTaskGraph } from './orchestrator.js';
import {
  compileSkillToGraphTemplate,
  loadSkillSpecFromJson,
  materializeEvidenceInto,
  type ExecuteCandidate,
  listSkillRunSummaries,
  type OrchestratorSkillSpec,
  projectSkillRun,
  selectExecuteCandidateByAcceptance,
  recomputeCompletion,
  recomputeCompletionFromLedger,
  resolveEvidenceArtifact,
  runOrchestratorSkill,
  type SkillSpecJson,
  storePhaseArtifact,
} from './orchestrator-skill.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-skill-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fakeCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-orch-skill-codex-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const cwd = args.includes('-C') ? args[args.indexOf('-C') + 1] : process.cwd();
const prompt = args.at(-1) || '';
const m = prompt.match(/write ([\\w.-]+\\.txt)(?: CONTENT (.+))?/);
if (m) fs.writeFileSync(path.join(cwd, m[1]), (m[2] || ('work by ' + m[1])) + '\\n');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'x' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function codexResult(opts: { cwd: string; label?: string; lastMessage?: string }) {
  return {
    label: opts.label ?? 'fake',
    cwd: opts.cwd,
    command: 'fake executor',
    started_at: new Date(0).toISOString(),
    ended_at: new Date(0).toISOString(),
    exit_code: 0,
    signal: null,
    timed_out: false,
    cancelled: false,
    last_message: opts.lastMessage ?? 'done',
    event_count: 1,
    stdout: '',
    stderr: '',
  };
}

function handoffExecutor(options: { executeWrites: boolean }): HarnessExecutor {
  return async (opts) => {
    if (opts.prompt.includes('research')) {
      writeFileSync(join(opts.cwd, 'research.txt'), 'RESEARCH_OUTPUT');
    } else if (opts.prompt.includes('execute')) {
      const research = readFileSync(join(opts.cwd, 'research.txt'), 'utf8');
      if (options.executeWrites) writeFileSync(join(opts.cwd, 'execute.txt'), `${research}+EXECUTED`);
    } else if (opts.prompt.includes('review')) {
      writeFileSync(join(opts.cwd, 'review.txt'), 'REVIEW_OUTPUT');
    }
    return codexResult({ cwd: opts.cwd, label: opts.label });
  };
}

function addAcceptanceExecutor(options: { implementation: string }): HarnessExecutor {
  return async (opts) => {
    if (opts.prompt.includes('research')) {
      writeFileSync(join(opts.cwd, 'research.txt'), 'research\n');
    } else if (opts.prompt.includes('execute')) {
      writeFileSync(join(opts.cwd, 'add.mjs'), options.implementation);
    } else if (opts.prompt.includes('review')) {
      writeFileSync(join(opts.cwd, 'review.txt'), 'review\n');
    }
    return codexResult({ cwd: opts.cwd, label: opts.label });
  };
}

function addAcceptanceSpec(executor: HarnessExecutor): OrchestratorSkillSpec {
  return {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}', executor, acceptArtifact: 'research.txt' },
      execute: { goalTemplate: 'execute {what}', executor, acceptArtifact: 'add.mjs' },
      review: { goalTemplate: 'review {what}', executor, acceptArtifact: 'review.txt' },
    },
    acceptance: {
      command: ['node', 'accept.test.mjs'],
      testFiles: [
        {
          path: 'accept.test.mjs',
          content: `import { add } from './add.mjs';
if (add(1, 2) !== 3 || add(-4, 9) !== 5) process.exit(1);
`,
        },
      ],
    },
  };
}

test('loadSkillSpecFromJson resolves named executors and runs through fake phases', async () => {
  const root = tmpRepo();
  const executor = addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' });
  const executors = { codex: undefined, claude: executor, agy: executor };
  const json: SkillSpecJson = {
    id: 'json-skill',
    phases: {
      research: { executor: 'claude', goalTemplate: 'research {what}', acceptArtifact: 'research.txt' },
      execute: { executor: 'agy', goalTemplate: 'execute {what}', acceptArtifact: 'add.mjs' },
      review: { executor: 'claude', goalTemplate: 'review {what}', acceptArtifact: 'review.txt' },
    },
    acceptance: {
      command: ['node', 'accept.test.mjs'],
      testFiles: [
        {
          path: 'accept.test.mjs',
          content: `import { add } from './add.mjs';
if (add(1, 2) !== 3) process.exit(1);
`,
        },
      ],
    },
  };

  const spec = loadSkillSpecFromJson(json, executors);

  assert.equal(spec.id, 'json-skill');
  assert.equal(spec.phases.research.executor, executor);
  assert.equal(spec.phases.execute.executor, executor);
  assert.equal(spec.phases.review.executor, executor);
  assert.equal(spec.phases.execute.goalTemplate, 'execute {what}');
  assert.equal(spec.phases.execute.acceptArtifact, 'add.mjs');
  assert.deepEqual(spec.acceptance, json.acceptance);

  const report = await runOrchestratorSkill(spec, { what: 'json resolver work', root, runId: 'json-skill-run' });

  assert.deepEqual(
    report.phases.map((phase) => phase.phase),
    ['research', 'execute', 'review'],
  );
  assert.deepEqual(
    report.phases.map((phase) => phase.nodeState),
    ['supported', 'supported', 'supported'],
  );
  assert.equal(report.acceptance?.passed, true);
  assert.equal(report.completion, 'passed');
});

test('loadSkillSpecFromJson rejects unknown executor names', () => {
  const executor = addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' });
  const json: SkillSpecJson = {
    id: 'json-skill',
    phases: {
      research: { executor: 'codex', goalTemplate: 'research {what}' },
      execute: { executor: 'gpt', goalTemplate: 'execute {what}' },
      review: { executor: 'claude', goalTemplate: 'review {what}' },
    },
  };

  assert.throws(() => loadSkillSpecFromJson(json, { codex: undefined, claude: executor, agy: executor }), {
    message: 'unknown executor: gpt',
  });
});

test('storePhaseArtifact stores a sha256 verified round-trip artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-skill-evidence-'));
  const sourceFile = join(root, 'research-output.txt');
  const content = Buffer.from('evidence bytes\n', 'utf8');
  writeFileSync(sourceFile, content);

  const ref = storePhaseArtifact({ root, skillRunId: 'run-1', phase: 'research', sourceFile });
  const resolved = resolveEvidenceArtifact(ref);

  assert.equal(ref.phase, 'research');
  assert.equal(ref.relativePath, 'research-output.txt');
  assert.equal(ref.sha256, sha256Hex(content));
  assert.equal(existsSync(ref.storePath), true);
  assert.equal(resolved.verified, true);
  assert.deepEqual(resolved.content, content);
});

test('evidence artifact verification detects tampered stored bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-skill-evidence-'));
  const sourceFile = join(root, 'execute-output.txt');
  writeFileSync(sourceFile, 'original evidence\n');
  const ref = storePhaseArtifact({ root, skillRunId: 'run-2', phase: 'execute', sourceFile });

  writeFileSync(ref.storePath, 'tampered evidence\n');
  const resolved = resolveEvidenceArtifact(ref);

  assert.equal(resolved.verified, false);
  assert.throws(() => materializeEvidenceInto(ref, mkdtempSync(join(tmpdir(), 'orchestrator-skill-materialize-'))), {
    message: /sha.*mismatch|tamper/i,
  });
});

test('materializeEvidenceInto writes verified evidence to the requested relative path', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-skill-evidence-'));
  const sourceFile = join(root, 'review-output.txt');
  const content = 'review evidence\n';
  writeFileSync(sourceFile, content);
  const ref = storePhaseArtifact({
    root,
    skillRunId: 'run-3',
    phase: 'review',
    sourceFile,
    relativePath: 'handoff/review-output.txt',
  });
  const destDir = mkdtempSync(join(tmpdir(), 'orchestrator-skill-materialize-'));

  const destPath = materializeEvidenceInto(ref, destDir);

  assert.equal(destPath, join(destDir, ref.relativePath));
  assert.equal(existsSync(destPath), true);
  assert.equal(readFileSync(destPath, 'utf8'), content);
});

test('compileSkillToGraphTemplate emits the fixed research execute review graph', () => {
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}', executor },
      execute: { goalTemplate: 'execute {what} then {what}', executor },
      review: { goalTemplate: 'review {what}', executor },
    },
  };

  const nodes = compileSkillToGraphTemplate(spec, { what: 'M12 compiler' });

  assert.deepEqual(
    nodes.map((n) => n.id),
    ['research', 'execute', 'review'],
  );
  assert.deepEqual(
    nodes.map((n) => n.deps),
    [[], ['research'], ['execute']],
  );
  assert.deepEqual(
    nodes.map((n) => n.goal),
    ['research M12 compiler', 'execute M12 compiler then M12 compiler', 'review M12 compiler'],
  );
  assert.deepEqual(
    nodes.map((n) => n.accept),
    [undefined, undefined, undefined],
  );
  assert.equal(
    nodes.every((n) => n.executor === executor),
    true,
  );
});

test('compiled graph runs all three phases in dependency order when each phase changes files', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const nodes = compileSkillToGraphTemplate(
    {
      id: 'research-execute-review',
      phases: {
        research: { goalTemplate: 'research {what}: write research.txt', executor },
        execute: { goalTemplate: 'execute {what}: write execute.txt', executor },
        review: { goalTemplate: 'review {what}: write review.txt', executor },
      },
    },
    { what: 'phase-gated work' },
  );

  const report = await runTaskGraph({ root, nodes, concurrency: 2 });

  assert.deepEqual(
    report.nodes.map((n) => n.workerId),
    ['research', 'execute', 'review'],
  );
  assert.deepEqual(
    report.nodes.map((n) => n.nodeState),
    ['supported', 'supported', 'supported'],
  );
  assert.equal(report.supportedCount, 3);
  assert.equal(report.waves, 3);
  for (const node of report.nodes) {
    assert.equal(existsSync(join(node.worktreePath, `${node.workerId}.txt`)), true);
  }
});

test('compiled graph skips review when execute makes no observable change', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const nodes = compileSkillToGraphTemplate(
    {
      id: 'research-execute-review',
      phases: {
        research: { goalTemplate: 'research {what}: write research.txt', executor },
        execute: { goalTemplate: 'execute {what} without observable file changes', executor },
        review: { goalTemplate: 'review {what}: write review.txt', executor },
      },
    },
    { what: 'unsupported execution' },
  );

  const report = await runTaskGraph({ root, nodes, concurrency: 2 });
  const research = report.nodes.find((n) => n.workerId === 'research');
  const execute = report.nodes.find((n) => n.workerId === 'execute');
  const review = report.nodes.find((n) => n.workerId === 'review');

  assert.equal(research?.nodeState, 'supported');
  assert.equal(execute?.nodeState, 'blocked');
  assert.equal(review?.nodeState, 'skipped');
  assert.match(review?.skippedReason ?? '', /unsupported deps: execute/);
  assert.equal(review?.worktreePath ? existsSync(review.worktreePath) : true, false);
});

test('runOrchestratorSkill returns refs-only phase report when all phases are supported', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}: write research.txt', executor },
      execute: { goalTemplate: 'execute {what}: write execute.txt', executor },
      review: { goalTemplate: 'review {what}: write review.txt', executor },
    },
  };

  const report = await runOrchestratorSkill(spec, { what: 'refs only work', root, runId: 'graph-skill-happy' });

  assert.equal(report.schema_version, 1);
  assert.equal(report.skillId, spec.id);
  assert.equal(report.runId, 'graph-skill-happy');
  assert.equal(report.what, 'refs only work');
  assert.deepEqual(
    report.phases.map((p) => p.phase),
    ['research', 'execute', 'review'],
  );
  assert.deepEqual(
    report.phases.map((p) => p.nodeState),
    ['supported', 'supported', 'supported'],
  );
  assert.equal(report.completionDisplay, 'supported');
  assert.equal(typeof report.ledgerHead.run_id, 'string');
  assert.equal(report.ledgerHead.event_count > 0, true);

  for (const phase of report.phases) {
    assert.equal(typeof phase.outputRef, 'string');
    assert.deepEqual(Object.keys(phase), ['phase', 'workerId', 'nodeState', 'outputRef', 'skippedReason']);
  }
});

test('runOrchestratorSkill passes accepted artifacts between phases through inputRefs', async () => {
  const root = tmpRepo();
  const runId = 'skill-handoff';
  const executor = handoffExecutor({ executeWrites: true });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}', executor, acceptArtifact: 'research.txt' },
      execute: { goalTemplate: 'execute {what}', executor, acceptArtifact: 'execute.txt' },
      review: { goalTemplate: 'review {what}', executor, acceptArtifact: 'review.txt' },
    },
  };

  const report = await runOrchestratorSkill(spec, { what: 'handoff work', root, runId });

  assert.equal(report.completionDisplay, 'supported');
  assert.deepEqual(
    report.phases.map((phase) => phase.nodeState),
    ['supported', 'supported', 'supported'],
  );
  assert.match(
    readFileSync(join(root, '.agent', 'skill-runs', runId, 'artifacts', 'execute', 'execute.txt'), 'utf8'),
    /RESEARCH_OUTPUT/,
  );
});

test('runOrchestratorSkill passes declared acceptance against clean execute evidence', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));

  const report = await runOrchestratorSkill(spec, { what: 'accepted add work', root, runId: 'skill-acceptance-pass' });
  const recomputed = recomputeCompletion(spec, report, { root });

  assert.equal(report.phases.find((phase) => phase.phase === 'execute')?.nodeState, 'supported');
  assert.equal(report.acceptance?.ran, true);
  assert.equal(report.acceptance?.passed, true);
  assert.equal(report.acceptance?.exitCode, 0);
  assert.equal(report.acceptance?.command.join(' '), 'node accept.test.mjs');
  assert.equal(typeof report.acceptance?.outputSha256, 'string');
  assert.equal(report.completion, 'passed');
  assert.equal(recomputed.completion, 'passed');
  assert.equal(recomputed.matchesReport, true);
});

test('runOrchestratorSkill fails completion when clean acceptance rejects forged execute evidence', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a-b}\n' }));

  const report = await runOrchestratorSkill(spec, { what: 'forged add work', root, runId: 'skill-acceptance-fail' });

  assert.equal(report.phases.find((phase) => phase.phase === 'execute')?.nodeState, 'supported');
  assert.equal(report.phases.find((phase) => phase.phase === 'review')?.nodeState, 'supported');
  assert.equal(report.acceptance?.ran, true);
  assert.equal(report.acceptance?.passed, false);
  assert.equal(report.acceptance?.exitCode, 1);
  assert.equal(report.completion, 'failed');
  assert.equal(report.completionDisplay, 'supported');

  report.completion = 'passed';
  const recomputed = recomputeCompletion(spec, report, { root });

  assert.equal(recomputed.completion, 'failed');
  assert.equal(recomputed.matchesReport, false);
});

test('runOrchestratorSkill gates review when execute does not produce its accepted artifact', async () => {
  const root = tmpRepo();
  const executor = handoffExecutor({ executeWrites: false });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}', executor, acceptArtifact: 'research.txt' },
      execute: { goalTemplate: 'execute {what}', executor, acceptArtifact: 'execute.txt' },
      review: { goalTemplate: 'review {what}', executor, acceptArtifact: 'review.txt' },
    },
  };

  const report = await runOrchestratorSkill(spec, { what: 'blocked handoff work', root, runId: 'skill-handoff-gated' });

  assert.notEqual(report.completionDisplay, 'supported');
  assert.deepEqual(
    report.phases.map((phase) => phase.nodeState),
    ['supported', 'blocked', 'skipped'],
  );
  assert.match(
    report.phases.find((phase) => phase.phase === 'review')?.skippedReason ?? '',
    /unsupported deps: execute/,
  );
});

test('runOrchestratorSkill mirrors skipped review when execute is blocked', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}: write research.txt', executor },
      execute: { goalTemplate: 'execute {what} without observable file changes', executor },
      review: { goalTemplate: 'review {what}: write review.txt', executor },
    },
  };

  const report = await runOrchestratorSkill(spec, { what: 'phase-gated work', root, runId: 'graph-skill-gated' });

  assert.equal(report.completionDisplay, 'skipped');
  assert.notEqual(report.completionDisplay, 'supported');
  assert.deepEqual(
    report.phases.map((p) => p.phase),
    ['research', 'execute', 'review'],
  );
  assert.deepEqual(
    report.phases.map((p) => p.nodeState),
    ['supported', 'blocked', 'skipped'],
  );
  assert.match(report.phases.find((p) => p.phase === 'review')?.skippedReason ?? '', /unsupported deps: execute/);
});

test('runOrchestratorSkill emits a chained lifecycle projection with no decision field', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));
  const runId = 'skill-lifecycle';

  await runOrchestratorSkill(spec, { what: 'lifecycle work', root, runId });
  const events = readRuntimeEvents(join(root, '.agent', 'skill-runs', runId));

  validateRuntimeLedger(events); // contiguous + hash-chained
  assert.deepEqual(
    events.map((event) => event.type),
    ['skill.started', 'phase.advanced', 'phase.advanced', 'phase.advanced', 'skill.completed'],
  );

  const completed = events.at(-1);
  assert.deepEqual(Object.keys(completed?.payload ?? {}).sort(), [
    'finalNodeId',
    'ledgerHeadBeforeEvent',
    'verifierVerdictRef',
  ]);
  assert.equal(completed?.payload.finalNodeId, 'review');
  // The projection must never carry a verdict an intermediary could trust.
  assert.equal('decision' in (completed?.payload ?? {}), false);
  assert.equal('completion' in (completed?.payload ?? {}), false);
});

test('a forged skill.completed decision cannot override the ledger recompute', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a-b}\n' }));
  const runId = 'skill-forged-completed';

  const report = await runOrchestratorSkill(spec, { what: 'forged add', root, runId });
  assert.equal(report.completion, 'failed');

  // A forger appends a well-formed, correctly-chained skill.completed claiming success.
  const dir = join(root, '.agent', 'skill-runs', runId);
  appendRuntimeEvent(dir, {
    runId,
    source: 'harness',
    type: 'skill.completed',
    payload: { finalNodeId: 'review', decision: 'supported', completion: 'passed' },
  });
  validateRuntimeLedger(readRuntimeEvents(dir)); // the forgery is a "legal" append; chain stays valid

  // Authority is the evidence-anchored recompute, which never reads skill.completed.
  assert.equal(recomputeCompletionFromLedger(spec, { root, runId }).completion, 'failed');
});

test('ledger recompute is evidence-anchored and invariant to the lifecycle projection', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));
  const runId = 'skill-evidence-anchored';

  await runOrchestratorSkill(spec, { what: 'anchored add', root, runId });
  assert.equal(recomputeCompletionFromLedger(spec, { root, runId }).completion, 'passed');

  // Drop the entire lifecycle ledger; the verdict comes from execute evidence, not events.
  writeFileSync(join(root, '.agent', 'skill-runs', runId, 'events.jsonl'), '');
  assert.equal(recomputeCompletionFromLedger(spec, { root, runId }).completion, 'passed');
});

test('ledger recompute fails closed on a tampered lifecycle chain', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));
  const runId = 'skill-tampered-chain';

  await runOrchestratorSkill(spec, { what: 'tamper add', root, runId });

  const ledgerPath = join(root, '.agent', 'skill-runs', runId, 'events.jsonl');
  const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const middle = JSON.parse(lines[1]) as { payload: Record<string, unknown> };
  middle.payload.nodeState = 'tampered'; // mutate payload, leave stale payload_sha256
  lines[1] = JSON.stringify(middle);
  writeFileSync(ledgerPath, `${lines.join('\n')}\n`);

  assert.throws(() => recomputeCompletionFromLedger(spec, { root, runId }), /payload hash mismatch|hash chain|sequence/i);
});

test('skill re-runs do not collide on fixed worktree names and clean up after themselves', async () => {
  const root = tmpRepo();
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const spec: OrchestratorSkillSpec = {
    id: 'research-execute-review',
    phases: {
      research: { goalTemplate: 'research {what}: write research.txt', executor },
      execute: { goalTemplate: 'execute {what}: write execute.txt', executor },
      review: { goalTemplate: 'review {what}: write review.txt', executor },
    },
  };

  const first = await runOrchestratorSkill(spec, { what: 'rerun A', root, runId: 'rerun-A' });
  // Second run with NO manual cleanup between — would collide on wt/<phase> before the fix.
  const second = await runOrchestratorSkill(spec, { what: 'rerun B', root, runId: 'rerun-B' });

  for (const report of [first, second]) {
    assert.deepEqual(
      report.phases.map((phase) => phase.nodeState),
      ['supported', 'supported', 'supported'],
    );
  }
  // Per-run worktrees are removed after each run, so none linger to collide with later runs.
  const worktreesDir = join(root, '.agent', 'worktrees');
  assert.equal(existsSync(worktreesDir) ? readdirSync(worktreesDir).length : 0, 0);
});

test('projectSkillRun reports authoritative pass with no contradiction on an honest green run', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));
  const runId = 'skill-projection-pass';

  await runOrchestratorSkill(spec, { what: 'projection pass', root, runId });
  const projection = projectSkillRun({ root, runId });

  assert.equal(projection.skillId, spec.id);
  assert.equal(projection.ledgerValid, true);
  assert.equal(projection.phases.length, 3);
  assert.equal(projection.reportCompletion, 'passed');
  assert.equal(projection.authoritativeCompletion, 'passed');
  assert.equal(projection.contradiction, false);
});

test('projectSkillRun flags a tampered report (UI cannot show green when the gate is red)', async () => {
  const root = tmpRepo();
  // forged execute (a-b) → clean acceptance fails → honest completion is "failed"
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a-b}\n' }));
  const runId = 'skill-projection-tamper';

  await runOrchestratorSkill(spec, { what: 'projection tamper', root, runId });
  const honest = projectSkillRun({ root, runId });
  assert.equal(honest.authoritativeCompletion, 'failed');
  assert.equal(honest.contradiction, false); // stored report already says failed — agrees

  // Tamper the operator-facing report on disk to claim success.
  const reportPath = join(root, '.agent', 'skill-runs', runId, 'skill-run-report.json');
  const stored = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  stored.completion = 'passed';
  stored.completionDisplay = 'supported';
  writeFileSync(reportPath, JSON.stringify(stored, null, 2));

  const projected = projectSkillRun({ root, runId });
  assert.equal(projected.authoritativeCompletion, 'failed'); // recompute ignores the tampered field
  assert.equal(projected.contradiction, true);
});

test('renderSkillRun surfaces authoritative completion and a contradiction panel on a tampered report', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a-b}\n' }));
  const runId = 'skill-render-tamper';

  await runOrchestratorSkill(spec, { what: 'render tamper', root, runId });

  const honestHtml = renderSkillRun(runId, root);
  assert.match(honestHtml, /Authoritative completion/);
  assert.doesNotMatch(honestHtml, /CONTRADICTION/);

  const reportPath = join(root, '.agent', 'skill-runs', runId, 'skill-run-report.json');
  const stored = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
  stored.completion = 'passed';
  writeFileSync(reportPath, JSON.stringify(stored, null, 2));

  const tamperedHtml = renderSkillRun(runId, root);
  assert.match(tamperedHtml, /CONTRADICTION/);
  // The surface shows the authoritative failed verdict, never the tampered green.
  assert.match(tamperedHtml, /Completion: <strong class="warning">failed/);
});

test('listSkillRunSummaries and the home page surface skill runs for discovery', async () => {
  const root = tmpRepo();
  const spec = addAcceptanceSpec(addAcceptanceExecutor({ implementation: 'export function add(a,b){return a+b}\n' }));
  await runOrchestratorSkill(spec, { what: 'discovery work', root, runId: 'skill-discovery' });

  const summaries = listSkillRunSummaries(root);
  assert.equal(
    summaries.some((s) => s.runId === 'skill-discovery' && s.skillId === spec.id),
    true,
  );

  const home = renderHtml(root);
  assert.match(home, /Skill runs \(orchestrator-as-skill\)/);
  assert.match(home, /\/skill\/skill-discovery/);
});

const candidateAcceptance = {
  command: ['node', 'accept.test.mjs'],
  testFiles: [
    {
      path: 'accept.test.mjs',
      content: `import { add } from './add.mjs';
if (add(1, 2) !== 3) process.exit(1);
`,
    },
  ],
};

function makeCandidate(label: string, addBody: string): ExecuteCandidate {
  const dir = mkdtempSync(join(tmpdir(), `cand-${label}-`));
  const storePath = join(dir, 'add.mjs');
  writeFileSync(storePath, addBody);
  return { label, executeRefs: [{ phase: 'execute', relativePath: 'add.mjs', sha256: sha256Hex(addBody), storePath }] };
}

test('selectExecuteCandidateByAcceptance picks the winner by acceptance, not order or rank', () => {
  const forged = makeCandidate('codex-forged', 'export function add(a,b){return a-b}\n');
  const correct = makeCandidate('claude-correct', 'export function add(a,b){return a+b}\n');

  // The CORRECT candidate is listed LAST — proving selection is by recomputable acceptance,
  // not by order, model rank, or self-claim.
  const selection = selectExecuteCandidateByAcceptance({ candidates: [forged, correct], acceptance: candidateAcceptance });

  assert.equal(selection.winner, 'claude-correct');
  assert.equal(selection.results.find((r) => r.label === 'codex-forged')?.passed, false);
  assert.equal(selection.results.find((r) => r.label === 'claude-correct')?.passed, true);
});

test('selectExecuteCandidateByAcceptance returns no winner when no candidate passes acceptance', () => {
  const sub = makeCandidate('a', 'export function add(a,b){return a-b}\n');
  const mul = makeCandidate('b', 'export function add(a,b){return a*b}\n');

  const selection = selectExecuteCandidateByAcceptance({ candidates: [sub, mul], acceptance: candidateAcceptance });

  assert.equal(selection.winner, null);
  assert.equal(
    selection.results.every((r) => !r.passed),
    true,
  );
});

function briefExecutor(briefContent: string): HarnessExecutor {
  return async (opts) => {
    if (opts.prompt.includes('Research')) {
      writeFileSync(join(opts.cwd, 'notes.md'), '# notes\n');
    } else if (opts.prompt.includes('structured research brief')) {
      writeFileSync(join(opts.cwd, 'brief.json'), briefContent);
    } else if (opts.prompt.includes('Review')) {
      writeFileSync(join(opts.cwd, 'review.md'), 'reviewed\n');
    }
    return codexResult({ cwd: opts.cwd, label: opts.label });
  };
}

function loadResearchBriefFixture(executor: HarnessExecutor): OrchestratorSkillSpec {
  const json = JSON.parse(
    readFileSync(join(process.cwd(), 'fixtures', 'skills', 'research-brief.json'), 'utf8'),
  ) as SkillSpecJson;
  return loadSkillSpecFromJson(json, { codex: executor, claude: executor, agy: executor });
}

test('research-brief.json fixture accepts a well-sourced structured brief', async () => {
  const root = tmpRepo();
  const brief = JSON.stringify({
    findings: [{ claim: 'native executor owns the loop', source_event_id: 'evt-123' }],
    sources: ['README.md'],
  });
  const spec = loadResearchBriefFixture(briefExecutor(brief));

  const report = await runOrchestratorSkill(spec, { what: 'harness thesis', root, runId: 'brief-good' });

  assert.equal(report.acceptance?.passed, true);
  assert.equal(report.completion, 'passed');
  assert.equal(recomputeCompletionFromLedger(spec, { root, runId: 'brief-good' }).completion, 'passed');
});

test('research-brief.json fixture rejects a non-empty but unsourced brief (no laundering)', async () => {
  const root = tmpRepo();
  // Plausible-looking, non-empty prose — but no source_event_id on any claim.
  const forged = JSON.stringify({
    findings: [{ claim: 'everything looks great and is definitely done' }],
    sources: ['README.md'],
  });
  const spec = loadResearchBriefFixture(briefExecutor(forged));

  const report = await runOrchestratorSkill(spec, { what: 'harness thesis', root, runId: 'brief-forged' });

  // execute/review nodes can be "supported" (a file was written) yet completion is failed:
  // the schema validator re-run over execute evidence rejects the unsourced brief.
  assert.equal(report.phases.find((phase) => phase.phase === 'execute')?.nodeState, 'supported');
  assert.equal(report.acceptance?.passed, false);
  assert.equal(report.completion, 'failed');
  assert.equal(recomputeCompletionFromLedger(spec, { root, runId: 'brief-forged' }).completion, 'failed');
});

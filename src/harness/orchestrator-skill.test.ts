import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeCliExecutor } from './compare.js';
import { runTaskGraph } from './orchestrator.js';
import {
  compileSkillToGraphTemplate,
  materializeEvidenceInto,
  type OrchestratorSkillSpec,
  resolveEvidenceArtifact,
  runOrchestratorSkill,
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
  assert.equal(report.ledgerHead.run_id, 'graph-skill-happy');

  for (const phase of report.phases) {
    assert.equal(typeof phase.outputRef, 'string');
    assert.deepEqual(Object.keys(phase), ['phase', 'workerId', 'nodeState', 'outputRef', 'skippedReason']);
  }
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

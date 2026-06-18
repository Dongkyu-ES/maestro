import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { makeCliExecutor } from './compare.js';
import { runTaskGraph } from './orchestrator.js';
import { compileSkillToGraphTemplate, type OrchestratorSkillSpec } from './orchestrator-skill.js';

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

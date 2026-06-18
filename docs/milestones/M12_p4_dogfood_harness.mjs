#!/usr/bin/env node
// P4 LIVE dogfood: drive runOrchestratorSkill end-to-end with REAL heterogeneous executors
// (codex research -> codex execute -> claude review), isolated worktrees, content-addressed
// cross-phase handoff. Prove a real research->execute->review skill runs, supervised.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'm12-p4-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# m12 p4 fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function main() {
  const skill = await import(pathToFileURL(join(REPO, 'dist', 'harness', 'orchestrator-skill.js')).href);
  const { makeCliExecutor } = await import(pathToFileURL(join(REPO, 'dist', 'harness', 'compare.js')).href);

  const codex = makeCliExecutor({ name: 'codex', bin: 'codex', buildArgs: (p, cwd) => ['exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, p] });
  const claude = makeCliExecutor({ name: 'claude', bin: 'claude', buildArgs: (p) => ['-p', p, '--permission-mode', 'acceptEdits'] });

  const spec = {
    id: 'feature-builder',
    phases: {
      research: {
        executor: codex,
        acceptArtifact: 'research.md',
        goalTemplate:
          'You are the RESEARCH phase. Task: {what}. Write a file named research.md in the repo root containing: a one-paragraph spec for the function, its exact signature, and 3 example input/output pairs. Write ONLY research.md.',
      },
      execute: {
        executor: codex,
        acceptArtifact: 'add.mjs',
        goalTemplate:
          'You are the EXECUTE phase. Task: {what}. A file research.md is already present in your working directory — read it and follow its spec exactly. Write a file named add.mjs that implements and `export`s the function described in research.md. Write ONLY add.mjs.',
      },
      review: {
        executor: claude,
        acceptArtifact: 'review.md',
        goalTemplate:
          'You are the REVIEW phase. Task: {what}. Files research.md and add.mjs are present in your working directory. Read both and write review.md stating, for each of the 3 examples in research.md, whether add.mjs would produce the expected output (PASS/FAIL each), and a final VERDICT line. Write ONLY review.md.',
      },
    },
  };

  const root = seed();
  const runId = 'p4-live';
  console.log(`seed repo: ${root}\nrunId: ${runId}\n`);
  const t0 = Date.now();
  const report = await skill.runOrchestratorSkill(spec, {
    what: 'a pure function add(a, b) that returns the sum of two numbers',
    root,
    runId,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`# M12 P4 live dogfood — elapsed ${secs}s\n`);
  console.log('| phase | nodeState | outputRef |');
  console.log('| --- | --- | --- |');
  for (const p of report.phases) console.log(`| ${p.phase} | ${p.nodeState} | ${(p.outputRef ?? '-').slice(0, 46)} |`);
  console.log(`\ncompletionDisplay (NON-authoritative): ${report.completionDisplay}`);
  console.log(`ledgerHead: ${JSON.stringify(report.ledgerHead)}`);

  const artDir = join(root, '.agent', 'skill-runs', runId, 'artifacts');
  for (const phase of ['research', 'execute', 'review']) {
    const dir = join(artDir, phase);
    console.log(`\n================ stored ${phase} artifact ================`);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        console.log(`--- ${phase}/${f} ---`);
        console.log(readFileSync(join(dir, f), 'utf8').trim().slice(0, 1400));
      }
    } else console.log('(no stored artifact — phase not supported)');
  }
}

main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

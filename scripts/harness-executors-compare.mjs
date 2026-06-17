#!/usr/bin/env node
// LIVE executor comparison: for each real agent CLI (claude -p, codex exec, agy -p) run
// the SAME task twice — once raw (CLI alone) and once through DH (harness slice: ledger +
// verifier + redaction) driving the SAME CLI. The only variable within each pair is the
// evidence layer, so model + reasoning are held constant per pair.
//
//   npm run build && node scripts/harness-executors-compare.mjs [--only claude,codex,agy]
//
// Makes real, billable model calls. Each lane runs in its own fresh git repo.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GOAL =
  'In this repository, create a file named calc.js using CommonJS that exports exactly two functions: ' +
  'add(a, b) returning a + b, and mul(a, b) returning a * b. Add nothing else.';
const TIMEOUT_MS = 240000;

const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const ONLY = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null;

function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'exec-compare-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

async function loadCompare() {
  return import(pathToFileURL(join(process.cwd(), 'dist', 'harness', 'compare.js')).href);
}

// name -> { rawArgs, dhExecutorFactory|null (null = codex native) }
function specs(mod) {
  return {
    claude: {
      bin: 'claude',
      rawArgs: ['-p', GOAL, '--permission-mode', 'acceptEdits'],
      dhExecutor: mod.makeCliExecutor({
        name: 'claude',
        bin: 'claude',
        buildArgs: (p) => ['-p', p, '--permission-mode', 'acceptEdits'],
      }),
    },
    codex: {
      bin: 'codex',
      rawArgs: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', GOAL],
      dhExecutor: undefined, // native runCodexExec
    },
    agy: {
      bin: 'agy',
      rawArgs: ['-p', GOAL, '--dangerously-skip-permissions'],
      dhExecutor: mod.makeCliExecutor({
        name: 'agy',
        bin: 'agy',
        buildArgs: (p) => ['-p', p, '--dangerously-skip-permissions'],
      }),
    },
  };
}

async function main() {
  const mod = await loadCompare();
  const all = specs(mod);
  const names = Object.keys(all).filter((n) => !ONLY || ONLY.has(n));
  const lanes = [];

  for (const name of names) {
    const spec = all[name];
    console.error(`\n=== ${name}: raw lane ===`);
    const rawRepo = freshRepo();
    const raw = await mod.runRawCliLane({ root: rawRepo, laneName: `${name}-raw`, bin: spec.bin, args: spec.rawArgs, timeoutMs: TIMEOUT_MS });
    lanes.push(raw);
    console.error(`  changed=${JSON.stringify(raw.metrics.leakedArtifacts.length === 0 ? 'ok' : 'leak')} state=${raw.metrics.state}`);

    console.error(`=== ${name}: dh lane ===`);
    const dhRepo = freshRepo();
    const dh = await mod.runDhSliceLane({ root: dhRepo, laneName: `${name}-dh`, goal: GOAL, executor: spec.dhExecutor, timeoutMs: TIMEOUT_MS });
    lanes.push(dh);
    console.error(`  verifier=${dh.metrics.verifierStatus} state=${dh.metrics.state}`);
  }

  const report = { schema_version: 1, goal: GOAL, generated_at: new Date().toISOString(), lanes };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'reports', 'harness-executors', stamp);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`);
  const md = mod.renderComparisonMarkdown(report);
  writeFileSync(join(outDir, 'comparison.md'), md);
  console.log(`\n${md}`);
  console.log(`\nwrote ${join('reports', 'harness-executors', stamp)}/comparison.{json,md}`);
}

main().catch((err) => {
  console.error(`error: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});

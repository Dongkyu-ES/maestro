#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 4 (magic run: inject-then-run + beforeExecute hook).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice4-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['magic-run.ts', 'magic-run.test.ts', 'inject.ts', 'inject-ledger.ts']) {
    copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  }
  // The beforeExecute hook (the only hot-path change) lives in orchestrator.ts — provide the diff.
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['show', '7f53120'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.patch'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice4 code'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE. The one hot-path change is an OPT-IN `beforeExecute` hook on runWorkerSlice/runIsolatedWorker (see DIFF.patch for orchestrator.ts). (1) Does the hook fire at the right point — AFTER evidence materialization and BEFORE the executor — and is it a strict no-op when undefined (zero behavior change for existing fan-out/skill callers)? (2) In magic-run.ts, does runMagicInjectionRun inject via beforeExecute so the executor genuinely runs with the .mcp.json present, then post-exec verify + record composition.injected + clean up? (3) Any failure mode where the hook throwing breaks an existing caller? Cite file:line.',
  claude:
    'ANTI-SELF-DECEPTION. (1) Can magic-run let injection reach a COMPLETION verdict (must not)? (2) Is consumptionProven still NEVER asserted (no live smokeProbe)? (3) Does the new shared-path beforeExecute hook open any seam where injected content could influence the run\'s verifier/acceptance verdict rather than just the executor\'s available tools? (4) Is the composition.injected record recomputable (not self-reported)? Name any laundering seam file:line.',
  agy:
    'SCOPE & TESTS. (1) Is beforeExecute truly opt-in/no-op by default (existing callers unchanged)? (2) Did instruction kinds (CLAUDE.md/soul) or a live smokeProbe sneak in (both deferred)? (3) Is the worktree cleanup correct (no leak, no failing the run)? (4) Is the key test honest — does the fake executor really prove injection-BEFORE-execution by reading its own cwd at run time? (5) Untested branch? Recommend the single highest-value missing test.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commit 7f53120; full diff in DIFF.patch). Warden Magic slice 4 adds \`warden magic run\` (inject-then-run) via an opt-in beforeExecute hook. Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code. Assume the author is overconfident.`;

async function main() {
  const orch = await import(pathToFileURL(join(REPO, 'dist', 'harness', 'orchestrator.js')).href);
  const { makeCliExecutor } = await import(pathToFileURL(join(REPO, 'dist', 'harness', 'compare.js')).href);
  const executors = {
    codex: makeCliExecutor({ name: 'codex', bin: 'codex', buildArgs: (p, cwd) => ['exec', '--json', '--sandbox', 'workspace-write', '-C', cwd, p] }),
    claude: makeCliExecutor({ name: 'claude', bin: 'claude', buildArgs: (p) => ['-p', p, '--permission-mode', 'acceptEdits'] }),
    agy: makeCliExecutor({ name: 'agy', bin: 'agy', buildArgs: (p) => ['-p', p, '--dangerously-skip-permissions'] }),
  };
  const root = seed();
  console.log(`seed repo: ${root}`);
  const t0 = Date.now();
  const report = await orch.runParallelWorkers({
    root, goal: 'verification panel on Warden Magic slice 4', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-4 impl verification panel — elapsed ${secs}s\n`);
  console.log('| reviewer | state | verifier | evidence ref |');
  console.log('| --- | --- | --- | --- |');
  for (const w of report.workers) console.log(`| ${w.workerId} | ${w.state} | ${w.verifierStatus ?? '-'} | ${(w.outputRef ?? '-').slice(0, 52)} |`);
  console.log(`\nsupported: ${report.supportedCount}/${report.workers.length}`);
  for (const w of report.workers) {
    const name = w.workerId.replace('verify-', '');
    const p = w.worktreePath ? join(w.worktreePath, `verify-${name}.md`) : null;
    console.log(`\n================ ${w.workerId} (${w.state}/${w.verifierStatus}) ================`);
    if (p && existsSync(p)) console.log(readFileSync(p, 'utf8').trim());
    else console.log(`(no verify-${name}.md at ${w.worktreePath})`);
  }
}
main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

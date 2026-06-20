#!/usr/bin/env node
// Design critic panel on Warden Magic slice 7 (instruction-kind injection + skill-run wiring).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice7-design-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  copyFileSync(`${DOCS}/WARDEN_MAGIC_slice7_DESIGN.md`, join(root, 'DESIGN.md'));
  copyFileSync(`${DOCS}/HARNESS_OS_CORRECTED_PLAN.md`, join(root, 'CORRECTED_PLAN.md'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice7 design'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'FEASIBILITY & MECHANISM. (1) Item B wires injection into runOrchestratorSkill\'s execute phase via the slice-4 beforeExecute hook and emits composition.injected into skillRunDir — is that mechanically sound, and does it truly leave recomputeCompletionFromLedger UNCHANGED (injection events never read by the recompute)? (2) Item A merges into CLAUDE.md/AGENTS.md — is the MERGE + backup + base/injected hash recording well-defined and tamper-evident? (3) What breaks FIRST implementing instruction kinds in inject.ts + the skill wiring? (4) Is "single-executor execute path first, fan-out deferred" a clean cut?',
  claude:
    'ANTI-SELF-DECEPTION — THE decisive lens for this slice. Instruction injection is a teaching-to-the-test channel. The design\'s load-bearing claim is "instruction injection CANNOT advance completion because completion stays recomputeCompletionFromLedger over operator-PINNED acceptance testFiles." ATTACK THIS: (1) Is that actually true for EVERY acceptance type, or only `test` with pinned testFiles? What about `artifact`/`diff`/`ledger`/`review_custody` acceptance — can an injected instruction satisfy those trivially (e.g. "create file X" when acceptance is artifact-exists)? (2) In Item B, does any injected instruction reach the REVIEW node or the verifier rather than only the execute executor? (3) Is approval-gating a real mechanical gate or prose? (4) Is the "operator responsibility" residual an honest boundary or a cop-out that licenses a weak gate? Name the exact condition under which an injected instruction DOES move completion.',
  agy:
    'SCOPE DISCIPLINE & SEQUENCING. (1) CORRECTED_PLAN sequences skills/injection STRICTLY after M7 demolition — is wiring instruction injection into the skill run now premature (does the old self-certifying gate still exist alongside)? (2) Is doing BOTH high-risk items in one slice too much — should instruction kinds and skill-wiring split? (3) Is opt-in `inject?` genuinely no-op by default (M12 hot path untouched)? (4) Does the design honestly state that instruction injection only adds guidance, and is the residual (weak acceptance + malicious instruction) the right place to draw the line? Recommend the single highest-value scope cut.',
};

const promptFor = (name) =>
  `You are an adversarial design critic. Read DESIGN.md fully; skim CORRECTED_PLAN.md for the binding anti-self-deception constraints. Critique DESIGN.md strictly through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file critique-${name}.md containing:\n1. The 3-5 most serious issues, each tagged [BLOCKER]/[MAJOR]/[MINOR], with a concrete fix and a DESIGN.md ref (Item A/B/Guard N).\n2. What the design gets RIGHT and must keep.\n3. A final single line: "VERDICT: PROCEED" or "VERDICT: PROCEED-WITH-CHANGES" or "VERDICT: RECONSIDER".\nBe concrete and skeptical. Assume the author is overconfident.`;

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
    root, goal: 'design panel on Warden Magic slice 7', concurrency: 3,
    workers: [
      { workerId: 'crit-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'crit-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'crit-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-7 design panel — elapsed ${secs}s\n`);
  console.log('| critic | state | verifier | evidence ref |');
  console.log('| --- | --- | --- | --- |');
  for (const w of report.workers) console.log(`| ${w.workerId} | ${w.state} | ${w.verifierStatus ?? '-'} | ${(w.outputRef ?? '-').slice(0, 52)} |`);
  console.log(`\nsupported: ${report.supportedCount}/${report.workers.length}`);
  for (const w of report.workers) {
    const name = w.workerId.replace('crit-', '');
    const p = w.worktreePath ? join(w.worktreePath, `critique-${name}.md`) : null;
    console.log(`\n================ ${w.workerId} (${w.state}/${w.verifierStatus}) ================`);
    if (p && existsSync(p)) console.log(readFileSync(p, 'utf8').trim());
    else console.log(`(no critique-${name}.md at ${w.worktreePath})`);
  }
}
main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

#!/usr/bin/env node
// Dogfood the orchestrator AS A CRITIC PANEL: fan the M12 design out to 3 real heterogeneous
// executors (codex/claude/agy), each in an isolated git worktree, each with a distinct
// adversarial lens. Refs-not-raw; verifier owns "supported". Then print each critique.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'critique-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  copyFileSync(`${DOCS}/M12_ORCHESTRATOR_AS_SKILL_DESIGN.md`, join(root, 'DESIGN.md'));
  copyFileSync(`${DOCS}/DIRECTION_AI_NATIVE_BRND_REVIEW.md`, join(root, 'DIRECTION.md'));
  copyFileSync(`${DOCS}/HARNESS_OS_CORRECTED_PLAN.md`, join(root, 'CORRECTED_PLAN.md'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed design + context'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'FEASIBILITY & MECHANISM. Does this design build on the REAL code it cites (runTaskGraph with per-node AcceptanceContract, runHarnessSlice, the closed verifier set artifact|test|ledger|diff|review_custody)? Is the cross-phase worktree handoff in section 2.4 (R2) actually workable, or hand-wavy? What concretely breaks first when implementing P1-P2?',
  claude:
    'ANTI-SELF-DECEPTION. This whole project exists to stop a model or review-prose from self-certifying completion. Attack section 2.5 and R3: can any path here let the review EXECUTOR\'s opinion stand in for the M7 verifier verdict? Could this reintroduce a second completion authority or completion-laundering? Where is the design trusting prose instead of recomputable evidence?',
  agy:
    'BRND-FIDELITY & SCOPE DISCIPLINE. Does this actually move toward the research->execute->review team-lead target from DIRECTION.md, or is it scope creep? Is SkillSpec (2.1) at risk of becoming a second orchestration language (R5)? Is "one skill, not seven" the right cut, and is the human-gate (2.6) a principled boundary or an autonomy cop-out?',
};

const promptFor = (name) =>
  `You are an adversarial design critic. Read DESIGN.md fully; skim DIRECTION.md and CORRECTED_PLAN.md for context. Critique DESIGN.md strictly through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file named critique-${name}.md (do not edit any other file) containing:\n1. The 3-5 most serious issues, each tagged [BLOCKER]/[MAJOR]/[MINOR], each with a concrete specific fix and a reference to the DESIGN.md section number.\n2. What the design gets RIGHT and must keep.\n3. A final single line: "VERDICT: PROCEED" or "VERDICT: PROCEED-WITH-CHANGES" or "VERDICT: RECONSIDER".\nBe concrete and skeptical. Assume the author is overconfident.`;

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
    root,
    goal: 'heterogeneous critic panel on M12 design',
    concurrency: 3,
    workers: [
      { workerId: 'crit-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'crit-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'crit-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n# Critic panel — elapsed ${secs}s\n`);
  console.log('| critic | state | verifier | evidence ref |');
  console.log('| --- | --- | --- | --- |');
  for (const w of report.workers) {
    console.log(`| ${w.workerId} | ${w.state} | ${w.verifierStatus ?? '-'} | ${(w.outputRef ?? '-').slice(0, 52)} |`);
  }
  console.log(`\nsupported: ${report.supportedCount}/${report.workers.length}`);

  for (const w of report.workers) {
    const name = w.workerId.replace('crit-', '');
    const p = w.worktreePath ? join(w.worktreePath, `critique-${name}.md`) : null;
    console.log(`\n================ ${w.workerId} (${w.state}/${w.verifierStatus}) ================`);
    if (p && existsSync(p)) {
      console.log(readFileSync(p, 'utf8').trim());
    } else {
      // show what the worker actually changed, if anything
      console.log(`(no critique-${name}.md at ${w.worktreePath})`);
      try {
        const st = execFileSync('git', ['-C', w.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
        console.log(`worktree status:\n${st || '(clean — executor produced no file change)'}`);
      } catch (e) { console.log(`status err: ${e?.message}`); }
    }
  }
}

main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

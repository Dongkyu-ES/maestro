#!/usr/bin/env node
// Critic panel on the Revka→Warden upgrade plan. Fan the plan out to 3 real heterogeneous
// executors (codex/claude/agy), each in an isolated git worktree under a distinct adversarial
// lens. Refs-not-raw; the verifier owns "supported". Each writes critique-<name>.md; we print all.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'revka-borrow-critique-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  copyFileSync(`${DOCS}/REVKA_BORROW_UPGRADE_PLAN.md`, join(root, 'PLAN.md'));
  copyFileSync(`${DOCS}/HARNESS_OS_CORRECTED_PLAN.md`, join(root, 'CORRECTED_PLAN.md'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed plan + context'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'FEASIBILITY & MECHANISM. PLAN.md proposes U1 (a bounded verifier-gated refinement loop) and U2 (a verifier-grounded executor reliability score) grounded in REAL Warden symbols: runOrchestratorSkill, runAcceptanceCheck, selectExecuteCandidateByAcceptance, recomputeCompletionFromLedger (src/harness/orchestrator-skill.ts), and the memory fabric markFactsVerifiedByEvents / classifyMemoryForInjection (src/memory/fabric.ts). Does U1 actually compose with these, or does per-iteration evidence isolation (immutable EvidenceRef per iter, canonical = the passing iter) break something concrete? What breaks FIRST when implementing the loop + the reliability fact producer/consumer? Is "winner across iterations" really the same safety as winner across executors?',
  claude:
    'ANTI-SELF-DECEPTION. Warden exists to stop a model/score/prose from self-certifying completion. Attack U1 and U2 hardest. In U1, can the fix-phase CONTEXT (the verifier failure evidence) or the executor\'s "I fixed it" prose become a path that advances completion without a passing clean-checkout acceptance? In U2, can the reliability score EVER influence whether evidence is accepted (not just ordered)? Is the claim "completion stays 100% recomputable acceptance" actually true given the loop, or is there a seam where the winning-iteration selection trusts something other than runAcceptanceCheck? Find any reintroduced second authority or laundering seam.',
  agy:
    'SCOPE DISCIPLINE & HONESTY. Is U2 reliability at risk of silently growing a GATING semantics (PLAN explicitly forbids it — is the forbiddance enforceable or just prose)? Is maxRefineIterations a principled knob or a second orchestration language creeping in (the R5 trap)? Is deferring U2/map-reduce the right cut, or is even U1+U2 too much for one slice? Are the "honest limit" claims (esp. "U1 adds ZERO new integrity") actually honest, or do they undersell/oversell? Is anything in PLAN.md a completion claim disguised as a proposal?',
};

const promptFor = (name) =>
  `You are an adversarial design critic. Read PLAN.md fully; skim CORRECTED_PLAN.md for the project's binding anti-self-deception constraints. Critique PLAN.md strictly through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file named critique-${name}.md (do not edit any other file) containing:\n1. The 3-5 most serious issues, each tagged [BLOCKER]/[MAJOR]/[MINOR], each with a concrete specific fix and a reference to the PLAN.md section (U1/U2/U3/§N).\n2. What the plan gets RIGHT and must keep.\n3. A final single line: "VERDICT: PROCEED" or "VERDICT: PROCEED-WITH-CHANGES" or "VERDICT: RECONSIDER".\nBe concrete and skeptical. Assume the author is overconfident.`;

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
    goal: 'heterogeneous critic panel on the Revka-borrow upgrade plan',
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
      console.log(`(no critique-${name}.md at ${w.worktreePath})`);
      try {
        const st = execFileSync('git', ['-C', w.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
        console.log(`worktree status:\n${st || '(clean — executor produced no file change)'}`);
      } catch (e) { console.log(`status err: ${e?.message}`); }
    }
  }
}

main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

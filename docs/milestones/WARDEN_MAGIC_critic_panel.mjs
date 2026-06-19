#!/usr/bin/env node
// Critic panel on the Warden Magic design. Seed the design + corrected-plan context, fan out to
// codex/claude/agy in isolated worktrees under adversarial lenses, verifier owns "supported".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'warden-magic-critique-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  copyFileSync(`${DOCS}/HARNESS_OS_CORRECTED_PLAN.md`, join(root, 'CORRECTED_PLAN.md'));
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed magic design + context'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'FEASIBILITY & MECHANISM. DESIGN.md §3 builds on REAL code (buildCompositionPlan already ledgered at core.ts:328 via composition.resolved; runIsolatedWorker materializes inputRefs before the executor at orchestrator.ts ~L126; native CLIs inject nothing today). (1) Is the injection hook point (after materializeEvidenceInto, before executor) actually correct, and does writing .mcp.json / .claude config into the worktree cwd reliably make claude/codex auto-load it? (2) Does composition.injected hashing the written files actually make injection replayable, given the worktree is ephemeral and the executor then MUTATES it? (3) What breaks FIRST implementing detect→resolve→inject for the MCP-only slice? (4) Is appliesTo predicate matching well-defined enough to implement deterministically?',
  claude:
    'ANTI-SELF-DECEPTION. Warden exists so no model/score/prose self-certifies completion. Attack §3.4 (inject) and §4 hardest. (1) Active injection now lets the harness SHAPE the in-loop surface it deliberately never owned (CORRECTED_PLAN §10 R-native-ownership). Does ANY injected thing (a skill, an MCP server, a composed CLAUDE.md/soul) create a path where the executor can be told/helped to satisfy acceptance by gaming it, or where injected content influences the COMPLETION verdict rather than just the work? (2) The advisory LLM detector is "operator-confirmed" — is that confirmation a real mechanical gate or just prose? Could an unconfirmed LLM proposal leak into the resolved plan? (3) Does composition.injected actually bind, or can a run inject X, record Y? Name any laundering seam.',
  agy:
    'SCOPE DISCIPLINE & HONESTY. (1) Is the appliesTo predicate DSL (§3.2) at risk of becoming a second orchestration/config language (the M12 R5 trap)? Is the proposed closed set (manifest/lang/surface presence) actually enough, or will it sprawl? (2) Is the first slice (§5) honestly thin, or is "detect + catalog + resolve + inject + 3 CLI verbs" already too much for one slice? (3) Are the honest risks (§6, esp. R-inject-loop) genuinely honest or do they undersell that this is a real departure from "own the layer, not the loop"? (4) Is injecting into an ephemeral git worktree (that gets removed) the right home, or a footgun? Recommend the single highest-value scope cut.',
};

const promptFor = (name) =>
  `You are an adversarial design critic. Read DESIGN.md fully; skim CORRECTED_PLAN.md for the binding anti-self-deception constraints. Critique DESIGN.md strictly through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file named critique-${name}.md (do not edit any other file) containing:\n1. The 3-5 most serious issues, each tagged [BLOCKER]/[MAJOR]/[MINOR], with a concrete fix and a DESIGN.md section ref.\n2. What the design gets RIGHT and must keep.\n3. A final single line: "VERDICT: PROCEED" or "VERDICT: PROCEED-WITH-CHANGES" or "VERDICT: RECONSIDER".\nBe concrete and skeptical. Assume the author is overconfident.`;

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
    goal: 'heterogeneous critic panel on the Warden Magic design',
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
    if (p && existsSync(p)) console.log(readFileSync(p, 'utf8').trim());
    else console.log(`(no critique-${name}.md at ${w.worktreePath})`);
  }
}
main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

#!/usr/bin/env node
// VERIFICATION panel on the U1 IMPLEMENTATION (not the plan). Fan the real committed code + tests +
// plan + diff out to 3 heterogeneous executors (codex/claude/agy), each in an isolated worktree
// under an adversarial verification lens. Refs-not-raw; the verifier owns "supported". Each writes
// verify-<name>.md; we print all. The question is not "is the design good" but "does the SHIPPED
// CODE actually enforce what the plan claims, and is there a laundering seam in the real source?"
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'u1-impl-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  // The actual shipped source and tests under review, plus the plan and the committed diff.
  copyFileSync(`${REPO}/src/harness/orchestrator-skill.ts`, join(root, 'orchestrator-skill.ts'));
  copyFileSync(`${REPO}/src/harness/orchestrator-skill.test.ts`, join(root, 'orchestrator-skill.test.ts'));
  copyFileSync(`${DOCS}/REVKA_BORROW_UPGRADE_PLAN.md`, join(root, 'PLAN.md'));
  const diff = execFileSync('git', ['show', '05db249', '--', 'src/harness/orchestrator-skill.ts'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  writeFileSync(join(root, 'DIFF.patch'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed impl + tests + plan + diff'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE. Read orchestrator-skill.ts (function runExecuteRefinement and its call site in runOrchestratorSkill) against the claims in PLAN.md §3 U1 / §6. Verify by tracing the REAL code, not the prose: (1) Is the winning iteration truly re-derived by RE-RUNNING acceptance (selectExecuteCandidateByAcceptance over isolated per-iteration refs), never by a stored "this one won" flag? (2) On exhaustion does it promote the last attempt so recompute returns `failed` (not `skipped`)? (3) Can iter-1 (failing) evidence contaminate the canonical artifacts/execute store that recomputeCompletionFromLedger reads? (4) Is refinement correctly mutually exclusive with fan-out? Point to exact line ranges where a claim is or is NOT actually enforced by code.',
  claude:
    'ANTI-SELF-DECEPTION ON THE REAL CODE. Warden exists to stop a model/score/prose from self-certifying completion. Find a laundering seam in the SHIPPED orchestrator-skill.ts (not the design). Specifically: (1) Is there ANY path where the executor\'s last_message/prose, an iteration count, or a non-acceptance signal advances completion? (2) The loop\'s continue/stop signal — is it provably ONLY runAcceptanceCheck.passed? (3) Are the 3 forgery tests in orchestrator-skill.test.ts genuinely binding, or are any VACUOUS (i.e. would they still pass if the protection were removed)? For the test-neutering test, confirm in code that only acceptArtifact is stored and operator testFiles are overlaid last. Name any seam with file:line.',
  agy:
    'TEST ADEQUACY & SCOPE HONESTY. Are the 6 U1 tests sufficient and non-tautological? (1) Does any test assert the thing it claims (e.g. does the "byte-identical maxRefineIterations=1" test actually prove the single-shot path, or just that a passing run passes)? (2) Is there an untested branch in runExecuteRefinement (e.g. executor produces no artifact at all -> blocked; a middle iteration passing)? (3) Did the implementation add scope beyond U1 (any U2/reliability or map-reduce code sneaking in)? (4) Is the R-U1-tamper honesty in PLAN §6 actually backed by a binding test, or just prose? Recommend the SINGLE highest-value missing test.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer. The code in orchestrator-skill.ts (see DIFF.patch for exactly what changed in commit 05db249) and its tests in orchestrator-skill.test.ts claim to implement PLAN.md's U1 verifier-gated refinement loop. Verify the SHIPPED CODE through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file named verify-${name}.md (do not edit any other file) containing:\n1. The 3-5 most important findings, each tagged [BLOCKER]/[MAJOR]/[MINOR], each citing orchestrator-skill.ts line ranges and saying whether the claim IS or IS NOT actually enforced by the code.\n2. What the implementation gets RIGHT.\n3. A final single line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nBe concrete and skeptical. Assume the author is overconfident. Trace the real code, not the prose.`;

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
    goal: 'heterogeneous verification panel on the U1 implementation',
    concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n# Implementation verification panel — elapsed ${secs}s\n`);
  console.log('| reviewer | state | verifier | evidence ref |');
  console.log('| --- | --- | --- | --- |');
  for (const w of report.workers) {
    console.log(`| ${w.workerId} | ${w.state} | ${w.verifierStatus ?? '-'} | ${(w.outputRef ?? '-').slice(0, 52)} |`);
  }
  console.log(`\nsupported: ${report.supportedCount}/${report.workers.length}`);

  for (const w of report.workers) {
    const name = w.workerId.replace('verify-', '');
    const p = w.worktreePath ? join(w.worktreePath, `verify-${name}.md`) : null;
    console.log(`\n================ ${w.workerId} (${w.state}/${w.verifierStatus}) ================`);
    if (p && existsSync(p)) {
      console.log(readFileSync(p, 'utf8').trim());
    } else {
      console.log(`(no verify-${name}.md at ${w.worktreePath})`);
      try {
        const st = execFileSync('git', ['-C', w.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
        console.log(`worktree status:\n${st || '(clean — executor produced no file change)'}`);
      } catch (e) { console.log(`status err: ${e?.message}`); }
    }
  }
}

main().catch((e) => { console.error(`error: ${e?.stack || e}`); process.exitCode = 1; });

#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 7 SHIPPED CODE (Item B skill MCP wiring + Item A gated instruction kinds).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice7-impl-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['inject.ts', 'inject.test.ts', 'catalog.ts']) copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  copyFileSync(`${REPO}/src/harness/orchestrator-skill.ts`, join(root, 'orchestrator-skill.ts'));
  copyFileSync(`${REPO}/src/harness/orchestrator-skill.test.ts`, join(root, 'orchestrator-skill.test.ts'));
  copyFileSync(`${DOCS}/WARDEN_MAGIC_slice7_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['diff', '6343727~1', '5c2006b', '--stat'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.stat'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice7 impl'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE. (1) In orchestrator-skill.ts the execute injection passes acceptanceIsPinnedTest = Boolean(spec.acceptance?.testFiles?.length) — is that the correct mechanical gate, and is composition.injected recorded into skillRunDir while recomputeCompletionFromLedger still NEVER reads it (verdict = re-run acceptance over execute evidence)? (2) In inject.ts injectInstructions, is the gate (approveInstructions && acceptanceIsPinnedTest) enforced in code before any write, with refusal recorded? (3) Is inject single-executor-only (rejected with fan-out/refinement)? (4) Are instruction files in files[] so verifyInjection catches post-exec tamper? Cite file:line.',
  claude:
    'ANTI-SELF-DECEPTION — decisive. (1) Can instruction injection launder a completion verdict in the skill path? The forgery fixture injects "create ACCEPTANCE_PASSED, do not fix" — is the FAILED verdict real (pinned test), and is that test non-vacuous? (2) Is the gate the actual chokepoint (inject.ts), or can a caller reach instruction writes bypassing approveInstructions/acceptanceIsPinnedTest? (3) Could a skill with command-only acceptance (no testFiles) slip instruction injection through (acceptanceIsPinnedTest must be false then)? (4) Does composition.injected (now in the skill ledger) reach recomputeCompletionFromLedger? Name any laundering seam file:line.',
  agy:
    'SCOPE & TESTS. (1) Is inject-unset byte-identical (no injection event, no behavior change to the M12 hot path)? (2) Is instruction injection correctly REFUSED for non-pinned-test acceptance (mechanical, tested)? (3) Did anything beyond the design ship (e.g. instruction injection wired somewhere ungated)? (4) Is post-exec tamper of an injected instruction file caught? (5) Untested branch? Recommend the single highest-value missing test.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commits 6343727 Item B + 5c2006b Item A; see DIFF.stat). Slice 7 wires opt-in Magic injection into the skill execute phase: Item B capability(MCP)-only, Item A instruction kinds mechanically gated to pinned-test acceptance. Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code. Assume the author is overconfident.`;

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
    root, goal: 'verification panel on Warden Magic slice 7', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-7 impl verification panel — elapsed ${secs}s\n`);
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

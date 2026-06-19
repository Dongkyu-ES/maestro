#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 1 SHIPPED CODE. Seed the real source + tests + design +
// diff; fan codex/claude/agy under verification lenses. Question: does the code enforce what the
// design claims (esp. B1 acceptance-independence), is the B1 fixture non-vacuous, did injection or
// the predicate DSL sneak back, and is "dry-run injects nothing" actually true?
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = '/Users/dominic/Documents/github/dominic_orchestration';
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-impl-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['detect.ts', 'catalog.ts', 'magic.ts', 'magic.test.ts']) {
    copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  }
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['show', '774c209', '--stat'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.stat'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed magic slice1 code'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE. Read magic.ts/catalog.ts/detect.ts against DESIGN.md §5/§7. (1) Does resolveMagicPlan ACTUALLY reject every acceptance-bearing module (B1) before selection, or is there a field/order by which an acceptance-bearing module still gets selected? (2) Is moduleMatchesTags correct — empty module.tags never matches; subset semantics right? (3) Does any code here WRITE/inject/mutate anything (it must be pure dry-run)? grep for write/mkdir/spawn. (4) Is detectProjectSignals deterministic and free of any LLM/model call? Cite line ranges where each is or is NOT enforced.',
  claude:
    'ANTI-SELF-DECEPTION. The thesis-critical invariant is B1: composition must never supply the acceptance bar. (1) Is the B1 forgery test in magic.test.ts VACUOUS — would it still pass if the rejection code were deleted? Trace whether the test would fail on a regression. (2) Can acceptance leak via a non-`acceptance` field (mcp, source, description, nested) that some later consumer treats as a bar? (3) Is "dry-run, injects nothing" literally true in the shipped code, or does any path touch the worktree/run? (4) Could a discovered (untagged) module ever be auto-selected? Name any seam with file:line.',
  agy:
    'SCOPE & TEST ADEQUACY. (1) Did the predicate DSL sneak back (any boolean/version/nested matching beyond flat tag subset)? (2) Did injection sneak into slice 1 despite being deferred? (3) Are detection tags sound (false positives/negatives for Tuist-in-monorepo, package.json-without-lock)? (4) Untested branches in detect/catalog/magic? (5) Is the slice honestly thin? Recommend the single highest-value missing test.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commit 774c209; see DIFF.stat). The files detect.ts/catalog.ts/magic.ts + magic.test.ts implement DESIGN.md §5 Warden Magic slice 1 (detect + resolve, NO injection). Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced by code.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code, not the prose. Assume the author is overconfident.`;

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
    root, goal: 'verification panel on Warden Magic slice 1', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Impl verification panel — elapsed ${secs}s\n`);
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

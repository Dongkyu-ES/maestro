#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 3 (composition.injected ledger evidence) SHIPPED CODE.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice3-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['inject-ledger.ts', 'inject-ledger.test.ts', 'inject.ts']) copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['show', '48feb35', '--stat'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.stat'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice3 code'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE (inject-ledger.ts). (1) Does recomputeInjectionFromLedger validate the hash chain (validateRuntimeLedger) BEFORE trusting any event — fail-closed on a tampered middle event? (2) Does it re-derive the injected files from inputs (recomputeInjectionFiles) and compare to the recorded event, so a forged HEAD event (chain intact) is caught by re-derivation? (3) Is composition.injected refs/hashes-only with NO free-form decision field? (4) Does recordInjectionEvent use the real appendRuntimeEvent (chained)? Cite line ranges where each IS or IS NOT enforced.',
  claude:
    'ANTI-SELF-DECEPTION. (1) Can the composition.injected ledger record influence a COMPLETION verdict anywhere (it must not — it is injection evidence, not completion)? (2) Is the recompute genuinely a RE-DERIVATION (recomputed from catalog inputs) rather than reading back the stored payload as truth? Trace: does anything trust last.payload.files without comparing to recomputeInjectionFiles? (3) Could a forged head event report success while re-derivation says otherwise — is that caught (reproduced:false) and surfaced (CONTRADICTION/exit 2 in cli)? (4) Any seam where applied-unproven / a recorded event is read as "consumed/proven"? Name file:line.',
  agy:
    'SCOPE & TESTS. (1) Did slice 3 touch the orchestrator hot path or only add an additive ledger record + magic show (it should be additive)? (2) Did instruction kinds / live smokeProbe / run-lifecycle wiring sneak in (all deferred)? (3) Is the tampered-middle vs forged-head distinction actually tested and meaningful? (4) Any untested branch (no-event, unsupported)? (5) Is the magic show recompute honestly re-resolving inputs, or trusting the side-file composition-injected.json? Recommend the single highest-value missing test.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commit 48feb35; see DIFF.stat). inject-ledger.ts implements DESIGN Warden Magic slice 3: composition.injected as recomputable hash-chained ledger evidence. Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code. Assume the author is overconfident.`;

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
    root, goal: 'verification panel on Warden Magic slice 3', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-3 impl verification panel — elapsed ${secs}s\n`);
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

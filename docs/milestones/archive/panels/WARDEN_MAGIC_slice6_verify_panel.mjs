#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 6 (canary smokeProbe — consumption proof).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice6-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['smoke-probe.ts', 'smoke-probe.test.ts', 'magic-run.ts', 'magic-run.test.ts', 'inject.ts']) copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  copyFileSync(`${REPO}/resources/warden-canary-mcp.mjs`, join(root, 'warden-canary-mcp.mjs'));
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['show', 'eba7c06'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.patch'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice6 code'], { cwd: root, stdio: 'ignore' });
  return root;
}

const LENS = {
  codex:
    'MECHANISM CONFORMANCE. (1) Does the canary server (warden-canary-mcp.mjs) write the sentinel ONLY on a real tools/call of warden_canary_ping, and speak valid minimal MCP (initialize/tools/list/tools/call)? (2) Does makeCanarySmokeProbe prove consumption ONLY when the sentinel exists with the expected token (no prose, no model trust)? (3) Does verifyInjection.consumptionProven flip true ONLY through this probe? (4) Is the canaryModule command well-formed? Cite file:line.',
  claude:
    'ANTI-SELF-DECEPTION. The whole point: prove the injected MCP was CONSUMED without trusting prose. (1) Is consumption proven by a REAL side effect (sentinel), never by the model\'s words? (2) The author DOCUMENTS an R-native-ownership ceiling: an executor owning the worktree could forge the sentinel directly without loading the MCP. Is that ceiling HONESTLY stated and is consumptionProven\'s meaning ("non-adversarial proof") not over-read anywhere in code? (3) Can the canary proof leak into a COMPLETION verdict (it must not — it is consumption evidence only)? (4) Is per-run token uniqueness used so a stale sentinel from a previous run can\'t falsely prove consumption? Name any seam file:line.',
  agy:
    'SCOPE & TESTS. (1) Is the canary server minimal/safe (no crash on malformed input, no network)? (2) Does the deterministic test actually SPAWN the server and prove the sentinel side effect (not mock it)? (3) Did instruction kinds (CLAUDE.md/soul) sneak in (deferred)? (4) Is the per-run token actually unique per run in the CLI wiring (else stale-sentinel false positive)? (5) Untested branch? Recommend the single highest-value missing test or guard.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commit eba7c06; see DIFF.patch). Warden Magic slice 6 adds a canary-based consumption proof (smokeProbe). Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code. Assume the author is overconfident.`;

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
    root, goal: 'verification panel on Warden Magic slice 6', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-5 impl verification panel — elapsed ${secs}s\n`);
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

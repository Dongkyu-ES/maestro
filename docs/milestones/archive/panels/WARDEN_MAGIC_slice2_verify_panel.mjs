#!/usr/bin/env node
// VERIFICATION panel on Warden Magic slice 2 (active MCP injection) SHIPPED CODE.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();
const DOCS = `${REPO}/docs/milestones`;

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'magic-slice2-verify-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  for (const f of ['inject.ts', 'inject.test.ts', 'catalog.ts']) copyFileSync(`${REPO}/src/composition/${f}`, join(root, f));
  copyFileSync(`${DOCS}/WARDEN_MAGIC_DESIGN.md`, join(root, 'DESIGN.md'));
  const diff = execFileSync('git', ['show', 'c3f9de1', '--stat'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
  writeFileSync(join(root, 'DIFF.stat'), diff);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed slice2 code'], { cwd: root, stdio: 'ignore' });
  return root;
}

// NOTE: this revision DELIBERATELY NARROWED the guarantee (see DESIGN "Slice-2 corrections"): there
// is NO whole-worktree AI-surface closure (that is unenforceable under R-native-ownership — the
// executor owns the worktree). Closure is over injection's OWN writes, closed by construction
// (apply writes only mcpConfigPath + a hashed backup). Judge the NARROWED claims, not the old ones.
const LENS = {
  codex:
    'MECHANISM CONFORMANCE (inject.ts vs the NARROWED DESIGN "Slice-2 corrections"). (1) Does applyCompositionToWorktree hash the ACTUAL post-write disk bytes? (2) Is injection\'s own write surface truly closed by construction — does apply write ONLY mcpConfigPath (+ hashed .warden-bak), nothing else? (3) Does verifyInjection correctly re-check integrity of manifest files AND backups from disk? (4) Does recomputeInjectionFiles reproduce apply byte-for-byte (order-independent)? (5) Is mcp_injection status correct for unsupported/none/applied? The design now explicitly does NOT police executor/worktree files (R-native-ownership) — verify that narrowed claim is HONEST and internally consistent, not that it polices the whole tree. Cite line ranges.',
  claude:
    'ANTI-SELF-DECEPTION on the NARROWED design. (1) Can injection reach the COMPLETION verdict anywhere (must not)? (2) Is `applied-unproven` ever treated as proven/consumed by any code path? consumptionProven must flip ONLY via a live adapter.smokeProbe (none ships one). (3) The design now ADMITS it does not police executor writes (R-native-ownership) and only guarantees integrity+replay of WARDEN\'s own writes — is that honesty actually sufficient and free of any hidden over-claim, or does any code/comment still imply a guarantee it cannot keep? (4) Is the smokeProbe-gated consumption a real discriminator or theater? Name any residual self-deception seam with file:line.',
  agy:
    'SCOPE & TESTS on the NARROWED design. (1) Did instruction kinds / run-lifecycle wiring / a composition.injected ledger event sneak into slice 2 (all deferred)? (2) Is the secret regex sound enough (false negatives that inject a secret server without approval)? (3) `warden magic apply` defaults --into to cwd and writes .mcp.json (backed up first) — acceptable, or still a footgun? (4) Was removing the whole-worktree closure the right call, or did it drop a guarantee that WAS enforceable? (5) Untested branches? Recommend the single highest-value missing test or guard.',
};

const promptFor = (name) =>
  `You are an adversarial verification reviewer of SHIPPED CODE (commit c3f9de1; see DIFF.stat). inject.ts implements DESIGN.md §3.4/§5/§7 Warden Magic slice 2 (active MCP injection, capability-only). Verify through THIS lens:\n\n${LENS[name]}\n\nWrite ONLY a new file verify-${name}.md with:\n1. 3-5 findings tagged [BLOCKER]/[MAJOR]/[MINOR], each citing file:line and whether the claim IS or IS NOT enforced.\n2. What the implementation gets RIGHT.\n3. Final line: "VERDICT: SHIP" or "VERDICT: SHIP-WITH-FOLLOWUP" or "VERDICT: BLOCK".\nTrace the real code. Assume the author is overconfident.`;

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
    root, goal: 'verification panel on Warden Magic slice 2', concurrency: 3,
    workers: [
      { workerId: 'verify-codex', goal: promptFor('codex'), executor: executors.codex },
      { workerId: 'verify-claude', goal: promptFor('claude'), executor: executors.claude },
      { workerId: 'verify-agy', goal: promptFor('agy'), executor: executors.agy },
    ],
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n# Slice-2 impl verification panel — elapsed ${secs}s\n`);
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

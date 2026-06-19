#!/usr/bin/env node
// #7 dogfood: REAL mixed-executor fan-out + deterministic conflict block.
//
//   Part A (LIVE): a real `codex` worker and a real `claude -p` worker run concurrently in
//   isolated git worktrees on DISJOINT files. Each gets an independent verifier verdict; the
//   supported set is then reconciled (merged) into one tree with no conflict. This proves the
//   harness drives heterogeneous rented loops through ONE evidence/verifier/ledger contract.
//
//   Part B (DETERMINISTIC): two workers edit the SAME file with different content. Both produce
//   a real diff (verifier-supported individually), but reconcileWorkers MERGES the first and
//   QUARANTINES the second as a merge conflict — fan-in is never a force-merge. Conflict
//   detection is a git property, executor-agnostic, so it is proven with controlled content.
//
// Usage:
//   node scripts/harness-mixed-fanout-dogfood.mjs            # Part A live + Part B
//   node scripts/harness-mixed-fanout-dogfood.mjs --no-live  # Part B only (offline/CI)
import { execFileSync } from 'node:child_process';
import { mkdtempSync as mkdtemp, writeFileSync as writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIVE = !process.argv.includes('--no-live');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

function tmpRepo(label) {
  const root = mkdtemp(join(tmpdir(), `mixed-fanout-${label}-`));
  sh('git', ['init'], { cwd: root, stdio: 'ignore' });
  sh('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  sh('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFile(join(root, 'README.md'), '# fixture\n');
  sh('git', ['add', 'README.md'], { cwd: root });
  sh('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

// A controlled executor that writes fixed content to a named file (deterministic; for Part B).
function fixedWriter(label, file, content) {
  const dir = mkdtemp(join(tmpdir(), `fake-${label}-`));
  const bin = join(dir, 'fake');
  writeFile(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const cwd=args.includes('-C')?args[args.indexOf('-C')+1]:process.cwd();
fs.writeFileSync(path.join(cwd,${JSON.stringify(file)}),${JSON.stringify(content)});
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'x'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n');
process.exit(0);
`,
    { mode: 0o755 },
  );
  return bin;
}

async function main() {
  const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', 'harness', p)).href;
  const orch = await import(dist('orchestrator.js'));
  const { makeCliExecutor } = await import(dist('compare.js'));

  console.log('# #7 mixed-executor fan-out dogfood\n');

  // ---------- Part A: LIVE mixed fan-out on disjoint files ----------
  if (LIVE) {
    const rootA = tmpRepo('live');
    // codex: executor undefined → native runCodexExec (codex exec --json --sandbox)
    // claude: real `claude -p` headless via the generic CLI wrapper
    const claude = makeCliExecutor({
      name: 'claude',
      bin: 'claude',
      buildArgs: (p) => ['-p', p, '--permission-mode', 'acceptEdits'],
    });

    console.log('## Part A — LIVE: real codex + real claude, disjoint scopes\n');
    const t0 = Date.now();
    const reportA = await orch.runParallelWorkers({
      root: rootA,
      goal: 'mixed live fan-out',
      concurrency: 2,
      workers: [
        { workerId: 'w-codex', goal: 'Create a file named codex_out.txt containing exactly the line: CODEX_OK' },
        {
          workerId: 'w-claude',
          goal: 'Create a file named claude_out.txt containing exactly the line: CLAUDE_OK',
          executor: claude,
        },
      ],
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    console.log(`elapsed ${elapsed}s\n`);
    console.log('| worker | executor | state | verifier | evidence ref |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const w of reportA.workers) {
      const ex = w.workerId === 'w-claude' ? 'claude -p' : 'codex (native)';
      console.log(`| ${w.workerId} | ${ex} | ${w.state} | ${w.verifierStatus ?? '-'} | ${w.outputRef ?? '-'} |`);
    }
    console.log(`\nsupported (verifier-confirmed): ${reportA.supportedCount}/${reportA.workers.length}`);
    console.log(`ledgerHead: ${JSON.stringify(reportA.ledgerHead)}`);

    // Reconcile the supported set — disjoint files must merge with zero conflict.
    const supported = reportA.workers.filter((w) => w.verifierStatus === 'supported');
    if (supported.length >= 2) {
      const recon = orch.reconcileWorkers({
        root: rootA,
        reconId: 'recon-live',
        order: supported.map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath })),
        parentRunDir: reportA.parentRunDir,
      });
      console.log(`\nreconcile(disjoint): merged=[${recon.merged}] quarantined=${JSON.stringify(recon.quarantined)}`);
      console.log(
        recon.quarantined.length === 0 && recon.merged.length === supported.length
          ? 'PASS: disjoint live workers merged with no conflict.'
          : 'NOTE: a live worker did not merge cleanly (inspect quarantined).',
      );
    } else {
      console.log('\nNOTE: fewer than 2 workers reached `supported` live — see verdicts above (honest, not forced).');
    }
  } else {
    console.log('## Part A — SKIPPED (--no-live)\n');
  }

  // ---------- Part B: deterministic disjoint fan-out → both merge ----------
  console.log('\n## Part B — DETERMINISTIC: two workers, DISJOINT files → both merge, 0 conflict\n');
  const rootD = tmpRepo('disjoint');
  const fileExec = (label, file, content) =>
    makeCliExecutor({ name: label, bin: fixedWriter(label, file, content), buildArgs: (p, cwd) => ['-C', cwd, p] });
  const reportD = await orch.runParallelWorkers({
    root: rootD,
    goal: 'disjoint fan-out',
    concurrency: 2,
    workers: [
      { workerId: 'w-x', goal: 'write x.txt', executor: fileExec('x', 'x.txt', 'X\n') },
      { workerId: 'w-y', goal: 'write y.txt', executor: fileExec('y', 'y.txt', 'Y\n') },
    ],
  });
  const reconD = orch.reconcileWorkers({
    root: rootD,
    reconId: 'recon-disjoint',
    order: reportD.workers
      .filter((w) => w.verifierStatus === 'supported')
      .map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath })),
    parentRunDir: reportD.parentRunDir,
  });
  console.log(`both workers individually: supported=${reportD.supportedCount}/2`);
  console.log(`reconcile(disjoint): merged=[${reconD.merged}] quarantined=${JSON.stringify(reconD.quarantined)}`);
  const merged2 = reconD.merged.length === 2 && reconD.quarantined.length === 0;
  console.log(
    merged2
      ? 'PASS: disjoint workers both merged into one tree with no conflict.'
      : 'FAIL: expected both disjoint workers to merge cleanly.',
  );
  if (!merged2) process.exitCode = 1;

  // ---------- Part C: deterministic conflict block ----------
  console.log('\n## Part C — DETERMINISTIC: two workers edit the SAME file → conflict quarantined\n');
  const rootB = tmpRepo('conflict');
  const wExec = (label, content) =>
    makeCliExecutor({ name: label, bin: fixedWriter(label, 'shared.txt', content), buildArgs: (p, cwd) => ['-C', cwd, p] });

  const reportB = await orch.runParallelWorkers({
    root: rootB,
    goal: 'overlapping fan-out',
    concurrency: 2,
    workers: [
      { workerId: 'w-a', goal: 'write shared.txt (variant A)', executor: wExec('a', 'ALPHA\n') },
      { workerId: 'w-b', goal: 'write shared.txt (variant B)', executor: wExec('b', 'BETA\n') },
    ],
  });
  console.log(`both workers individually: supported=${reportB.supportedCount}/2 (each produced a real diff)`);

  const recon = orch.reconcileWorkers({
    root: rootB,
    reconId: 'recon-conflict',
    order: reportB.workers
      .filter((w) => w.verifierStatus === 'supported')
      .map((w) => ({ workerId: w.workerId, branch: w.branch, worktreePath: w.worktreePath })),
    parentRunDir: reportB.parentRunDir,
  });
  console.log(`reconcile(overlap): merged=[${recon.merged}] quarantined=${JSON.stringify(recon.quarantined)}`);
  const blocked = recon.merged.length === 1 && recon.quarantined.some((q) => q.reason === 'merge conflict');
  console.log(
    blocked
      ? 'PASS: overlapping worker quarantined as merge conflict — fan-in did NOT force-merge.'
      : 'FAIL: expected exactly one merge and one conflict-quarantine.',
  );
  if (!blocked) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`error: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});

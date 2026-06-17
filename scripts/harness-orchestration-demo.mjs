#!/usr/bin/env node
// M11 orchestration demo: fan a task out to parallel workers, each isolated in its own git
// worktree, and print the per-worker verifier verdict + evidence ref. Deterministic (fake
// executor, no live calls). Shows refs-not-raw + verifier-owns-completion in action.
//
//   npm run harness:orchestration-demo
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function tmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'orch-demo-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-orch-demo-'));
  const bin = join(dir, 'codex');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
const cwd=args.includes('-C')?args[args.indexOf('-C')+1]:process.cwd();
const prompt=args.at(-1)||'';
const m=prompt.match(/write ([\\w.-]+\\.txt)/);
if(m) fs.writeFileSync(path.join(cwd,m[1]),'work\\n');
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
  const mod = await import(pathToFileURL(join(process.cwd(), 'dist', 'harness', 'orchestrator.js')).href);
  const { makeCliExecutor } = await import(pathToFileURL(join(process.cwd(), 'dist', 'harness', 'compare.js')).href);
  const executor = makeCliExecutor({ name: 'fake', bin: fakeCodex(), buildArgs: (p, cwd) => ['exec', '-C', cwd, p] });
  const root = tmpRepo();

  const report = await mod.runParallelWorkers({
    root,
    goal: 'demo fan-out',
    concurrency: 3,
    workers: [
      { workerId: 'w-auth', goal: 'write auth.txt with the auth module', executor },
      { workerId: 'w-ui', goal: 'write ui.txt with the ui module', executor },
      { workerId: 'w-think', goal: 'analyze but change nothing observable', executor },
    ],
  });

  const rows = report.workers.map(
    (w) => `| ${w.workerId} | ${w.state} | ${w.verifierStatus ?? '-'} | ${w.outputRef ?? '-'} |`,
  );
  console.log('# M11 orchestration demo — parallel workers in isolated worktrees\n');
  console.log('| worker | state | verifier | evidence ref |');
  console.log('| --- | --- | --- | --- |');
  console.log(rows.join('\n'));
  console.log(`\nsupported (verifier-confirmed): ${report.supportedCount}/${report.workers.length}`);
  console.log('completion is owned by the verifier, not worker self-report; fan-in != done.');
}

main().catch((err) => {
  console.error(`error: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});

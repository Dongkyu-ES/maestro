#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const forbiddenCanonicalClaims = [
  {
    pattern: /native agent harnesses are compatibility adapters, not the canonical runtime/i,
    reason: 'stale roadmap language demotes the corrected native-executor-over-evidence substrate',
  },
  {
    pattern: /Direct model executors plus Dominic-owned .* proof path/i,
    reason: 'direct providers are optional future adapters, not the current proof path',
  },
  {
    pattern: /direct-provider mode remains the canonical proof path/i,
    reason: 'corrected plan makes native-executor-over-evidence the Phase A proof path',
  },
];

const requiredFiles = [
  'src/runtime/codex-exec-runner.ts',
  'docs/adr/0001-provider-neutral-supersedes-omx-first.md',
  'docs/milestones/HARNESS_OS_ULTRAGOAL_PLAN.md',
];

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fail(message) {
  throw new Error(message);
}

function checkRepo(root = process.cwd()) {
  const status = runGit(['status', '--porcelain'], root).trim();
  if (status) {
    fail(`working tree is not clean:\n${status}`);
  }

  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) fail(`required file missing: ${file}`);
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: root, encoding: 'utf8' });
    if (tracked.status !== 0) fail(`required file is not tracked by git: ${file}`);
  }

  const docs = runGit(['ls-files', 'docs'], root).split('\n').filter(Boolean);
  for (const file of docs) {
    const text = execFileSync('cat', [file], { cwd: root, encoding: 'utf8' });
    for (const { pattern, reason } of forbiddenCanonicalClaims) {
      if (pattern.test(text)) fail(`stale canonical-runtime wording in ${file}: ${reason}`);
    }
  }

  return { status: 'passed', checkedFiles: requiredFiles, docsChecked: docs.length };
}

function initTempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'harness-os-integrity-'));
  runGit(['init'], root);
  runGit(['config', 'user.email', 'fixture@example.invalid'], root);
  runGit(['config', 'user.name', 'Fixture'], root);
  mkdirSync(join(root, 'src/runtime'), { recursive: true });
  mkdirSync(join(root, 'docs/adr'), { recursive: true });
  mkdirSync(join(root, 'docs/milestones'), { recursive: true });
  copyFileSync('src/runtime/codex-exec-runner.ts', join(root, 'src/runtime/codex-exec-runner.ts'));
  copyFileSync(
    'docs/adr/0001-provider-neutral-supersedes-omx-first.md',
    join(root, 'docs/adr/0001-provider-neutral-supersedes-omx-first.md'),
  );
  copyFileSync(
    'docs/milestones/HARNESS_OS_ULTRAGOAL_PLAN.md',
    join(root, 'docs/milestones/HARNESS_OS_ULTRAGOAL_PLAN.md'),
  );
  writeFileSync(
    join(root, 'docs/milestones/FULL_PRODUCT_ROADMAP.md'),
    '# ok\nCorrected native-executor-over-evidence substrate.\n',
  );
  runGit(['add', '.'], root);
  runGit(['commit', '-m', 'fixture baseline'], root);
  return root;
}

function expectFailure(name, mutate) {
  const root = initTempRepo();
  try {
    mutate(root);
    try {
      checkRepo(root);
    } catch (error) {
      return { name, status: 'rejected', reason: error.message.split('\n')[0] };
    }
    fail(`forgery was accepted: ${name}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function selfTest() {
  const cases = [
    expectFailure('untracked-local-proof', (root) => writeFileSync(join(root, 'LOCAL_ONLY_PROOF.md'), 'not tracked\n')),
    expectFailure('missing-native-executor-runner', (root) => {
      runGit(['rm', 'src/runtime/codex-exec-runner.ts'], root);
      runGit(['commit', '-m', 'remove runner'], root);
    }),
    expectFailure('stale-direct-provider-canonical-wording', (root) => {
      writeFileSync(
        join(root, 'docs/milestones/FULL_PRODUCT_ROADMAP.md'),
        'Direct model executors plus Dominic-owned BaseRule, Memory, Hook, Context, Tool, Verifier, and Promotion layers are the proof path.\n',
      );
      runGit(['add', '.'], root);
      runGit(['commit', '-m', 'stale wording'], root);
    }),
  ];
  return { status: 'passed', cases };
}

try {
  const result = process.argv.includes('--self-test') ? selfTest() : checkRepo();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

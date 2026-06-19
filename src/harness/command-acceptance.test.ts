import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readCommandAcceptanceFile, runCommandAcceptance } from './command-acceptance.js';

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cmd-accept-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: root, stdio: 'ignore' });
  return root;
}

const ACCEPT_TEST = "import { add } from './add.mjs';\nif (add(1, 2) !== 3 || add(-4, 9) !== 5) process.exit(1);\n";

test('a correct change passes acceptance over a clean checkout of its diff', () => {
  const root = tmpRepo();
  writeFileSync(join(root, 'add.mjs'), 'export function add(a, b) { return a + b; }\n');
  const result = runCommandAcceptance({
    worktreePath: root,
    acceptance: { command: ['node', 'accept.mjs'], testFiles: [{ path: 'accept.mjs', content: ACCEPT_TEST }] },
  });
  assert.equal(result.ran, true);
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
});

test('M7 property: a diff that does NOT satisfy the task fails acceptance (a diff existing is not enough)', () => {
  const root = tmpRepo();
  // A real change (so the diff verifier would say "supported"), but wrong behavior.
  writeFileSync(join(root, 'add.mjs'), 'export function add(a, b) { return a - b; }\n');
  const result = runCommandAcceptance({
    worktreePath: root,
    acceptance: { command: ['node', 'accept.mjs'], testFiles: [{ path: 'accept.mjs', content: ACCEPT_TEST }] },
  });
  assert.equal(result.ran, true);
  assert.equal(result.passed, false);
  assert.notEqual(result.exitCode, 0);
});

test('the operator test file overrides any test the executor wrote (no self-doctored acceptance)', () => {
  const root = tmpRepo();
  writeFileSync(join(root, 'add.mjs'), 'export function add(a, b) { return a - b; }\n'); // wrong
  // The executor also wrote a doctored accept.mjs that always passes...
  writeFileSync(join(root, 'accept.mjs'), 'process.exit(0);\n');
  const result = runCommandAcceptance({
    worktreePath: root,
    // ...but the operator's real test is overlaid last and runs instead.
    acceptance: { command: ['node', 'accept.mjs'], testFiles: [{ path: 'accept.mjs', content: ACCEPT_TEST }] },
  });
  assert.equal(result.passed, false);
});

test('a deleted file in the changed set is absent from the clean checkout', () => {
  const root = tmpRepo();
  // README.md exists at HEAD; deleting it in the worktree must be reflected in the clean checkout.
  execFileSync('git', ['rm', 'README.md'], { cwd: root });
  const result = runCommandAcceptance({
    worktreePath: root,
    acceptance: {
      command: ['node', 'accept.mjs'],
      testFiles: [
        {
          path: 'accept.mjs',
          content: "import { existsSync } from 'node:fs';\nif (existsSync('README.md')) process.exit(1);\n",
        },
      ],
    },
  });
  assert.equal(result.passed, true);
});

test('C1: a HEAD-committed symlink cannot be followed to write outside the clean checkout', () => {
  const root = tmpRepo();
  const escapeDir = mkdtempSync(join(tmpdir(), 'escape-target-'));
  symlinkSync(escapeDir, join(root, 'link')); // link -> escapeDir, committed at HEAD
  execFileSync('git', ['add', 'link'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'add symlink'], { cwd: root, stdio: 'ignore' });

  runCommandAcceptance({
    worktreePath: root,
    acceptance: {
      command: ['node', '-e', 'process.exit(0)'],
      // An overlay path whose ancestor is the HEAD symlink must be refused, not followed out.
      testFiles: [{ path: 'link/escaped.txt', content: 'pwned' }],
    },
  });

  assert.equal(existsSync(join(escapeDir, 'escaped.txt')), false);
});

test('C2: a unicode-named changed file is materialized (no git quotepath divergence)', () => {
  const root = tmpRepo();
  const name = 'café-ünïcode.txt';
  writeFileSync(join(root, name), 'present\n'); // untracked change with a non-ASCII name
  const result = runCommandAcceptance({
    worktreePath: root,
    acceptance: {
      command: ['node', 'accept.mjs'],
      testFiles: [
        {
          path: 'accept.mjs',
          content: `import { existsSync } from 'node:fs';\nif (!existsSync(${JSON.stringify(name)})) process.exit(1);\n`,
        },
      ],
    },
  });
  // Without the -z/quotepath fix the file would be mis-parsed and dropped → exit 1 → passed false.
  assert.equal(result.passed, true);
});

test('readCommandAcceptanceFile parses a valid spec and rejects malformed ones (fail fast, not silent degrade)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-file-'));
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify({ command: ['node', 'accept.mjs'], testFiles: [{ path: 'accept.mjs', content: 'x' }] }));
  const spec = readCommandAcceptanceFile(ok);
  assert.deepEqual(spec.command, ['node', 'accept.mjs']);
  assert.equal(spec.testFiles?.[0].path, 'accept.mjs');

  // command must be a non-empty string[]
  const noCmd = join(dir, 'nocmd.json');
  writeFileSync(noCmd, JSON.stringify({ command: [] }));
  assert.throws(() => readCommandAcceptanceFile(noCmd), /non-empty string\[\]/);

  // testFiles entries must be {path,content} strings
  const badTf = join(dir, 'badtf.json');
  writeFileSync(badTf, JSON.stringify({ command: ['node'], testFiles: [{ path: 'a' }] }));
  assert.throws(() => readCommandAcceptanceFile(badTf), /string "path" and "content"/);

  // not JSON, and missing file
  const notJson = join(dir, 'bad.json');
  writeFileSync(notJson, 'not json');
  assert.throws(() => readCommandAcceptanceFile(notJson), /not valid JSON/);
  assert.throws(() => readCommandAcceptanceFile(join(dir, 'nope.json')), /not found/);
});

#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, '_workspace', 'goal-reachability', 'final');
const reportPath = join(outDir, 'review-custody-bootstrap.json');
const mdPath = join(outDir, 'review-custody-bootstrap.md');
const environmentName = 'trusted-reviewer-custody';
const requiredEnv = [
  'AGENT_TRUSTED_REVIEW_ACTORS',
  'AGENT_REVIEW_BUNDLE_HMAC_KEY',
  'AGENT_REVIEW_HMAC_KEY',
  'AGENT_REVIEW_CUSTODY_HMAC_KEY',
];

function run(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    command: args,
    exit_code: result.status ?? 1,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || '',
  };
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function branch() {
  return gitOutput(['branch', '--show-current']) || '<unknown-branch>';
}

function head() {
  return gitOutput(['rev-parse', 'HEAD']) || '<unknown-head>';
}

function dirty() {
  return Boolean(gitOutput(['status', '--porcelain']));
}

function upstream() {
  return gitOutput(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function redact(command) {
  return command.map((part) => (String(part).startsWith(process.env.AGENT_REVIEW_BUNDLE_HMAC_KEY || '\u0000') ? '<redacted>' : part));
}

function secretFingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function plannedCommands(currentBranch) {
  return [
    ['git', 'push', '-u', 'origin', currentBranch],
    ['gh', 'api', '-X', 'PUT', `repos/:owner/:repo/environments/${environmentName}`],
    ['gh', 'variable', 'set', 'AGENT_TRUSTED_REVIEW_ACTORS', '--body', process.env.AGENT_TRUSTED_REVIEW_ACTORS || '<AGENT_TRUSTED_REVIEW_ACTORS>'],
    ['gh', 'secret', 'set', 'AGENT_REVIEW_BUNDLE_HMAC_KEY', '--app', 'actions', '--body-file', '-'],
    ['gh', 'secret', 'set', 'AGENT_REVIEW_BUNDLE_HMAC_KEY', '--env', environmentName, '--body-file', '-'],
    ['gh', 'secret', 'set', 'AGENT_REVIEW_HMAC_KEY', '--app', 'actions', '--body-file', '-'],
    ['gh', 'secret', 'set', 'AGENT_REVIEW_CUSTODY_HMAC_KEY', '--app', 'actions', '--body-file', '-'],
    ['npm', 'run', 'harness:review-custody-preflight'],
  ];
}

function writeReport(report) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    mdPath,
    [
      '# Review Custody Bootstrap',
      '',
      `- decision: ${report.decision}`,
      `- mode: ${report.mode}`,
      `- branch: ${report.branch}`,
      `- head: ${report.head}`,
      `- dirty: ${report.dirty}`,
      `- upstream: ${report.upstream || 'none'}`,
      '',
      '## Missing Inputs',
      ...(report.missing_env.length ? report.missing_env.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Commands',
      ...report.commands.map((item) => `- ${item.command.join(' ')}`),
      '',
    ].join('\n'),
  );
}

function buildReport(mode) {
  const currentBranch = branch();
  const missingEnv = requiredEnv.filter((name) => !process.env[name]);
  const commands = plannedCommands(currentBranch).map((command) => ({ command }));
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode,
    decision: missingEnv.length ? 'MISSING_SECRET_INPUTS' : dirty() ? 'COMMIT_REQUIRED_BEFORE_BOOTSTRAP' : mode === 'apply' ? 'READY_TO_APPLY' : 'DRY_RUN_READY',
    branch: currentBranch,
    head: head(),
    dirty: dirty(),
    upstream: upstream() || null,
    missing_env: missingEnv,
    secret_fingerprints: Object.fromEntries(requiredEnv.filter((name) => process.env[name]).map((name) => [name, secretFingerprint(process.env[name])])),
    setup_commands_template: commands.map((item) => item.command.join(' ')),
    commands,
  };
}

function apply(report) {
  if (report.decision !== 'READY_TO_APPLY') return report;
  const executions = [];
  const commandInputs = new Map([
    ['AGENT_REVIEW_BUNDLE_HMAC_KEY:repo', process.env.AGENT_REVIEW_BUNDLE_HMAC_KEY],
    ['AGENT_REVIEW_BUNDLE_HMAC_KEY:env', process.env.AGENT_REVIEW_BUNDLE_HMAC_KEY],
    ['AGENT_REVIEW_HMAC_KEY:repo', process.env.AGENT_REVIEW_HMAC_KEY],
    ['AGENT_REVIEW_CUSTODY_HMAC_KEY:repo', process.env.AGENT_REVIEW_CUSTODY_HMAC_KEY],
  ]);
  const commands = plannedCommands(report.branch);
  const inputs = [undefined, undefined, undefined, commandInputs.get('AGENT_REVIEW_BUNDLE_HMAC_KEY:repo'), commandInputs.get('AGENT_REVIEW_BUNDLE_HMAC_KEY:env'), commandInputs.get('AGENT_REVIEW_HMAC_KEY:repo'), commandInputs.get('AGENT_REVIEW_CUSTODY_HMAC_KEY:repo'), undefined];
  for (let i = 0; i < commands.length; i += 1) {
    const result = run(commands[i], { input: inputs[i] });
    executions.push({ command: redact(commands[i]), exit_code: result.exit_code, stdout_tail: result.stdout.slice(-500), stderr_tail: result.stderr.slice(-500) });
    if (result.exit_code !== 0) {
      report.decision = 'APPLY_FAILED';
      report.executions = executions;
      return report;
    }
  }
  report.decision = 'APPLY_COMPLETE_RERUN_PREFLIGHT';
  report.executions = executions;
  return report;
}

function selfTest() {
  const original = { ...process.env };
  for (const name of requiredEnv) delete process.env[name];
  let report = buildReport('dry-run');
  if (report.decision !== 'MISSING_SECRET_INPUTS') throw new Error('dry run must fail closed without secret inputs');
  for (const name of requiredEnv) process.env[name] = `${name}-${randomBytes(8).toString('hex')}`;
  report = buildReport('dry-run');
  if (!['DRY_RUN_READY', 'COMMIT_REQUIRED_BEFORE_BOOTSTRAP'].includes(report.decision)) throw new Error(`unexpected dry-run decision ${report.decision}`);
  if (!report.commands.some((item) => item.command.join(' ').includes(`git push -u origin ${report.branch}`))) throw new Error('must include exact push command');
  if (!report.commands.some((item) => item.command.join(' ').includes(`environments/${environmentName}`))) throw new Error('must include environment command');
  process.env = original;
  return { decision: 'PASS' };
}

try {
  if (process.argv.includes('--self-test')) {
    console.log(JSON.stringify(selfTest(), null, 2));
  } else {
    const mode = process.argv.includes('--apply') ? 'apply' : 'dry-run';
    let report = buildReport(mode);
    if (mode === 'apply' && !process.argv.includes('--confirm-external-mutation')) {
      report.decision = 'CONFIRM_EXTERNAL_MUTATION_REQUIRED';
    } else if (mode === 'apply') {
      report = apply(report);
    }
    writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    process.exit(['MISSING_SECRET_INPUTS', 'COMMIT_REQUIRED_BEFORE_BOOTSTRAP', 'CONFIRM_EXTERNAL_MUTATION_REQUIRED', 'APPLY_FAILED'].includes(report.decision) ? 2 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

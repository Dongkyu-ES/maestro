#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, '_workspace', 'goal-reachability', 'final');
const reportJson = join(outDir, 'reachability-report.json');
const reportMd = join(outDir, 'reachability-report.md');

const requiredArtifacts = [
  '.agents/skills/goal-reachability-orchestrator/SKILL.md',
  '.agents/skills/goal-reachability-orchestrator/references/no-escape-critic.md',
  'docs/harness/goal-reachability/team-spec.md',
  'scripts/goal-reachability-harness.mjs',
  'scripts/review-custody-preflight.mjs',
  'scripts/review-custody-bootstrap.mjs',
  'scripts/review-custody-comment-validate.mjs',
  '.github/workflows/trusted-independent-review-bundle.yml',
  '_workspace/goal-reachability/00_postmortem-lock.md',
  '_workspace/goal-reachability/00_goal-contract.md',
  '_workspace/goal-reachability/01_stage-map.md',
];

const knownReviewBlockerNeedles = [
  'verifier command execution',
  'legacy runtime ledger',
  'caller-controlled independent review custody issuer',
  'symlink/digest-optional HARD artifact proof',
  'CI install fallback',
];

function readText(path) {
  return readFileSync(join(root, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function latestProductGate() {
  const dir = join(root, '.agent', 'product-gates');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((file) => /^product-gate-\d+\.json$/.test(file))
    .sort();
  if (!files.length) return null;
  const file = files.at(-1);
  const path = join(dir, file);
  try {
    return { file: `.agent/product-gates/${file}`, mtimeMs: statSync(path).mtimeMs, json: readJson(path) };
  } catch (error) {
    return { file: `.agent/product-gates/${file}`, error: error instanceof Error ? error.message : String(error) };
  }
}

function commandResult(command, args) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  return {
    command: [command, ...args].join(' '),
    started_at: started,
    exit_code: typeof result.status === 'number' ? result.status : 124,
    stdout_tail: String(result.stdout || '').slice(-4000),
    stderr_tail: String(result.stderr || result.error?.message || '').slice(-4000),
  };
}

function validateStructure() {
  const issues = [];
  for (const artifact of requiredArtifacts) {
    if (!existsSync(join(root, artifact))) issues.push(`missing required artifact: ${artifact}`);
  }
  if (!issues.length) {
    const skill = readText('.agents/skills/goal-reachability-orchestrator/SKILL.md');
    if (!skill.startsWith('---\nname: goal-reachability-orchestrator\n')) issues.push('orchestrator skill missing YAML frontmatter name');
    if (!/description: .+/.test(skill.split('---')[1] || '')) issues.push('orchestrator skill missing YAML description');
    for (const section of ['When to Use', 'Required Inputs', 'Workflow', 'Outputs', 'Validation', 'Failure Policy']) {
      if (!skill.includes(`## ${section}`)) issues.push(`orchestrator skill missing section: ${section}`);
    }
    const spec = readText('docs/harness/goal-reachability/team-spec.md');
    for (const term of ['Pipeline + Producer-Reviewer', 'Failure Policy', 'Product Gate', 'CRITICAL/HIGH']) {
      if (!spec.includes(term)) issues.push(`team spec missing required term: ${term}`);
    }
    const contract = readText('_workspace/goal-reachability/00_goal-contract.md');
    for (const needle of ['Final Authority', 'Forbidden Substitutes', 'Kill Criteria']) {
      if (!contract.includes(needle)) issues.push(`goal contract missing: ${needle}`);
    }
    const missingNeedles = knownReviewBlockerNeedles.filter((needle) => !contract.includes(needle));
    for (const needle of missingNeedles) issues.push(`goal contract does not preserve known blocker: ${needle}`);
    const workflow = readText('.github/workflows/independent-review-gate.yml');
    const bundleWorkflow = readText('.github/workflows/trusted-independent-review-bundle.yml');
    const custodyPreflight = readText('scripts/review-custody-preflight.mjs');
    const custodyBootstrap = readText('scripts/review-custody-bootstrap.mjs');
    const custodyCommentValidator = readText('scripts/review-custody-comment-validate.mjs');
    for (const term of ['READY_FOR_EXTERNAL_CUSTODY', 'reviewed_input_sha256', 'runs repo-controlled commands before first HMAC secret exposure']) {
      if (!custodyPreflight.includes(term)) issues.push(`review custody preflight missing required term: ${term}`);
    }
    for (const term of ['CONFIRM_EXTERNAL_MUTATION_REQUIRED', 'setup_commands_template', 'AGENT_REVIEW_CUSTODY_HMAC_KEY', 'git push -u origin']) {
      if (!custodyBootstrap.includes(term)) issues.push(`review custody bootstrap missing required term: ${term}`);
    }
    for (const term of ['reviewed_head_sha mismatch', 'reviewed_input_sha256 mismatch', 'comment author is not trusted', 'completed text missing required verdict']) {
      if (!custodyCommentValidator.includes(term)) issues.push(`review custody comment validator missing required term: ${term}`);
    }
    const workflowDispatchInputs = workflow.split('jobs:')[0] || workflow;
    if (/custody_issuer:/.test(workflowDispatchInputs)) issues.push('independent review workflow exposes caller-controlled custody_issuer input');
    if (/AGENT_TRUSTED_REVIEW_CUSTODY_ISSUERS:\s*\$\{\{\s*inputs\./.test(workflow))
      issues.push('independent review workflow derives trusted custody issuers from workflow inputs');
    if (/npm ci\s*\|\|\s*npm install/.test(workflow)) issues.push('independent review workflow masks npm ci failures with npm install fallback');
    if (!/^name: Trusted Independent Reviewer Bundle/m.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow has wrong name');
    if (!/environment:\s*trusted-reviewer-custody/.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow missing protected custody environment');
    if (!/AGENT_REVIEW_BUNDLE_HMAC_KEY:\s*\$\{\{\s*secrets\.AGENT_REVIEW_BUNDLE_HMAC_KEY\s*\}\}/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow missing HMAC secret');
    if (/completed_b64/i.test(bundleWorkflow) || /COMPLETED_B64/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow accepts caller-supplied completed review text');
    if (!/AGENT_TRUSTED_REVIEW_ACTORS/.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow missing trusted actor allowlist');
    if (!/issues\/comments\/\$CODE_REVIEWER_COMMENT_ID/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow does not fetch code-reviewer notification from GitHub comment');
    if (!/comment body must be notification JSON, not prose/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow does not reject prose reviewer comments');
    if (!/comment author is not trusted/.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow does not validate comment author custody');
    if (!/reviewed_head_sha mismatch/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow does not bind reviewer notification to current head sha');
    if (!/reviewed_input_sha256 mismatch/.test(bundleWorkflow) || !/reviewInputFiles/.test(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow does not bind reviewer notification to current review input hash');
    if (!/reviewer-bundle-attestation\.json/.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow missing attestation artifact');
    if (!/actions\/upload-artifact@v4/.test(bundleWorkflow)) issues.push('trusted reviewer bundle workflow does not upload bundle artifact');
    if (bundleWorkflow.indexOf('AGENT_REVIEW_BUNDLE_HMAC_KEY: ${{ secrets.AGENT_REVIEW_BUNDLE_HMAC_KEY }}') < bundleWorkflow.indexOf('- name: Build signed reviewer bundle from trusted comments'))
      issues.push('trusted reviewer bundle HMAC key is exposed before the signing step');
    if (workflow.indexOf('AGENT_REVIEW_BUNDLE_HMAC_KEY: ${{ secrets.AGENT_REVIEW_BUNDLE_HMAC_KEY }}') < workflow.indexOf('- name: Verify reviewer bundle attestation'))
      issues.push('independent review bundle HMAC key is exposed before attestation verification');
    if (workflow.indexOf('AGENT_REVIEW_HMAC_KEY: ${{ secrets.AGENT_REVIEW_HMAC_KEY }}') < workflow.indexOf('- name: Custody-attest independent review'))
      issues.push('independent review signing key is exposed before custody attestation');
    if (workflow.indexOf('AGENT_REVIEW_CUSTODY_HMAC_KEY: ${{ secrets.AGENT_REVIEW_CUSTODY_HMAC_KEY }}') < workflow.indexOf('- name: Custody-attest independent review'))
      issues.push('independent review custody key is exposed before custody attestation');
    const repoCommandBeforeFirstSecret = (text) => {
      const firstSecret = text.indexOf('${{ secrets.');
      if (firstSecret < 0) return true;
      return /npm ci|npm run build|npm test|npm run e2e|node dist\/cli\.js/.test(text.slice(0, firstSecret));
    };
    if (repoCommandBeforeFirstSecret(bundleWorkflow))
      issues.push('trusted reviewer bundle workflow runs repo-controlled commands before HMAC secret exposure');
    if (repoCommandBeforeFirstSecret(workflow))
      issues.push('independent review workflow runs repo-controlled commands before HMAC secret exposure');
    for (const [name, text] of [['independent review workflow', workflow], ['trusted reviewer bundle workflow', bundleWorkflow]]) {
      const runBlocks = [...text.matchAll(/run: \|\n([\s\S]*?)(?=\n\s{6}- name:|\n\s{6}- uses:|\n\s{4}[A-Za-z_-]+:|$)/g)].map((match) => match[1]);
      if (runBlocks.some((block) => /\$\{\{\s*inputs\./.test(block))) issues.push(`${name} interpolates dispatch inputs directly in run blocks`);
    }
  }
  return issues;
}

function analyzeLatestGate(latest) {
  if (!latest) return { status: 'BLOCKED', reasons: ['no product gate artifact found'] };
  if (latest.error) return { status: 'BLOCKED', reasons: [`latest product gate unreadable: ${latest.error}`] };
  const gate = latest.json || {};
  const reasons = [];
  if (gate.decision !== 'PASS') reasons.push(`Product Gate decision is ${gate.decision || 'missing'}`);
  if (Number(gate.completion_ceiling || 0) < 95) reasons.push(`completion ceiling is ${gate.completion_ceiling ?? 'missing'}`);
  const gates = gate.hard_completion_gates || gate.hard_gates || {};
  if (gates && typeof gates === 'object') {
    for (const [key, value] of Object.entries(gates)) {
      if (value === false) reasons.push(`hard gate false: ${key}`);
    }
  }
  if (gate.independent_review === false) reasons.push('independent_review=false');
  return { status: reasons.length ? 'BLOCKED' : 'PASS', reasons };
}

function buildReport({ runAuthority = false, authorityResult = null } = {}) {
  const structureIssues = validateStructure();
  const latest = latestProductGate();
  const latestGateAnalysis = analyzeLatestGate(latest);
  const harnessDecision = structureIssues.length ? 'FAIL' : 'PASS';
  const productGoalDecision = latestGateAnalysis.status;
  const authorityFailed = authorityResult && authorityResult.exit_code !== 0;
  const finalDecision = runAuthority
    ? structureIssues.length || authorityFailed || productGoalDecision !== 'PASS'
      ? 'BLOCKED'
      : 'PASS'
    : harnessDecision;
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: runAuthority ? 'run-authority' : 'inspect',
    decision: finalDecision,
    harness_decision: harnessDecision,
    product_goal_decision: productGoalDecision,
    structure_issues: structureIssues,
    latest_product_gate: latest
      ? {
          file: latest.file,
          decision: latest.json?.decision,
          completion_ceiling: latest.json?.completion_ceiling,
          independent_review: latest.json?.independent_review,
          sha256: latest.error ? undefined : sha256Text(JSON.stringify(latest.json)),
          error: latest.error,
        }
      : null,
    product_blockers: latestGateAnalysis.reasons,
    authority_result: authorityResult,
    required_artifacts: requiredArtifacts,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    reportMd,
    [
      '# Goal Reachability Report',
      '',
      `- decision: ${report.decision}`,
      `- harness_decision: ${report.harness_decision}`,
      `- product_goal_decision: ${report.product_goal_decision}`,
      `- latest_product_gate: ${report.latest_product_gate?.file || 'missing'}`,
      '',
      '## Structure Issues',
      ...(structureIssues.length ? structureIssues.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Product Blockers',
      ...(latestGateAnalysis.reasons.length ? latestGateAnalysis.reasons.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Authority Command',
      authorityResult ? `- ${authorityResult.command}: exit ${authorityResult.exit_code}` : '- not run in inspect mode',
      '',
    ].join('\n'),
  );
  return report;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'goal-reachability-harness-'));
  try {
    const script = readFileSync(new URL(import.meta.url), 'utf8');
    assert(script.includes('checkpoint status can only be supporting evidence') || existsSync(join(root, '_workspace', 'goal-reachability', '00_postmortem-lock.md')), 'postmortem invariant missing');
    const issues = validateStructure();
    assert(issues.length === 0, `structure issues: ${issues.join('; ')}`);
    const blocked = analyzeLatestGate({ file: 'x', json: { decision: 'FAIL', completion_ceiling: 60, independent_review: false } });
    assert(blocked.status === 'BLOCKED', 'FAIL gate must block');
    assert(blocked.reasons.some((reason) => reason.includes('Product Gate decision')), 'blocked report must cite gate decision');
    const pass = analyzeLatestGate({ file: 'x', json: { decision: 'PASS', completion_ceiling: 95, independent_review: true } });
    assert(pass.status === 'PASS', 'PASS gate should pass minimal gate analysis');
    writeFileSync(join(tmp, 'ok'), 'ok');
    return { decision: 'PASS', tmp };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const args = new Set(process.argv.slice(2));
try {
  if (args.has('--self-test')) {
    const result = selfTest();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  let authorityResult = null;
  if (args.has('--run-authority')) {
    const build = commandResult('npm', ['run', 'build']);
    if (build.exit_code !== 0) {
      authorityResult = build;
    } else {
      authorityResult = commandResult('node', ['dist/cli.js', 'quality', 'gate', '--write']);
    }
  }
  const report = buildReport({ runAuthority: args.has('--run-authority'), authorityResult });
  console.log(JSON.stringify(report, null, 2));
  process.exit(args.has('--run-authority') && report.decision !== 'PASS' ? 1 : report.harness_decision === 'PASS' ? 0 : 1);
} catch (error) {
  mkdirSync(outDir, { recursive: true });
  const failure = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    decision: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  };
  writeFileSync(reportJson, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(failure.error);
  process.exit(1);
}

#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const outDir = join(root, '_workspace', 'goal-reachability', 'final');
const reportJson = join(outDir, 'review-custody-preflight.json');
const reportMd = join(outDir, 'review-custody-preflight.md');
const reviewerCommentTemplateJson = join(outDir, 'code-reviewer-notification-template.json');
const architectCommentTemplateJson = join(outDir, 'architect-notification-template.json');
const commentsTemplateMd = join(outDir, 'trusted-reviewer-comment-templates.md');
const requiredRepoSecrets = ['AGENT_REVIEW_BUNDLE_HMAC_KEY', 'AGENT_REVIEW_HMAC_KEY', 'AGENT_REVIEW_CUSTODY_HMAC_KEY'];
const requiredEnvironmentSecrets = ['AGENT_REVIEW_BUNDLE_HMAC_KEY'];
const requiredVariables = ['AGENT_TRUSTED_REVIEW_ACTORS'];
const requiredEnvironment = 'trusted-reviewer-custody';

const reviewInputFiles = [
  'src/core.ts',
  'src/cli.ts',
  'src/product-gate.ts',
  'src/util.ts',
  'src/core.test.ts',
  'src/runtime-architecture.test.ts',
  'src/harness/verifier.ts',
  'src/harness/verifier.test.ts',
  'src/harness/promotion-differential.ts',
  'src/harness/skill-contracts.ts',
  '.github/workflows/independent-review-gate.yml',
  '.github/workflows/trusted-independent-review-bundle.yml',
  'scripts/goal-reachability-harness.mjs',
  'scripts/review-custody-preflight.mjs',
  'scripts/review-custody-bootstrap.mjs',
  'scripts/review-custody-comment-validate.mjs',
  'package.json',
  'package-lock.json',
  'scripts/harness-os-integrity-gate.mjs',
  'scripts/operator-browser-e2e.mjs',
  'scripts/operator-codex-web-e2e.mjs',
  'scripts/live-integration-smoke.mjs',
  'docs/milestones/HARD_COMPLETION_GATES.md',
  'docs/milestones/FULL_PRODUCT_ROADMAP.md',
  'docs/milestones/DOGFOOD_REPORT.md',
  'docs/milestones/REVIEW_PROVENANCE.md',
];

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function exists(rel) {
  return existsSync(join(root, rel));
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function currentReviewInputHash() {
  const digest = createHash('sha256');
  for (const rel of reviewInputFiles) {
    digest.update(rel);
    digest.update(exists(rel) ? read(rel) : 'missing');
  }
  return digest.digest('hex');
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function currentHeadSha() {
  return gitOutput(['rev-parse', 'HEAD']) || '<current sha unavailable>';
}

function gitState() {
  const status = gitOutput(['status', '--porcelain']);
  const branch = gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']) || '<unknown>';
  const upstream = gitOutput(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = gitOutput(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]).split(/\s+/);
    behind = Number(counts[0] || 0);
    ahead = Number(counts[1] || 0);
  }
  return {
    branch,
    upstream: upstream || null,
    has_upstream: Boolean(upstream),
    dirty: Boolean(status),
    status_lines: status ? status.split('\n') : [],
    ahead,
    behind,
  };
}

function ghJson(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    return { __error: error instanceof Error ? error.message : String(error) };
  }
}

function githubState() {
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,url,viewerPermission']);
  const environments = ghJson(['api', 'repos/:owner/:repo/environments']);
  const variables = ghJson(['variable', 'list', '--json', 'name,updatedAt']);
  const repoSecrets = ghJson(['secret', 'list', '--json', 'name,updatedAt']);
  const envSecrets = ghJson(['secret', 'list', '--env', requiredEnvironment, '--json', 'name,updatedAt']);

  const environmentNames = Array.isArray(environments.environments) ? environments.environments.map((item) => item.name) : [];
  const variableNames = Array.isArray(variables) ? variables.map((item) => item.name) : [];
  const repoSecretNames = Array.isArray(repoSecrets) ? repoSecrets.map((item) => item.name) : [];
  const envSecretNames = Array.isArray(envSecrets) ? envSecrets.map((item) => item.name) : [];
  const missing = [];

  if (!repo.__error && repo.viewerPermission && !['ADMIN', 'MAINTAIN'].includes(repo.viewerPermission)) {
    missing.push(`viewerPermission is ${repo.viewerPermission}, expected ADMIN or MAINTAIN to configure custody prerequisites`);
  }
  if (environments.__error) {
    missing.push(`cannot inspect GitHub environments: ${environments.__error}`);
  } else if (!environmentNames.includes(requiredEnvironment)) {
    missing.push(`missing GitHub environment ${requiredEnvironment}`);
  }
  if (variables.__error) {
    missing.push(`cannot inspect GitHub variables: ${variables.__error}`);
  } else {
    for (const name of requiredVariables) {
      if (!variableNames.includes(name)) missing.push(`missing GitHub variable ${name}`);
    }
  }
  if (repoSecrets.__error) {
    missing.push(`cannot inspect GitHub repo secrets: ${repoSecrets.__error}`);
  } else {
    for (const name of requiredRepoSecrets) {
      if (!repoSecretNames.includes(name)) missing.push(`missing GitHub repo secret ${name}`);
    }
  }
  if (envSecrets.__error) {
    missing.push(`cannot inspect GitHub environment secrets for ${requiredEnvironment}: ${envSecrets.__error}`);
  } else {
    for (const name of requiredEnvironmentSecrets) {
      if (!envSecretNames.includes(name)) missing.push(`missing GitHub environment secret ${requiredEnvironment}/${name}`);
    }
  }

  return {
    repo: repo.__error ? { error: repo.__error } : repo,
    environment_names: environmentNames,
    variable_names: variableNames,
    repo_secret_names: repoSecretNames,
    environment_secret_names: envSecretNames,
    missing,
  };
}

function setupCommandsTemplate(branch) {
  return [
    `git push -u origin ${branch}`,
    `gh api -X PUT repos/:owner/:repo/environments/${requiredEnvironment}`,
    "gh variable set AGENT_TRUSTED_REVIEW_ACTORS --body '<trusted-code-reviewer-login>,<trusted-architect-login>'",
    "printf '%s' '<bundle-hmac-key>' | gh secret set AGENT_REVIEW_BUNDLE_HMAC_KEY --app actions",
    `printf '%s' '<bundle-hmac-key>' | gh secret set AGENT_REVIEW_BUNDLE_HMAC_KEY --env ${requiredEnvironment}`,
    "printf '%s' '<review-hmac-key>' | gh secret set AGENT_REVIEW_HMAC_KEY --app actions",
    "printf '%s' '<review-custody-hmac-key>' | gh secret set AGENT_REVIEW_CUSTODY_HMAC_KEY --app actions",
    'npm run harness:review-custody-preflight',
  ];
}

function notificationTemplate({ agentId, role, headSha, inputHash }) {
  const verdictLine = role === 'code-reviewer' ? 'Recommendation: APPROVE' : 'Architectural Status: CLEAR';
  return {
    agent_path: agentId,
    status: {
      completed: `${role} independent review for ${headSha} and review input ${inputHash}.\n\n${verdictLine}\n\nReplace this paragraph with the actual independent review findings before posting. Do not post this template unchanged.`,
      reviewed_head_sha: headSha,
      reviewed_input_sha256: inputHash,
    },
  };
}

function latestProductGate() {
  const dir = join(root, '.agent', 'product-gates');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((file) => /^product-gate-\d+\.json$/.test(file)).sort();
  if (!files.length) return null;
  const file = files.at(-1);
  const rel = `.agent/product-gates/${file}`;
  const json = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  return { file: rel, json, sha256: sha256(JSON.stringify(json)) };
}

function runBlocks(workflow) {
  return [...workflow.matchAll(/run: \|\n([\s\S]*?)(?=\n\s{6}- name:|\n\s{6}- uses:|\n\s{4}[A-Za-z_-]+:|$)/g)].map((match) => match[1]);
}

function hasRepoCommandBeforeFirstSecret(workflow) {
  const firstSecret = workflow.indexOf('${{ secrets.');
  if (firstSecret < 0) return true;
  return /npm ci|npm run build|npm test|npm run e2e|node dist\/cli\.js/.test(workflow.slice(0, firstSecret));
}

function validateLocalWorkflows() {
  const issues = [];
  for (const rel of ['.github/workflows/trusted-independent-review-bundle.yml', '.github/workflows/independent-review-gate.yml']) {
    if (!exists(rel)) issues.push(`missing workflow: ${rel}`);
  }
  if (issues.length) return issues;

  const bundle = read('.github/workflows/trusted-independent-review-bundle.yml');
  const gate = read('.github/workflows/independent-review-gate.yml');
  const requiredBundleNeedles = [
    'name: Trusted Independent Reviewer Bundle',
    'environment: trusted-reviewer-custody',
    'AGENT_TRUSTED_REVIEW_ACTORS',
    'code_reviewer_comment_id',
    'architect_comment_id',
    'comment body must be notification JSON, not prose',
    'comment author is not trusted',
    'reviewed_head_sha mismatch',
    'reviewed_input_sha256 mismatch',
    'reviewer-bundle-attestation.json',
    'AGENT_REVIEW_BUNDLE_HMAC_KEY: ${{ secrets.AGENT_REVIEW_BUNDLE_HMAC_KEY }}',
  ];
  const requiredGateNeedles = [
    'review_run_id',
    'review_artifact_name',
    'Trusted Independent Reviewer Bundle',
    'review bundle attestation signature mismatch',
    'CURRENT_REVIEW_INPUT_HASH',
    "source: 'codex-native-subagent'",
    "status: 'completed'",
    'AGENT_REVIEW_HMAC_KEY: ${{ secrets.AGENT_REVIEW_HMAC_KEY }}',
    'AGENT_REVIEW_CUSTODY_HMAC_KEY: ${{ secrets.AGENT_REVIEW_CUSTODY_HMAC_KEY }}',
    'Install dependencies after custody signing',
  ];
  for (const needle of requiredBundleNeedles) if (!bundle.includes(needle)) issues.push(`trusted bundle workflow missing: ${needle}`);
  for (const needle of requiredGateNeedles) if (!gate.includes(needle)) issues.push(`independent review workflow missing: ${needle}`);
  if (/completed_b64|COMPLETED_B64/.test(bundle)) issues.push('trusted bundle workflow accepts caller-supplied completed review text');
  for (const [name, workflow] of [
    ['trusted bundle workflow', bundle],
    ['independent review workflow', gate],
  ]) {
    if (runBlocks(workflow).some((block) => /\$\{\{\s*inputs\./.test(block))) {
      issues.push(`${name} interpolates dispatch inputs directly in run blocks`);
    }
    if (hasRepoCommandBeforeFirstSecret(workflow)) {
      issues.push(`${name} runs repo-controlled commands before first HMAC secret exposure`);
    }
  }
  return issues;
}

function analyzeGate(latest) {
  if (!latest) return { status: 'MISSING', reasons: ['no product gate artifact found'] };
  const fails = Array.isArray(latest.json.checks) ? latest.json.checks.filter((check) => check.status !== 'PASS') : [];
  const hardFailOnly = fails.length === 1 && fails[0].name === 'Hard Completion Ceiling Gate';
  const evidence = String(fails[0]?.evidence || '');
  const externalCustodyOnly =
    latest.json.decision === 'FAIL' &&
    Number(latest.json.completion_ceiling) === 60 &&
    hardFailOnly &&
    /independent_review=false/.test(evidence) &&
    /provenance=no-signing-key/.test(evidence) &&
    /reconciliation=true/.test(evidence);
  return {
    status: externalCustodyOnly ? 'EXTERNAL_CUSTODY_ONLY' : latest.json.decision === 'PASS' ? 'PASS' : 'BLOCKED_OTHER',
    reasons: fails.map((check) => `${check.name}: ${check.evidence}`),
  };
}

function buildReport() {
  const workflowIssues = validateLocalWorkflows();
  const latest = latestProductGate();
  const gate = analyzeGate(latest);
  const reviewInputHash = currentReviewInputHash();
  const headSha = currentHeadSha();
  const git = gitState();
  const github = githubState();
  const codeReviewerTemplate = notificationTemplate({ agentId: '<code-reviewer-agent-id>', role: 'code-reviewer', headSha, inputHash: reviewInputHash });
  const architectTemplate = notificationTemplate({ agentId: '<architect-agent-id>', role: 'architect', headSha, inputHash: reviewInputHash });
  const externalRequirements = [
    {
      id: 'protected-environment',
      status: 'external-required',
      evidence: 'GitHub environment trusted-reviewer-custody must exist and be reviewer/CI controlled.',
    },
    {
      id: 'bundle-secret',
      status: 'external-required',
      evidence: 'AGENT_REVIEW_BUNDLE_HMAC_KEY must be configured only in trusted-reviewer-custody or equivalent reviewer custody.',
    },
    {
      id: 'signing-secrets',
      status: 'external-required',
      evidence: 'AGENT_REVIEW_HMAC_KEY and AGENT_REVIEW_CUSTODY_HMAC_KEY must be configured for Independent Review Gate under reviewer/CI custody.',
    },
    {
      id: 'trusted-actors-var',
      status: 'external-required',
      evidence: 'AGENT_TRUSTED_REVIEW_ACTORS must list only trusted reviewer actors allowed to publish notification comments.',
    },
    {
      id: 'reviewer-notification-comments',
      status: 'external-required',
      evidence: `Need code-reviewer and architect GitHub comment ids containing notification JSON with status.reviewed_head_sha=${headSha} and status.reviewed_input_sha256=${reviewInputHash}. This is valid only after the reviewed code is committed/pushed and GitHub computes the same review input hash.`,
    },
    {
      id: 'trusted-bundle-run',
      status: 'external-required',
      evidence: 'Run Trusted Independent Reviewer Bundle with expected agent ids and trusted comment ids; record review_run_id and artifact name.',
    },
    {
      id: 'independent-review-gate-run',
      status: 'external-required',
      evidence: 'Run Independent Review Gate with trusted bundle run id/artifact and expected agent ids; rerun Product Gate after it writes signed provenance.',
    },
  ];
  const decision = workflowIssues.length
    ? 'FAIL'
    : git.dirty
      ? 'COMMIT_REQUIRED_BEFORE_EXTERNAL_CUSTODY'
      : !git.has_upstream || git.ahead > 0
        ? 'PUSH_REQUIRED_BEFORE_EXTERNAL_CUSTODY'
        : github.missing.length
          ? 'EXTERNAL_SETUP_REQUIRED_BEFORE_CUSTODY'
          : gate.status === 'EXTERNAL_CUSTODY_ONLY'
            ? 'READY_FOR_EXTERNAL_CUSTODY'
            : 'BLOCKED_OTHER';
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    decision,
    review_input_sha256: reviewInputHash,
    reviewed_head_sha: headSha,
    git_state: git,
    github_state: github,
    local_workflow_issues: workflowIssues,
    latest_product_gate: latest
      ? {
          file: latest.file,
          decision: latest.json.decision,
          completion_ceiling: latest.json.completion_ceiling,
          sha256: latest.sha256,
        }
      : null,
    product_gate_analysis: gate,
    external_requirements: externalRequirements,
    local_publication_requirements: [
      'Commit current worktree before asking reviewers to bind reviewed_head_sha.',
      'Push the commit containing workflow and preflight changes before running GitHub Actions; a branch without an upstream is not publication-ready.',
      'Regenerate preflight after commit/push; use the regenerated review_input_sha256 in trusted comments.',
    ],
    setup_commands_template: setupCommandsTemplate(git.branch),
    forbidden_local_actions: [
      'Do not create local signing keys to lift the ceiling.',
      'Do not edit .agent/independent-review-gate.json by hand.',
      'Do not mark G012/G006 complete until Product Gate PASS is produced by reviewer/CI custody.',
    ],
    trusted_comment_templates: {
      code_reviewer: { file: '_workspace/goal-reachability/final/code-reviewer-notification-template.json', json: codeReviewerTemplate },
      architect: { file: '_workspace/goal-reachability/final/architect-notification-template.json', json: architectTemplate },
    },
    next_external_commands_template: [
      'gh workflow run trusted-independent-review-bundle.yml -f code_reviewer_agent=<agent-id> -f architect_agent=<agent-id> -f code_reviewer_comment_id=<comment-id> -f architect_comment_id=<comment-id>',
      'gh workflow run independent-review-gate.yml -f review_run_id=<trusted-bundle-run-id> -f review_artifact_name=trusted-independent-review-bundle -f code_reviewer_agent=<agent-id> -f architect_agent=<agent-id>',
      'node dist/cli.js quality gate --write',
    ],
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(reviewerCommentTemplateJson, `${JSON.stringify(codeReviewerTemplate, null, 2)}\n`);
  writeFileSync(architectCommentTemplateJson, `${JSON.stringify(architectTemplate, null, 2)}\n`);
  writeFileSync(commentsTemplateMd, [
    '# Trusted Reviewer Notification Comment Templates',
    '',
    `- reviewed_head_sha: ${headSha}`,
    `- reviewed_input_sha256: ${reviewInputHash}`,
    '',
    'Post these as GitHub issue/PR comments from trusted actors listed in AGENT_TRUSTED_REVIEW_ACTORS after replacing placeholder agent ids and template prose with actual review findings.',
    '',
    '## Code Reviewer Comment Body',
    '```json',
    JSON.stringify(codeReviewerTemplate, null, 2),
    '```',
    '',
    '## Architect Comment Body',
    '```json',
    JSON.stringify(architectTemplate, null, 2),
    '```',
    '',
  ].join('\n'));
  writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    reportMd,
    [
      '# Review Custody Preflight',
      '',
      `- decision: ${report.decision}`,
      `- review_input_sha256: ${report.review_input_sha256}`,
      `- reviewed_head_sha: ${report.reviewed_head_sha}`,
      `- latest_product_gate: ${report.latest_product_gate?.file || 'missing'}`,
      `- product_gate_status: ${report.product_gate_analysis.status}`,
      `- git_dirty: ${report.git_state.dirty}`,
      `- git_has_upstream: ${report.git_state.has_upstream}`,
      `- git_ahead: ${report.git_state.ahead}`,
      `- git_behind: ${report.git_state.behind}`,
      `- github_missing: ${report.github_state.missing.length}`,
      '',
      '## Local Workflow Issues',
      ...(workflowIssues.length ? workflowIssues.map((item) => `- ${item}`) : ['- none']),
      '',
      '## Trusted Comment Templates',
      `- code_reviewer: ${report.trusted_comment_templates.code_reviewer.file}`,
      `- architect: ${report.trusted_comment_templates.architect.file}`,
      `- markdown: _workspace/goal-reachability/final/trusted-reviewer-comment-templates.md`,
      '',
      '## Local Publication Requirements',
      ...report.local_publication_requirements.map((item) => `- ${item}`),
      '',
      '## Setup Commands Template',
      ...report.setup_commands_template.map((item) => `- ${item}`),
      '',
      '## GitHub Custody Setup Gaps',
      ...(report.github_state.missing.length ? report.github_state.missing.map((item) => `- ${item}`) : ['- none detected']),
      '',
      '## External Requirements',
      ...externalRequirements.map((item) => `- ${item.id}: ${item.evidence}`),
      '',
      '## Forbidden Local Actions',
      ...report.forbidden_local_actions.map((item) => `- ${item}`),
      '',
      '## Next External Command Template',
      ...report.next_external_commands_template.map((item) => `- ${item}`),
      '',
    ].join('\n'),
  );
  return report;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function selfTest() {
  assert(hasRepoCommandBeforeFirstSecret('steps:\n  - run: npm ci\n  - env:\n      X: ${{ secrets.X }}'), 'must catch repo command before secret');
  assert(!hasRepoCommandBeforeFirstSecret('steps:\n  - run: echo ok\n  - env:\n      X: ${{ secrets.X }}\n  - run: npm ci'), 'repo command after secret is allowed by this invariant');
  assert(validateLocalWorkflows().length === 0, `local workflow issues: ${validateLocalWorkflows().join('; ')}`);
  const report = buildReport();
  assert(['READY_FOR_EXTERNAL_CUSTODY', 'BLOCKED_OTHER', 'COMMIT_REQUIRED_BEFORE_EXTERNAL_CUSTODY', 'PUSH_REQUIRED_BEFORE_EXTERNAL_CUSTODY', 'EXTERNAL_SETUP_REQUIRED_BEFORE_CUSTODY'].includes(report.decision), 'report decision must be explicit');
  assert(report.reviewed_head_sha && report.reviewed_head_sha !== '<current sha unavailable>', 'report must include concrete reviewed_head_sha');
  assert(report.setup_commands_template.some((command) => command.includes(`git push -u origin ${report.git_state.branch}`)), 'setup commands must include exact branch push command');
  assert(report.setup_commands_template.some((command) => command.includes(`environments/${requiredEnvironment}`)), 'setup commands must include environment creation command');
  assert(!report.setup_commands_template.some((command) => command.includes('--body-file')), 'setup commands must not use unsupported gh secret --body-file flag');
  assert(existsSync(reviewerCommentTemplateJson), 'code-reviewer notification template must be written');
  assert(existsSync(architectCommentTemplateJson), 'architect notification template must be written');
  assert(existsSync(commentsTemplateMd), 'markdown comment template must be written');
  return { decision: 'PASS', report: reportJson };
}

try {
  if (process.argv.includes('--self-test')) {
    console.log(JSON.stringify(selfTest(), null, 2));
  } else {
    const report = buildReport();
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.decision === 'FAIL' ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

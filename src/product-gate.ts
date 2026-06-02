import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { activeStatus, rebuildIndex, reconcileRuns } from './core.js';
import {
  AGENT_DIR,
  ensureDir,
  nowIso,
  projectRoot,
  type RunMeta,
  readYaml,
  reviewProvenanceKey,
  reviewProvenanceSignature,
  safeJoin,
  sha256Text,
} from './util.js';

export interface ProductGateCheck {
  name: string;
  status: 'PASS' | 'FAIL';
  evidence: string;
}
export interface ProductGateDelta {
  target: string;
  evidence: string;
  delta: string;
  status: 'PASS' | 'FAIL';
}
export interface ProductGateReport {
  schema_version: number;
  generated_at: string;
  decision: 'PASS' | 'FAIL';
  scope: string;
  completion_ceiling: number;
  completion_label: string;
  result_reality_delta: ProductGateDelta[];
  checks: ProductGateCheck[];
  report_path?: string;
}
function hasAll(text: string, needles: string[]): boolean {
  return needles.every((needle) => text.includes(needle));
}
function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
function gateCheck(name: string, ok: boolean, evidence: string): ProductGateCheck {
  return { name, status: ok ? 'PASS' : 'FAIL', evidence };
}
function jsonIfExists(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
}
function commandEvidence(root: string, args: string[], mustInclude: string[]): boolean {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    return mustInclude.every((needle) => out.includes(needle));
  } catch {
    return false;
  }
}
function markdownTableRows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => /^\|.*\|$/.test(line.trim()) && !/^\|\s*-/.test(line.trim()))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
}
function hasPassingMatrixRows(roadmap: string, requiredAreas: string[]): boolean {
  const rows = markdownTableRows(roadmap);
  return (
    requiredAreas.every((area) => rows.some((row) => row[0] === area && row.at(-1) === 'PASS')) &&
    !rows.some((row) => row.at(-1) === 'FAIL')
  );
}
function countTests(testText: string): number {
  return [...testText.matchAll(/\btest\(/g)].length;
}

export function currentReviewInputHash(root: string): string {
  const digest = createHash('sha256');
  for (const rel of [
    'src/core.ts',
    'src/cli.ts',
    'src/core.test.ts',
    'scripts/live-integration-smoke.mjs',
    'docs/milestones/HARD_COMPLETION_GATES.md',
    'docs/milestones/FULL_PRODUCT_ROADMAP.md',
    'docs/milestones/DOGFOOD_REPORT.md',
  ]) {
    const p = join(root, rel);
    digest.update(rel);
    digest.update(existsSync(p) ? readFileSync(p) : 'missing');
  }
  return digest.digest('hex');
}
function reviewArtifactOk(root: string, reviewGate: any): boolean {
  if (!reviewGate || reviewGate.status !== 'PASS') return false;
  const inputHash = currentReviewInputHash(root);
  if (reviewGate.input_sha256 !== inputHash) return false;
  const cr = reviewGate.codeReview;
  if (cr?.recommendation !== 'APPROVE' || cr?.architectStatus !== 'CLEAR') return false;
  const reviewer = cr.independentReview?.codeReviewer;
  const architect = cr.independentReview?.architect;
  const reviewerPath = reviewer?.artifact_path;
  const architectPath = architect?.artifact_path;
  if (!reviewerPath || !architectPath || reviewerPath === architectPath) return false;
  const invalidReviewText = (text: string): boolean =>
    /\b(fake|placeholder|stub|dummy|todo|lorem)\b/i.test(text) || text.trim().split(/\s+/).length < 25;
  const validAgentId = (id: unknown): boolean =>
    typeof id === 'string' && /^019[a-f0-9]{5}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
  const validIso = (x: unknown): boolean => typeof x === 'string' && !Number.isNaN(Date.parse(x));
  const reviewerFull = join(root, reviewerPath);
  const architectFull = join(root, architectPath);
  if (
    typeof reviewerPath !== 'string' ||
    typeof architectPath !== 'string' ||
    reviewerPath.startsWith('/') ||
    architectPath.startsWith('/') ||
    reviewerPath.includes('..') ||
    architectPath.includes('..')
  )
    return false;
  if (!existsSync(reviewerFull) || !existsSync(architectFull)) return false;
  const reviewerText = readFileSync(reviewerFull, 'utf8');
  const architectText = readFileSync(architectFull, 'utf8');
  const reviewerSha = sha256Text(reviewerText);
  const architectSha = sha256Text(architectText);
  if (invalidReviewText(reviewerText) || invalidReviewText(architectText)) return false;
  if (!/code-reviewer/i.test(reviewerText) || !/recommendation\s*:\s*APPROVE/i.test(reviewerText)) return false;
  if (!/architect/i.test(architectText) || !/architectural status\s*:\s*CLEAR/i.test(architectText)) return false;
  for (const [entry, role, sha] of [
    [reviewer, 'code-reviewer', reviewerSha],
    [architect, 'architect', architectSha],
  ] as const) {
    if (entry?.agentRole !== role) return false;
    if (entry?.artifact_sha256 !== sha) return false;
    if (entry?.reviewed_input_sha256 !== inputHash) return false;
    if (!validAgentId(entry?.agent_id)) return false;
    if (entry?.source !== 'codex-native-subagent') return false;
    if (entry?.status !== 'completed') return false;
    if (!validIso(entry?.completed_at)) return false;
    if (!Array.isArray(entry?.commands) || entry.commands.length < 2) return false;
    const notificationPath = entry?.notification_path;
    if (typeof notificationPath !== 'string' || notificationPath.startsWith('/') || notificationPath.includes('..'))
      return false;
    const notification = jsonIfExists(join(root, notificationPath));
    const completedText = String(notification?.status?.completed || '');
    if (notification?.agent_path !== entry.agent_id) return false;
    if (sha256Text(completedText) !== sha) return false;
    if (completedText !== (role === 'code-reviewer' ? reviewerText : architectText)) return false;
    if (role === 'code-reviewer' && !/Recommendation\s*:\s*APPROVE/i.test(completedText)) return false;
    if (role === 'architect' && !/Architectural Status\s*:\s*CLEAR/i.test(completedText)) return false;
  }
  const key = reviewProvenanceKey();
  if (!key) return false;
  const prov = reviewGate.provenance;
  if (prov?.algorithm !== 'HMAC-SHA256' || typeof prov?.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(prov.signature))
    return false;
  const expected = reviewProvenanceSignature(key, inputHash, reviewerSha, architectSha);
  const actualBuf = Buffer.from(prov.signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) return false;
  return true;
}
function hardGateRows(text: string): { total: number; fail: number; pass: number } {
  const rows = markdownTableRows(text).filter((row) => row.length >= 3 && row[0] !== 'Gate');
  return {
    total: rows.length,
    fail: rows.filter((row) => row.at(-1) === 'FAIL').length,
    pass: rows.filter((row) => row.at(-1) === 'PASS').length,
  };
}
function contradictoryRunEvidence(root: string): string[] {
  const dir = join(root, AGENT_DIR, 'runs');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const runId of readdirSync(dir)
    .filter((f) => existsSync(join(dir, f, 'run.yaml')))
    .sort()) {
    const runDir = join(dir, runId);
    const meta = readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta;
    const hasEnded = Boolean(meta.ended_at);
    const hasCancel = existsSync(join(runDir, 'cancel.requested'));
    const hasProcess = readdirSync(runDir).some((f) => f.endsWith('.process.json'));
    if (activeStatus(meta.status) && (hasEnded || hasCancel))
      out.push(`${runId}: active status ${meta.status} with ended/cancel evidence`);
    if (meta.status === 'created' && hasProcess) out.push(`${runId}: created status with process evidence`);
    const cmdPath = join(runDir, 'executor-command.txt');
    const cmd = readIfExists(cmdPath).trim();
    if (/^(진행해|다시|해봐|좋아|ㅇㅋ|오케이)(\s|$)/.test(cmd))
      out.push(`${runId}: natural-language operator reply captured as command (${cmd.slice(0, 40)})`);
  }
  return out;
}

function dogfoodEvidence(
  rootDir: string,
  dogfood: string,
): { ok: boolean; root: string; basicRun: string; multiRun: string; approval: string; evidence: string } {
  const root = dogfood.match(/root=([^\s]+)/)?.[1] || '';
  const basicRun = dogfood.match(/basic_run=([^\s]+)/)?.[1] || '';
  const multiRun = dogfood.match(/multi_run=([^\s]+)/)?.[1] || '';
  const approval = dogfood.match(/approval=([^\s]+)/)?.[1] || '';
  const basicDir = root && basicRun ? join(root, AGENT_DIR, 'runs', basicRun) : '';
  const multiDir = root && multiRun ? join(root, AGENT_DIR, 'runs', multiRun) : '';
  const approvalPath = root && approval ? join(root, AGENT_DIR, 'approvals', `${approval}.json`) : '';
  const basicYaml = basicDir && existsSync(join(basicDir, 'run.yaml')) ? readYaml(join(basicDir, 'run.yaml')) : {};
  const multiYaml = multiDir && existsSync(join(multiDir, 'run.yaml')) ? readYaml(join(multiDir, 'run.yaml')) : {};
  const basicProcess = basicDir ? jsonIfExists(join(basicDir, 'executor.process.json')) : null;
  const scheduler = multiDir ? jsonIfExists(join(multiDir, 'scheduler.json')) : null;
  const approvalJson = approvalPath ? jsonIfExists(approvalPath) : null;
  const manifestPath = approvalJson?.proposal_path
    ? join(root, String(approvalJson.proposal_path), 'manifest.json')
    : '';
  const manifest = manifestPath ? jsonIfExists(manifestPath) : null;
  const patchFiles =
    manifestPath && Array.isArray(manifest?.patches)
      ? manifest.patches.map((patch: string) => join(dirname(manifestPath), patch))
      : [];
  const basicOk =
    basicYaml.id === basicRun &&
    basicYaml.mode === 'basic' &&
    basicYaml.status === 'completed' &&
    basicYaml.decision === 'pass' &&
    Number(basicYaml.exit_code) === 0 &&
    basicProcess?.label === 'executor' &&
    Number(basicProcess?.exit_code) === 0 &&
    String(basicProcess?.stdout || '').includes('Dominic Orchestration task adapter executed') &&
    /## Decision\npass/.test(readIfExists(join(basicDir, 'review.md')));
  const multiOk =
    multiYaml.id === multiRun &&
    multiYaml.mode === 'multi' &&
    multiYaml.status === 'completed' &&
    multiYaml.decision === 'pass' &&
    Number(multiYaml.exit_code) === 0 &&
    Number(multiYaml.max_workers) >= 2 &&
    scheduler?.strategy === 'bounded-parallel' &&
    Array.isArray(scheduler?.workers) &&
    scheduler.workers.length >= 2 &&
    Boolean(scheduler?.ended_at) &&
    /Status: clear/.test(readIfExists(join(multiDir, 'conflict-report.generated.md'))) &&
    /worker-001/.test(readIfExists(join(multiDir, 'conflict-report.generated.md'))) &&
    /worker-002/.test(readIfExists(join(multiDir, 'conflict-report.generated.md')));
  const patchesOk =
    patchFiles.length >= 1 &&
    patchFiles.every(
      (patch: string) => existsSync(patch) && readFileSync(patch, 'utf8').trim().startsWith('diff --git '),
    );
  const patchDigest = patchesOk
    ? (() => {
        const digest = createHash('sha256');
        for (const patch of patchFiles) digest.update(readFileSync(patch));
        return digest.digest('hex');
      })()
    : '';
  const applyOk =
    approvalJson?.id === approval &&
    approvalJson?.run_id === multiRun &&
    approvalJson?.type === 'apply_proposal' &&
    ['approved', 'applied'].includes(String(approvalJson?.status)) &&
    manifest?.run_id === multiRun &&
    /^[a-f0-9]{64}$/.test(String(manifest?.sha256 || '')) &&
    manifest?.sha256 === approvalJson?.proposal_sha256 &&
    manifest?.sha256 === patchDigest &&
    patchesOk;
  const legacyOk = Boolean(root && basicRun && multiRun && approval && basicOk && multiOk && applyOk);
  const liveReport = jsonIfExists(join(rootDir, AGENT_DIR, 'live-integration-smoke.json'));
  const liveOk =
    liveReport?.status === 'PASS' &&
    typeof liveReport?.run_id === 'string' &&
    liveReport?.exit_code === 0 &&
    liveReport?.decision === 'pass' &&
    liveReport?.natural_language_ignored === true &&
    liveReport?.ui_permission_boundary === true;
  const ok = legacyOk || liveOk;
  const reasons = [
    basicOk ? '' : 'basic run content invalid',
    multiOk ? '' : 'multi run content invalid',
    applyOk ? '' : 'apply proposal content invalid',
  ]
    .filter(Boolean)
    .join('; ');
  return {
    ok,
    root,
    basicRun,
    multiRun,
    approval,
    evidence: legacyOk
      ? `resolved coherent dogfood artifacts at ${root}`
      : liveOk
        ? `resolved live web/CLI integration artifact ${join(AGENT_DIR, 'live-integration-smoke.json')}`
        : `missing/unresolved dogfood artifacts root=${root || 'missing'} basic=${basicRun || 'missing'} multi=${multiRun || 'missing'} approval=${approval || 'missing'} ${reasons}`.trim(),
  };
}
function deltaRow(
  target: string,
  ok: boolean,
  evidence: string,
  passDelta: string,
  failDelta: string,
): ProductGateDelta {
  return { target, evidence, delta: ok ? passDelta : failDelta, status: ok ? 'PASS' : 'FAIL' };
}
export function runProductGate(cwd = process.cwd(), options: { write?: boolean } = {}): ProductGateReport {
  const root = projectRoot(cwd);
  const liveReconciliation = reconcileRuns(root);
  const prd = readIfExists(join(root, 'dominic_orchestration_PRD.md'));
  const standard = readIfExists(join(root, 'docs', 'milestones', 'PRODUCT_COMPLETION_STANDARD.md'));
  const roadmap = readIfExists(join(root, 'docs', 'milestones', 'FULL_PRODUCT_ROADMAP.md'));
  const rerun = readIfExists(join(root, 'docs', 'milestones', 'PRODUCT_GATE_RERUN_REPORT.md'));
  const dogfood = readIfExists(join(root, 'docs', 'milestones', 'DOGFOOD_REPORT.md'));
  const hardGates = readIfExists(join(root, 'docs', 'milestones', 'HARD_COMPLETION_GATES.md'));
  const packageJson = jsonIfExists(join(root, 'package.json'));
  const tests = readIfExists(join(root, 'src', 'core.test.ts'));
  const helpOk =
    existsSync(join(root, 'dist', 'cli.js')) &&
    commandEvidence(
      root,
      ['dist/cli.js', '--help'],
      ['agent quality gate [--write]', 'agent run create|start|collect|cancel|latest', 'agent apply propose|approved'],
    );
  const versionOk =
    existsSync(join(root, 'dist', 'cli.js')) &&
    commandEvidence(root, ['dist/cli.js', '--version'], ['dominic-orchestration']);
  const requiredRows = [
    'Installable CLI',
    'Web UI',
    'Project registry',
    'Durable index',
    'v0 run lifecycle',
    'v1 role execution',
    'Executor adapter',
    'Policy/approval',
    'Promotion proposals',
    'v2 scheduler',
    'v2 worktrees',
    'Conflict detection',
    'Apply/merge proposal',
    'Dogfood',
    'Scope integrity',
    'Anti-self-deception critic',
  ];
  const reportHasDelta = hasAll(rerun, [
    'Result-Reality Delta',
    '| Original PRD / v0-v2 target | Current runnable evidence | Delta |',
    'Forbidden completion claim',
    'Allowed completion claim',
  ]);
  const prdScopeOk = hasAll(prd, [
    '로컬 웹서비스',
    '로컬 에이전트 작업',
    'v0: Single Run + Review',
    'v1: Manager + Worker + Reviewer',
    'v2: Bounded Multi-Worker',
  ]);
  const acceptanceOk = hasPassingMatrixRows(roadmap, requiredRows);
  const dogfoodResolved = dogfoodEvidence(root, dogfood);
  const executionOk =
    dogfoodResolved.ok &&
    (hasAll(dogfood, ['FINAL_PRODUCT_SMOKE_PASS', 'basic_run=', 'multi_run=', 'approval=']) ||
      hasAll(dogfood, ['LIVE_INTEGRATION_SMOKE_PASS', 'live_integration_run='])) &&
    hasAll(tests, [
      'executor.process.json',
      'scheduler.json',
      'worker-001.process.json',
      'roles mode passes distinct ROLE context',
    ]);
  const evidenceOk = hasAll(tests, [
    'actual worktree changes not declared',
    'declared files not present in worktree diff',
    'multi mode detects actual worktree conflicts',
    'multi mode blocks stale declared files absent from actual worktree diff',
  ]);
  const safetyOk = hasAll(tests, [
    'unsafe-host auth does not leak tokens',
    'readonly shell allowlist rejects mutating git output flags',
    'secret path detection and safeJoin reject unsafe paths',
    'shell mutation approvals are bound to the exact command digest',
    'applyApprovedProposal checks whole bundle before applying',
  ]);
  const regressionOk =
    countTests(tests) >= 49 &&
    hasAll(tests, [
      'fake string-only repo cannot pass the product gate',
      'product gate durable report contains report_path',
      'hard completion ceiling requires independent review and reconciliation artifacts',
    ]);
  const hardRows = hardGateRows(hardGates);
  const contradictoryRuns = contradictoryRunEvidence(root);
  const hardGateDocOk = hasAll(hardGates, [
    'CLAIM_LOCK: FORBID_90_95_UNTIL_ALL_HARD_GATES_PASS',
    'CURRENT_COMPLETION_CEILING: 95',
    'Local-Web State Truth Gate',
    'Real Agent Runtime Gate',
    'Operator Intent Boundary Gate',
    'Live Integration Gate',
  ]);
  const liveSmokeOk =
    existsSync(join(root, 'scripts', 'live-integration-smoke.mjs')) &&
    commandEvidence(root, ['scripts/live-integration-smoke.mjs'], ['LIVE_INTEGRATION_SMOKE_PASS']) &&
    jsonIfExists(join(root, AGENT_DIR, 'live-integration-smoke.json'))?.status === 'PASS';
  const forbiddenClaimsRemain = hardRows.fail > 0 && /\| .* \| .* \| PASS \|/.test(roadmap);
  const reconciliationGate = jsonIfExists(join(root, AGENT_DIR, 'reconciliation.json'));
  const reconciliationOk =
    liveReconciliation.repaired === 0 &&
    reconciliationGate?.status === 'PASS' &&
    Number(reconciliationGate?.repaired || 0) === 0;
  const reviewGate = jsonIfExists(join(root, AGENT_DIR, 'independent-review-gate.json'));
  const independentReviewOk = reviewArtifactOk(root, reviewGate);
  const provenanceState = !reviewProvenanceKey()
    ? 'no-signing-key'
    : reviewGate?.provenance?.algorithm === 'HMAC-SHA256' && typeof reviewGate?.provenance?.signature === 'string'
      ? independentReviewOk
        ? 'signed'
        : 'signature-invalid'
      : 'unsigned';
  const hardGatesAllPass =
    hardGateDocOk &&
    hardRows.total >= 7 &&
    hardRows.fail === 0 &&
    hardRows.pass >= 7 &&
    contradictoryRuns.length === 0 &&
    reconciliationOk &&
    liveSmokeOk &&
    independentReviewOk &&
    !forbiddenClaimsRemain;
  const resultRealityDelta: ProductGateDelta[] = [
    deltaRow(
      'Original PRD scope: local webservice, task/run/worker/review/promotion, v0-v2 bounded flow',
      prdScopeOk,
      'dominic_orchestration_PRD.md required scope anchors',
      'Claimed local v0-v2 scope is PRD-derived.',
      'Cannot prove claimed scope from original PRD.',
    ),
    deltaRow(
      'Runnable operator surface: installable CLI and command help/version',
      Boolean(packageJson?.bin?.agent === './dist/cli.js') && helpOk && versionOk,
      'package.json bin + dist/cli.js --help/--version',
      'Runnable CLI evidence exists.',
      'CLI/package evidence is missing or not runnable.',
    ),
    deltaRow(
      'Acceptance matrix: every PRD-scoped row passes without FAIL',
      acceptanceOk,
      'docs/milestones/FULL_PRODUCT_ROADMAP.md parsed table rows',
      'Matrix has all required PASS rows and no FAIL rows.',
      'Acceptance matrix is incomplete or contains FAIL rows.',
    ),
    deltaRow(
      'Real execution: dogfood run ids plus process/scheduler/role regressions',
      executionOk,
      `${dogfoodResolved.evidence}; DOGFOOD_REPORT.md + src/core.test.ts behavioral tests`,
      'Execution evidence is stronger than prose.',
      'Execution evidence is missing or prose-only.',
    ),
    deltaRow(
      'Evidence integrity: worker output checked against actual worktree diff',
      evidenceOk,
      'src/core.test.ts mismatch/conflict tests',
      'Worker prose is not the sole truth source.',
      'No deterministic mismatch/conflict regression evidence.',
    ),
    deltaRow(
      'Safety: command/control boundaries covered by adversarial tests',
      safetyOk,
      'src/core.test.ts safety and approval tests',
      'Policy/safety claims have adversarial tests.',
      'Policy/safety claims lack adversarial tests.',
    ),
    deltaRow(
      'Anti-rubber-stamp regression: fake string-only repo fails',
      regressionOk,
      'src/core.test.ts positive and negative product gate tests',
      'The gate has negative tests against string-only self-certification.',
      'The gate lacks negative anti-rubber-stamp tests.',
    ),
    deltaRow(
      'Hard completion ceiling: no 90/95 claim while live UI/runtime gates fail',
      hardGatesAllPass,
      `docs/milestones/HARD_COMPLETION_GATES.md rows=${hardRows.total} fail=${hardRows.fail}; contradictory_runs=${contradictoryRuns.length}; live_smoke=${liveSmokeOk}; reconciliation=${reconciliationOk}; independent_review=${independentReviewOk} (provenance=${provenanceState})`,
      'All hard gates pass, so the completion ceiling can be lifted.',
      `Hard gates block completion inflation: ${hardRows.fail} declared FAIL rows; ${contradictoryRuns.length} contradictory run artifacts.`,
    ),
  ];
  const deltaOk = resultRealityDelta.every((row) => row.status === 'PASS');
  const checks: ProductGateCheck[] = [
    gateCheck(
      'PRD Scope Integrity Gate',
      prdScopeOk && deltaOk,
      'Original PRD scope and the Result-Reality Delta report must both exist; local-first scope must be PRD-derived, not invented after implementation.',
    ),
    gateCheck(
      'Anti-Self-Deception Critic Gate',
      hasAll(standard, [
        'Anti-Self-Deception Critic Gate',
        'Scope Integrity Gate',
        'rubber-stamp',
        '원 PRD',
        'Result-Reality Delta',
      ]) &&
        deltaOk &&
        (!rerun || reportHasDelta),
      'The repo must document the rubber-stamp failure mode and include an explicit PRD-vs-result delta plus allowed/forbidden completion wording.',
    ),
    gateCheck(
      'Product Completeness Gate',
      Boolean(packageJson?.bin?.agent === './dist/cli.js') && helpOk && versionOk && acceptanceOk,
      'Package bin, built CLI help/version, and every PRD-scoped acceptance matrix row must pass without FAIL rows.',
    ),
    gateCheck(
      'Real Execution Gate',
      executionOk,
      'Execution claims require dogfood run identifiers plus process/scheduler/role regression evidence.',
    ),
    gateCheck(
      'Evidence Integrity Gate',
      evidenceOk,
      'Worker prose must be tested against actual worktree diff mismatches and conflicts.',
    ),
    gateCheck(
      'Safety and Policy Gate',
      safetyOk,
      'Security/policy gates must be backed by adversarial tests, not just source-code strings.',
    ),
    gateCheck(
      'Operator UX Gate',
      helpOk &&
        hasAll(rerun, ['CLI/Web controls', 'agent quality gate --write']) &&
        hasAll(roadmap, ['UI shows worker lanes', 'Run detail UI showing all required evidence']),
      'CLI help and reports must expose task/run/approval/product gate controls without manual .agent editing.',
    ),
    gateCheck(
      'Regression Gate',
      regressionOk,
      'Regression tests must include positive and negative anti-rubber-stamp fixtures plus durable report-path coverage.',
    ),
    gateCheck(
      'Dogfood Gate',
      dogfoodResolved.ok &&
        (hasAll(dogfood, ['FINAL_PRODUCT_SMOKE_PASS', 'WEB_CSRF_SMOKE_PASS', 'FINAL_POLICY_EVIDENCE_PASS']) ||
          hasAll(dogfood, ['LIVE_INTEGRATION_SMOKE_PASS', 'natural-language command ignored'])),
      'Dogfood must record real product use and policy/web smoke evidence.',
    ),
    gateCheck(
      'Hard Completion Ceiling Gate',
      hardGatesAllPass,
      hardGatesAllPass
        ? 'All hard gates pass and no contradictory run artifacts exist.'
        : `90/95 claims forbidden: hard gate rows fail=${hardRows.fail}, pass=${hardRows.pass}, live_smoke=${liveSmokeOk}; reconciliation=${reconciliationOk}; independent_review=${independentReviewOk} (provenance=${provenanceState}), forbidden_claims=${forbiddenClaimsRemain}, contradictory run artifacts=${contradictoryRuns.slice(0, 5).join('; ') || 'none'}`,
    ),
  ];
  const decision = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL';
  const completionCeiling = hardGatesAllPass ? 95 : 60;
  const completionLabel = hardGatesAllPass
    ? 'PRD-scoped completion candidate'
    : 'Prototype / control-plane scaffold with hard blockers; 90/95 claims forbidden';
  const report: ProductGateReport = {
    schema_version: 1,
    generated_at: nowIso(),
    decision,
    scope: 'PRD-scoped local v0-v2 product; no 90/95 claim allowed unless Hard Completion Ceiling Gate passes.',
    completion_ceiling: completionCeiling,
    completion_label: completionLabel,
    result_reality_delta: resultRealityDelta,
    checks,
  };
  if (options.write) {
    const dir = safeJoin(root, AGENT_DIR, 'product-gates');
    ensureDir(dir);
    const reportPath = join(
      dir,
      `product-gate-${nowIso()
        .replace(/[-:TZ.]/g, '')
        .slice(0, 14)}.json`,
    );
    report.report_path = relative(root, reportPath);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    rebuildIndex(root);
  }
  return report;
}

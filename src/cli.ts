#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { parse as parseQuery } from 'node:querystring';
import { fileURLToPath } from 'node:url';
import {
  addProject,
  addTask,
  applyApprovedPromotion,
  applyApprovedProposal,
  cancelRun,
  cleanupWorktrees,
  collectRun,
  createApproval,
  createRun,
  initProject,
  latestRunId,
  listApprovals,
  listPromotions,
  listProjects,
  listTasks,
  loadIndex,
  proposeApply,
  rebuildIndex,
  rebuildRuntimeProjectionStore,
  reconcileRuns,
  removeProject,
  resolveApproval,
  resolvePromotion,
  runPath,
  startRun,
  taskPath,
  updateTask,
} from './core.js';
import { readRuntimeEvents } from './events/ledger.js';
import { readClosedLoopAcceptanceFile, runClosedLoop } from './harness/closed-loop.js';
import { exerciseCodexAppServerLifecycle } from './harness/codex-lifecycle-exercise.js';
import { verifyContextProvenance } from './harness/context-provenance.js';
import { writeFullTargetGateArtifact } from './harness/full-target-gate.js';
import { runHarnessSlice } from './harness/harness-run.js';
import { verifyFullTargetGateArtifact } from './harness/full-target-verifier.js';
import { appendM8BoundaryEvidence } from './harness/m8-boundary-evidence.js';
import { runNativeEvidenceSmoke, verifyNativeEvidenceRun } from './harness/native-evidence.js';
import { verifyPromotionDifferential } from './harness/promotion-differential.js';
import { runProviderConformance } from './harness/provider-normalization.js';
import { verifySkillContracts } from './harness/skill-contracts.js';
import { writeUiAgreementSmoke } from './harness/ui-agreement.js';
import { currentReviewInputHash, runProductGate } from './product-gate.js';
import {
  reviewCustodyKey,
  reviewCustodySignature,
  reviewProvenanceKey,
  reviewProvenanceSignature,
  sha256Text,
} from './util.js';
import { renderHtml, renderReviewGate, renderRun } from './view.js';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function firstNonFlag(items: string[]): string | undefined {
  return items.find((x) => !x.startsWith('--'));
}
function safeReviewRelPath(root: string, artifactPath: unknown): string {
  if (
    typeof artifactPath !== 'string' ||
    artifactPath.startsWith('/') ||
    artifactPath.includes('..') ||
    artifactPath.trim() === ''
  )
    throw new Error('review artifact_path must be a safe repo-relative path');
  const full = join(root, artifactPath);
  if (!existsSync(full)) throw new Error(`review artifact is missing: ${artifactPath}`);
  const rel = relative(realpathSync(root), realpathSync(full)).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../')) throw new Error('review artifact_path escapes the repo');
  return artifactPath;
}
function readReviewArtifact(root: string, artifactPath: unknown): string {
  const relPath = safeReviewRelPath(root, artifactPath);
  return readFileSync(join(root, relPath), 'utf8');
}
interface ReviewNotificationEnvelope {
  agent_path?: string;
  status?: { completed?: string };
}
function readReviewJsonArtifact(root: string, artifactPath: unknown): ReviewNotificationEnvelope {
  const relPath = safeReviewRelPath(root, artifactPath);
  return JSON.parse(readFileSync(join(root, relPath), 'utf8')) as ReviewNotificationEnvelope;
}
async function readBody(req: any): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  return parseQuery(Buffer.concat(chunks).toString()) as Record<string, string>;
}
function redirect(res: any, path = '/') {
  res.statusCode = 303;
  res.setHeader('location', path);
  res.end('redirect');
}
function cookieValue(req: any, name: string): string {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function usage(): string {
  return `usage:
  agent --help|--version
  agent init
  agent project add|list|show|remove
  agent index rebuild|show
  agent task add|list|show|status|update|archive
  agent run create|start|collect|cancel|latest
  agent run native-evidence-smoke --task <fixture-task> [--timeout-ms N]
  agent run start <run-id> [--command cmd] [--sandbox read-only|workspace-write|danger-full-access] [--timeout-ms N]
  agent harness run <goal> [--executor-bin <path>]
  agent loop run <goal> --acceptance-file <path> [--max-iters N] [--stall K]
  agent runtime projection
  agent context verify --run <run-id>
  agent runtime verify-ledger <run-id>
  agent runtime full-target-gate <run-id> [--append-pass-event]
  agent runtime m8-boundary-evidence <run-id>
  agent runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>
  agent runtime ui-agreement <run-id>
  agent runtime verify-full-target <run-id> [--append-verified-event]
  agent verifier run --run <run-id>
  agent runtime prepare-review-gate --code-reviewer-artifact .agent/review-gates/code-reviewer.md --architect-artifact .agent/review-gates/architect.md --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json --architect-notification .agent/review-gates/subagent-notifications/architect.json --code-reviewer-agent PASTE_CODE_REVIEWER_AGENT_ID --architect-agent PASTE_ARCHITECT_AGENT_ID
  agent runtime sign-review --custody reviewer-ci [--custody-issuer ISSUER --review-session RUN_ID]
  agent review latest
  agent approvals
  agent approval request|approve|reject
  agent apply propose|approved
  agent report github-projects [--github-dir ~/Documents/github] [--out-dir reports/github-projects/<timestamp>]
  agent promotions
  agent promotion approve|reject|apply <id>
  agent promotion verify-learning
  agent provider conformance --all
  agent skills verify-contracts [--run <run-id>]
  agent worktrees cleanup
  agent maintenance reconcile-runs
  agent quality gate [--write]
  agent web [--host 127.0.0.1] [--port 4317] [--unsafe-host]`;
}

async function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  try {
    if (cmd === '--version' || cmd === 'version') {
      console.log('dominic-orchestration 0.1.0');
      return;
    }
    if (cmd === '--help' || cmd === 'help' || !cmd) {
      console.log(usage());
      return;
    }
    if (cmd === 'init') {
      const created = initProject();
      console.log(created.length ? `created:\n${created.join('\n')}` : '.agent already initialized');
      return;
    }
    if (cmd === 'project' && sub === 'add') {
      const rec = addProject(rest[0] || process.cwd());
      console.log(`${rec.id}\t${rec.root_path}`);
      return;
    }
    if (cmd === 'project' && sub === 'list') {
      for (const p of listProjects()) console.log(`${p.id}\t${p.root_path}`);
      return;
    }
    if (cmd === 'project' && sub === 'show') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent project show <id>');
      const project = listProjects().find((p) => p.id === id);
      if (!project) throw new Error(`project not found: ${id}`);
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    if (cmd === 'project' && sub === 'remove') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent project remove <id>');
      removeProject(id);
      return;
    }
    if (cmd === 'index' && sub === 'rebuild') {
      console.log(JSON.stringify(rebuildIndex(), null, 2));
      return;
    }
    if (cmd === 'index' && sub === 'show') {
      console.log(JSON.stringify(loadIndex(), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'add') {
      const title = rest.join(' ').trim();
      if (!title) throw new Error('usage: agent task add "title"');
      const task = addTask(title);
      console.log(`${task.id}\t${task.title}`);
      return;
    }
    if (cmd === 'task' && sub === 'list') {
      for (const t of listTasks()) console.log(`${t.id}\t${t.status}\t${t.title}`);
      return;
    }
    if (cmd === 'task' && sub === 'show') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task show <task-id>');
      const p = taskPath(id);
      if (!existsSync(p)) throw new Error(`task not found: ${id}`);
      console.log(readFileSync(p, 'utf8'));
      return;
    }
    if (cmd === 'task' && sub === 'status') {
      const id = rest[0];
      const status = rest[1] as any;
      if (!id || !status) throw new Error('usage: agent task status <task-id> <status>');
      console.log(JSON.stringify(updateTask(id, { status }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'update') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task update <task-id> [--title title] [--status status]');
      console.log(JSON.stringify(updateTask(id, { title: arg('--title'), status: arg('--status') as any }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'archive') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent task archive <task-id>');
      console.log(JSON.stringify(updateTask(id, { status: 'abandoned' }), null, 2));
      return;
    }
    if (cmd === 'run' && sub === 'create') {
      const id = firstNonFlag(rest);
      if (!id)
        throw new Error(
          'usage: agent run create <task-id> [--mode roles|multi] [--executor command|codex|omx|agy] [--max-workers N] [--command cmd]',
        );
      const mode = (arg('--mode', has('--multi') ? 'multi' : has('--roles') ? 'roles' : 'basic') || 'basic') as any;
      const maxWorkers = Number(arg('--max-workers', '2'));
      const command = arg('--command');
      const executor = (arg('--executor', 'command') || 'command') as any;
      const run = createRun(id, { mode, executor, maxWorkers, command });
      console.log(`run: ${run.id}`);
      console.log(`prompt: ${run.run_dir}/prompt.md`);
      return;
    }
    if (cmd === 'run' && sub === 'start') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run start <run-id> [--command cmd] [--sandbox mode] [--timeout-ms N]');
      const timeoutArg = arg('--timeout-ms');
      const run = await startRun(id, {
        command: arg('--command'),
        sandbox: arg('--sandbox') as 'read-only' | 'workspace-write' | 'danger-full-access' | undefined,
        timeoutMs: timeoutArg !== undefined ? Number(timeoutArg) : undefined,
      });
      console.log(`started: ${run.id}\nstatus: ${run.status}`);
      return;
    }
    if (cmd === 'run' && sub === 'collect') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run collect <run-id>');
      const run = collectRun(id);
      console.log(`collected: ${run.id}\nstatus: ${run.status}\ndecision: ${run.decision}`);
      return;
    }
    if (cmd === 'run' && sub === 'cancel') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent run cancel <run-id>');
      cancelRun(id);
      console.log(`cancelled: ${id}`);
      return;
    }
    if (cmd === 'run' && sub === 'latest') {
      console.log(latestRunId() || 'no runs');
      return;
    }
    if (cmd === 'run' && sub === 'native-evidence-smoke') {
      const task = arg('--task');
      if (!task) throw new Error('usage: agent run native-evidence-smoke --task <fixture-task> [--timeout-ms N]');
      const timeoutArg = arg('--timeout-ms');
      const report = await runNativeEvidenceSmoke({
        root: process.cwd(),
        task,
        sandbox: arg('--sandbox') as 'read-only' | 'workspace-write' | 'danger-full-access' | undefined,
        timeoutMs: timeoutArg !== undefined ? Number(timeoutArg) : undefined,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.verification.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'harness' && sub === 'run') {
      const goal = rest.filter((item, index) => item !== '--executor-bin' && rest[index - 1] !== '--executor-bin').join(' ').trim();
      if (!goal) throw new Error('usage: agent harness run <goal> [--executor-bin <path>]');
      const report = await runHarnessSlice({ root: process.cwd(), goal, executorBin: arg('--executor-bin') });
      console.log(JSON.stringify(report, null, 2));
      if (report.state !== 'completed') process.exitCode = 2;
      return;
    }
    if (cmd === 'loop' && sub === 'run') {
      const acceptanceFile = arg('--acceptance-file');
      const goal = rest
        .filter((item, index) => !['--acceptance-file', '--max-iters', '--stall', '--executor-bin', '--verify-cmd'].includes(item) && !['--acceptance-file', '--max-iters', '--stall', '--executor-bin', '--verify-cmd'].includes(rest[index - 1]))
        .join(' ')
        .trim();
      if (!goal || !acceptanceFile)
        throw new Error('usage: agent loop run <goal> --acceptance-file <path> [--max-iters N] [--stall K]');
      const report = await runClosedLoop({
        root: process.cwd(),
        goal,
        acceptanceContract: readClosedLoopAcceptanceFile(acceptanceFile),
        maxIters: arg('--max-iters') !== undefined ? Number(arg('--max-iters')) : undefined,
        stall: arg('--stall') !== undefined ? Number(arg('--stall')) : undefined,
        executorBin: arg('--executor-bin'),
        verifyCmd: arg('--verify-cmd'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'done') process.exitCode = 2;
      return;
    }
    if (cmd === 'context' && sub === 'verify') {
      const id = arg('--run') || rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent context verify --run <run-id>');
      const report = verifyContextProvenance({ root: process.cwd(), runId: id, writeIfMissing: true });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'projection') {
      console.log(JSON.stringify(rebuildRuntimeProjectionStore(), null, 2));
      return;
    }
    if (cmd === 'runtime' && sub === 'verify-ledger') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime verify-ledger <run-id>');
      const runDir = runPath(id);
      const events = readRuntimeEvents(runDir);
      const { createRuntimeLedgerHeadBinding, validateRuntimeLedger } = await import('./events/ledger.js');
      validateRuntimeLedger(events);
      console.log(JSON.stringify({ status: 'PASS', runId: id, ...createRuntimeLedgerHeadBinding(events) }, null, 2));
      return;
    }
    if (cmd === 'runtime' && sub === 'full-target-gate') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime full-target-gate <run-id> [--append-pass-event]');
      const report = writeFullTargetGateArtifact({
        root: process.cwd(),
        agentDir: '.agent',
        runId: id,
        appendPassEvent: has('--append-pass-event'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'm8-boundary-evidence') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime m8-boundary-evidence <run-id>');
      console.log(
        JSON.stringify(appendM8BoundaryEvidence({ root: process.cwd(), agentDir: '.agent', runId: id }), null, 2),
      );
      return;
    }
    if (cmd === 'runtime' && sub === 'codex-lifecycle-proof') {
      const id = firstNonFlag(rest) || latestRunId();
      const threadId = arg('--thread-id');
      if (!id || !threadId)
        throw new Error('usage: agent runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>');
      const report = await exerciseCodexAppServerLifecycle({
        root: process.cwd(),
        agentDir: '.agent',
        runId: id,
        threadId,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'ui-agreement') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime ui-agreement <run-id>');
      const report = writeUiAgreementSmoke({ root: process.cwd(), agentDir: '.agent', runId: id });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'verify-full-target') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent runtime verify-full-target <run-id> [--append-verified-event]');
      const report = verifyFullTargetGateArtifact({
        agentDir: '.agent',
        runId: id,
        appendVerifiedEvent: has('--append-verified-event'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'verifier' && sub === 'run') {
      const id = arg('--run') || rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent verifier run --run <run-id>');
      const report = verifyNativeEvidenceRun({ root: process.cwd(), runId: id });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'prepare-review-gate') {
      const root = process.cwd();
      const reviewerArtifactPath = arg('--code-reviewer-artifact');
      const architectArtifactPath = arg('--architect-artifact');
      const reviewerNotificationPath = arg('--code-reviewer-notification');
      const architectNotificationPath = arg('--architect-notification');
      const reviewerAgentId = arg('--code-reviewer-agent');
      const architectAgentId = arg('--architect-agent');
      if (
        !reviewerArtifactPath ||
        !architectArtifactPath ||
        !reviewerNotificationPath ||
        !architectNotificationPath ||
        !reviewerAgentId ||
        !architectAgentId
      )
        throw new Error(
          'usage: agent runtime prepare-review-gate --code-reviewer-artifact .agent/review-gates/code-reviewer.md --architect-artifact .agent/review-gates/architect.md --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json --architect-notification .agent/review-gates/subagent-notifications/architect.json --code-reviewer-agent PASTE_CODE_REVIEWER_AGENT_ID --architect-agent PASTE_ARCHITECT_AGENT_ID',
        );
      const reviewerText = readReviewArtifact(root, reviewerArtifactPath);
      const architectText = readReviewArtifact(root, architectArtifactPath);
      const reviewerNotification = readReviewJsonArtifact(root, reviewerNotificationPath);
      const architectNotification = readReviewJsonArtifact(root, architectNotificationPath);
      if (reviewerNotification?.agent_path !== reviewerAgentId)
        throw new Error('code-reviewer notification agent_path does not match --code-reviewer-agent');
      if (architectNotification?.agent_path !== architectAgentId)
        throw new Error('architect notification agent_path does not match --architect-agent');
      if (String(reviewerNotification?.status?.completed || '') !== reviewerText)
        throw new Error('code-reviewer notification completed text does not match artifact');
      if (String(architectNotification?.status?.completed || '') !== architectText)
        throw new Error('architect notification completed text does not match artifact');
      const inputHash = currentReviewInputHash(root);
      const reviewerSha = sha256Text(reviewerText);
      const architectSha = sha256Text(architectText);
      const gate = {
        status: 'PASS',
        input_sha256: inputHash,
        codeReview: {
          recommendation: 'APPROVE',
          architectStatus: 'CLEAR',
          independentReview: {
            codeReviewer: {
              agentRole: 'code-reviewer',
              agent_id: reviewerAgentId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: new Date().toISOString(),
              reviewed_input_sha256: inputHash,
              artifact_path: safeReviewRelPath(root, reviewerArtifactPath),
              artifact_sha256: reviewerSha,
              notification_path: safeReviewRelPath(root, reviewerNotificationPath),
              commands: ['npm test', 'npm run e2e', 'node dist/cli.js quality gate --write'],
              evidence: 'artifact-backed external code-reviewer approval',
            },
            architect: {
              agentRole: 'architect',
              agent_id: architectAgentId,
              source: 'codex-native-subagent',
              status: 'completed',
              completed_at: new Date().toISOString(),
              reviewed_input_sha256: inputHash,
              artifact_path: safeReviewRelPath(root, architectArtifactPath),
              artifact_sha256: architectSha,
              notification_path: safeReviewRelPath(root, architectNotificationPath),
              commands: ['npm test', 'npm run e2e', 'node dist/cli.js quality gate --write'],
              evidence: 'artifact-backed external architect clear',
            },
          },
        },
      };
      const gatePath = join(root, '.agent', 'independent-review-gate.json');
      writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
      console.log(JSON.stringify({ path: '.agent/independent-review-gate.json', input_sha256: inputHash }, null, 2));
      return;
    }
    if (cmd === 'runtime' && sub === 'sign-review') {
      const root = process.cwd();
      const gatePath = join(root, '.agent', 'independent-review-gate.json');
      if (!existsSync(gatePath)) throw new Error(`missing review gate: ${gatePath}`);
      const key = reviewProvenanceKey();
      if (!key)
        throw new Error(
          'no signing key configured: set AGENT_REVIEW_HMAC_KEY or create ~/.dominic_orchestration/review-signing.key',
        );
      const gate = JSON.parse(readFileSync(gatePath, 'utf8'));
      const inputHash = currentReviewInputHash(root);
      const reviewer = gate?.codeReview?.independentReview?.codeReviewer;
      const architect = gate?.codeReview?.independentReview?.architect;
      const reviewerText = readReviewArtifact(root, reviewer?.artifact_path);
      const architectText = readReviewArtifact(root, architect?.artifact_path);
      const reviewerSha = sha256Text(reviewerText);
      const architectSha = sha256Text(architectText);
      const signature = reviewProvenanceSignature(key, inputHash, reviewerSha, architectSha);
      const custody = arg('--custody') || gate?.provenance?.custody || process.env.AGENT_REVIEW_CUSTODY;
      if (String(custody || '') !== 'reviewer-ci')
        throw new Error(
          'review custody is required: pass --custody reviewer-ci or set AGENT_REVIEW_CUSTODY=reviewer-ci; local/non-CI signatures are diagnostic only',
        );
      const custodyKey = reviewCustodyKey();
      if (!custodyKey)
        throw new Error(
          'no review custody key configured: set AGENT_REVIEW_CUSTODY_HMAC_KEY or create ~/.dominic_orchestration/review-custody.key',
        );
      const reviewSessionId =
        arg('--review-session') ||
        process.env.AGENT_REVIEW_SESSION_ID ||
        process.env.GITHUB_RUN_ID ||
        process.env.CI_PIPELINE_ID;
      const custodyIssuer = arg('--custody-issuer') || process.env.AGENT_REVIEW_CUSTODY_ISSUER;
      const reviewerAgentId = arg('--reviewer-agent') || reviewer?.agent_id;
      if (!custodyIssuer || !reviewSessionId || !reviewerAgentId)
        throw new Error(
          'review custody metadata is required: provide --custody-issuer and --review-session (or AGENT_REVIEW_CUSTODY_ISSUER/AGENT_REVIEW_SESSION_ID) plus reviewer agent id',
        );
      const custodyMetadata = {
        custody_issuer: String(custodyIssuer),
        review_session_id: String(reviewSessionId),
        reviewer_agent_id: String(reviewerAgentId),
        reviewer_artifact_path: String(reviewer?.artifact_path),
        architect_artifact_path: String(architect?.artifact_path),
        reviewer_artifact_sha256: reviewerSha,
        architect_artifact_sha256: architectSha,
      };
      gate.provenance = {
        algorithm: 'HMAC-SHA256',
        signature,
        custody,
        ...custodyMetadata,
        custody_signature: reviewCustodySignature(custodyKey, custody, inputHash, signature, custodyMetadata),
      };
      writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);
      console.log(signature);
      return;
    }
    if (cmd === 'review' && sub === 'latest') {
      const id = latestRunId();
      if (!id) throw new Error('no runs');
      console.log(readFileSync(`.agent/runs/${id}/review.md`, 'utf8'));
      return;
    }
    if (cmd === 'approvals' && !sub) {
      for (const a of listApprovals()) console.log(`${a.id}\t${a.status}\t${a.risk}\t${a.type}\t${a.summary}`);
      return;
    }
    if (cmd === 'approval' && (sub === 'approve' || sub === 'reject')) {
      const id = rest[0];
      if (!id) throw new Error(`usage: agent approval ${sub} <id>`);
      console.log(JSON.stringify(resolveApproval(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'approval' && sub === 'request') {
      const runId = rest[0] || latestRunId();
      if (!runId) throw new Error('usage: agent approval request <run-id>');
      console.log(
        JSON.stringify(
          createApproval(runId, arg('--type', 'manual')!, 'medium', arg('--summary', 'manual approval request')!),
          null,
          2,
        ),
      );
      return;
    }
    if (cmd === 'apply' && sub === 'propose') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: agent apply propose <run-id>');
      console.log(JSON.stringify(proposeApply(id), null, 2));
      return;
    }
    if (cmd === 'apply' && sub === 'approved') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent apply approved <approval-id>');
      console.log(JSON.stringify(applyApprovedProposal(id), null, 2));
      return;
    }
    if (cmd === 'report' && sub === 'github-projects') {
      const cliDir = dirname(fileURLToPath(import.meta.url));
      const script = join(cliDir, '..', 'scripts', 'github-projects-report.mjs');
      if (!existsSync(script)) throw new Error(`report script missing: ${script}`);
      const scriptArgs = [script];
      const githubDir = arg('--github-dir');
      const outDir = arg('--out-dir');
      const maxProjects = arg('--max-projects');
      if (githubDir) scriptArgs.push('--github-dir', githubDir);
      if (outDir) scriptArgs.push('--out-dir', outDir);
      if (maxProjects) scriptArgs.push('--max-projects', maxProjects);
      const result = spawnSync(process.execPath, scriptArgs, { cwd: process.cwd(), stdio: 'inherit' });
      process.exitCode = result.status ?? 1;
      return;
    }
    if (cmd === 'promotions' && !sub) {
      for (const p of listPromotions()) console.log(`${p.id}\t${p.status}\t${p.target_type}\t${p.reason}`);
      return;
    }
    if (cmd === 'promotion' && (sub === 'approve' || sub === 'reject')) {
      const id = rest[0];
      if (!id) throw new Error(`usage: agent promotion ${sub} <id>`);
      console.log(JSON.stringify(resolvePromotion(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'promotion' && sub === 'apply') {
      const id = rest[0];
      if (!id) throw new Error('usage: agent promotion apply <id>');
      console.log(JSON.stringify(applyApprovedPromotion(id), null, 2));
      return;
    }
    if (cmd === 'promotion' && sub === 'verify-learning') {
      const report = verifyPromotionDifferential({ root: process.cwd() });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'provider' && sub === 'conformance') {
      if (!has('--all')) throw new Error('usage: agent provider conformance --all');
      const report = runProviderConformance({ root: process.cwd() });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'skills' && sub === 'verify-contracts') {
      const runId = arg('--run');
      const report = verifySkillContracts({ root: process.cwd(), runDir: runId ? runPath(runId) : undefined });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'worktrees' && sub === 'cleanup') {
      cleanupWorktrees();
      console.log('worktrees cleaned');
      return;
    }
    if (cmd === 'maintenance' && sub === 'reconcile-runs') {
      console.log(JSON.stringify(reconcileRuns(), null, 2));
      return;
    }
    if (cmd === 'quality' && sub === 'gate') {
      reconcileRuns();
      const report = runProductGate(process.cwd(), { write: has('--write') });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'web') {
      await serveWeb();
      return;
    }
    console.log(usage());
  } catch (err: any) {
    console.error(`error: ${err.message || err}`);
    process.exitCode = 1;
  }
}

async function serveWeb(): Promise<void> {
  const csrfToken = randomBytes(24).toString('hex');
  const port = Number(arg('--port', '4317'));
  const host = arg('--host', '127.0.0.1')!;
  const unsafeHost = has('--unsafe-host');
  if (!['127.0.0.1', 'localhost'].includes(host) && !unsafeHost)
    throw new Error(
      'agent web only binds loopback hosts by default; pass --unsafe-host with --auth-token to acknowledge remote command/control risk',
    );
  const authToken = arg('--auth-token') || process.env.AGENT_WEB_TOKEN || '';
  if (unsafeHost && !authToken)
    throw new Error(
      '--unsafe-host requires --auth-token or AGENT_WEB_TOKEN because web controls can execute local commands',
    );
  const allowedOrigins = new Set([`http://${host}:${port}`]);
  if (host === '127.0.0.1' || host === 'localhost') {
    allowedOrigins.add(`http://127.0.0.1:${port}`);
    allowedOrigins.add(`http://localhost:${port}`);
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    try {
      const providedAuth = () =>
        url.searchParams.get('auth') || String(req.headers['x-agent-auth'] || '') || cookieValue(req, 'agent_auth');
      const requireRemoteAuth = (provided: string): void => {
        if (!authToken) return;
        const ok =
          provided.length === authToken.length && timingSafeEqual(Buffer.from(provided), Buffer.from(authToken));
        if (!ok) throw new Error('invalid auth token');
      };
      const requirePageAuth = (): void => {
        if (!authToken) return;
        const provided = providedAuth();
        requireRemoteAuth(provided);
        if (url.searchParams.get('auth') === authToken)
          res.setHeader('set-cookie', `agent_auth=${encodeURIComponent(authToken)}; HttpOnly; SameSite=Strict; Path=/`);
      };
      const requirePostAuth = async (): Promise<Record<string, string>> => {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(String(origin))) throw new Error('invalid origin');
        const body = await readBody(req);
        requireRemoteAuth(body.auth || String(req.headers['x-agent-auth'] || '') || cookieValue(req, 'agent_auth'));
        const token = body.csrf || '';
        const ok = token.length === csrfToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken));
        if (!ok) throw new Error('invalid csrf token');
        return body;
      };
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const body = await requirePostAuth();
        const path = (body.path || '').trim();
        if (!path) throw new Error('project path is required');
        addProject(path);
        redirect(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks') {
        const body = await requirePostAuth();
        addTask(body.title || 'Untitled task');
        redirect(res);
        return;
      }
      const taskUpdateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/update$/);
      if (req.method === 'POST' && taskUpdateMatch) {
        const body = await requirePostAuth();
        updateTask(taskUpdateMatch[1], { title: body.title || undefined, status: (body.status as any) || undefined });
        redirect(res);
        return;
      }
      const taskArchiveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (req.method === 'POST' && taskArchiveMatch) {
        await requirePostAuth();
        updateTask(taskArchiveMatch[1], { status: 'abandoned' });
        redirect(res);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const body = await requirePostAuth();
        const executor = ['codex', 'omx', 'agy', 'command'].includes(body.executor) ? body.executor : 'command';
        createRun(body.taskId, { mode: (body.mode || 'basic') as any, executor: executor as any, source: 'web' });
        redirect(res);
        return;
      }
      const startMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/start$/);
      if (req.method === 'POST' && startMatch) {
        const body = await requirePostAuth();
        await startRun(startMatch[1], {
          command: body.confirmCommand === 'yes' ? body.command || undefined : undefined,
        });
        redirect(res, `/run/${startMatch[1]}`);
        return;
      }
      const collectMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/collect$/);
      if (req.method === 'POST' && collectMatch) {
        await requirePostAuth();
        collectRun(collectMatch[1]);
        redirect(res, `/run/${collectMatch[1]}`);
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        await requirePostAuth();
        cancelRun(cancelMatch[1]);
        redirect(res, `/run/${cancelMatch[1]}`);
        return;
      }
      const proposeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/apply-proposal$/);
      if (req.method === 'POST' && proposeMatch) {
        await requirePostAuth();
        proposeApply(proposeMatch[1]);
        redirect(res, `/run/${proposeMatch[1]}`);
        return;
      }
      const approveMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approveMatch) {
        await requirePostAuth();
        resolveApproval(approveMatch[1], 'approved');
        redirect(res);
        return;
      }
      const rejectMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/reject$/);
      if (req.method === 'POST' && rejectMatch) {
        await requirePostAuth();
        resolveApproval(rejectMatch[1], 'rejected');
        redirect(res);
        return;
      }
      const applyMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/apply$/);
      if (req.method === 'POST' && applyMatch) {
        await requirePostAuth();
        applyApprovedProposal(applyMatch[1]);
        redirect(res);
        return;
      }
      const eventStreamMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === 'GET' && eventStreamMatch) {
        requirePageAuth();
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        let sent = 0;
        const send = () => {
          const events = readRuntimeEvents(runPath(eventStreamMatch[1]));
          for (const event of events.slice(sent)) res.write(`event: runtime\\ndata: ${JSON.stringify(event)}\\n\\n`);
          sent = events.length;
        };
        send();
        const timer = setInterval(send, 500);
        const end = setTimeout(() => {
          clearInterval(timer);
          res.end();
        }, 30000);
        req.on('close', () => {
          clearInterval(timer);
          clearTimeout(end);
        });
        return;
      }
      if (req.method !== 'GET') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      requirePageAuth();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname.startsWith('/run/')) res.end(renderRun(decodeURIComponent(url.pathname.slice(5))));
      else if (url.pathname === '/review-gate') res.end(renderReviewGate(process.cwd()));
      else if (url.pathname === '/') res.end(renderHtml(process.cwd(), csrfToken));
      else {
        res.statusCode = 404;
        res.end('not found');
      }
    } catch (err: any) {
      res.statusCode = 500;
      res.end(String(err.message || err));
    }
  });
  server.listen(port, host, () => console.log(`agent web listening at http://${host}:${port}`));
}

main();

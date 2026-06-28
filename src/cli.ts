#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
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
  listProjects,
  listPromotions,
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
import { readCommandAcceptanceFile } from './harness/command-acceptance.js';
import { exerciseCodexAppServerLifecycle } from './harness/codex-lifecycle-exercise.js';
import { verifyContextProvenance } from './harness/context-provenance.js';
import { anthropicDirectTransport, makeDirectProviderExecutor } from './harness/direct-provider.js';
import { writeFullTargetGateArtifact } from './harness/full-target-gate.js';
import { verifyFullTargetGateArtifact } from './harness/full-target-verifier.js';
import { resolveHarnessExecutor } from './harness/executor-resolve.js';
import { type HarnessExecutor, runHarnessSlice } from './harness/harness-run.js';
import { detectExternalCli } from './runtime/external-cli-adapter.js';
import { appendM8BoundaryEvidence } from './harness/m8-boundary-evidence.js';
import { runNativeEvidenceSmoke, verifyNativeEvidenceRun } from './harness/native-evidence.js';
import { createOrchestratorServer, defaultExecutorRegistry, runSubmittedGraph } from './harness/orchestrator-server.js';
import {
  loadSkillSpecFromJson,
  projectSkillRun,
  recomputeCompletionFromLedger,
  runOrchestratorSkill,
  type SkillSpecJson,
  writeSkillLaunchMarker,
} from './harness/orchestrator-skill.js';
import { verifyPromotionCausal } from './harness/promotion-causal.js';
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
import { renderHtml, renderReviewGate, renderRun, renderSkillRun } from './view.js';
import { loadModuleCatalog } from './composition/catalog.js';
import { adapterFor, applyCompositionToWorktree, verifyInjection } from './composition/inject.js';
import { recomputeInjectionFromLedger, recordInjectionEvent } from './composition/inject-ledger.js';
import { runMagicInjectionRun } from './composition/magic-run.js';
import { formatMagicPlan, resolveMagicPlan } from './composition/magic.js';

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
export interface SkillSpecOption {
  id: string;
  path: string;
}
/**
 * Discover the bundled skill specs an operator can launch from the UI. The set is a server-owned
 * whitelist (the launch POST only accepts an id from this list), so an operator never supplies a
 * free-text spec path — that keeps the spawned `skill run` command server-controlled.
 */
export function listSkillSpecs(): SkillSpecOption[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [join(here, '..', 'fixtures', 'skills'), join(process.cwd(), 'fixtures', 'skills')];
  const seen = new Set<string>();
  const specs: SkillSpecOption[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.replace(/\.json$/, '');
      if (seen.has(id)) continue;
      seen.add(id);
      specs.push({ id, path: join(dir, file) });
    }
  }
  return specs.sort((a, b) => a.id.localeCompare(b.id));
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
  maestro --help|--version
  maestro init
  maestro project add|list|show|remove
  maestro index rebuild|show
  maestro task add|list|show|status|update|archive
  maestro run create|start|collect|cancel|latest
  maestro run native-evidence-smoke --task <fixture-task> [--timeout-ms N]
  maestro run start <run-id> [--command cmd] [--sandbox read-only|workspace-write|danger-full-access] [--timeout-ms N]
  maestro harness run <goal> [--executor codex|claude|agy|anthropic-direct|<custom>] [--executor-bin <path>] [--model M] [--acceptance-file <path>]
  maestro loop run <goal> --acceptance-file <path> [--max-iters N] [--stall K]
  maestro runtime projection
  maestro context verify --run <run-id>
  maestro runtime verify-ledger <run-id>
  maestro runtime full-target-gate <run-id> [--append-pass-event]
  maestro runtime m8-boundary-evidence <run-id>
  maestro runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>
  maestro runtime ui-agreement <run-id>
  maestro runtime verify-full-target <run-id> [--append-verified-event]
  maestro verifier run --run <run-id>
  maestro runtime prepare-review-gate --code-reviewer-artifact .agent/review-gates/code-reviewer.md --architect-artifact .agent/review-gates/architect.md --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json --architect-notification .agent/review-gates/subagent-notifications/architect.json --code-reviewer-agent PASTE_CODE_REVIEWER_AGENT_ID --architect-agent PASTE_ARCHITECT_AGENT_ID
  maestro runtime sign-review --custody reviewer-ci [--custody-issuer ISSUER --review-session RUN_ID]
  maestro review latest
  maestro approvals
  maestro approval request|approve|reject
  maestro apply propose|approved
  maestro report github-projects [--github-dir ~/Documents/github] [--out-dir reports/github-projects/<timestamp>]
  maestro promotions
  maestro promotion approve|reject|apply <id>
  maestro promotion verify-learning
  maestro promotion verify-causal --goal <g> --promotion-file <path> [--executor codex|claude|agy] [--executor-bin <path>]
  maestro provider conformance --all
  maestro skill run <spec.json> --what "<goal>"
  maestro skill show <runId>            # operator projection: recomputes completion, flags contradictions
  maestro magic plan "<goal>"           # dry-run: detect project tags + resolve composable modules (no injection)
  maestro magic catalog                 # list the module catalog (declared + discovered)
  maestro magic apply [--into <dir>] [--executor claude|codex|agy] [--approve-secrets]  # inject resolved MCP capability (hash-chained composition.injected ledger record)
  maestro magic show <magicRunId> [--into <dir>] [--executor ...]  # recompute the injection record from the ledger; flag contradiction
  maestro magic run "<goal>" [--executor claude|codex|agy] [--approve-secrets] [--prove]  # inject resolved MCP then run; --prove adds a canary to prove consumption from a real side effect
  maestro skills verify-contracts [--run <run-id>]
  maestro worktrees cleanup
  maestro maintenance reconcile-runs
  maestro quality gate [--write]
  maestro web [--host 127.0.0.1] [--port 4317] [--unsafe-host]
  maestro orchestrate serve [--host 127.0.0.1] [--port 4319] [--auth-token TOKEN] [--verify-cmd CMD] [--unsafe-host]
  maestro orchestrate run --file <graph.json> [--reconcile] [--verify-cmd CMD] [--concurrency N]`;
}

async function main() {
  const [, , cmd, sub, ...rest] = process.argv;
  try {
    if (cmd === '--version' || cmd === 'version') {
      console.log('maestro 0.1.0');
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
      if (!id) throw new Error('usage: maestro project show <id>');
      const project = listProjects().find((p) => p.id === id);
      if (!project) throw new Error(`project not found: ${id}`);
      console.log(JSON.stringify(project, null, 2));
      return;
    }
    if (cmd === 'project' && sub === 'remove') {
      const id = rest[0];
      if (!id) throw new Error('usage: maestro project remove <id>');
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
      if (!title) throw new Error('usage: maestro task add "title"');
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
      if (!id) throw new Error('usage: maestro task show <task-id>');
      const p = taskPath(id);
      if (!existsSync(p)) throw new Error(`task not found: ${id}`);
      console.log(readFileSync(p, 'utf8'));
      return;
    }
    if (cmd === 'task' && sub === 'status') {
      const id = rest[0];
      const status = rest[1] as any;
      if (!id || !status) throw new Error('usage: maestro task status <task-id> <status>');
      console.log(JSON.stringify(updateTask(id, { status }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'update') {
      const id = rest[0];
      if (!id) throw new Error('usage: maestro task update <task-id> [--title title] [--status status]');
      console.log(JSON.stringify(updateTask(id, { title: arg('--title'), status: arg('--status') as any }), null, 2));
      return;
    }
    if (cmd === 'task' && sub === 'archive') {
      const id = rest[0];
      if (!id) throw new Error('usage: maestro task archive <task-id>');
      console.log(JSON.stringify(updateTask(id, { status: 'abandoned' }), null, 2));
      return;
    }
    if (cmd === 'run' && sub === 'create') {
      const id = firstNonFlag(rest);
      if (!id)
        throw new Error(
          'usage: maestro run create <task-id> [--mode roles|multi] [--executor command|codex|omx|agy] [--max-workers N] [--command cmd]',
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
      if (!id) throw new Error('usage: maestro run start <run-id> [--command cmd] [--sandbox mode] [--timeout-ms N]');
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
      if (!id) throw new Error('usage: maestro run collect <run-id>');
      const run = collectRun(id);
      console.log(`collected: ${run.id}\nstatus: ${run.status}\ndecision: ${run.decision}`);
      return;
    }
    if (cmd === 'run' && sub === 'cancel') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: maestro run cancel <run-id>');
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
      if (!task) throw new Error('usage: maestro run native-evidence-smoke --task <fixture-task> [--timeout-ms N]');
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
      const valueFlags = ['--executor-bin', '--executor', '--model', '--acceptance-file'];
      const goal = rest
        .filter((item, index) => !valueFlags.includes(item) && !valueFlags.includes(rest[index - 1]))
        .join(' ')
        .trim();
      if (!goal)
        throw new Error(
          'usage: maestro harness run <goal> [--executor codex|claude|agy|anthropic-direct|<custom>] [--executor-bin <path>] [--acceptance-file <path>]',
        );
      const executorKind = arg('--executor') ?? 'codex';
      const executorBinArg = arg('--executor-bin');
      let executor: HarnessExecutor | undefined;
      if (executorKind === 'anthropic-direct') {
        // Stage D: optional direct-provider executor (product-owned single turn; not native-assisted).
        executor = makeDirectProviderExecutor({
          name: 'anthropic-direct',
          transport: anthropicDirectTransport({ model: arg('--model') }),
        });
      } else {
        // Built-ins (codex/claude/agy) resolve through the registry; ANY other name is a
        // bring-your-own headless CLI (`<bin> -p "<prompt>"`, bin = --executor-bin ?? name).
        // BYO is graded by the same acceptance recompute — the executor is never trusted.
        const detect = (bin: string) =>
          bin.includes('/') ? existsSync(bin) : detectExternalCli(bin).available;
        executor = resolveHarnessExecutor(executorKind, executorBinArg, detect).executor;
      }
      // Opt-in build/test gate: with --acceptance-file, "a real diff" is no longer enough —
      // runCommandAcceptance re-runs the operator's command over a clean checkout of the run's diff
      // (harness-run.ts), so a wrong implementation is blocked despite producing a diff. Without it,
      // completion stays diff-only (a real, non-forbidden change), as before.
      const acceptanceFile = arg('--acceptance-file');
      const acceptance = acceptanceFile ? readCommandAcceptanceFile(acceptanceFile) : undefined;
      const report = await runHarnessSlice({
        root: process.cwd(),
        goal,
        executor,
        executorLabel: executorKind,
        executorBin: arg('--executor-bin'),
        acceptance,
        // Load this project's memory fabric into context (gate #4 admits only provenanced+fresh
        // facts). No-op when the fabric is empty, so this is safe to enable by default.
        fabricAgentDir: '.agent',
        stampFabricOnVerify: true,
      });
      console.log(JSON.stringify(report, null, 2));
      if (report.state !== 'completed') process.exitCode = 2;
      return;
    }
    if (cmd === 'loop' && sub === 'run') {
      const acceptanceFile = arg('--acceptance-file');
      const goal = rest
        .filter(
          (item, index) =>
            !['--acceptance-file', '--max-iters', '--stall', '--executor-bin', '--verify-cmd'].includes(item) &&
            !['--acceptance-file', '--max-iters', '--stall', '--executor-bin', '--verify-cmd'].includes(
              rest[index - 1],
            ),
        )
        .join(' ')
        .trim();
      if (!goal || !acceptanceFile)
        throw new Error('usage: maestro loop run <goal> --acceptance-file <path> [--max-iters N] [--stall K]');
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
      if (!id) throw new Error('usage: maestro context verify --run <run-id>');
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
      if (!id) throw new Error('usage: maestro runtime verify-ledger <run-id>');
      const runDir = runPath(id);
      const events = readRuntimeEvents(runDir);
      const { createRuntimeLedgerHeadBinding, validateRuntimeLedger } = await import('./events/ledger.js');
      validateRuntimeLedger(events);
      console.log(JSON.stringify({ status: 'PASS', runId: id, ...createRuntimeLedgerHeadBinding(events) }, null, 2));
      return;
    }
    if (cmd === 'runtime' && sub === 'full-target-gate') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: maestro runtime full-target-gate <run-id> [--append-pass-event]');
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
      if (!id) throw new Error('usage: maestro runtime m8-boundary-evidence <run-id>');
      console.log(
        JSON.stringify(appendM8BoundaryEvidence({ root: process.cwd(), agentDir: '.agent', runId: id }), null, 2),
      );
      return;
    }
    if (cmd === 'runtime' && sub === 'codex-lifecycle-proof') {
      const id = firstNonFlag(rest) || latestRunId();
      const threadId = arg('--thread-id');
      if (!id || !threadId)
        throw new Error('usage: maestro runtime codex-lifecycle-proof <run-id> --thread-id <thread-id>');
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
      if (!id) throw new Error('usage: maestro runtime ui-agreement <run-id>');
      const report = writeUiAgreementSmoke({ root: process.cwd(), agentDir: '.agent', runId: id });
      console.log(JSON.stringify(report, null, 2));
      if (report.status !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'runtime' && sub === 'verify-full-target') {
      const id = rest[0] || latestRunId();
      if (!id) throw new Error('usage: maestro runtime verify-full-target <run-id> [--append-verified-event]');
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
      if (!id) throw new Error('usage: maestro verifier run --run <run-id>');
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
          'usage: maestro runtime prepare-review-gate --code-reviewer-artifact .agent/review-gates/code-reviewer.md --architect-artifact .agent/review-gates/architect.md --code-reviewer-notification .agent/review-gates/subagent-notifications/code-reviewer.json --architect-notification .agent/review-gates/subagent-notifications/architect.json --code-reviewer-agent PASTE_CODE_REVIEWER_AGENT_ID --architect-agent PASTE_ARCHITECT_AGENT_ID',
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
      if (!id) throw new Error(`usage: maestro approval ${sub} <id>`);
      console.log(JSON.stringify(resolveApproval(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'approval' && sub === 'request') {
      const runId = rest[0] || latestRunId();
      if (!runId) throw new Error('usage: maestro approval request <run-id>');
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
      if (!id) throw new Error('usage: maestro apply propose <run-id>');
      console.log(JSON.stringify(proposeApply(id), null, 2));
      return;
    }
    if (cmd === 'apply' && sub === 'approved') {
      const id = rest[0];
      if (!id) throw new Error('usage: maestro apply approved <approval-id>');
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
      if (!id) throw new Error(`usage: maestro promotion ${sub} <id>`);
      console.log(JSON.stringify(resolvePromotion(id, sub === 'approve' ? 'approved' : 'rejected'), null, 2));
      return;
    }
    if (cmd === 'promotion' && sub === 'apply') {
      const id = rest[0];
      if (!id) throw new Error('usage: maestro promotion apply <id>');
      console.log(JSON.stringify(applyApprovedPromotion(id), null, 2));
      return;
    }
    if (cmd === 'promotion' && sub === 'verify-learning') {
      const report = verifyPromotionDifferential({ root: process.cwd() });
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'promotion' && sub === 'verify-causal') {
      // Strong A/A/B causal proof: two identical runs must agree (stability) and adding ONLY the
      // promotion to context must flip the executor's decision. Reachable as a product command (not
      // only a unit test), over any executor — codex (native) or a real `claude -p` / `agy -p`.
      const goal = arg('--goal');
      const promotionFile = arg('--promotion-file');
      if (!goal || !promotionFile)
        throw new Error(
          'usage: maestro promotion verify-causal --goal <g> --promotion-file <path> [--executor codex|claude|agy] [--executor-bin <path>] [--promotion-id <id>]',
        );
      const text = readFileSync(promotionFile, 'utf8');
      const executorKind = arg('--executor') ?? 'codex';
      const registry = defaultExecutorRegistry();
      if (!registry.has(executorKind))
        throw new Error(`unknown executor: ${executorKind} (use codex|claude|agy)`);
      const report = await verifyPromotionCausal({
        root: process.cwd(),
        goal,
        promotion: { id: arg('--promotion-id') ?? 'cli-promotion', text },
        executor: registry.resolve(executorKind),
        executorBin: arg('--executor-bin'),
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.causal) process.exitCode = 2;
      return;
    }
    if (cmd === 'provider' && sub === 'conformance') {
      if (!has('--all')) throw new Error('usage: maestro provider conformance --all');
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
    if (cmd === 'skill' && sub === 'run') {
      const specPath = firstNonFlag(rest);
      const what = arg('--what');
      if (!specPath || !what) throw new Error('usage: maestro skill run <spec.json> --what "<goal>"');
      const reg = defaultExecutorRegistry();
      const executors = {
        codex: reg.resolve('codex'),
        claude: reg.resolve('claude'),
        agy: reg.resolve('agy'),
      };
      const json = JSON.parse(readFileSync(specPath, 'utf8')) as SkillSpecJson;
      const spec = loadSkillSpecFromJson(json, executors);
      const report = await runOrchestratorSkill(spec, { what, root: process.cwd(), runId: arg('--run-id') });
      console.log(JSON.stringify(report, null, 2));
      const recomputed = recomputeCompletionFromLedger(spec, { root: process.cwd(), runId: report.runId });
      console.log(
        `AUTHORITATIVE (ledger recompute, report field is display-only): completion=${recomputed.completion} (${recomputed.reason})`,
      );
      if (recomputed.completion === 'failed') process.exitCode = 2;
      return;
    }
    if (cmd === 'skill' && sub === 'show') {
      const runId = firstNonFlag(rest);
      if (!runId) throw new Error('usage: maestro skill show <runId>');
      const projection = projectSkillRun({ root: process.cwd(), runId });
      console.log(JSON.stringify(projection, null, 2));
      if (projection.contradiction) {
        console.log(
          'CONTRADICTION: stored/display completion disagrees with the authoritative ledger recompute — trust the recompute, not the report.',
        );
        process.exitCode = 2;
      }
      return;
    }
    if (cmd === 'magic' && sub === 'plan') {
      const goal = firstNonFlag(rest) ?? '';
      if (!goal) throw new Error('usage: maestro magic plan "<goal>"');
      const plan = resolveMagicPlan({ root: process.cwd(), goal });
      console.log(formatMagicPlan(plan));
      return;
    }
    if (cmd === 'magic' && sub === 'catalog') {
      const catalog = loadModuleCatalog({ root: process.cwd() });
      console.log(`catalog sources: ${catalog.sources.length ? catalog.sources.join(', ') : '(none)'}`);
      for (const m of catalog.modules) {
        console.log(`  - ${m.id} [${m.kind}] ${m.origin} (tags: ${m.tags.length ? m.tags.join(', ') : 'none — not auto-selected'})`);
      }
      return;
    }
    if (cmd === 'magic' && sub === 'apply') {
      const into = arg('--into') ?? process.cwd();
      const executor = arg('--executor') ?? 'claude';
      const goal = firstNonFlag(rest) ?? '(apply)';
      const catalog = loadModuleCatalog({ root: process.cwd() });
      const plan = resolveMagicPlan({ root: process.cwd(), goal, catalog });
      const selectedMcpIds = new Set(plan.selected.filter((s) => s.kind === 'mcp').map((s) => s.moduleId));
      const mcpModules = catalog.modules.filter((m) => m.kind === 'mcp' && selectedMcpIds.has(m.id));
      const adapter = adapterFor(executor);
      const manifest = applyCompositionToWorktree({ worktree: into, mcpModules, adapter, approveSecrets: has('--approve-secrets') });
      const verification = verifyInjection(into, manifest, { adapter });
      // Record the injection into a hash-chained ledger so it is recomputable evidence, not a flat
      // side-file. `magic show <id>` re-derives it from the same catalog inputs and flags mismatch.
      const magicRunId = `magic-${randomUUID()}`;
      const runDir = join(into, '.agent', 'magic-runs', magicRunId);
      mkdirSync(runDir, { recursive: true });
      recordInjectionEvent(runDir, magicRunId, manifest);
      const ledgerCheck = recomputeInjectionFromLedger(runDir, { mcpModules, adapter, approveSecrets: has('--approve-secrets') });
      writeFileSync(join(runDir, 'composition-injected.json'), `${JSON.stringify({ manifest, verification, ledgerCheck }, null, 2)}\n`);
      console.log(JSON.stringify({ magicRunId, into, executor, manifest, verification, ledgerCheck }, null, 2));
      // Fail on integrity loss OR a recorded-but-unreproducible injection — independent of file count
      // (an empty/forged manifest must not bypass). Honest 'unsupported'/'none' exits 0.
      if (!verification.integrityOk || (ledgerCheck.found && !ledgerCheck.reproduced)) process.exitCode = 2;
      return;
    }
    if (cmd === 'magic' && sub === 'run') {
      const goal = firstNonFlag(rest);
      if (!goal) throw new Error('usage: maestro magic run "<goal>" [--executor claude|codex|agy] [--approve-secrets]');
      const executorLabel = arg('--executor') ?? 'claude';
      const magicRegistry = defaultExecutorRegistry();
      if (!magicRegistry.has(executorLabel)) throw new Error(`unknown executor: ${executorLabel} (use codex|claude|agy)`);
      const executor = magicRegistry.resolve(executorLabel); // undefined for codex → native default
      const catalog = loadModuleCatalog({ root: process.cwd() });
      const plan = resolveMagicPlan({ root: process.cwd(), goal, catalog });
      const selectedMcpIds = new Set(plan.selected.filter((s) => s.kind === 'mcp').map((s) => s.moduleId));
      const mcpModules = catalog.modules.filter((m) => m.kind === 'mcp' && selectedMcpIds.has(m.id));
      const magicRunId = `magic-${randomUUID()}`;
      // --prove: inject a canary MCP + ask the executor to call it once, then prove consumption from
      // the sentinel it leaves (real side effect, not prose). The canary's absolute sentinel path is
      // resolved against the run worktree inside runMagicInjectionRun (cwd-independent). Without
      // --prove, consumption stays honestly unproven.
      const prove = has('--prove');
      const runGoal = prove
        ? `${goal}\n\n[maestro consumption check] First call the MCP tool warden_canary_ping exactly once (this confirms your injected MCP config loaded), then proceed with the task.`
        : goal;
      const result = await runMagicInjectionRun({
        root: process.cwd(),
        goal: runGoal,
        magicRunId,
        executor,
        executorLabel,
        mcpModules,
        adapter: adapterFor(executorLabel),
        approveSecrets: has('--approve-secrets'),
        prove: prove ? { token: magicRunId } : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      // Fail on integrity loss OR a recorded-but-unreproducible injection — independent of file count
      // (an empty/forged manifest must not bypass the check). Honest 'unsupported'/'none' has no
      // recorded files and reproduces trivially, so it correctly exits 0.
      if (!result.verification.integrityOk || (result.ledgerCheck.found && !result.ledgerCheck.reproduced)) {
        process.exitCode = 2;
      }
      return;
    }
    if (cmd === 'magic' && sub === 'show') {
      const magicRunId = firstNonFlag(rest);
      if (!magicRunId) throw new Error('usage: maestro magic show <magicRunId> [--into <dir>] [--executor ...]');
      const into = arg('--into') ?? process.cwd();
      const executor = arg('--executor') ?? 'claude';
      const runDir = join(into, '.agent', 'magic-runs', magicRunId);
      // Re-resolve the same catalog inputs and re-derive the injection from the ledger — recompute,
      // never trust the stored side-file.
      const catalog = loadModuleCatalog({ root: process.cwd() });
      const plan = resolveMagicPlan({ root: process.cwd(), goal: '(show)', catalog });
      const selectedMcpIds = new Set(plan.selected.filter((s) => s.kind === 'mcp').map((s) => s.moduleId));
      const mcpModules = catalog.modules.filter((m) => m.kind === 'mcp' && selectedMcpIds.has(m.id));
      const ledgerCheck = recomputeInjectionFromLedger(runDir, { mcpModules, adapter: adapterFor(executor), approveSecrets: has('--approve-secrets') });
      console.log(JSON.stringify({ magicRunId, ledgerCheck }, null, 2));
      if (ledgerCheck.found && !ledgerCheck.reproduced) {
        console.log('CONTRADICTION: the ledgered composition.injected record does not match a re-derivation from the current catalog — trust the recompute.');
        process.exitCode = 2;
      }
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
      console.log(
        'ADVISORY ONLY: this gate cannot mark a run or milestone complete. Completion authority = M7 ledger/diff verifier.',
      );
      console.log(JSON.stringify(report, null, 2));
      if (report.decision !== 'PASS') process.exitCode = 2;
      return;
    }
    if (cmd === 'orchestrate' && sub === 'run') {
      const file = arg('--file');
      if (!file) throw new Error('usage: maestro orchestrate run --file <graph.json> [--reconcile] [--verify-cmd CMD]');
      const spec = JSON.parse(readFileSync(file, 'utf8')) as {
        goal?: string;
        nodes?: { id: string; goal: string; deps?: string[]; executor?: string; purpose?: string }[];
      };
      if (!Array.isArray(spec.nodes) || spec.nodes.length === 0)
        throw new Error('graph file must contain a non-empty nodes[]');
      const result = await runSubmittedGraph({
        root: process.cwd(),
        registry: defaultExecutorRegistry(),
        goal: spec.goal,
        nodes: spec.nodes,
        reconcile: has('--reconcile'),
        reconcileVerifyCmd: arg('--verify-cmd'),
        concurrency: arg('--concurrency') !== undefined ? Number(arg('--concurrency')) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      const failed = result.graph.supportedCount === 0 || (result.reconcile && result.reconcile.verifyPassed === false);
      if (failed) process.exitCode = 2;
      return;
    }
    if (cmd === 'orchestrate' && sub === 'serve') {
      const host = arg('--host', '127.0.0.1') ?? '127.0.0.1';
      const unsafeHost = has('--unsafe-host');
      if (!['127.0.0.1', 'localhost'].includes(host) && !unsafeHost)
        throw new Error(
          'orchestrate serve binds loopback only; pass --unsafe-host with --auth-token to accept remote spawn risk',
        );
      const authToken = arg('--auth-token') || process.env.AGENT_ORCH_TOKEN;
      const reconcileVerifyCmd = arg('--verify-cmd') || process.env.AGENT_ORCH_VERIFY_CMD;
      if (unsafeHost && !authToken)
        throw new Error('--unsafe-host requires --auth-token or AGENT_ORCH_TOKEN (the server spawns local executors)');
      const port = Number(arg('--port', '4319'));
      const server = createOrchestratorServer({ root: process.cwd(), host, authToken, reconcileVerifyCmd });
      server.listen(port, host, () =>
        console.log(`orchestrator listening at http://${host}:${port}  (POST /graph, GET /health)`),
      );
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
      'maestro web only binds loopback hosts by default; pass --unsafe-host with --auth-token to acknowledge remote command/control risk',
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
      if (req.method === 'POST' && url.pathname === '/api/skill-runs') {
        const body = await requirePostAuth();
        const what = (body.what || '').trim();
        if (!what) throw new Error('a skill run needs a one-line goal (what)');
        // A goal never legitimately starts with `--`. Rejecting it stops a value like `--run-id`
        // from colliding with the child CLI's flag parser and corrupting the run id (which would
        // orphan the marker from the report it recomputes against).
        if (what.startsWith('--')) throw new Error('goal (what) must not start with "--"');
        const chosen = listSkillSpecs().find((s) => s.id === body.specId);
        if (!chosen) throw new Error('unknown skill spec');
        // Fail fast: confirm the spec is a real, loadable skill before spawning a detached child.
        const reg = defaultExecutorRegistry();
        loadSkillSpecFromJson(JSON.parse(readFileSync(chosen.path, 'utf8')) as SkillSpecJson, {
          codex: reg.resolve('codex'),
          claude: reg.resolve('claude'),
          agy: reg.resolve('agy'),
        });
        const root = process.cwd();
        const runId = `skill-${randomUUID()}`;
        const logDir = join(root, '.agent', 'skill-runs', runId);
        mkdirSync(logDir, { recursive: true });
        const logFd = openSync(join(logDir, 'launch.log'), 'a');
        // Async, wrap-don't-rebuild: the launch reuses the exact `maestro skill run` CLI as a
        // detached child. `what` is a separate argv element (no shell), and the spec path comes
        // from the server-owned whitelist — so neither can inject a command.
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), 'skill', 'run', chosen.path, '--what', what, '--run-id', runId],
          { cwd: root, detached: true, stdio: ['ignore', logFd, logFd] },
        );
        // The child inherited a dup of logFd; close the parent's copy so each launch does not
        // leak a descriptor in the long-lived web server.
        closeSync(logFd);
        // Marker carries operator input + pid only — it is NOT a verdict; completion is recomputed
        // from the ledger once the child writes its report.
        writeSkillLaunchMarker(root, {
          runId,
          skillId: chosen.id,
          what,
          startedAt: new Date().toISOString(),
          pid: child.pid ?? -1,
        });
        child.unref();
        redirect(res, `/skill/${runId}`);
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
      else if (url.pathname.startsWith('/skill/')) res.end(renderSkillRun(decodeURIComponent(url.pathname.slice(7))));
      else if (url.pathname === '/review-gate') res.end(renderReviewGate(process.cwd()));
      else if (url.pathname === '/') res.end(renderHtml(process.cwd(), csrfToken, '', listSkillSpecs()));
      else {
        res.statusCode = 404;
        res.end('not found');
      }
    } catch (err: any) {
      res.statusCode = 500;
      res.end(String(err.message || err));
    }
  });
  server.listen(port, host, () => console.log(`maestro web listening at http://${host}:${port}`));
}

main();

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeLedgerHeadBinding } from '../events/ledger.js';
import type { HarnessExecutor } from './harness-run.js';

export {
  type EvidenceRef,
  materializeEvidenceInto,
  type PhaseId,
  resolveEvidenceArtifact,
  storePhaseArtifact,
} from './evidence-store.js';

import type { PhaseId } from './evidence-store.js';
import { storePhaseArtifact, type EvidenceRef } from './evidence-store.js';
import { type GraphNode, type NodeState, runIsolatedWorker, type WorkerResult } from './orchestrator.js';

export interface PhaseSpec {
  executor?: HarnessExecutor;
  goalTemplate: string;
  acceptArtifact?: string;
}

export interface OrchestratorSkillSpec {
  id: string;
  phases: {
    research: PhaseSpec;
    execute: PhaseSpec;
    review: PhaseSpec;
  };
}

export interface PhaseResult {
  phase: PhaseId;
  workerId: string;
  nodeState: NodeState;
  outputRef?: string;
  skippedReason?: string;
}

export interface SkillRunReport {
  schema_version: 1;
  skillId: string;
  what: string;
  phases: PhaseResult[];
  ledgerHead: RuntimeLedgerHeadBinding;
  /**
   * Display-only mirror of the review node's nodeState. This is NOT the
   * authoritative completion verdict; the authoritative verdict is the
   * verifier-gated review-node state recorded in the hash-chained ledger.
   */
  completionDisplay: NodeState;
}

function interpolateGoal(template: string, input: { what: string }): string {
  return template.replaceAll('{what}', input.what);
}

export function compileSkillToGraphTemplate(spec: OrchestratorSkillSpec, input: { what: string }): GraphNode[] {
  return [
    {
      id: 'research',
      goal: interpolateGoal(spec.phases.research.goalTemplate, input),
      deps: [],
      executor: spec.phases.research.executor,
    },
    {
      id: 'execute',
      goal: interpolateGoal(spec.phases.execute.goalTemplate, input),
      deps: ['research'],
      executor: spec.phases.execute.executor,
    },
    {
      id: 'review',
      goal: interpolateGoal(spec.phases.review.goalTemplate, input),
      deps: ['execute'],
      executor: spec.phases.review.executor,
    },
  ];
}

const PHASE_IDS: PhaseId[] = ['research', 'execute', 'review'];

function isSupported(result: WorkerResult): boolean {
  return result.state === 'completed' && result.verifierStatus === 'supported';
}

function toPhaseResult(result: WorkerResult, phase: PhaseId): PhaseResult {
  return {
    phase,
    workerId: result.workerId,
    nodeState: isSupported(result) ? 'supported' : result.state === 'failed' ? 'failed' : 'blocked',
    outputRef: result.outputRef ?? undefined,
    skippedReason: undefined,
  };
}

function readWorkerLedgerHead(result: WorkerResult): RuntimeLedgerHeadBinding | undefined {
  if (!result.runDir) return undefined;
  const reportPath = join(result.worktreePath, result.runDir, 'harness-run-report.json');
  if (!existsSync(reportPath)) return undefined;
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { ledgerHead?: RuntimeLedgerHeadBinding };
  return report.ledgerHead;
}

export async function runOrchestratorSkill(
  spec: OrchestratorSkillSpec,
  input: { what: string; root: string; runId?: string },
): Promise<SkillRunReport> {
  const runId = input.runId ?? `skill-${randomUUID()}`;
  const nodes = compileSkillToGraphTemplate(spec, { what: input.what });
  const goalsByPhase = new Map(nodes.map((node) => [node.id, node.goal]));
  const phases: PhaseResult[] = [];
  const inputRefs: EvidenceRef[] = [];
  let ledgerHead: RuntimeLedgerHeadBinding | undefined;

  for (const phase of PHASE_IDS) {
    const priorUnsupported = phases.find((result) => result.nodeState !== 'supported');
    if (priorUnsupported) {
      phases.push({
        phase,
        workerId: phase,
        nodeState: 'skipped',
        outputRef: undefined,
        skippedReason: `unsupported deps: ${priorUnsupported.phase}`,
      });
      continue;
    }

    const result = await runIsolatedWorker({
      root: input.root,
      workerId: phase,
      goal: goalsByPhase.get(phase) ?? spec.phases[phase].goalTemplate,
      executor: spec.phases[phase].executor,
      inputRefs,
    });
    ledgerHead = readWorkerLedgerHead(result) ?? ledgerHead;

    const phaseResult = toPhaseResult(result, phase);
    phases.push(phaseResult);
    if (phaseResult.nodeState !== 'supported' || !spec.phases[phase].acceptArtifact) continue;

    try {
      inputRefs.push(
        storePhaseArtifact({
          root: input.root,
          skillRunId: runId,
          phase,
          sourceFile: join(result.worktreePath, spec.phases[phase].acceptArtifact),
        }),
      );
    } catch {
      phaseResult.nodeState = 'blocked';
    }
  }

  if (!ledgerHead) throw new Error('runOrchestratorSkill could not bind a worker ledger head');
  const review = phases.find((phase) => phase.phase === 'review');

  return {
    schema_version: 1,
    skillId: spec.id,
    what: input.what,
    phases,
    ledgerHead,
    completionDisplay: review?.nodeState ?? 'failed',
  };
}

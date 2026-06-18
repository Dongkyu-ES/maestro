import type { RuntimeLedgerHeadBinding } from '../events/ledger.js';
import type { HarnessExecutor } from './harness-run.js';
import { type GraphNode, type GraphNodeResult, type NodeState, runTaskGraph } from './orchestrator.js';

type PhaseId = 'research' | 'execute' | 'review';

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

function toPhaseResult(node: GraphNodeResult, phase: PhaseId): PhaseResult {
  return {
    phase,
    workerId: node.workerId,
    nodeState: node.nodeState,
    outputRef: node.outputRef ?? undefined,
    skippedReason: node.skippedReason,
  };
}

export async function runOrchestratorSkill(
  spec: OrchestratorSkillSpec,
  input: { what: string; root: string; runId?: string },
): Promise<SkillRunReport> {
  const nodes = compileSkillToGraphTemplate(spec, { what: input.what });
  const report = await runTaskGraph({ root: input.root, nodes, goal: spec.id, runId: input.runId });
  const resultsByWorkerId = new Map(report.nodes.map((node) => [node.workerId, node]));
  const phases = PHASE_IDS.flatMap((phase) => {
    const node = resultsByWorkerId.get(phase);
    return node ? [toPhaseResult(node, phase)] : [];
  });
  const review = resultsByWorkerId.get('review');

  return {
    schema_version: 1,
    skillId: spec.id,
    what: input.what,
    phases,
    ledgerHead: report.ledgerHead,
    completionDisplay: review?.nodeState ?? 'failed',
  };
}

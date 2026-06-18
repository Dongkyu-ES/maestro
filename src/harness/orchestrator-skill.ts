import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RuntimeLedgerHeadBinding } from '../events/ledger.js';
import type { HarnessExecutor } from './harness-run.js';
import { type GraphNode, type GraphNodeResult, type NodeState, runTaskGraph } from './orchestrator.js';

export type PhaseId = 'research' | 'execute' | 'review';

export interface EvidenceRef {
  phase: PhaseId;
  relativePath: string;
  sha256: string;
  storePath: string;
}

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

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function storePhaseArtifact(opts: {
  root: string;
  skillRunId: string;
  phase: PhaseId;
  sourceFile: string;
  relativePath?: string;
}): EvidenceRef {
  const content = readFileSync(opts.sourceFile);
  const relativePath = opts.relativePath ?? basename(opts.sourceFile);
  const storePath = join(
    opts.root,
    '.agent',
    'skill-runs',
    opts.skillRunId,
    'artifacts',
    opts.phase,
    basename(relativePath),
  );
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, content);

  return {
    phase: opts.phase,
    relativePath,
    sha256: sha256Hex(content),
    storePath,
  };
}

export function resolveEvidenceArtifact(ref: EvidenceRef): { content: Buffer; verified: boolean } {
  const content = readFileSync(ref.storePath);
  return { content, verified: sha256Hex(content) === ref.sha256 };
}

export function materializeEvidenceInto(ref: EvidenceRef, destDir: string): string {
  const { content, verified } = resolveEvidenceArtifact(ref);
  if (!verified) {
    throw new Error(`sha256 mismatch for evidence artifact ${ref.storePath}; possible tamper`);
  }

  const destPath = join(destDir, ref.relativePath);
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
  return destPath;
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

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runCodexExec } from '../runtime/codex-exec-runner.js';
import { type GenericCliSpec, runGenericCli } from '../runtime/generic-cli-runner.js';
import { runClosedLoop } from './closed-loop.js';
import { type HarnessExecutor, runHarnessSlice } from './harness-run.js';
import { computeRunMetrics, type RunMetrics } from './metrics.js';

export interface LaneResult {
  name: string;
  description: string;
  runDir: string;
  metrics: RunMetrics;
}

// Wrap any agent CLI as a DH executor so the dh lane drives the SAME model as its raw
// counterpart — the only variable between the two lanes is the evidence layer.
export function makeCliExecutor(spec: GenericCliSpec): HarnessExecutor {
  return (o) => runGenericCli(spec, o);
}

// Raw lane: run the CLI alone and capture the git diff the naive (un-redacted, ungated)
// way. This is the honest baseline for "what you get without DH".
export async function runRawCliLane(options: {
  root: string;
  laneName: string;
  bin: string;
  args: string[];
  timeoutMs?: number;
}): Promise<LaneResult> {
  const runId = `raw-${randomUUID()}`;
  const runDir = join(options.root, '.agent', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  await new Promise<void>((resolveDone) => {
    const child = spawn(options.bin, options.args, { cwd: options.root, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined;
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => {});
    child.on('close', () => {
      if (timer) clearTimeout(timer);
      resolveDone();
    });
  });
  const exclude = `:(exclude).agent/runs/${runId}`;
  try {
    execFileSync('git', ['add', '--intent-to-add', '--', '.', exclude], { cwd: options.root });
  } catch {
    /* nothing to stage */
  }
  const diff = execFileSync('git', ['diff', '--', '.', exclude], { cwd: options.root, encoding: 'utf8' });
  const status = execFileSync('git', ['status', '--porcelain', '--', '.', exclude], { cwd: options.root, encoding: 'utf8' });
  writeFileSync(join(runDir, 'tool-git-diff.patch'), diff);
  writeFileSync(join(runDir, 'tool-git-status.txt'), status);
  return {
    name: options.laneName,
    description: `raw ${options.bin} (no evidence layer: un-redacted diff, no ledger/verifier)`,
    runDir,
    metrics: computeRunMetrics({ root: options.root, runDir }),
  };
}

// DH lane: drive the SAME CLI (via executor) through the harness slice — hash-chained
// ledger + diff verifier + redaction.
export async function runDhSliceLane(options: {
  root: string;
  laneName: string;
  goal: string;
  executor?: HarnessExecutor;
  timeoutMs?: number;
}): Promise<LaneResult> {
  const slice = await runHarnessSlice({
    root: options.root,
    goal: options.goal,
    executor: options.executor,
    timeoutMs: options.timeoutMs,
  });
  const runDir = abs(options.root, slice.runDir);
  return {
    name: options.laneName,
    description: 'dh slice: hash-chained ledger + diff verifier + secret redaction',
    runDir,
    metrics: computeRunMetrics({ root: options.root, runDir }),
  };
}

export interface ComparisonReport {
  schema_version: 1;
  goal: string;
  generated_at: string;
  lanes: LaneResult[];
}

function abs(root: string, runDir: string): string {
  return isAbsolute(runDir) ? runDir : join(root, runDir);
}

// The "raw" lane = a native executor run with NO evidence layer: it captures the git
// diff the naive way (un-redacted, no verifier, no critic). This is exactly what DH
// did before the redaction fix, so the lane is an honest baseline for what the evidence
// layer adds.
async function runRawLane(options: { root: string; goal: string; executorBin?: string }): Promise<string> {
  const runId = `raw-${randomUUID()}`;
  const runDir = join(options.root, '.agent', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const previous = process.env.AGENT_CODEX_BIN;
  if (options.executorBin) process.env.AGENT_CODEX_BIN = options.executorBin;
  try {
    await runCodexExec({ runDir, cwd: options.root, prompt: options.goal, label: 'executor' });
  } finally {
    if (options.executorBin) {
      if (previous === undefined) delete process.env.AGENT_CODEX_BIN;
      else process.env.AGENT_CODEX_BIN = previous;
    }
  }
  const excludeRunDir = `:(exclude).agent/runs/${runId}`;
  try {
    execFileSync('git', ['add', '--intent-to-add', '--', '.', excludeRunDir], { cwd: options.root });
  } catch {
    /* nothing to stage */
  }
  const diff = execFileSync('git', ['diff', '--', '.', excludeRunDir], { cwd: options.root, encoding: 'utf8' });
  const status = execFileSync('git', ['status', '--porcelain', '--', '.', excludeRunDir], { cwd: options.root, encoding: 'utf8' });
  // No redact(): the whole point of the baseline is that the unguarded path persists
  // whatever the executor produced, secrets included.
  writeFileSync(join(runDir, 'tool-git-diff.patch'), diff);
  writeFileSync(join(runDir, 'tool-git-status.txt'), status);
  return runDir;
}

export async function runHarnessComparison(options: {
  root: string;
  goal: string;
  acceptanceContract: string;
  executorBin?: string;
  verifyCmd?: string;
  maxIters?: number;
}): Promise<ComparisonReport> {
  const root = resolve(options.root);
  const lanes: LaneResult[] = [];

  const rawDir = await runRawLane({ root, goal: options.goal, executorBin: options.executorBin });
  lanes.push({
    name: 'raw',
    description: 'native executor, no evidence layer (un-redacted diff, no verifier/critic)',
    runDir: rawDir,
    metrics: computeRunMetrics({ root, runDir: rawDir }),
  });

  const slice = await runHarnessSlice({ root, goal: options.goal, executorBin: options.executorBin });
  const sliceDir = abs(root, slice.runDir);
  lanes.push({
    name: 'dh-slice',
    description: 'harness slice: hash-chained ledger + diff verifier + redaction',
    runDir: sliceDir,
    metrics: computeRunMetrics({ root, runDir: sliceDir }),
  });

  const loop = await runClosedLoop({
    root,
    goal: options.goal,
    acceptanceContract: options.acceptanceContract,
    maxIters: options.maxIters ?? 2,
    executorBin: options.executorBin,
    verifyCmd: options.verifyCmd,
  });
  const loopDir = abs(root, loop.runDir);
  lanes.push({
    name: 'dh-loop',
    description: 'closed loop: slice + isolated critic gating + stall/escalation + verify-exit gate',
    runDir: loopDir,
    metrics: computeRunMetrics({ root, runDir: loopDir }),
  });

  return { schema_version: 1, goal: options.goal, generated_at: new Date().toISOString(), lanes };
}

const METRIC_ROWS: Array<{ key: keyof RunMetrics; label: string }> = [
  { key: 'state', label: 'final state' },
  { key: 'selfClaimBlocked', label: 'self-claim blocked' },
  { key: 'secretLeaked', label: 'secret leaked' },
  { key: 'coverageChecked', label: 'coverage/exit checked' },
  { key: 'exitClassified', label: 'exec error classified' },
  { key: 'driftSuspected', label: 'drift suspected' },
  { key: 'stopBlocks', label: 'stop blocks' },
  { key: 'escalations', label: 'escalations' },
  { key: 'iterations', label: 'iterations' },
];

export function renderComparisonMarkdown(report: ComparisonReport): string {
  const header = `| metric | ${report.lanes.map((l) => l.name).join(' | ')} |`;
  const divider = `| --- | ${report.lanes.map(() => '---').join(' | ')} |`;
  const rows = METRIC_ROWS.map((row) => {
    const cells = report.lanes.map((lane) => String(lane.metrics[row.key]));
    return `| ${row.label} | ${cells.join(' | ')} |`;
  });
  const legend = report.lanes.map((l) => `- **${l.name}** — ${l.description}`).join('\n');
  return `# Harness layer comparison\n\nGoal: ${report.goal}\nGenerated: ${report.generated_at}\n\n${header}\n${divider}\n${rows.join('\n')}\n\n${legend}\n`;
}

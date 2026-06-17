import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRuntimeEvents, type RuntimeEventEnvelope } from '../events/ledger.js';
import { containsLikelySecret } from '../util.js';

// Aggregated, comparable metrics over a single run's hash-chained ledger + persisted
// evidence. Pure reader — adds no instrumentation. This is the "measurable control"
// layer: it lets us tabulate what each harness layer actually caught on the same task.
export interface RunMetrics {
  runDir: string;
  kind: 'slice' | 'loop' | 'raw' | 'unknown';
  state: string | null;
  verifierStatus: string | null;
  iterations: number;
  selfClaimBlocked: boolean;
  secretLeaked: boolean;
  leakedArtifacts: string[];
  coverageChecked: boolean;
  exitClassified: boolean;
  stopBlocks: number;
  escalations: number;
  executorErrors: number;
  driftSuspected: boolean;
  tokensIn: number;
  tokensOut: number;
  determinismField: string | null;
  eventTypes: Record<string, number>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(full, acc);
    else if (stat.isFile()) acc.push(full);
  }
  return acc;
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function tally(events: RuntimeEventEnvelope[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) out[event.type] = (out[event.type] ?? 0) + 1;
  return out;
}

function scanLeaks(dirs: string[]): string[] {
  const leaked: string[] = [];
  for (const dir of dirs) {
    for (const file of walkFiles(dir)) {
      try {
        if (containsLikelySecret(readFileSync(file, 'utf8'))) leaked.push(file);
      } catch {
        /* unreadable/binary — skip */
      }
    }
  }
  return leaked;
}

function sumTokens(dirs: string[]): { tokensIn: number; tokensOut: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  for (const dir of dirs) {
    for (const file of walkFiles(dir)) {
      if (!file.endsWith('.process.json')) continue;
      const proc = readJsonFile<{ token_usage?: { input_tokens?: number; output_tokens?: number } }>(file);
      tokensIn += proc?.token_usage?.input_tokens ?? 0;
      tokensOut += proc?.token_usage?.output_tokens ?? 0;
    }
  }
  return { tokensIn, tokensOut };
}

export function computeRunMetrics(options: { root: string; runDir: string }): RunMetrics {
  const { root, runDir } = options;
  const events = readRuntimeEvents(runDir);
  const eventTypes = tally(events);
  const loopReport = readJsonFile<{
    status?: string;
    iterations?: Array<{ runDir?: string; deterministicStatus?: string; verify?: { ran?: boolean }; critic?: { met?: boolean; drift_suspected?: boolean } }>;
  }>(join(runDir, 'closed-loop-report.json'));
  const sliceReport = readJsonFile<{ state?: string; verifier?: { status?: string } }>(join(runDir, 'harness-run-report.json'));

  const kind: RunMetrics['kind'] = loopReport ? 'loop' : sliceReport ? 'slice' : events.length === 0 ? 'raw' : 'unknown';

  // Loop iteration work happens in sibling run dirs; include them for leak/token scans.
  const iterationDirs = (loopReport?.iterations ?? [])
    .map((it) => (typeof it.runDir === 'string' ? join(root, it.runDir) : ''))
    .filter(Boolean);
  const scanDirs = [runDir, ...iterationDirs];

  const leakedArtifacts = scanLeaks(scanDirs);
  const { tokensIn, tokensOut } = sumTokens(scanDirs);

  const criticRejections = events.filter(
    (e) => e.type === 'loop.critic' && (e.payload as { controller_done?: boolean }).controller_done === false,
  ).length;
  const selfClaimBlocked =
    criticRejections > 0 ||
    (eventTypes['run.blocked'] ?? 0) > 0 ||
    (kind === 'loop' && loopReport?.status === 'blocked') ||
    (kind === 'slice' && sliceReport?.state === 'blocked');

  const coverageChecked =
    events.some((e) => e.type === 'loop.verify' && (e.payload as { coverage_checked?: boolean }).coverage_checked === true) ||
    existsSync(join(runDir, 'tool-verify-result.json'));

  const exitClassified = events.some(
    (e) => e.type === 'loop.executor_error' && typeof (e.payload as { error_class?: string }).error_class === 'string',
  );

  const driftSuspected =
    (loopReport?.iterations ?? []).some((it) => it.critic?.drift_suspected === true) ||
    events.some((e) => e.type === 'loop.verify' && (e.payload as { drift_suspected?: boolean }).drift_suspected === true);

  return {
    runDir,
    kind,
    state: loopReport?.status ?? sliceReport?.state ?? null,
    verifierStatus: sliceReport?.verifier?.status ?? null,
    iterations: kind === 'loop' ? (loopReport?.iterations?.length ?? eventTypes['loop.iteration'] ?? 0) : kind === 'slice' ? 1 : 0,
    selfClaimBlocked,
    secretLeaked: leakedArtifacts.length > 0,
    leakedArtifacts,
    coverageChecked,
    exitClassified,
    stopBlocks: criticRejections + (eventTypes['run.blocked'] ?? 0) + (eventTypes['loop.blocked'] ?? 0),
    escalations: eventTypes['loop.escalated'] ?? 0,
    executorErrors: eventTypes['loop.executor_error'] ?? 0,
    driftSuspected,
    tokensIn,
    tokensOut,
    determinismField: sliceReport?.verifier?.status ?? null,
    eventTypes,
  };
}

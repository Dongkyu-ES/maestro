import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { appendRuntimeEvent } from '../events/ledger.js';
import { rebuildIndex } from './index-builder.js';
import {
  AGENT_DIR,
  type PromotionRecord,
  type RunMeta,
  ensureDir,
  nowIso,
  projectRoot,
  readYaml,
  safeJoin,
  slug,
  uniqueId,
  writeIfMissing,
} from '../util.js';

export function listPromotions(cwd = process.cwd()): PromotionRecord[] {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'promotions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function sectionBody(text: string, heading: string): string {
  const re = new RegExp(`##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

interface PromotionCandidate {
  target_type: PromotionRecord['target_type'];
  reason: string;
  target_path: string;
  body: string;
}

export function classifyRunPromotions(runDir: string, runId: string, cwd = process.cwd()): PromotionRecord[] {
  const root = projectRoot(cwd);
  const read = (rel: string): string => (existsSync(join(runDir, rel)) ? readFileSync(join(runDir, rel), 'utf8') : '');
  const review = read('review.md');
  const result = read('result.md');
  const runMeta = existsSync(join(runDir, 'run.yaml'))
    ? (readYaml(join(runDir, 'run.yaml')) as unknown as RunMeta)
    : ({} as RunMeta);
  const mode = String(runMeta.mode || 'basic');
  const decision = String(runMeta.decision || '');
  const taskTitle = String(runMeta.task_id || runId);

  const candidates: PromotionCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: PromotionCandidate): void => {
    const key = `${c.target_type}:${c.target_path}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(c);
  };

  const patchSuggestions = sectionBody(review, 'System Patch Suggestions');
  if (patchSuggestions && patchSuggestions !== 'None.') {
    push({
      target_type: 'policy',
      reason: `Review proposed a durable system patch: ${patchSuggestions.split('\n')[0]}`,
      target_path: '.agent/promotions/applied/policy/' + `${slug(taskTitle)}.md`,
      body: `# Policy Guard\n\nDerived from run ${runId} review.\n\n## Guard\n${patchSuggestions}\n`,
    });
    push({
      target_type: 'agent_instruction',
      reason: `Capture agent instruction so future runs avoid: ${patchSuggestions.split('\n')[0]}`,
      target_path: '.agent/promotions/applied/agent_instruction/' + `${slug(taskTitle)}.md`,
      body: `# Agent Instruction\n\nDerived from run ${runId} review.\n\n## Instruction\n${patchSuggestions}\n`,
    });
  }

  const hasScheduler = existsSync(join(runDir, 'scheduler.json'));
  const hasWorkOrders = existsSync(join(runDir, 'work-orders'));
  if ((mode === 'multi' || mode === 'roles') && (hasScheduler || hasWorkOrders)) {
    push({
      target_type: 'workflow',
      reason: `Run mode '${mode}' executed a repeatable multi-step procedure worth capturing as a workflow.`,
      target_path: '.agent/promotions/applied/workflows/' + `${slug(taskTitle)}.md`,
      body: `# Workflow: ${taskTitle}\n\nCaptured from ${mode} run ${runId}.\n\n## Steps\n${
        hasScheduler
          ? 'See scheduler.json for the executed step graph.'
          : 'See work-orders/ for the executed work orders.'
      }\n`,
    });
  }

  if (decision === 'pass') {
    const summary = sectionBody(result, 'Summary');
    if (summary) {
      push({
        target_type: 'memory',
        reason: 'Run passed review; result summary is a verified project fact.',
        target_path: '.agent/memory/project-facts.md',
        body: `## ${taskTitle} (run ${runId})\n\n${summary}\n`,
      });
    }
  }

  const rubric = sectionBody(review, 'Rubric Breakdown');
  const score = sectionBody(review, 'Score');
  if (rubric && score) {
    push({
      target_type: 'eval',
      reason: `Review rubric (score ${score}) can be captured as a regression check.`,
      target_path: '.agent/promotions/applied/evals/' + `${slug(taskTitle)}.md`,
      body: `# Eval: ${taskTitle}\n\nCaptured from run ${runId}.\n\n## Score\n${score}\n\n## Rubric\n${rubric}\n`,
    });
  }

  if (!candidates.length) return [];

  const ts = nowIso();
  const promotionsRunDir = join(runDir, 'promotions');
  ensureDir(promotionsRunDir);
  const records: PromotionRecord[] = [];
  for (const c of candidates) {
    const id = uniqueId('promotion', `${runId}-${c.target_type}`);
    const proposalPath = join(promotionsRunDir, `${id}.md`);
    writeFileSync(proposalPath, c.body);
    const rec: PromotionRecord = {
      schema_version: 1,
      id,
      run_id: runId,
      target_type: c.target_type,
      status: 'proposed',
      reason: c.reason,
      target_path: c.target_path,
      proposal_path: proposalPath,
      created_at: ts,
      updated_at: ts,
    };
    writeFileSync(safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`), JSON.stringify(rec, null, 2));
    records.push(rec);
  }
  return records;
}

export function resolvePromotion(id: string, status: 'approved' | 'rejected', cwd = process.cwd()): PromotionRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`);
  if (!existsSync(p)) throw new Error(`promotion ${id} not found`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as PromotionRecord;
  rec.status = status;
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'runtime-manager',
      type: 'promotion.decided',
      payload: { promotion_id: id, decision: status, target_type: rec.target_type, runtime_label: 'promotion_loop' },
      artifactRefs: [`promotions/${id}.json`],
    });
  rebuildIndex(root);
  return rec;
}

export function applyApprovedPromotion(id: string, cwd = process.cwd()): PromotionRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'promotions', `${id}.json`);
  if (!existsSync(p)) throw new Error(`promotion ${id} not found`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as PromotionRecord;
  if (rec.status === 'applied') return rec;
  if (rec.status !== 'approved') throw new Error(`promotion ${id} is not approved (status: ${rec.status})`);
  const proposalBody = existsSync(rec.proposal_path) ? readFileSync(rec.proposal_path, 'utf8') : rec.reason;
  const targetAbs = safeJoin(root, rec.target_path);
  const marker = `<!-- promotion:${id} -->`;
  if (rec.target_type === 'memory') {
    const existing = existsSync(targetAbs) ? readFileSync(targetAbs, 'utf8') : '# Project Facts\n';
    if (!existing.includes(marker)) {
      ensureDir(dirname(targetAbs));
      writeFileSync(targetAbs, `${existing.replace(/\n*$/, '\n')}\n${marker}\n${proposalBody.replace(/\n*$/, '\n')}`);
    }
  } else {
    writeIfMissing(targetAbs, `${marker}\n${proposalBody.replace(/\n*$/, '\n')}`);
  }
  rec.status = 'applied';
  rec.applied_path = relative(root, targetAbs);
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'runtime-manager',
      type: 'promotion.applied',
      payload: {
        promotion_id: id,
        target_type: rec.target_type,
        applied_path: rec.applied_path,
        runtime_label: 'promotion_loop',
      },
      artifactRefs: [`promotions/${id}.json`],
    });
  rebuildIndex(root);
  return rec;
}

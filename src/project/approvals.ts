import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRuntimeEvent } from '../events/ledger.js';
import { rebuildIndex } from './index-builder.js';
import { initProject } from './registry.js';
import {
  AGENT_DIR,
  type ApprovalRecord,
  nowIso,
  projectRoot,
  safeJoin,
  uniqueId,
} from '../util.js';

export function createApprovalInternal(
  runId: string,
  type: string,
  risk: 'low' | 'medium' | 'high',
  summary: string,
  cwd = process.cwd(),
  extra: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  const root = projectRoot(cwd);
  initProject(root);
  const ts = nowIso();
  const rec: ApprovalRecord = {
    schema_version: 1,
    id: uniqueId('approval', type),
    run_id: runId,
    type,
    status: 'requested',
    risk,
    summary,
    created_at: ts,
    updated_at: ts,
    ...extra,
  };
  writeFileSync(safeJoin(root, AGENT_DIR, 'approvals', `${rec.id}.json`), JSON.stringify(rec, null, 2));
  rebuildIndex(root);
  return rec;
}

export function createApproval(
  runId: string,
  type: string,
  risk: 'low' | 'medium' | 'high',
  summary: string,
  cwd = process.cwd(),
): ApprovalRecord {
  if (type === 'apply_proposal') throw new Error('apply_proposal approvals must be created by proposeApply');
  return createApprovalInternal(runId, type, risk, summary, cwd);
}

export function listApprovals(cwd = process.cwd()): ApprovalRecord[] {
  const dir = safeJoin(projectRoot(cwd), AGENT_DIR, 'approvals');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

export function resolveApproval(id: string, status: 'approved' | 'rejected', cwd = process.cwd()): ApprovalRecord {
  const root = projectRoot(cwd);
  const p = safeJoin(root, AGENT_DIR, 'approvals', `${id}.json`);
  const rec = JSON.parse(readFileSync(p, 'utf8')) as ApprovalRecord;
  rec.status = status;
  rec.updated_at = nowIso();
  writeFileSync(p, JSON.stringify(rec, null, 2));
  const runDir = existsSync(safeJoin(root, AGENT_DIR, 'runs', rec.run_id))
    ? safeJoin(root, AGENT_DIR, 'runs', rec.run_id)
    : '';
  if (runDir)
    appendRuntimeEvent(runDir, {
      runId: rec.run_id,
      source: 'permission-broker',
      type: 'approval.decided',
      payload: { approval_id: id, decision: status, runtime_label: 'approval_chain' },
      artifactRefs: [`approvals/${id}.json`],
    });
  rebuildIndex(cwd);
  return rec;
}

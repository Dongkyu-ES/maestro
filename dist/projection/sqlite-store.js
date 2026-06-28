import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const require = createRequire(import.meta.url);
export function writeProjectionSqlite(dbPath, projection) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, event_count INTEGER NOT NULL, rebuilt_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_sessions (run_id TEXT NOT NULL, session_id TEXT NOT NULL, adapter_kind TEXT, status TEXT NOT NULL, last_event_sequence INTEGER NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY(run_id, session_id));
    CREATE TABLE IF NOT EXISTS runtime_approvals (run_id TEXT NOT NULL, approval_id TEXT NOT NULL, status TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(run_id, approval_id));
    CREATE TABLE IF NOT EXISTS runtime_labels (run_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(run_id, label));
    CREATE TABLE IF NOT EXISTS runtime_artifacts (run_id TEXT NOT NULL, artifact_ref TEXT NOT NULL, PRIMARY KEY(run_id, artifact_ref));
    DELETE FROM runtime_runs; DELETE FROM runtime_sessions; DELETE FROM runtime_approvals; DELETE FROM runtime_labels; DELETE FROM runtime_artifacts;
  `);
    const insertRun = db.prepare('INSERT INTO runtime_runs(run_id,status,event_count,rebuilt_at) VALUES(?,?,?,?)');
    const insertSession = db.prepare('INSERT INTO runtime_sessions(run_id,session_id,adapter_kind,status,last_event_sequence,evidence_json) VALUES(?,?,?,?,?,?)');
    const insertApproval = db.prepare('INSERT INTO runtime_approvals(run_id,approval_id,status,sequence) VALUES(?,?,?,?)');
    const insertLabel = db.prepare('INSERT INTO runtime_labels(run_id,label) VALUES(?,?)');
    const insertArtifact = db.prepare('INSERT INTO runtime_artifacts(run_id,artifact_ref) VALUES(?,?)');
    for (const run of projection.runs) {
        insertRun.run(run.run_id, run.status, run.event_count, projection.rebuilt_at);
        for (const session of run.sessions)
            insertSession.run(run.run_id, session.session_id, session.adapter_kind || null, session.status, session.last_event_sequence, JSON.stringify(session.evidence));
        for (const approval of run.approvals)
            insertApproval.run(run.run_id, approval.approval_id, approval.status, approval.sequence);
        for (const label of run.labels)
            insertLabel.run(run.run_id, label);
        for (const artifact of run.artifacts)
            insertArtifact.run(run.run_id, artifact);
    }
    db.close();
}
export function readProjectionSqliteSummary(dbPath) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
    const out = {
        runs: count('runtime_runs'),
        sessions: count('runtime_sessions'),
        approvals: count('runtime_approvals'),
        labels: count('runtime_labels'),
        artifacts: count('runtime_artifacts'),
    };
    db.close();
    return out;
}

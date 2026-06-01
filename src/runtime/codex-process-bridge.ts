import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { detectCodexCli } from './codex-adapter.js';
import { sha256Text, upsertCodexSession, type CodexSessionRecord } from './codex-session-registry.js';


export function discoverCodexTranscriptPath(threadId = process.env.CODEX_THREAD_ID, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(threadId)) return undefined;
  const sessionsRoot = join(codexHome, 'sessions');
  const matches: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) matches.push(path);
    }
  };
  walk(sessionsRoot);
  matches.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
  return matches.at(-1);
}

export function shouldAutoAttachCurrentCodexTranscript(cwd: string): boolean {
  return Boolean(process.env.CODEX_THREAD_ID && cwd === process.cwd());
}

export interface CodexLaunchProof {
  schema_version: 1;
  run_id: string;
  status: 'unsupported' | 'unproven' | 'supported';
  session_id?: string;
  codex_path?: string;
  codex_version?: string;
  transcript_path?: string;
  transcript_sha256?: string;
  evidence_path: string;
  notes: string[];
}

export function createCodexLaunchProof(options: { runId: string; cwd: string; agentDir: string; runDir: string; prompt?: string; liveTranscriptPath?: string; autoAttachCurrentSession?: boolean }): CodexLaunchProof {
  mkdirSync(options.runDir, { recursive: true });
  const detected = detectCodexCli(options.cwd);
  const notes: string[] = [];
  let status: CodexLaunchProof['status'] = detected.available ? 'unproven' : 'unsupported';
  let transcriptPath = options.liveTranscriptPath || (options.autoAttachCurrentSession && shouldAutoAttachCurrentCodexTranscript(options.cwd) ? discoverCodexTranscriptPath() : undefined);
  let transcriptSha: string | undefined;
  if (transcriptPath && existsSync(transcriptPath)) {
    transcriptSha = sha256Text(readFileSync(transcriptPath, 'utf8'));
    status = 'supported';
    notes.push('Existing Codex session transcript was attached as first-class launch/attach/stream evidence. Approval, interrupt, resume, and fork remain operation-specific unless separately proven.');
  } else if (detected.available) {
    notes.push('Codex CLI binary detected; no live interactive transcript attached, so lifecycle remains unproven.');
  } else {
    notes.push(`Codex CLI unavailable: ${detected.error || 'not found'}`);
  }
  let doctor: string | undefined;
  if (detected.available) {
    try { doctor = execFileSync('codex doctor', { cwd: options.cwd, shell: true, encoding: 'utf8', timeout: 10000 }); }
    catch (err: any) { doctor = String(err.stdout || err.stderr || err.message || err); notes.push('codex doctor returned non-zero; preserved as evidence.'); }
  }
  const session: CodexSessionRecord = upsertCodexSession(options.agentDir, {
    run_id: options.runId,
    status: status === 'supported' ? 'supported' : detected.available ? 'launched_unproven' : 'unsupported',
    cwd: options.cwd,
    codex_path: detected.path,
    codex_version: detected.version,
    transcript_path: transcriptPath,
    transcript_sha256: transcriptSha,
    evidence_status: status,
    notes,
  });
  const evidence = {
    schema_version: 1,
    run_id: options.runId,
    session_id: session.session_id,
    status,
    detected,
    doctor,
    prompt_sha256: options.prompt ? sha256Text(options.prompt) : undefined,
    transcript_path: transcriptPath,
    transcript_sha256: transcriptSha,
    notes,
  };
  const evidencePath = 'codex-launch-proof.json';
  writeFileSync(join(options.runDir, evidencePath), JSON.stringify(evidence, null, 2));
  return { schema_version: 1, run_id: options.runId, status, session_id: session.session_id, codex_path: detected.path, codex_version: detected.version, transcript_path: transcriptPath, transcript_sha256: transcriptSha, evidence_path: evidencePath, notes };
}

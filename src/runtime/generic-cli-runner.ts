import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, redact } from '../util.js';
import type { CodexExecResult } from './codex-exec-runner.js';

// A generic non-codex executor: drive ANY agent CLI (claude -p, agy -p, ...) against a
// project directory and capture redacted execution evidence in the SAME shape the codex
// runner produces. DH's evidence layer (git diff, verifier, ledger) is executor-agnostic,
// so this is all the harness needs to wrap a different model behind the same contract.
export interface GenericCliSpec {
  name: string;
  bin: string;
  // Build argv from the prompt and working directory (cwd is where files get edited).
  buildArgs: (prompt: string, cwd: string) => string[];
}

export function runGenericCli(
  spec: GenericCliSpec,
  options: { runDir: string; cwd: string; prompt: string; timeoutMs?: number; label?: string },
): Promise<CodexExecResult> {
  const label = options.label || 'executor';
  const args = spec.buildArgs(options.prompt, options.cwd);
  const command = `${spec.bin} ${args.map((a) => (a === options.prompt ? '<prompt>' : a)).join(' ')}`;
  const started = nowIso();
  return new Promise<CodexExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    // Close stdin (EOF): headless agent CLIs (e.g. agy -p) block waiting on stdin if it
    // stays an open pipe, which manifests as a hang/timeout rather than an error.
    const child = spawn(spec.bin, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      writeFileSync(join(options.runDir, `${label}.pid`), String(child.pid || ''));
    } catch {
      /* runDir may be missing; the close handler re-creates it */
    }
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      stderr += `${err.message}\n`;
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result: CodexExecResult = {
        label,
        cwd: options.cwd,
        command,
        started_at: started,
        ended_at: nowIso(),
        exit_code: code ?? (timedOut ? 124 : 1),
        signal: signal ?? null,
        timed_out: timedOut,
        cancelled: false,
        session_id: undefined,
        last_message: redact(stdout).slice(-4000),
        token_usage: undefined,
        event_count: 0,
        stdout: redact(stdout),
        stderr: redact(stderr),
      };
      // Never throw out of this child-process callback (it would crash the process and
      // bypass the caller's try/catch). An executor with shell access can even delete
      // its own runDir mid-run, so re-create it and capture any write failure.
      let writeError = '';
      for (const [name, data] of [
        [`${label}.process.json`, JSON.stringify(result, null, 2)],
        [`${label}.stdout.log`, result.stdout],
        [`${label}.stderr.log`, result.stderr],
      ] as const) {
        try {
          mkdirSync(options.runDir, { recursive: true });
          writeFileSync(join(options.runDir, name), data);
        } catch (err) {
          writeError += `${name}: ${err instanceof Error ? err.message : String(err)}\n`;
        }
      }
      if (writeError) result.stderr = `${result.stderr}\n[evidence write failed]\n${writeError}`;
      resolve(result);
    });
  });
}

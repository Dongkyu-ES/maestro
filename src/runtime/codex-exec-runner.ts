import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, redact } from '../util.js';

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexExecResult {
  label: string;
  cwd: string;
  command: string;
  started_at: string;
  ended_at: string;
  exit_code: number;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  cancelled: boolean;
  session_id?: string;
  last_message: string;
  token_usage?: Record<string, number>;
  event_count: number;
  stdout: string;
  stderr: string;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: { type?: string; text?: string };
  usage?: Record<string, number>;
}

/**
 * Drive `codex exec` non-interactively against a project directory and capture
 * real execution evidence: the agent edits files in `cwd`, and the JSONL event
 * stream is parsed for the session id, final message, and token usage.
 *
 * This is the executor that actually performs work. It is intentionally NOT a
 * "launch proof": the returned exit code and the resulting git diff are the
 * trusted evidence, not the fact that the codex binary exists.
 */
export function runCodexExec(options: {
  runDir: string;
  cwd: string;
  prompt: string;
  sandbox?: CodexSandboxMode;
  timeoutMs?: number;
  label?: string;
  cancelRequested?: () => boolean;
}): Promise<CodexExecResult> {
  const label = options.label || 'executor';
  const sandbox = options.sandbox || 'workspace-write';
  const timeoutMs = options.timeoutMs;
  const lastMessagePath = join(options.runDir, 'codex-last-message.txt');
  const args = [
    'exec',
    '--json',
    '--sandbox',
    sandbox,
    '--skip-git-repo-check',
    '-C',
    options.cwd,
    '-o',
    lastMessagePath,
    options.prompt,
  ];
  const command = `codex exec --json --sandbox ${sandbox} -C ${options.cwd} <prompt>`;
  // Seam for hermetic tests / wrappers: AGENT_CODEX_BIN overrides the codex binary.
  // Production leaves it unset and runs the real `codex`.
  const codexBin = process.env.AGENT_CODEX_BIN || 'codex';
  const started = nowIso();
  return new Promise<CodexExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let sessionId: string | undefined;
    let lastMessage = '';
    let tokenUsage: Record<string, number> | undefined;
    let eventCount = 0;
    const rawLines: string[] = [];
    const childEnv = {
      ...process.env,
      PATH: process.env.PATH
        ? `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
        : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    };
    const child = spawn(codexBin, args, {
      cwd: options.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    writeFileSync(join(options.runDir, `${label}.pid`), String(child.pid || ''));

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      rawLines.push(trimmed);
      eventCount += 1;
      let event: CodexJsonEvent;
      try {
        event = JSON.parse(trimmed) as CodexJsonEvent;
      } catch {
        return;
      }
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string')
        lastMessage = event.item.text;
      if (event.type === 'turn.completed' && event.usage) tokenUsage = event.usage;
    };

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      let idx = stdoutBuffer.indexOf('\n');
      while (idx >= 0) {
        consumeLine(stdoutBuffer.slice(0, idx));
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        idx = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      stderr += `${err.message}\n`;
    });

    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      try {
        child.kill(signal);
      } catch {}
    };
    const timer =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            terminate('SIGTERM');
            setTimeout(() => {
              if (!settled) terminate('SIGKILL');
            }, 2000).unref();
          }, timeoutMs)
        : undefined;
    const cancelTimer = setInterval(() => {
      if (settled) return;
      if (options.cancelRequested?.()) {
        cancelled = true;
        terminate('SIGTERM');
        setTimeout(() => {
          if (!settled) terminate('SIGKILL');
        }, 2000).unref();
      }
    }, 200);

    child.on('close', (code, signal) => {
      settled = true;
      if (timer) clearTimeout(timer);
      clearInterval(cancelTimer);
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      const exitCode = cancelled ? 130 : (code ?? (timedOut ? 124 : 1));
      writeFileSync(join(options.runDir, 'codex-events.jsonl'), `${rawLines.join('\n')}\n`);
      const result: CodexExecResult = {
        label,
        cwd: options.cwd,
        command,
        started_at: started,
        ended_at: nowIso(),
        exit_code: exitCode,
        signal: signal ?? null,
        timed_out: timedOut,
        cancelled,
        session_id: sessionId,
        last_message: lastMessage,
        token_usage: tokenUsage,
        event_count: eventCount,
        stdout: redact(lastMessage || stdout),
        stderr: redact(stderr),
      };
      // Write the same ProcessLog-shaped evidence the shell executor produces, so
      // the existing collect/review/normalize pipeline treats this as a real run
      // and uses the real exit code.
      writeFileSync(join(options.runDir, `${label}.process.json`), JSON.stringify(result, null, 2));
      writeFileSync(join(options.runDir, `${label}.stdout.log`), result.stdout);
      writeFileSync(join(options.runDir, `${label}.stderr.log`), result.stderr);
      resolve(result);
    });
  });
}

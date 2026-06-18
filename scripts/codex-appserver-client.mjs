#!/usr/bin/env node
// Minimal driver for the Codex app-server (JSONRPC over WebSocket).
// Drives one bounded turn against a running `codex app-server --listen ws://IP:PORT`
// and prints the final agent message. Used to operate Codex as a sub-agent executor.
//
// Usage:
//   node scripts/codex-appserver-client.mjs --cwd <dir> --sandbox read-only|workspace-write \
//        [--url ws://127.0.0.1:8787] [--model gpt-5.5] [--timeout-ms 600000] [--json] "<prompt>"
//   (prompt may also be piped on stdin)
//
// Exit 0 with the final agent message on stdout; non-zero on protocol/turn error.

import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const o = { url: 'ws://127.0.0.1:8787', sandbox: 'read-only', cwd: process.cwd(), timeoutMs: 600000, json: false, prompt: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--sandbox') o.sandbox = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--approval') o.approval = argv[++i];
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--json') o.json = true;
    else if (a === '--prompt-file') o.prompt = readFileSync(argv[++i], 'utf8');
    else rest.push(a);
  }
  if (!o.prompt) o.prompt = rest.join(' ').trim();
  if (!o.prompt && !process.stdin.isTTY) {
    try { o.prompt = readFileSync(0, 'utf8').trim(); } catch { /* no stdin */ }
  }
  return o;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.prompt) {
  console.error('error: no prompt provided (arg, --prompt-file, or stdin)');
  process.exit(2);
}

const ws = new WebSocket(opts.url);
let nextId = 1;
const pending = new Map();
let threadId = null;
let finalMessage = '';
const deltas = [];
let settled = false;

function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function done(code, msg) {
  if (settled) return;
  settled = true;
  if (msg !== undefined) process.stdout.write(msg);
  try { ws.close(); } catch { /* already closed */ }
  process.exit(code);
}

const timer = setTimeout(() => { console.error(`timeout after ${opts.timeoutMs}ms`); done(124); }, opts.timeoutMs);
timer.unref?.();

ws.addEventListener('open', async () => {
  try {
    await send('initialize', { clientInfo: { name: 'warden', title: 'Warden', version: '0.1.0' }, capabilities: null });
    const start = await send('thread/start', {
      cwd: opts.cwd,
      sandbox: opts.sandbox,
      approvalPolicy: opts.approval || 'never',
      ...(opts.model ? { model: opts.model } : {}),
    });
    threadId = start?.thread?.id ?? start?.threadId ?? start?.thread_id;
    if (!threadId) throw new Error('no threadId in thread/start response: ' + JSON.stringify(start).slice(0, 300));
    await send('turn/start', {
      threadId,
      input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
    });
    // turn/completed notification drives completion.
  } catch (e) {
    console.error('driver error:', e?.message || e);
    done(1);
  }
});

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
  // Response to one of our requests
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    return;
  }
  // Server notification
  const method = m.method;
  const params = m.params || {};
  if (method === 'item/agentMessage/delta') {
    const d = params.delta ?? params.text ?? params.delta?.text;
    if (typeof d === 'string') deltas.push(d);
  } else if (method === 'item/completed') {
    const it = params.item || params;
    if ((it.type === 'agent_message' || it.item_type === 'agentMessage') && typeof (it.text ?? it.content) === 'string') {
      finalMessage = it.text ?? it.content;
    }
  } else if (method === 'turn/completed') {
    const turn = params.turn || {};
    const msg = finalMessage || deltas.join('') || (Array.isArray(turn.items) ? turn.items.filter((x) => x?.type === 'agent_message').map((x) => x.text).join('\n') : '');
    clearTimeout(timer);
    if (opts.json) done(0, JSON.stringify({ threadId, message: msg, usage: turn.usage ?? null }, null, 2) + '\n');
    else done(0, (msg || '').trimEnd() + '\n');
  } else if (method === 'error' || method === 'thread/realtime/error') {
    console.error('server error notification:', JSON.stringify(params).slice(0, 500));
    clearTimeout(timer);
    done(1);
  }
});

ws.addEventListener('error', (e) => { console.error('ws error:', e?.message || 'connection failed'); done(1); });
ws.addEventListener('close', () => { if (!settled) { console.error('ws closed before turn/completed'); done(1); } });

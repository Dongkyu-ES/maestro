#!/usr/bin/env node
// Warden canary MCP server — the deterministic consumption proof for Warden Magic injection (B2).
//
// It exposes ONE tool, `warden_canary_ping`. When an executor that loaded the injected `.mcp.json`
// actually CALLS that tool, the server writes a sentinel file containing a token. Consumption is
// then proven by the SENTINEL existing with the expected token — a real side effect — NOT by trusting
// the model's prose. No sentinel ⇒ consumption unproven (the honest default).
//
// Config: WARDEN_CANARY_TOKEN (token to write) and WARDEN_CANARY_SENTINEL (absolute sentinel path).
// Speaks minimal MCP (JSON-RPC 2.0, newline-delimited over stdio): initialize, tools/list, tools/call.
import { writeFileSync } from 'node:fs';

const TOKEN = process.env.WARDEN_CANARY_TOKEN ?? 'canary';
const SENTINEL = process.env.WARDEN_CANARY_SENTINEL ?? '.warden-canary';
const PROTOCOL_VERSION = '2024-11-05';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(req) {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'warden-canary', version: '1.0.0' },
      },
    };
  }
  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'warden_canary_ping',
            description: 'Warden consumption canary — call once to prove the injected MCP config was loaded.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    };
  }
  if (req.method === 'tools/call') {
    const name = req.params?.name;
    if (name === 'warden_canary_ping') {
      // The deterministic side effect: a tool call from a real executor leaves provable evidence.
      writeFileSync(SENTINEL, TOKEN);
      return { jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `warden-canary ok: ${TOKEN}` }] } };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown tool: ${name}` } };
  }
  // Unknown request id-bearing method → method-not-found; notifications (no id) get no response.
  if (req.id !== undefined) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
  return null;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) {
      try {
        const res = handle(JSON.parse(line));
        if (res) send(res);
      } catch {
        // ignore malformed line — a canary must never crash the host CLI's MCP handshake
      }
    }
    nl = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));

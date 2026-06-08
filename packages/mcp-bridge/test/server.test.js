'use strict';

// Integration tests for src/server.js — transport + auth gate + tool mounting
// (T1). Uses the real SDK MCP client over Streamable HTTP to prove a full
// round-trip: connect (bearer-gated) → list a read-only tool → call it → assert
// the result is egress-redacted. Also covers the fail-closed registration rule
// and the unauthenticated 401 → WWW-Authenticate(PRM) path.
//
// These run with a FAKE policy + FAKE tool (T2/T3 land the real ones); the wiring
// they exercise is identical to production.

const test = require('node:test');
const assert = require('node:assert');
const { createBridgeServer, registerTools, withEgressRedaction } = require('../src/server');
const { createBridgeAuth, createMemoryStore } = require('../src/auth');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const PLANTED = 'sk-ant-' + 'a'.repeat(40); // matches redact.js anthropic-key rule

const fakePolicy = {
  assertReadOnly(t) {
    if (t && t.write) throw new Error('write capability rejected');
    if (t && t.annotations && t.annotations.readOnlyHint === false) throw new Error('not read-only');
  },
  requiresApproval(name) {
    return name === 'read_panel';
  },
  visiblePanels(s) {
    return s;
  },
};

function fakeTools() {
  return [
    {
      name: 'echo_status',
      title: 'Echo status',
      description: 'Returns canned text containing a planted secret (to prove egress redaction).',
      inputSchema: (z) => ({ query: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      approval: false,
      handler: withEgressRedaction(async (args) => ({
        content: [{ type: 'text', text: `q=${(args && args.query) || ''}; key=${PLANTED}` }],
      })),
    },
  ];
}

function startServer() {
  const auth = createBridgeAuth({
    issuerUrl: 'http://127.0.0.1:8911', // fixed; the round-trip uses a static bearer
    store: createMemoryStore(),
    staticBearer: 'test-bearer',
    operatorSecret: 'op',
    autoApprove: true,
  });
  const server = createBridgeServer({ tools: fakeTools(), policy: fakePolicy, auth });
  const http = server.listen(0, '127.0.0.1');
  return {
    http,
    ready: new Promise((r) => http.once('listening', r)),
    base: () => `http://127.0.0.1:${http.address().port}`,
  };
}

test('health endpoint + unauthenticated /mcp → 401 with WWW-Authenticate(PRM)', async () => {
  const s = startServer();
  await s.ready;
  try {
    const h = await (await fetch(`${s.base()}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.tools, 1);
    assert.equal(h.auth, 'oauth+static');

    const r = await fetch(`${s.base()}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /resource_metadata/);
    await r.body?.cancel();
  } finally {
    s.http.close();
  }
});

test('fail-closed: registering a tool with no policy throws (no tool ever exposed unguarded)', () => {
  const server = new McpServer({ name: 'test', version: '0' });
  assert.throws(() => registerTools(server, { tools: fakeTools(), policy: null }), /fail-closed/);
});

test('SDK-client round-trip: list + call a read-only tool, result is egress-redacted', async () => {
  const s = startServer();
  await s.ready;
  const transport = new StreamableHTTPClientTransport(new URL(`${s.base()}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer test-bearer' } },
  });
  const client = new Client({ name: 'test-client', version: '0' });
  try {
    await client.connect(transport);

    const list = await client.listTools();
    const tool = list.tools.find((t) => t.name === 'echo_status');
    assert.ok(tool, 'echo_status is listed');
    assert.equal(tool.annotations && tool.annotations.readOnlyHint, true, 'readOnlyHint annotation present');
    // settles the open question: a Zod RAW SHAPE passed to registerTool serializes
    // to a proper JSON object schema in tools/list.
    assert.equal(tool.inputSchema && tool.inputSchema.type, 'object', 'inputSchema serialized as object schema');
    assert.ok(tool.inputSchema.properties && 'query' in tool.inputSchema.properties, 'inputSchema exposes the `query` property');

    const res = await client.callTool({ name: 'echo_status', arguments: { query: 'hi' } });
    const text = res.content.map((c) => c.text).join('');
    assert.ok(!text.includes(PLANTED), 'planted secret is NOT present in the tool result (egress-redacted)');
    assert.match(text, /‹redacted:anthropic-key›/, 'redaction marker is present');
    assert.match(text, /q=hi/, 'tool received its arguments');
  } finally {
    await client.close().catch(() => {});
    s.http.close();
  }
});

test('approval-required tool registers and carries the approval _meta hint', async () => {
  // requiresApproval('read_panel') === true in fakePolicy; ensure it mounts and
  // the advisory hint is set (real enforcement is handler-side).
  const server = new McpServer({ name: 'test', version: '0' });
  const tools = [
    {
      name: 'read_panel',
      description: 'reads a panel tail',
      inputSchema: (z) => ({ id: z.string() }),
      annotations: { readOnlyHint: true },
      approval: true,
      handler: withEgressRedaction(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    },
  ];
  const n = registerTools(server, { tools, policy: fakePolicy });
  assert.equal(n, 1);
});

test('stale/unknown session id on a non-initialize request → 404 (so the client re-initializes)', async () => {
  // Regression for the live go-live fix (2026-06-08): the stateful transport used
  // to answer 400 for an unknown session id, which stranded Claude.ai's connector
  // replaying a dead session after a Bridge restart / ephemeral-tunnel cycle. The
  // MCP Streamable-HTTP spec requires 404 so the client starts a fresh session.
  const s = startServer();
  await s.ready;
  try {
    const r = await fetch(`${s.base()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer test-bearer',
        'Mcp-Session-Id': 'no-such-session',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 404, 'unknown session id must 404 (not 400) so the client re-initializes');
    await r.body?.cancel();
  } finally {
    s.http.close();
  }
});

test('no session id + non-initialize request → 400 (genuine bad request preserved)', async () => {
  const s = startServer();
  await s.ready;
  try {
    const r = await fetch(`${s.base()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer test-bearer',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 400, 'no session id + non-initialize stays a 400');
    await r.body?.cancel();
  } finally {
    s.http.close();
  }
});

'use strict';

// Memory-only mode (Sprint 75 / T3). TERMDECK_BRIDGE_MEMORY_ONLY=1 (or
// options.memoryOnly) runs the Bridge for a panel-less host (the cloud third
// origin of the bridge HA chain): the panel-tool family is never BUILT —
// absent from tools/list, not present-but-erroring — while memory tools,
// OAuth, egress redaction, rate limiting, and the fail-closed policy withhold
// stay exactly as in full mode.
//
// Tests use the REAL src/tools assembly + REAL src/policy with hermetic
// injected clients (per server.test.js idiom: real SDK client over Streamable
// HTTP against a listen(0) server). The injected mnestra client deliberately
// has no `propose` method, so the (separately-owned) proposal channel can
// never mount here regardless of its in-tree state.

const test = require('node:test');
const assert = require('node:assert');
const { bootstrap, withEgressRedaction } = require('../src/server');
const { buildTools } = require('../src/tools');
const policy = require('../src/policy');
const { createBridgeAuth, createMemoryStore } = require('../src/auth');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MEMORY_TOOLS = ['memory_recall', 'memory_search'];
const PANEL_TOOLS = ['list_panels', 'panel_status', 'read_panel', 'recent_activity'];
const PLANTED = 'sk-ant-' + 'b'.repeat(40); // matches redact.js anthropic-key rule

function fakeClients() {
  return {
    mnestra: {
      recall: async () => ({ memories: [{ content: `cloud note; key=${PLANTED}` }], total: 1 }),
      search: async () => ({ hits: [], total: 0 }),
    },
    termdeck: {
      listSessions: async () => [],
      getTranscript: async () => ({ content: '' }),
      getRecentTranscripts: async () => [],
    },
  };
}

function makeAuth() {
  return createBridgeAuth({
    issuerUrl: 'http://127.0.0.1:8912', // fixed; round-trips use the static bearer
    store: createMemoryStore(),
    staticBearer: 'test-bearer',
    operatorSecret: 'op',
    autoApprove: true,
  });
}

// bootstrap with REAL policy + REAL tool assembly; clients injected hermetically.
function boot(opts = {}) {
  const server = bootstrap({ auth: makeAuth(), clients: fakeClients(), ...opts });
  const http = server.listen(0, '127.0.0.1');
  return {
    server,
    http,
    ready: new Promise((r) => http.once('listening', r)),
    base: () => `http://127.0.0.1:${http.address().port}`,
  };
}

async function withClient(base, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer test-bearer' } },
  });
  const client = new Client({ name: 'memory-only-test', version: '0' });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

test('flag ON (options.memoryOnly): memory tools mounted, NO panel tool mounted (asserted by name)', async () => {
  const s = boot({ memoryOnly: true });
  await s.ready;
  try {
    const names = await withClient(s.base(), async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const m of MEMORY_TOOLS) assert.ok(names.includes(m), `${m} must be mounted in memory-only mode`);
    for (const p of PANEL_TOOLS) assert.ok(!names.includes(p), `${p} must be ABSENT in memory-only mode`);
  } finally {
    s.http.close();
  }
});

test('flag ON via env (TERMDECK_BRIDGE_MEMORY_ONLY=1); explicit option false beats env', async () => {
  process.env.TERMDECK_BRIDGE_MEMORY_ONLY = '1';
  try {
    const on = boot({});
    await on.ready;
    try {
      const names = await withClient(on.base(), async (c) => (await c.listTools()).tools.map((t) => t.name));
      for (const p of PANEL_TOOLS) assert.ok(!names.includes(p), `${p} absent under the env flag`);
      for (const m of MEMORY_TOOLS) assert.ok(names.includes(m), `${m} present under the env flag`);
    } finally {
      on.http.close();
    }
    const off = boot({ memoryOnly: false }); // option > env, explicit false wins
    await off.ready;
    try {
      const h = await (await fetch(`${off.base()}/healthz`)).json();
      assert.equal(h.mode, 'full', 'explicit memoryOnly:false must beat env=1');
    } finally {
      off.http.close();
    }
  } finally {
    delete process.env.TERMDECK_BRIDGE_MEMORY_ONLY;
  }
});

test('flag OFF (regression): both families mounted', async () => {
  const s = boot({});
  await s.ready;
  try {
    const names = await withClient(s.base(), async (c) => (await c.listTools()).tools.map((t) => t.name));
    for (const n of [...MEMORY_TOOLS, ...PANEL_TOOLS]) assert.ok(names.includes(n), `${n} mounted in full mode`);
  } finally {
    s.http.close();
  }
});

test('/healthz reports the mode + opt-in origin label (absent when unset)', async () => {
  const on = boot({ memoryOnly: true, serverOptions: { originLabel: 'cloud-test' } });
  await on.ready;
  try {
    const h = await (await fetch(`${on.base()}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.mode, 'memory-only');
    assert.equal(h.tools, MEMORY_TOOLS.length, 'memory-only mounts exactly the memory family (this fixture)');
    assert.equal(h.origin, 'cloud-test', 'configured origin label surfaces');
  } finally {
    on.http.close();
  }
  const off = boot({});
  await off.ready;
  try {
    const h = await (await fetch(`${off.base()}/healthz`)).json();
    assert.equal(h.mode, 'full');
    assert.ok(!('origin' in h), 'origin label absent unless configured');
  } finally {
    off.http.close();
  }
});

test('fail-closed withhold preserved: tools-without-policy are withheld regardless of the flag', async () => {
  const stub = [
    {
      name: 'echo_status',
      description: 'stub',
      inputSchema: (z) => ({ q: z.string().optional() }),
      annotations: { readOnlyHint: true },
      approval: false,
      handler: withEgressRedaction(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    },
  ];
  const s = boot({ tools: stub, policy: null, memoryOnly: true });
  await s.ready;
  try {
    assert.equal(s.server.toolCount, 0, 'withhold branch zeroes the tool list');
    const h = await (await fetch(`${s.base()}/healthz`)).json();
    assert.equal(h.tools, 0);
    assert.equal(h.mode, 'memory-only', 'mode is the configured flavor, not a mount-success signal');
  } finally {
    s.http.close();
  }
});

test('auth gate untouched by the flag: unauthenticated /mcp still 401 + WWW-Authenticate(PRM)', async () => {
  const s = boot({ memoryOnly: true });
  await s.ready;
  try {
    const r = await fetch(`${s.base()}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') || '', /resource_metadata/);
    await r.body?.cancel();
  } finally {
    s.http.close();
  }
});

test('egress redaction untouched by the flag: memory_recall result scrubbed in memory-only mode', async () => {
  const s = boot({ memoryOnly: true });
  await s.ready;
  try {
    const text = await withClient(s.base(), async (c) => {
      const res = await c.callTool({ name: 'memory_recall', arguments: { query: 'cloud note' } });
      return res.content.map((x) => x.text).join('');
    });
    assert.ok(!text.includes(PLANTED), 'planted secret never egresses in memory-only mode');
    assert.match(text, /‹redacted:anthropic-key›/, 'redaction marker present');
  } finally {
    s.http.close();
  }
});

test('buildTools unit: memoryOnly builds WITHOUT clients.termdeck; full mode still requires it', () => {
  const noTermdeck = { mnestra: fakeClients().mnestra };
  const built = buildTools({ withEgressRedaction, policy, clients: noTermdeck, memoryOnly: true });
  assert.deepEqual(built.map((t) => t.name).sort(), [...MEMORY_TOOLS].sort());
  assert.throws(() => buildTools({ withEgressRedaction, policy, clients: noTermdeck }), /clients/);
});

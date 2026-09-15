'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_propose_status + /healthz `inbox` (Sprint 86) — the write-VISIBILITY
// path.
//
// Covers: the policy carve-out that lets a READ tool carry a mutating verb in
// its name (and refuses to let that carve-out be abused), the two new mnestra
// read ops and their 404/501 handling, the tool handler's uuid gate and its
// three dispositions, the mount gate riding the propose flag, the pointer
// memory_propose now leaves to this tool, and the health field's three
// non-negotiables: never blocks, degrades to ABSENT, stays minimal.
//
// Hermetic by construction: every env bag points the loaders at /nonexistent
// files, so no test ever reads ~/.termdeck state.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/policy');
const { buildTools } = require('../src/tools');
const { buildProposeStatusTools } = require('../src/tools/propose-status');
const { createMnestraClient } = require('../src/clients/mnestra');
const { createBridgeServer } = require('../src/server');
const { createBridgeAuth, createMemoryStore } = require('../src/auth');

const UUID = '3f8a1c2e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
const wrap = (h) => h;

function hermeticEnv(extra = {}) {
  return {
    TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
    TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/bridge-propose.json',
    ...extra,
  };
}

// ── policy: the exact-name read exemption ────────────────────────────────────

test('policy: memory_propose_status mounts as a READ despite the "propose" verb token', () => {
  assert.equal(
    policy.assertReadOnly({
      name: 'memory_propose_status',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }),
    true,
  );
});

test('policy: the exemption demands an EXPLICIT readOnlyHint:true — silence is not enough', () => {
  // No annotations at all: step 1 has nothing to reject, but the exemption
  // refuses to extend its benefit to a tool that will not assert read-only.
  assert.throws(
    () => policy.assertReadOnly({ name: 'memory_propose_status' }),
    /must declare readOnlyHint:true explicitly/,
  );
  assert.throws(
    () => policy.assertReadOnly({ name: 'memory_propose_status', annotations: { readOnlyHint: false } }),
    /declared writable/,
  );
  assert.throws(
    () => policy.assertReadOnly({
      name: 'memory_propose_status',
      annotations: { readOnlyHint: true, destructiveHint: true },
    }),
    /declared destructive/,
  );
});

test('policy: the exemption is exact-name — it does not widen to other propose-ish names', () => {
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  for (const name of ['memory_propose_write', 'proposal_status', 'memory_propose_status_v2', 'memory_remember_status']) {
    assert.throws(
      () => policy.assertReadOnly({ name, annotations: ro }),
      /implies a mutating capability/,
      `${name} must still be rejected by the name heuristic`,
    );
  }
  // And the real write channel still cannot mount by lying read-only.
  assert.throws(
    () => policy.assertReadOnly({ name: 'memory_propose', annotations: ro }),
    /does not declare the exact honest/,
  );
});

test('policy: a status check is a memory read — not approval-gated', () => {
  assert.equal(policy.requiresApproval('memory_propose_status'), false);
  assert.equal(policy.requiresApproval('memory_propose'), true, 'the write still is');
});

// ── mnestra client: the two new read ops ─────────────────────────────────────

function fetchStub(handler) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const r = handler(body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => 'application/json' },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

test('client: proposeStatus posts op=propose_status and projects bounded fields only', async () => {
  const seen = [];
  const c = createMnestraClient({
    env: {},
    fetchImpl: fetchStub((body) => {
      seen.push(body);
      return {
        status: 200,
        body: {
          ok: true,
          found: true,
          id: UUID,
          status: 'rejected',
          rejection_reason: 'recipe-level',
          promoted_memory_id: null,
          proposed_at: '2026-09-06T01:28:03Z',
          detail: 'covered by git history',
          text: 'THE ORIGINAL PROPOSAL TEXT',
        },
      };
    }),
  });

  const r = await c.proposeStatus({ proposalId: UUID });
  assert.deepEqual(seen[0], { op: 'propose_status', id: UUID }, 'sends the canonical `id` key');
  assert.equal(r.found, true);
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejectionReason, 'recipe-level');
  assert.equal(r.promotedMemoryId, null);
  assert.equal(r.proposedAt, '2026-09-06T01:28:03Z');
  assert.equal(r.detail, 'covered by git history');
  // The proposal TEXT must never come back — the caller already sent it, and
  // re-emitting stored content through the provider cloud buys nothing.
  assert.ok(!('text' in r), 'proposal text must not be projected back');
  assert.ok(!JSON.stringify(r).includes('THE ORIGINAL PROPOSAL TEXT'));
});

test('client: unknown arrives as 200 found:false — never as pending; 501 names the upgrade', async () => {
  // THE CONTRACT: unknown is a 200 with found:false, NOT a 404.
  const unknown = createMnestraClient({
    env: {},
    fetchImpl: fetchStub(() => ({
      status: 200,
      body: { ok: true, found: false, id: UUID, status: null, detail: 'unknown — no such proposal, or it aged out' },
    })),
  });
  const u = await unknown.proposeStatus({ proposalId: UUID });
  assert.equal(u.found, false);
  assert.equal(u.status, null, 'an unknown proposal has NO status — it must never read as pending');
  assert.match(u.detail, /aged out/, 'detail passes straight through');

  // Defensive: a 404 from an older/proxied build still reads as unknown.
  const notFound = createMnestraClient({
    env: {},
    fetchImpl: fetchStub(() => ({ status: 404, body: { ok: false, error: 'not found' } })),
  });
  assert.equal((await notFound.proposeStatus({ proposalId: UUID })).found, false);

  const old = createMnestraClient({
    env: {},
    fetchImpl: fetchStub(() => ({ status: 501, body: { ok: false, error: 'unknown op' } })),
  });
  await assert.rejects(
    () => old.proposeStatus({ proposalId: UUID }),
    /no propose_status op \(upgrade @jhizzard\/mnestra/,
  );
});

test('client: proposeStatus requires an id', async () => {
  const c = createMnestraClient({ env: {}, fetchImpl: fetchStub(() => ({ status: 200, body: { ok: true } })) });
  await assert.rejects(() => c.proposeStatus({}), /requires a proposal id/);
  await assert.rejects(() => c.proposeStatus({ proposalId: '   ' }), /requires a proposal id/);
});

test('client: inboxStaleness uses the precomputed `overall`; 501 names the upgrade', async () => {
  const seen = [];
  const c = createMnestraClient({
    env: {},
    fetchImpl: fetchStub((body) => {
      seen.push(body);
      return {
        status: 200,
        body: {
          ok: true,
          count: 2,
          overall: { scope: 'overall', source_agent: null, inbox_last_at: '2026-09-06T01:28:03Z', inbox_stale_hours: '225.9', inbox_pending: 4, items_last_at: '2026-09-15T10:00:00Z', items_stale_hours: 1.5 },
          rows: [
            { scope: 'agent', source_agent: 'grok-web', inbox_last_at: '2026-09-06T01:28:03Z', inbox_stale_hours: 225.9 },
            { scope: 'agent', source_agent: 'chatgpt-web', inbox_last_at: null, inbox_stale_hours: null },
          ],
        },
      };
    }),
  });

  const r = await c.inboxStaleness();
  assert.deepEqual(seen[0], { op: 'inbox_staleness' });
  assert.equal(r.count, 2);
  assert.equal(r.overall.scope, 'overall');
  assert.equal(r.overall.inbox_stale_hours, 225.9, 'numeric strings are coerced');
  assert.equal(r.rows.length, 2);
  // NULL stale_hours means NEVER WROTE — it must survive as null, never as 0.
  assert.equal(r.rows[1].source_agent, 'chatgpt-web');
  assert.equal(r.rows[1].inbox_stale_hours, null);
  assert.equal(r.rows[1].inbox_last_at, null);

  const old = createMnestraClient({
    env: {},
    fetchImpl: fetchStub(() => ({ status: 501, body: { ok: false } })),
  });
  await assert.rejects(() => old.inboxStaleness(), /no inbox_staleness op \(upgrade @jhizzard\/mnestra/);
});

test('client: inboxStaleness falls back to finding overall among rows', async () => {
  const c = createMnestraClient({
    env: {},
    fetchImpl: fetchStub(() => ({
      status: 200,
      body: { ok: true, rows: [{ scope: 'overall', inbox_last_at: '2026-09-06T01:28:03Z', inbox_stale_hours: 225.9 }] },
    })),
  });
  const r = await c.inboxStaleness();
  assert.equal(r.overall.inbox_stale_hours, 225.9);
});

// ── the tool handler ─────────────────────────────────────────────────────────

function statusTool(impl) {
  const [t] = buildProposeStatusTools({ clients: { mnestra: { proposeStatus: impl } } });
  return t;
}

test('tool: a malformed id never becomes a webhook round trip', async () => {
  let called = false;
  const t = statusTool(async () => { called = true; return null; });
  for (const bad of ['', '   ', 'not-a-uuid', '12345']) {
    const r = await t.handler({ proposal_id: bad });
    assert.equal(r.isError, true);
  }
  assert.equal(called, false, 'no call should reach the store');
});

test('tool: found:false renders as UNKNOWN — not an error, and explicitly NOT pending', async () => {
  const t = statusTool(async () => ({
    found: false, id: UUID, status: null,
    detail: 'unknown — no such proposal, or it aged out of the inbox',
  }));
  const r = await t.handler({ proposal_id: UUID });
  assert.ok(!r.isError, 'an unknown id must not read as an outage');
  assert.equal(r.structuredContent.found, false);
  assert.equal(r.structuredContent.status, 'unknown');
  assert.match(r.content[0].text, /UNKNOWN/);
  assert.match(r.content[0].text, /Do NOT report it as pending or saved/);
  // detail is passed straight through to the chat surface.
  assert.match(r.content[0].text, /aged out of the inbox/);
  assert.match(r.structuredContent.detail, /aged out/);
  // The word "pending" must not appear as a description of this proposal.
  assert.ok(!/STILL PENDING/.test(r.content[0].text));
});

test('tool: a null record (defensive) is still UNKNOWN, never pending', async () => {
  const r = await statusTool(async () => null).handler({ proposal_id: UUID });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.status, 'unknown');
});

test('tool: the three dispositions read correctly and never upgrade pending into saved', async () => {
  const pending = await statusTool(async () => ({ found: true, id: UUID, status: 'pending' })).handler({ proposal_id: UUID });
  assert.match(pending.content[0].text, /STILL PENDING/);
  assert.match(pending.content[0].text, /not part of canonical memory/i);

  const rejected = await statusTool(async () => ({
    found: true, id: UUID, status: 'rejected', rejectionReason: 'recipe-level', detail: 'covered by git history',
  })).handler({ proposal_id: UUID });
  assert.match(rejected.content[0].text, /REJECTED/);
  assert.match(rejected.content[0].text, /Reason: recipe-level/);
  assert.match(rejected.content[0].text, /covered by git history/, 'detail passes straight through');
  assert.equal(rejected.structuredContent.rejection_reason, 'recipe-level');

  const promoted = await statusTool(async () => ({
    found: true, id: UUID, status: 'promoted', promotedMemoryId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  })).handler({ proposal_id: UUID });
  assert.match(promoted.content[0].text, /PROMOTED/);
  assert.equal(promoted.structuredContent.promoted_memory_id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('tool: an old-Mnestra 501 surfaces as a clean tool error naming the upgrade', async () => {
  const t = statusTool(async () => {
    const e = new Error('this Mnestra build has no propose_status op (upgrade @jhizzard/mnestra to the release carrying it)');
    e.unsupported = true;
    throw e;
  });
  const r = await t.handler({ proposal_id: UUID });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /upgrade @jhizzard\/mnestra/);
});

// ── mount gate ───────────────────────────────────────────────────────────────

function mountClients({ withProposeStatus = true } = {}) {
  const mnestra = {
    recall: async () => ({ memories: [], total: 0 }),
    search: async () => ({ hits: [], total: 0 }),
    status: async () => ({ ok: true }),
    propose: async () => ({ id: UUID, status: 'pending' }),
    proposeStatus: async () => null,
  };
  if (!withProposeStatus) delete mnestra.proposeStatus;
  return {
    mnestra,
    termdeck: {
      listPanels: async () => [],
      panelStatus: async () => ({}),
      readPanel: async () => ({}),
      recentActivity: async () => [],
    },
  };
}

const IDENTITY = { getClient: async () => ({ client_id: 'mcp_x', client_name: 'Claude' }) };

function namesFor(env, opts = {}) {
  return buildTools({
    withEgressRedaction: wrap,
    policy,
    clients: opts.clients || mountClients(),
    identity: IDENTITY,
    env,
  }).map((t) => t.name);
}

test('mount gate: the status tool rides the propose flag', () => {
  const off = namesFor(hermeticEnv());
  assert.ok(!off.includes('memory_propose_status'), 'absent without the flag');
  assert.ok(!off.includes('memory_propose'));

  const on = namesFor(hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '1' }));
  assert.ok(on.includes('memory_propose'));
  assert.ok(on.includes('memory_propose_status'), 'both halves of the channel mount together');
});

test('mount gate: flag ON but the client cannot do propose_status ⇒ tool absent, not erroring', () => {
  const names = namesFor(
    hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '1' }),
    { clients: mountClients({ withProposeStatus: false }) },
  );
  assert.ok(!names.includes('memory_propose_status'));
  assert.ok(names.includes('memory_propose'), 'the write half is unaffected');
});

test('mount gate: the mounted descriptor survives registration as an honest READ', () => {
  const [t] = buildTools({
    withEgressRedaction: wrap,
    policy,
    clients: mountClients(),
    identity: IDENTITY,
    env: hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '1' }),
  }).filter((x) => x.name === 'memory_propose_status');
  assert.equal(t.annotations.readOnlyHint, true);
  assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.approval, false);
});

// ── memory_propose now points at the status tool ─────────────────────────────

test('memory_propose tells the caller the id AND where to check it', async () => {
  const [proposeTool] = buildTools({
    withEgressRedaction: wrap,
    policy,
    clients: mountClients(),
    identity: IDENTITY,
    env: hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '1' }),
  }).filter((x) => x.name === 'memory_propose');

  const r = await proposeTool.handler(
    { text: 'Kitchen: a health check that only proves transport proves nothing about the write path.' },
    { authInfo: { clientId: 'mcp_x' } },
  );
  assert.ok(!r.isError, r.content && r.content[0] && r.content[0].text);
  assert.match(r.content[0].text, /memory_propose_status/);
  assert.match(r.content[0].text, new RegExp(UUID));
  assert.equal(r.structuredContent.check_status_with, 'memory_propose_status');
});

// ── /healthz inbox ───────────────────────────────────────────────────────────

function startServer(mnestraClient) {
  const auth = createBridgeAuth({
    issuerUrl: 'http://127.0.0.1:8912',
    store: createMemoryStore(),
    staticBearer: 'test-bearer',
    operatorSecret: 'op',
    autoApprove: true,
  });
  const server = createBridgeServer({
    tools: [],
    policy,
    auth,
    options: mnestraClient ? { mnestraClient } : {},
  });
  const http = server.listen(0, '127.0.0.1');
  return {
    http,
    ready: new Promise((r) => http.once('listening', r)),
    base: () => `http://127.0.0.1:${http.address().port}`,
  };
}

const OVERALL = {
  count: 1,
  overall: {
    scope: 'overall', source_agent: null,
    inbox_last_at: '2026-09-06T01:28:03Z', inbox_stale_hours: 225.9, inbox_pending: 4,
    items_last_at: '2026-09-15T10:00:00Z', items_stale_hours: 1.5,
  },
  rows: [{ scope: 'agent', source_agent: 'grok-web', inbox_last_at: '2026-09-06T01:28:03Z', inbox_stale_hours: 225.9 }],
};

test('/healthz: inbox warms into the cache and exposes ONLY the two timing fields', async () => {
  let calls = 0;
  const s = startServer({ inboxStaleness: async () => { calls += 1; return OVERALL; } });
  await s.ready;
  try {
    // First probe never blocks — it warms the cache and omits the field.
    const first = await (await fetch(`${s.base()}/healthz`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.inbox, undefined, 'the first probe must not wait on the store');

    // Let the background refresh settle, then the next probe carries it.
    await new Promise((r) => setTimeout(r, 50));
    const second = await (await fetch(`${s.base()}/healthz`)).json();
    assert.deepEqual(second.inbox, {
      inbox_last_at: '2026-09-06T01:28:03Z',
      inbox_stale_hours: 225.9,
    });
    // Minimal by design: /healthz is public and unauthenticated.
    assert.ok(!('inbox_pending' in second.inbox), 'pending counts must not go out publicly');
    assert.ok(!('source_agent' in second.inbox), 'no per-agent breakdown publicly');
  } finally {
    s.http.close();
  }
});

test('/healthz: the value is cached — repeat probes do not hammer the store', async () => {
  let calls = 0;
  const s = startServer({ inboxStaleness: async () => { calls += 1; return OVERALL; } });
  await s.ready;
  try {
    for (let i = 0; i < 6; i += 1) await fetch(`${s.base()}/healthz`);
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${s.base()}/healthz`);
    assert.equal(calls, 1, `expected a single refresh within the TTL, saw ${calls}`);
  } finally {
    s.http.close();
  }
});

test('/healthz: NEVER-WROTE is published as nulls — it is a datum, not an absence', async () => {
  // The distinction the whole field rests on: absent = unknown (we could not
  // ask), nulls = the store answered and nothing has EVER landed. Collapsing
  // the second into the first would hide the worst case behind the same
  // silence as a transport hiccup.
  const s = startServer({
    inboxStaleness: async () => ({
      count: 0,
      overall: { scope: 'overall', source_agent: null, inbox_last_at: null, inbox_stale_hours: null },
      rows: [],
    }),
  });
  await s.ready;
  try {
    await fetch(`${s.base()}/healthz`);
    await new Promise((r) => setTimeout(r, 50));
    const body = await (await fetch(`${s.base()}/healthz`)).json();
    assert.deepEqual(body.inbox, { inbox_last_at: null, inbox_stale_hours: null });
  } finally {
    s.http.close();
  }
});

test('/healthz: an old Mnestra (501) or a down webhook degrades to ABSENT, never to a failure', async () => {
  for (const impl of [
    async () => { const e = new Error('no inbox_staleness op'); e.unsupported = true; throw e; },
    async () => { throw new Error('ECONNREFUSED'); },
    async () => ({ count: 0, overall: null, rows: [] }),
  ]) {
    const s = startServer({ inboxStaleness: impl });
    await s.ready;
    try {
      await fetch(`${s.base()}/healthz`);
      await new Promise((r) => setTimeout(r, 50));
      const res = await fetch(`${s.base()}/healthz`);
      const body = await res.json();
      assert.equal(res.status, 200, 'health must stay 200');
      assert.equal(body.ok, true);
      assert.equal(body.inbox, undefined, 'unknown is ABSENT, not null and not zero');
    } finally {
      s.http.close();
    }
  }
});

test('/healthz: with no mnestra client wired at all, the field is simply absent', async () => {
  const s = startServer(null);
  await s.ready;
  try {
    const body = await (await fetch(`${s.base()}/healthz`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.inbox, undefined);
  } finally {
    s.http.close();
  }
});

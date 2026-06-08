'use strict';

// Cross-lane composition: the REAL src/tools (T3) + src/policy (T2) + src/redact
// (A0) + src/clients (T3), wired exactly as T1's server bootstrap will wire them.
// Unit tests use fakes for isolation; this proves the real modules compose and
// that T3's tools honor T2's real policy (read-only assertion, approval gating,
// default-deny allowlist) and A0's real egress redaction end-to-end.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/tools');
const policy = require('../src/policy');     // T2 — real
const redact = require('../src/redact');     // A0 — real
const { createClients } = require('../src/clients');

const withEgressRedaction = (h) => async (a, e) => redact.redactDeep(await h(a, e));

// Route-aware fake fetch: (url, method, body) => { status?, body? }.
function fakeFetch(routes) {
  return async (url, init = {}) => {
    const r = routes(String(url), init.method || 'GET', init.body ? JSON.parse(init.body) : undefined) || {};
    const status = r.status || 200;
    const payload = r.body !== undefined ? r.body : {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
  };
}

// Run `fn` with a deterministic allowlist env (no dependency on any real
// ~/.termdeck/bridge-allowlist.json on the host), then restore.
async function withAllowlistEnv(vars, fn) {
  const keys = ['TERMDECK_BRIDGE_ALLOWLIST_FILE', 'TERMDECK_BRIDGE_ALLOWLIST_PROJECTS', 'TERMDECK_BRIDGE_ALLOWLIST_PANELS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    // Point the file at a guaranteed-absent path so only env drives the allowlist.
    process.env.TERMDECK_BRIDGE_ALLOWLIST_FILE = '/nonexistent/termdeck-bridge-allowlist.json';
    delete process.env.TERMDECK_BRIDGE_ALLOWLIST_PROJECTS;
    delete process.env.TERMDECK_BRIDGE_ALLOWLIST_PANELS;
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('integration: buildTools composes with the REAL policy + redact + clients', () => {
  const clients = createClients({ fetchImpl: fakeFetch(() => ({ body: [] })) });
  const tools = buildTools({ withEgressRedaction, policy, clients });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(tools.length, 6);
  // approval values come from T2's REAL requiresApproval
  assert.equal(byName.memory_recall.approval, false);
  assert.equal(byName.memory_search.approval, false);
  for (const n of ['list_panels', 'panel_status', 'read_panel', 'recent_activity']) {
    assert.equal(byName[n].approval, true, `${n} must be approval-gated by real policy`);
  }
});

test('integration: real default-deny allowlist hides every panel until a project is opted in', async () => {
  const sessions = [
    { id: 's1', pid: 1, meta: { label: 'A', project: 'termdeck', status: 'active', lastActivity: 't' } },
    { id: 's2', pid: 2, meta: { label: 'B', project: 'secret-proj', status: 'active', lastActivity: 't' } },
  ];
  const clients = createClients({
    fetchImpl: fakeFetch((u) => (u.endsWith('/api/sessions') ? { body: sessions } : { body: {} })),
  });
  const byName = Object.fromEntries(buildTools({ withEgressRedaction, policy, clients }).map((t) => [t.name, t]));

  // (1) No allowlist configured → default-deny → zero visible.
  await withAllowlistEnv({}, async () => {
    const r = await byName.list_panels.handler({});
    assert.equal(r.structuredContent.count, 0, 'default-deny must expose nothing');
  });

  // (2) Opt in only `termdeck` → s1 visible, s2 (secret-proj) still hidden.
  await withAllowlistEnv({ TERMDECK_BRIDGE_ALLOWLIST_PROJECTS: 'termdeck' }, async () => {
    const r = await byName.list_panels.handler({});
    assert.equal(r.structuredContent.count, 1);
    assert.equal(r.structuredContent.panels[0].project, 'termdeck');
    assert.ok(!r.structuredContent.panels.some((p) => p.project === 'secret-proj'));
  });
});

test('integration: a non-allowlisted panel id is invisible to read_panel (no existence leak)', async () => {
  const sessions = [{ id: 's2', pid: 2, meta: { label: 'B', project: 'secret-proj' } }];
  const clients = createClients({
    fetchImpl: fakeFetch((u) => (u.endsWith('/api/sessions') ? { body: sessions } : { body: { content: 'SHOULD NOT BE REACHED' } })),
  });
  const byName = Object.fromEntries(buildTools({ withEgressRedaction, policy, clients }).map((t) => [t.name, t]));
  await withAllowlistEnv({ TERMDECK_BRIDGE_ALLOWLIST_PROJECTS: 'termdeck' }, async () => {
    const r = await byName.read_panel.handler({ id: 's2' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not found or not visible/);
    assert.ok(!JSON.stringify(r).includes('SHOULD NOT BE REACHED'), 'must not fetch/expose a non-allowlisted panel transcript');
  });
});

test('integration: real egress redaction scrubs a secret returned by the Mnestra client', async () => {
  // Fragment-assembled fake key (gitleaks-safe) that the REAL redactor catches.
  const FAKE_KEY = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
  const clients = createClients({
    fetchImpl: fakeFetch((u, m, body) => {
      if (body && body.op === 'recall') {
        return { body: { ok: true, memories: [{ content: `key is ${FAKE_KEY} done`, source_type: 'decision', project: 'termdeck', score: 1, created_at: '2026-01-01' }] } };
      }
      return { body: {} };
    }),
  });
  const byName = Object.fromEntries(buildTools({ withEgressRedaction, policy, clients }).map((t) => [t.name, t]));
  const r = await byName.memory_recall.handler({ query: 'key' });
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY), 'Anthropic key leaked through the tool layer');
  assert.equal(redact.scan(JSON.stringify(r)).clean, true);
});

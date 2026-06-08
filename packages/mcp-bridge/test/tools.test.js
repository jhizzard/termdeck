'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildTools } = require('../src/tools');
const redact = require('../src/redact'); // A0 — dependency-free; used for the egress E2E test

const IDENTITY = (h) => h; // withEgressRedaction stand-in when not testing redaction

// Minimal zod stand-in so we can exercise the (z)=>rawShape factories with no
// node_modules. Each method returns a chainable placeholder.
function fakeZ() {
  const chain = (t) => {
    const o = { _t: t };
    o.describe = () => o;
    o.optional = () => o;
    return o;
  };
  return {
    object: (shape) => ({ _t: 'object', shape }),
    string: () => chain('string'),
    number: () => chain('number'),
  };
}

function fakePolicy(overrides = {}) {
  const calls = { assertReadOnly: [], requiresApproval: [] };
  const policy = {
    // hide any panel labelled 'hidden' — stands in for the operator allowlist
    visiblePanels: (sessions) => (sessions || []).filter((s) => (s.meta || {}).label !== 'hidden'),
    // mirror T2's real policy: memory reads open, every terminal-state tool gated
    requiresApproval: (name) => { calls.requiresApproval.push(name); return !['memory_recall', 'memory_search'].includes(name); },
    assertReadOnly: (t) => { calls.assertReadOnly.push(t.name); },
    ...overrides,
  };
  return { policy, calls };
}

function fakeClients(overrides = {}) {
  return {
    mnestra: {
      recall: async () => ({ memories: [{ content: 'mem one', source_type: 'decision', project: 'termdeck', similarity: 0.9, created_at: '2026-01-01' }], total: 1 }),
      search: async () => ({ hits: [{ content: 'hit one', source_type: 'reference', project: 'termdeck', similarity: 0.5, created_at: '2026-01-02' }], total: 1 }),
      status: async () => ({ ok: true }),
      ...(overrides.mnestra || {}),
    },
    termdeck: {
      listSessions: async () => [
        { id: 's1', pid: 11, meta: { label: 'T1', project: 'termdeck', role: 'worker', type: 'claude-code', status: 'thinking', statusDetail: 'reasoning', lastActivity: '2026-06-08T16:00:00Z', cwd: '/repo' } },
        { id: 's2', pid: 22, meta: { label: 'hidden', project: 'secret', status: 'active', lastActivity: '2026-06-08T16:01:00Z' } },
      ],
      getSession: async (id) => ({ id, pid: 11, meta: { label: 'T1' } }),
      getBuffer: async () => ({ ok: true, status: 'thinking' }),
      getTranscript: async () => ({ content: 'X'.repeat(10000), lines: [], chunks: [] }),
      getRecentTranscripts: async () => [
        { session_id: 's1', chunks: [{ created_at: '2026-06-08T16:00:00Z' }, { created_at: '2026-06-08T16:02:00Z' }] },
        { session_id: 's2', chunks: [{ created_at: '2026-06-08T16:01:00Z' }] }, // hidden → must be filtered
      ],
      ...(overrides.termdeck || {}),
    },
  };
}

function build(opts = {}) {
  const { policy, calls } = fakePolicy(opts.policyOverrides);
  const clients = fakeClients(opts.clientsOverrides);
  const tools = buildTools({ withEgressRedaction: opts.wrap || IDENTITY, policy, clients });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { tools, byName, calls, clients };
}

// ── structure / contract ─────────────────────────────────────────────────────

test('buildTools returns the six read-only tools', () => {
  const { tools } = build();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['list_panels', 'memory_recall', 'memory_search', 'panel_status', 'read_panel', 'recent_activity'],
  );
});

test('every tool declares read-only annotations; assertReadOnly invoked for each', () => {
  const { tools, calls } = build();
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} missing readOnlyHint`);
    assert.equal(t.annotations.destructiveHint, false, `${t.name} destructiveHint must be false`);
  }
  assert.equal(calls.assertReadOnly.length, 6);
});

test('approval resolves from policy.requiresApproval — memory reads open, all terminal-state tools gated', () => {
  const { byName } = build();
  for (const n of ['memory_recall', 'memory_search']) {
    assert.equal(byName[n].approval, false, `${n} should not be approval-gated`);
  }
  for (const n of ['list_panels', 'panel_status', 'read_panel', 'recent_activity']) {
    assert.equal(byName[n].approval, true, `${n} should be approval-gated`);
  }
});

test('buildTools rejects missing dependencies', () => {
  const { policy } = fakePolicy();
  assert.throws(() => buildTools({ policy, clients: fakeClients() }), /withEgressRedaction/);
  assert.throws(() => buildTools({ withEgressRedaction: IDENTITY, clients: fakeClients() }), /policy\.visiblePanels/);
  assert.throws(() => buildTools({ withEgressRedaction: IDENTITY, policy }), /clients/);
});

test('inputSchema is a (z)=>rawShape factory', () => {
  const { byName } = build();
  const z = fakeZ();
  assert.equal(typeof byName.memory_recall.inputSchema, 'function');
  assert.deepEqual(Object.keys(byName.memory_recall.inputSchema(z)).sort(), ['project', 'query']);
  assert.deepEqual(Object.keys(byName.list_panels.inputSchema(z)), []); // no-arg tool
});

// ── handlers ─────────────────────────────────────────────────────────────────

test('memory_recall handler returns text + structuredContent.memories', async () => {
  const { byName } = build();
  const r = await byName.memory_recall.handler({ query: 'thing' });
  assert.match(r.content[0].text, /1 memory for "thing"/);
  assert.equal(r.structuredContent.total, 1);
  assert.equal(r.structuredContent.memories[0].content, 'mem one');
});

test('list_panels applies the allowlist (hidden panel excluded)', async () => {
  const { byName } = build();
  const r = await byName.list_panels.handler({});
  assert.equal(r.structuredContent.count, 1);
  assert.equal(r.structuredContent.panels[0].label, 'T1');
  assert.ok(!r.structuredContent.panels.some((p) => p.label === 'hidden'));
});

test('panel_status on a non-visible id returns isError (not an existence leak)', async () => {
  const { byName } = build();
  const r = await byName.panel_status.handler({ id: 's2' }); // s2 is 'hidden'
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not found or not visible/);
});

test('read_panel tails output to the cap and flags truncation', async () => {
  const { byName } = build();
  const r = await byName.read_panel.handler({ id: 's1', maxChars: 1000 });
  assert.equal(r.structuredContent.truncated, true);
  assert.equal(r.structuredContent.content.length, 1000);
  assert.equal(r.structuredContent.bytes, 1000);
});

test('recent_activity is metadata-only (no content) and filters hidden panels', async () => {
  const { byName } = build();
  const r = await byName.recent_activity.handler({ sinceMinutes: 120 });
  assert.equal(r.structuredContent.count, 1); // s2 (hidden) filtered out
  const p = r.structuredContent.panels[0];
  assert.equal(p.id, 's1');
  assert.equal(p.chunk_count, 2);
  assert.equal(p.content, undefined); // never any terminal content here
});

test('a client failure becomes a tidy isError result, not a thrown transport fault', async () => {
  const { byName } = build({ clientsOverrides: { mnestra: { recall: async () => { throw new Error('mnestra unreachable'); } } } });
  const r = await byName.memory_recall.handler({ query: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /memory_recall failed: mnestra unreachable/);
});

// ── egress invariant (end-to-end through the real redactor) ──────────────────

test('EGRESS: withEgressRedaction(redactDeep) scrubs a secret that surfaced in a memory', async () => {
  // Assembled from fragments so no whole JWT literal sits in source (gitleaks-safe);
  // the assembled value still matches redact.js's JWT rule.
  const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', ['FAKEsig', 'FAKEsig'].join('')].join('.');
  const wrap = (h) => async (a, e) => redact.redactDeep(await h(a, e));
  const { byName } = build({
    wrap,
    clientsOverrides: {
      mnestra: { recall: async () => ({ memories: [{ content: `token is ${FAKE_JWT} ok`, source_type: 'decision', project: 'termdeck', similarity: 1, created_at: '2026-01-01' }], total: 1 }) },
    },
  });
  const r = await byName.memory_recall.handler({ query: 'token' });
  // The JWT must be gone from BOTH the human text and the structured payload.
  assert.ok(!r.content[0].text.includes(FAKE_JWT), 'JWT leaked into content text');
  assert.ok(!r.structuredContent.memories[0].content.includes(FAKE_JWT), 'JWT leaked into structuredContent');
  assert.equal(redact.scan(JSON.stringify(r)).clean, true, 'scan found a residual secret');
});

// Sprint 81 T4 (Part 2) — the memory-proof surface. Unit tests for the pure
// groupRecallEvents helper (reinjection-event grouping of memory_recall_log
// rows) + a BEHAVIOR fail-soft test of the GET /api/recall-events route (no
// DATABASE_URL ⇒ 200 empty, never a 5xx that would break the Memory panel).
// Behavior-not-existence per INSTALLER-PITFALLS ledger #16; canonical glob.
//
// The happy-path pg read is verified by ORCH live at close-out (this lane is
// file-only + cannot query the daily-driver DB); here we prove the grouping
// logic exhaustively and the fail-soft contract end-to-end.
//
// Run: node --test packages/server/tests/recall-events.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// createServer registers a 2s status_broadcast interval whose handle is never
// exposed; wrap setInterval so cleanup can clear it and the test process can
// exit (mirrors adapter-spawn-shell-wrap.test.js). Must be installed before
// createServer is called.
const _trackedIntervals = new Set();
const _origSetInterval = global.setInterval;
const _origClearInterval = global.clearInterval;
global.setInterval = function trackedSetInterval(...args) {
  const id = _origSetInterval.apply(this, args);
  _trackedIntervals.add(id);
  return id;
};
global.clearInterval = function trackedClearInterval(id) {
  _trackedIntervals.delete(id);
  return _origClearInterval.apply(this, [id]);
};
function clearAllTrackedIntervals() {
  for (const id of _trackedIntervals) {
    try { _origClearInterval(id); } catch (_) { /* fail-soft */ }
  }
  _trackedIntervals.clear();
}

const { groupRecallEvents, DEFAULT_MAX_EVENTS } = require('../src/recall-events');

// A memory_recall_log row (post-031 shape) with overridable fields.
function row(over = {}) {
  return Object.assign({
    memory_id: '11111111-1111-4111-8111-111111111111',
    query_preview: 'auditor checkpoint cadence',
    score: 0.21,
    rank: 1,
    surface: 'recall',
    source_session_id: 'panel-A',
    source_agent: 'claude',
    source_type: 'decision',
    token_budget: 2000,
    recall_group_id: 'gggggggg-1111-4111-8111-111111111111',
    created_at: '2026-07-05T21:00:00.000Z',
    memory_project: 'termdeck',
    memory_preview: 'Auditors must post CHECKPOINT every 15 minutes.',
  }, over);
}

// ---------------------------------------------------------------------------
// groupRecallEvents — the reinjection-event grouping.
// ---------------------------------------------------------------------------

test('groups K rows of one recall_group_id into a single reinjection event', () => {
  const g = 'aaaaaaaa-1111-4111-8111-111111111111';
  const rows = [
    row({ recall_group_id: g, rank: 1, memory_id: 'm1', source_type: 'doctrine' }),
    row({ recall_group_id: g, rank: 2, memory_id: 'm2', source_type: 'decision' }),
    row({ recall_group_id: g, rank: 3, memory_id: 'm3', source_type: 'decision' }),
  ];
  const events = groupRecallEvents(rows);
  assert.equal(events.length, 1, 'one reinjection event');
  const ev = events[0];
  assert.equal(ev.recallGroupId, g);
  assert.equal(ev.hitCount, 3);
  assert.equal(ev.sourceSessionId, 'panel-A');
  assert.equal(ev.sourceAgent, 'claude');
  assert.equal(ev.tokenBudget, 2000);
  assert.deepEqual(ev.sourceTypeMix, { doctrine: 1, decision: 2 });
  assert.equal(ev.hasDoctrine, true, 'doctrine hit flags the event');
});

test('hasDoctrine is false when no hit is a doctrine memory', () => {
  const events = groupRecallEvents([row({ source_type: 'fact' }), row({ rank: 2, source_type: 'decision' })]);
  assert.equal(events[0].hasDoctrine, false);
  assert.deepEqual(events[0].sourceTypeMix, { fact: 1, decision: 1 });
});

test('separate recall_group_ids become separate events, in DESC (first-seen) order', () => {
  const rows = [
    row({ recall_group_id: 'g-new', created_at: '2026-07-05T22:00:00.000Z', query_preview: 'newer' }),
    row({ recall_group_id: 'g-old', created_at: '2026-07-05T20:00:00.000Z', query_preview: 'older' }),
  ];
  const events = groupRecallEvents(rows);
  assert.equal(events.length, 2);
  assert.equal(events[0].recallGroupId, 'g-new', 'input DESC order is preserved (newest first)');
  assert.equal(events[1].recallGroupId, 'g-old');
});

test('NULL recall_group_id rows become singleton events (pre-031, cannot be reassembled)', () => {
  const rows = [
    row({ recall_group_id: null, memory_id: 'x1' }),
    row({ recall_group_id: null, memory_id: 'x2' }),
  ];
  const events = groupRecallEvents(rows);
  assert.equal(events.length, 2, 'two NULL-group rows do NOT merge into one event');
  assert.equal(events[0].recallGroupId, null);
  assert.equal(events[0].hitCount, 1);
});

test('hits are sorted by rank ascending; NULL ranks sink to the bottom', () => {
  const g = 'bbbbbbbb-1111-4111-8111-111111111111';
  const rows = [
    row({ recall_group_id: g, rank: null, memory_id: 'no-rank' }),
    row({ recall_group_id: g, rank: 3, memory_id: 'r3' }),
    row({ recall_group_id: g, rank: 1, memory_id: 'r1' }),
  ];
  const ev = groupRecallEvents(rows)[0];
  assert.deepEqual(ev.hits.map((h) => h.memoryId), ['r1', 'r3', 'no-rank']);
});

test('per-call fields survive a partial row that carries NULLs', () => {
  const g = 'cccccccc-1111-4111-8111-111111111111';
  const rows = [
    row({ recall_group_id: g, rank: 1, token_budget: null, source_agent: null, source_session_id: null, query_preview: null }),
    row({ recall_group_id: g, rank: 2, token_budget: 3000, source_agent: 'codex', source_session_id: 'panel-B', query_preview: 'the query' }),
  ];
  const ev = groupRecallEvents(rows)[0];
  assert.equal(ev.tokenBudget, 3000, 'first non-null token_budget wins');
  assert.equal(ev.sourceAgent, 'codex');
  assert.equal(ev.sourceSessionId, 'panel-B');
  assert.equal(ev.queryPreview, 'the query');
});

test('score, rank, project, preview carried onto each hit', () => {
  const ev = groupRecallEvents([row({ score: 0.29, rank: 2, memory_project: 'forecede', memory_preview: 'snippet' })])[0];
  const h = ev.hits[0];
  assert.equal(h.score, 0.29);
  assert.equal(h.rank, 2);
  assert.equal(h.project, 'forecede');
  assert.equal(h.preview, 'snippet');
});

test('maxEvents caps the number of events returned', () => {
  const rows = [];
  for (let i = 0; i < 80; i++) rows.push(row({ recall_group_id: `g-${i}` }));
  assert.equal(groupRecallEvents(rows).length, DEFAULT_MAX_EVENTS, `default cap is ${DEFAULT_MAX_EVENTS}`);
  assert.equal(groupRecallEvents(rows, { maxEvents: 5 }).length, 5);
});

test('groupRecallEvents is fail-soft on empty / garbage input (never throws)', () => {
  for (const bad of [null, undefined, [], {}, 42, [null, undefined, 7, {}]]) {
    assert.doesNotThrow(() => groupRecallEvents(bad));
    assert.ok(Array.isArray(groupRecallEvents(bad)));
  }
  assert.equal(groupRecallEvents([]).length, 0);
  assert.equal(groupRecallEvents([null, 7]).length, 0, 'non-object rows are skipped, not grouped');
});

test('Date created_at is normalized to ISO', () => {
  const ev = groupRecallEvents([row({ created_at: new Date('2026-07-05T21:00:00.000Z') })])[0];
  assert.equal(ev.createdAt, '2026-07-05T21:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Route fail-soft — GET /api/recall-events with no DATABASE_URL must return
// 200 { events: [] } (never a 5xx), so a fresh install / pre-031 store never
// breaks the Memory panel. Boots a real Express app (same harness shape as
// adapter-spawn-shell-wrap.test.js) and hits the route.
// ---------------------------------------------------------------------------

const serverModule = require('../src/index.js');
const { createServer, _resetTermdeckSecretsCache } = serverModule;

async function bootTestServer() {
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  const { server, ptyReaper, transcriptWriter } = createServer({
    shell: '/bin/sh',
    projects: {},
    rag: { enabled: false },
    ptyReaper: { enabled: false },
    transcripts: { enabled: false },
    sessionLogs: { enabled: false },
    defaultTheme: 'tokyo-night',
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  return { server, port: server.address().port, ptyReaper, transcriptWriter };
}

async function closeTestServer({ server, ptyReaper, transcriptWriter }) {
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) {} }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) {} }
  try { server.closeAllConnections(); } catch (_) {}
  await new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
  clearAllTrackedIntervals();
}

test('GET /api/recall-events fail-soft: no DATABASE_URL ⇒ 200 empty (never breaks the panel)', async () => {
  const origHome = process.env.HOME;
  const origDb = process.env.DATABASE_URL;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-s81-recall-events-'));
  process.env.HOME = tmpHome;
  delete process.env.DATABASE_URL; // force getRumenPool() → null → fail-soft path
  const handle = await bootTestServer();
  try {
    for (const url of ['/api/recall-events', '/api/recall-events/panel-abc']) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${url}`);
      assert.equal(res.status, 200, `${url} must be 200 (fail-soft), never 5xx`);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.events, [], `${url} returns an empty event list`);
      assert.equal(body.eventCount, 0);
      assert.equal(body.degraded, 'no-database', 'degraded reason is honest');
    }
  } finally {
    await closeTestServer(handle);
    process.env.HOME = origHome;
    if (origDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = origDb;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
});

// Tests for the flashback-diag ring buffer + GET /api/flashback/diag route
// (Sprint 39 T1).
//
// Pins:
//   - ring buffer log/snapshot semantics (timestamp stamping, filters, cap)
//   - the route returns { count, events } shape and respects query params
//
// These tests give T2/T3/T4 a contract to consume — if the diag log shape
// changes underneath them, the test fails before the consumer breaks.
//
// Run: node --test tests/flashback-diag.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const flashbackDiag = require('../packages/server/src/flashback-diag');

function reset() {
  flashbackDiag._resetForTest();
}

// ---- ring buffer ---------------------------------------------------------

test('log() appends event with auto-stamped ISO timestamp', () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match', pattern: 'error' });
  const events = flashbackDiag.snapshot();
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'a');
  assert.equal(events[0].event, 'pattern_match');
  assert.equal(events[0].pattern, 'error');
  assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('log() preserves arbitrary fields per event type', () => {
  reset();
  flashbackDiag.log({
    sessionId: 's1',
    event: 'bridge_query',
    project_tag_in_filter: 'termdeck',
    query_text: 'foo',
    mode: 'direct',
    rpc_args: { project: 'termdeck', searchAll: false, project_source: 'explicit' },
    duration_ms: 42,
  });
  const [evt] = flashbackDiag.snapshot();
  assert.equal(evt.project_tag_in_filter, 'termdeck');
  assert.equal(evt.mode, 'direct');
  assert.equal(evt.duration_ms, 42);
  assert.deepEqual(evt.rpc_args, {
    project: 'termdeck',
    searchAll: false,
    project_source: 'explicit',
  });
});

test('snapshot() returns most-recent events in order', () => {
  reset();
  flashbackDiag.log({ sessionId: 's1', event: 'pattern_match', n: 1 });
  flashbackDiag.log({ sessionId: 's1', event: 'pattern_match', n: 2 });
  flashbackDiag.log({ sessionId: 's1', event: 'pattern_match', n: 3 });
  const events = flashbackDiag.snapshot();
  assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
});

test('snapshot({ sessionId }) filters by session', () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'b', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'a', event: 'error_detected' });
  const aOnly = flashbackDiag.snapshot({ sessionId: 'a' });
  assert.equal(aOnly.length, 2);
  assert.ok(aOnly.every((e) => e.sessionId === 'a'));
});

test('snapshot({ eventType }) filters by event type', () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'b', event: 'bridge_query' });
  flashbackDiag.log({ sessionId: 'c', event: 'pattern_match' });
  const matches = flashbackDiag.snapshot({ eventType: 'pattern_match' });
  assert.equal(matches.length, 2);
  assert.ok(matches.every((e) => e.event === 'pattern_match'));
});

test('snapshot({ sessionId, eventType }) combines filters', () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'b', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'a', event: 'bridge_query' });
  const out = flashbackDiag.snapshot({ sessionId: 'a', eventType: 'pattern_match' });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, 'a');
  assert.equal(out[0].event, 'pattern_match');
});

test('snapshot({ limit }) caps the return to the most recent N', () => {
  reset();
  for (let i = 0; i < 10; i++) {
    flashbackDiag.log({ sessionId: 's', event: 'pattern_match', n: i });
  }
  const last3 = flashbackDiag.snapshot({ limit: 3 });
  assert.equal(last3.length, 3);
  assert.deepEqual(last3.map((e) => e.n), [7, 8, 9]);
});

test('snapshot() with empty ring returns []', () => {
  reset();
  assert.deepEqual(flashbackDiag.snapshot(), []);
  assert.deepEqual(flashbackDiag.snapshot({ sessionId: 'nope' }), []);
});

test('ring caps at RING_SIZE — oldest events get dropped', () => {
  reset();
  const N = flashbackDiag.RING_SIZE;
  for (let i = 0; i < N + 50; i++) {
    flashbackDiag.log({ sessionId: 's', event: 'pattern_match', n: i });
  }
  const all = flashbackDiag.snapshot();
  assert.equal(all.length, N);
  // First retained event should be n=50 (the first 50 got dropped).
  assert.equal(all[0].n, 50);
  // Last retained event is n=N+49.
  assert.equal(all[all.length - 1].n, N + 49);
});

test('snapshot({ limit }) clamps requests above RING_SIZE', () => {
  reset();
  for (let i = 0; i < 50; i++) {
    flashbackDiag.log({ sessionId: 's', event: 'pattern_match', n: i });
  }
  // Asking for 9999 should not crash and should return only what we have.
  const events = flashbackDiag.snapshot({ limit: 9999 });
  assert.equal(events.length, 50);
});

test('_resetForTest() clears the ring', () => {
  flashbackDiag.log({ sessionId: 'x', event: 'pattern_match' });
  assert.ok(flashbackDiag.snapshot().length > 0);
  flashbackDiag._resetForTest();
  assert.deepEqual(flashbackDiag.snapshot(), []);
});

// ---- HTTP route ----------------------------------------------------------

function listenOnce(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// Recreate the route handler shape as registered in index.js. Importing all of
// index.js for one route would pull in pty/sqlite/Supabase init; mirroring the
// handler keeps the test hermetic. If the route's contract changes in
// index.js, update this fixture too — that's the point of pinning here.
function attachDiagRoute(app) {
  app.get('/api/flashback/diag', (req, res) => {
    const { sessionId, eventType } = req.query || {};
    const rawLimit = req.query && req.query.limit;
    const limit = rawLimit != null ? parseInt(rawLimit, 10) : undefined;
    const events = flashbackDiag.snapshot({
      sessionId: typeof sessionId === 'string' && sessionId.length ? sessionId : undefined,
      eventType: typeof eventType === 'string' && eventType.length ? eventType : undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, flashbackDiag.RING_SIZE) : undefined,
    });
    res.json({ count: events.length, events });
  });
}

test('GET /api/flashback/diag returns { count, events } shape', async () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'a', event: 'error_detected' });
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.count, 2);
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].sessionId, 'a');
  } finally {
    server.close();
  }
});

test('GET /api/flashback/diag?sessionId filters server-side', async () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'b', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'a', event: 'error_detected' });
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag?sessionId=a`);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.ok(body.events.every((e) => e.sessionId === 'a'));
  } finally {
    server.close();
  }
});

test('GET /api/flashback/diag?eventType filters server-side', async () => {
  reset();
  flashbackDiag.log({ sessionId: 'a', event: 'pattern_match' });
  flashbackDiag.log({ sessionId: 'b', event: 'bridge_query' });
  flashbackDiag.log({ sessionId: 'c', event: 'pattern_match' });
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag?eventType=pattern_match`);
    const body = await res.json();
    assert.equal(body.count, 2);
    assert.ok(body.events.every((e) => e.event === 'pattern_match'));
  } finally {
    server.close();
  }
});

test('GET /api/flashback/diag?limit caps the response', async () => {
  reset();
  for (let i = 0; i < 25; i++) {
    flashbackDiag.log({ sessionId: 's', event: 'pattern_match', n: i });
  }
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag?limit=5`);
    const body = await res.json();
    assert.equal(body.count, 5);
    assert.deepEqual(body.events.map((e) => e.n), [20, 21, 22, 23, 24]);
  } finally {
    server.close();
  }
});

test('GET /api/flashback/diag clamps limit > RING_SIZE', async () => {
  reset();
  for (let i = 0; i < 250; i++) {
    flashbackDiag.log({ sessionId: 's', event: 'pattern_match', n: i });
  }
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag?limit=99999`);
    const body = await res.json();
    // Ring already capped at RING_SIZE on insert, and the route's clamp is
    // belt-and-suspenders on the read path.
    assert.equal(body.count, flashbackDiag.RING_SIZE);
  } finally {
    server.close();
  }
});

test('GET /api/flashback/diag returns empty events array when ring is empty', async () => {
  reset();
  const app = express();
  attachDiagRoute(app);
  const { server, port } = await listenOnce(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flashback/diag`);
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.events, []);
  } finally {
    server.close();
  }
});

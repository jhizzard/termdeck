// Sprint 80 T1 (FR-4 — Brad) — inject-vs-human-typing queue on
// POST /api/sessions/:id/input.
//
// Problem: an agent-to-agent API inject that lands while a human is mid-line in
// a panel interleaves into the human's input and corrupts it. FR-4 holds injects
// while a human is actively typing (buffer non-empty + a keystroke within a
// short window) and flushes them FIFO on the human's next submit (Enter) or
// clear (Ctrl-C / Ctrl-U / bare Esc), or when a later inject arrives after
// typing stops. Default ON for orchestrator-tier panels only (Brad's ask);
// per-panel override via meta.holdInjectsWhileTyping. A queued inject older than
// the TTL is dropped on flush so a stale inject never fires into a changed
// context.
//
// Harness: fake node-pty (captures writes), real createServer (exposes
// `sessions` + `db`), settle pinned to 0ms. Human-typing state is seeded on the
// real session object; the Enter-triggered flush is exercised over a real WS.
//
// Run: node --test packages/server/tests/input-inject-queue.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '0';

// ── Interval tracking ──
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

// ── Fake node-pty (captures writes) ──
let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();
(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 92001;
  const fakeModule = {
    spawn() {
      const handlers = { data: [], exit: [] };
      const term = {
        pid: nextPid++,
        _writes: [],
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        on() {},          // real node-pty is an EventEmitter; no-op is enough here
        write(text) { this._writes.push(text); },
        resize() {},
        kill() {},
      };
      _fakeTermsByPid.set(term.pid, term);
      return term;
    },
  };
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: fakeModule, parent: null, children: [], paths: [],
  };
  _ptyFakeAvailable = true;
})();

const serverModule = require('../src/index.js');
const {
  createServer, _resetTermdeckSecretsCache,
  flushInjectQueue, shouldHoldInject, isInjectHoldEnabled,
} = serverModule;

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-s80-fr4-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  try {
    return await fn(tmpHome);
  } finally {
    process.env.HOME = origHome;
    if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
  }
}

async function bootTestServer() {
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  const config = {
    shell: process.env.SHELL || '/bin/sh',
    projects: {},
    rag: { enabled: false },
    ptyReaper: { enabled: false },
    transcripts: { enabled: false },
    sessionLogs: { enabled: false },
    defaultTheme: 'tokyo-night',
  };
  const { server, sessions, db, ptyReaper, transcriptWriter } = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return { server, port, sessions, db, ptyReaper, transcriptWriter };
}

async function closeTestServer({ server, ptyReaper, transcriptWriter }) {
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) { /* fail-soft */ } }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) { /* fail-soft */ } }
  try { server.closeAllConnections(); } catch (_) { /* older Node */ }
  await new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
  clearAllTrackedIntervals();
}

function url(port, p) { return `http://127.0.0.1:${port}${p}`; }
async function postJson(port, p, body) {
  const res = await fetch(url(port, p), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a panel with an explicit role, resolve its capture-term + session obj.
async function freshPanel(h, role) {
  const body = { type: 'shell' };
  if (role) body.role = role;
  const created = await postJson(h.port, '/api/sessions', body);
  assert.equal(created.status, 201, 'panel created');
  const term = _fakeTermsByPid.get(created.json.pid);
  assert.ok(term, 'capture-term resolved by pid');
  await sleep(20);
  term._writes.length = 0;
  const session = h.sessions.get(created.json.id);
  assert.ok(session, 'session object resolved');
  return { id: created.json.id, term, session };
}

// Seed the "a human is actively typing right now" state on the session.
function seedTyping(session) {
  session._inputBuffer = 'abc';
  session._lastHumanKeystrokeAt = Date.now();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — HOLD: orchestrator panel + a human typing ⇒ the inject is QUEUED, not
//     written; the response says queued:true with a position.
// ═══════════════════════════════════════════════════════════════════════════

test('orch panel + human typing ⇒ inject queued, not written', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      seedTyping(session);
      const { status, json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'INJECT-A' });
      assert.equal(status, 200);
      assert.equal(json.queued, true, 'held inject reports queued:true');
      assert.equal(json.queuePosition, 1);
      assert.equal(term._writes.length, 0, 'nothing written to the PTY while the human types');
      assert.equal(session._injectQueue.length, 1, 'one inject parked on the queue');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — FIFO drain when typing stops: two held injects flush in order ahead of a
//     later inject that arrives after the human has stopped typing.
// ═══════════════════════════════════════════════════════════════════════════

test('backlog drains FIFO ahead of a later direct inject once typing stops', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      seedTyping(session);
      await postJson(h.port, `/api/sessions/${id}/input`, { text: 'A' });
      await postJson(h.port, `/api/sessions/${id}/input`, { text: 'B' });
      assert.equal(session._injectQueue.length, 2, 'A and B both queued');
      assert.equal(term._writes.length, 0);

      // Human stops typing (keystroke goes stale past the window).
      session._lastHumanKeystrokeAt = Date.now() - 60_000;
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'C' });

      assert.equal(json.queued, undefined, 'C is not held once typing stopped');
      assert.deepEqual(term._writes, ['A', 'B', 'C'],
        'held A,B flush FIFO, THEN C — no reordering, no interleave');
      assert.equal(session._injectQueue.length, 0, 'queue fully drained');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — FLUSH on human Enter over a REAL WebSocket: the primary trigger. The
//     human's Enter is written first, then the held injects flush FIFO.
// ═══════════════════════════════════════════════════════════════════════════

test('human Enter (WS) flushes the held queue FIFO after the submit keystroke', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    let ws;
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      seedTyping(session);
      await postJson(h.port, `/api/sessions/${id}/input`, { text: 'Q1' });
      await postJson(h.port, `/api/sessions/${id}/input`, { text: 'Q2' });
      assert.equal(term._writes.length, 0, 'both held while typing');

      ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws?session=${id}`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'input', data: '\r' }));   // human presses Enter
      await sleep(60);   // let the async flush complete (settle=0)

      // First write is the human's own Enter; then the queued injects FIFO.
      assert.equal(term._writes[0], '\r', 'human Enter written first (their line submits)');
      assert.deepEqual(term._writes.slice(1), ['Q1', 'Q2'],
        'held injects flush FIFO immediately after the human submit');
      assert.equal(session._injectQueue.length, 0, 'queue drained on Enter');
    } finally {
      try { if (ws) ws.close(); } catch (_) { /* fail-soft */ }
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — TTL: a queued inject older than the TTL is DROPPED on flush (never fired
//     into a changed context); a fresh one beside it still delivers.
// ═══════════════════════════════════════════════════════════════════════════

test('flush drops a stale (past-TTL) inject but delivers a fresh one', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { term, session } = await freshPanel(h, 'orchestrator');
      // TTL default is 30s; stamp one item well past it and one fresh.
      session._injectQueue.push({ text: 'STALE', submit: false, enqueuedAt: Date.now() - 120_000 });
      session._injectQueue.push({ text: 'FRESH', submit: false, enqueuedAt: Date.now() });
      await flushInjectQueue(session, h.db);
      assert.deepEqual(term._writes, ['FRESH'], 'stale inject dropped, fresh delivered');
      assert.equal(session._injectQueue.length, 0);
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — Default OFF for a non-orchestrator role: a worker panel writes injects
//     through immediately even while a human types.
// ═══════════════════════════════════════════════════════════════════════════

test('non-orchestrator (worker) panel does NOT hold — writes immediately', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'worker');
      seedTyping(session);
      assert.equal(isInjectHoldEnabled(session), false, 'hold default OFF for worker role');
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'W' });
      assert.equal(json.queued, undefined);
      assert.deepEqual(term._writes, ['W'], 'worker inject writes straight through');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Per-panel opt-out: an orchestrator panel with holdInjectsWhileTyping=false
//     writes through immediately.
// ═══════════════════════════════════════════════════════════════════════════

test('holdInjectsWhileTyping=false opt-out overrides the orch default', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      session.meta.holdInjectsWhileTyping = false;
      seedTyping(session);
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'X' });
      assert.equal(json.queued, undefined);
      assert.deepEqual(term._writes, ['X'], 'opt-out writes straight through');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 & 8 — Hold gate needs BOTH a non-empty buffer AND a recent keystroke.
// ═══════════════════════════════════════════════════════════════════════════

test('no hold when the input buffer is empty (human not mid-line)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      session._inputBuffer = '';                       // nothing typed
      session._lastHumanKeystrokeAt = Date.now();      // but a recent keystroke
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'Y' });
      assert.equal(json.queued, undefined);
      assert.deepEqual(term._writes, ['Y']);
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

test('no hold when the last keystroke is stale (human walked away)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      session._inputBuffer = 'half-typed';
      session._lastHumanKeystrokeAt = Date.now() - 60_000;   // long past the window
      assert.equal(shouldHoldInject(session, Date.now()), false);
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'Z' });
      assert.equal(json.queued, undefined);
      assert.deepEqual(term._writes, ['Z']);
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 — A queued {submit:true} inject flushes via the server-sequenced submit
//     (body write + a LONE \r), not a single write.
// ═══════════════════════════════════════════════════════════════════════════

test('queued submit:true inject flushes as body + lone \\r', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { id, term, session } = await freshPanel(h, 'orchestrator');
      seedTyping(session);
      const { json } = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'hi', submit: true });
      assert.equal(json.queued, true, 'submit:true inject is held like any other');
      assert.equal(term._writes.length, 0);

      session._lastHumanKeystrokeAt = Date.now() - 60_000;   // typing stops
      await flushInjectQueue(session, h.db);
      assert.deepEqual(term._writes, ['hi', '\r'],
        'flush honors submit:true — body then a separate lone carriage return');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10 — markHumanKeystroke / _humanKeyFlushSignal classification + clear resets
//      the input buffer; arrow-key CSI (\x1b[) does NOT count as a clear.
// ═══════════════════════════════════════════════════════════════════════════

test('markHumanKeystroke classifies submit/clear and leaves typing untouched', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const h = await bootTestServer();
    try {
      const { session } = await freshPanel(h, 'orchestrator');

      session._inputBuffer = 'abc';
      assert.equal(session.markHumanKeystroke('x'), false, 'plain char is not a flush signal');
      assert.equal(session._inputBuffer, 'abc', 'plain char does not reset the buffer here');
      assert.ok(session._lastHumanKeystrokeAt > 0, 'keystroke clock stamped');

      assert.equal(session.markHumanKeystroke('\r'), true, 'Enter ⇒ flush (submit)');
      assert.equal(session.markHumanKeystroke('\x03'), true, 'Ctrl-C ⇒ flush (clear)');

      session._inputBuffer = 'zzz';
      assert.equal(session.markHumanKeystroke('\x15'), true, 'Ctrl-U ⇒ flush (clear)');
      assert.equal(session._inputBuffer, '', 'a clear signal resets the tracked buffer');

      session._inputBuffer = 'yyy';
      assert.equal(session.markHumanKeystroke('\x1b'), true, 'bare Esc ⇒ flush (clear)');
      assert.equal(session._inputBuffer, '', 'bare Esc clears the buffer');

      session._inputBuffer = 'nav';
      assert.equal(session.markHumanKeystroke('\x1b[C'), false, 'arrow-key CSI is NOT a clear');
      assert.equal(session._inputBuffer, 'nav', 'arrow key leaves the buffer intact');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(h);
    }
  });
});

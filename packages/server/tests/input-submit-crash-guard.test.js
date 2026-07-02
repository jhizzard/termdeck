// Sprint 80 T1 (INCIDENT 2026-07-01 — whole-deck crash) — regression guard for
// the node-pty unhandled-'error' → uncaught-exception crash.
//
// What happened: Brad's four-lane deck died the instant ORCH sent a
// POST /api/sessions/:id/input {submit:true} to re-engage a panel whose agent
// (Claude) had just exited on a transient 529. Root cause is NOT in
// pty-submit.js (that helper is fully try/caught and cannot throw) — it is in
// node-pty itself. UnixTerminal's master-socket 'error' handler
// (@homebridge/node-pty-prebuilt-multiarch/lib/unixTerminal.js:114-140)
// swallows EAGAIN + EIO, but for ANY OTHER errno (EBADF/ENOTTY/EPIPE — what a
// write to a pty whose child just died emits) it does:
//
//     if (this.listeners('error').length < 2) throw err;
//
// INSIDE an async socket callback. The terminal's baseline 'error'-listener
// count is 1, so with no consumer listener a single bad write RE-THROWS →
// uncaughtException → the whole server process (all lane PTYs + HTTP listener)
// dies. `{submit:true}` didn't cause the throw; its 400ms server-held settle
// (pty-submit.js) merely WIDENED the write-after-death race so the body write's
// async socket error surfaced while the request was still in flight.
//
// The fix (packages/server/src/index.js, spawnTerminalSession): attach one
// `term.on('error', …)` so the count reaches 2 → node-pty declines to throw.
//
// This file fences the fix with a fake pty that is a REAL EventEmitter and
// mirrors node-pty's `< 2` throw rule verbatim (baseline of 1 error listener +
// the same errno gating), driven through the real createServer + the real
// {submit:true} route.
//
// Run: node --test packages/server/tests/input-submit-crash-guard.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '0';

// ── Interval tracking (drop createServer's status-broadcast loop) ──
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

// ── Faithful node-pty fake: a real EventEmitter that reproduces the exact
//    unixTerminal.js:114-140 throw semantics on a write-after-death. ──
let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();

class FakePty extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this._writes = [];
    this._handlers = { data: [], exit: [] };
    this._fdDead = false;   // fd usable? flip WITHOUT firing onExit to mirror
                            // "child dying but meta.status not yet 'exited'".
    // node-pty's UnixTerminal carries ONE baseline 'error' listener right after
    // spawn (empirically verified against the real module). Reproduce it so the
    // `< 2` guard below has the same starting count the real crash saw.
    this._baselineErrorHandler = () => {};
    this.on('error', this._baselineErrorHandler);
  }
  onData(cb) { this._handlers.data.push(cb); }
  onExit(cb) { this._handlers.exit.push(cb); }
  resize() {}
  kill() {}
  // Verbatim node-pty rule (unixTerminal.js:138): a non-swallowed socket error
  // re-throws only when the terminal has fewer than 2 'error' listeners.
  _deadWriteWouldThrow() { return this.listeners('error').length < 2; }
  write(data) {
    this._writes.push(data);
    if (!this._fdDead) return;
    // Mirror unixTerminal.js:114-140 — a non-EAGAIN/non-EIO socket error fires
    // ASYNCHRONOUSLY; if the terminal has < 2 'error' listeners, node-pty
    // re-THROWS it (→ uncaughtException). We use EBADF (the classic
    // write-to-dead-fd errno that node-pty does NOT swallow).
    const err = new Error('write EBADF'); err.code = 'EBADF';
    setImmediate(() => {
      if (this._deadWriteWouldThrow()) {
        throw err;                      // ← the whole-process crash, faithfully
      }
      // ≥ 2 listeners ⇒ node-pty declines to throw (the fix's effect).
    });
  }
  _emitExit(payload) {
    this._fdDead = true;
    for (const cb of this._handlers.exit) cb(payload || { exitCode: 0, signal: null });
  }
}

(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 91001;
  const fakeModule = {
    spawn(_shell, _args, _opts) {
      const term = new FakePty(nextPid++);
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
const { createServer, _resetTermdeckSecretsCache } = serverModule;

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-s80-crash-'));
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
  const { server, ptyReaper, transcriptWriter } = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return { server, port, ptyReaper, transcriptWriter };
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
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshPanel(port) {
  const created = await postJson(port, '/api/sessions', { type: 'shell' });
  assert.equal(created.status, 201, 'panel created');
  const term = _fakeTermsByPid.get(created.json.pid);
  assert.ok(term, 'capture-term resolved by pid');
  await sleep(20);
  term._writes.length = 0;
  return { id: created.json.id, term };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — THE FIX INVARIANT: after spawn, the pty must carry ≥ 2 'error' listeners
//     (node-pty's baseline 1 + TermDeck's attached 1). This is the direct,
//     deterministic sentinel — it FAILS if the spawn-time `term.on('error')`
//     is ever removed, WITHOUT needing to trigger an actual async throw.
// ═══════════════════════════════════════════════════════════════════════════

test('spawn attaches a pty error listener (count reaches node-pty\'s safe ≥2)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { term } = await freshPanel(h.port);
        assert.ok(term instanceof EventEmitter, 'fake pty is a real EventEmitter');
        assert.ok(term.listeners('error').length >= 2,
          `pty must have >=2 'error' listeners so node-pty (unixTerminal.js:138) never re-throws; got ${term.listeners('error').length}`);
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2 — END-TO-END: a {submit:true} inject to a panel whose fd has died (child
//     exiting, meta.status not yet flipped) must NOT crash the process. The
//     body/submit writes trigger node-pty's async EBADF throw-guard; with the
//     fix's listener the count is ≥2 so it declines to throw.
// ═══════════════════════════════════════════════════════════════════════════

test('{submit:true} to a dying panel does not crash the server (no uncaughtException)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      const caught = [];
      const onUncaught = (err) => { caught.push(err); };
      // Capture instead of crash — with the fix nothing throws, so this stays
      // empty; if the fix regresses this records the async throw rather than
      // taking down the test runner.
      process.on('uncaughtException', onUncaught);
      try {
        const { id, term } = await freshPanel(h.port);
        // Mark the fd dead WITHOUT firing onExit: mirrors "child dying, meta
        // still 'active'" — the exact window the route's entry guard can't see.
        term._fdDead = true;

        const { status, json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: '\x1b[200~re-engage\x1b[201~', submit: true });

        // Let the async setImmediate throw-guard(s) from both writes run.
        await sleep(30);

        assert.equal(caught.length, 0,
          `no uncaughtException may escape a write to a dead pty; got: ${caught.map((e) => e && e.message).join(', ')}`);
        assert.equal(typeof status, 'number', 'the request returned an HTTP response (connection not dropped mid-request)');
        assert.ok(json && typeof json === 'object', 'response body parsed as JSON');
        // The writes were attempted (proving we exercised the dead-fd path).
        assert.ok(term._writes.length >= 1, 'at least the body write reached the pty');
      } finally {
        process.removeListener('uncaughtException', onUncaught);
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 3 — MECHANISM PROOF: the fake faithfully reproduces node-pty's `< 2` throw
//     rule, so Tests 1–2 aren't passing vacuously. Asserted SYNCHRONOUSLY via
//     the same predicate the async throw-guard consults (`_deadWriteWouldThrow`)
//     — we do NOT fire a real async throw here, because node:test intercepts
//     any escaped uncaughtException and fails the test regardless of capture.
//     With the baseline single listener the rule says "would throw" (the crash);
//     one more listener — exactly what spawnTerminalSession attaches — flips it
//     to "won't throw". This anchors WHY the ≥2 count matters.
// ═══════════════════════════════════════════════════════════════════════════

test('mechanism: node-pty <2 rule — baseline throws, server\'s +1 listener prevents it',
  { skip: !_ptyFakeAvailable }, () => {
    const t = new FakePty(99999);   // constructor attaches the baseline 1
    t._fdDead = true;
    assert.equal(t.listeners('error').length, 1, 'baseline is a single listener (< 2)');
    assert.equal(t._deadWriteWouldThrow(), true,
      'with < 2 listeners a dead-fd write surfaces node-pty\'s uncaught throw (the crash we fix)');

    t.on('error', () => {});   // the exact listener spawnTerminalSession attaches
    assert.equal(t.listeners('error').length, 2, 'baseline + server listener = 2');
    assert.equal(t._deadWriteWouldThrow(), false,
      'with >=2 listeners the dead-fd write no longer throws (crash prevented)');
  });

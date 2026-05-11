// Sprint 63 T1 — Crash class wiring fences.
//
// The unit tests in `crash-class-helpers.test.js` pin the helpers
// (isPtyRaceError, hexEscapePrefix, safelyResizePty._destroyed). This file
// pins the *wiring* of those helpers through createServer:
//
//   • Item 1.1 — `session.pty` is nulled by the `term.onExit` handler
//     registered inside spawnTerminalSession at packages/server/src/index.js.
//     Without this, the node-pty wrapper stays pinned by closures even after
//     the child exits, accumulating fds → Joshua's 2026-05-08/09 overnight
//     `kern.tty.ptmx_max=511` exhaustion.
//
//   • Item 1.2 — DELETE /api/sessions/:id stamps `pty._destroyed = true`
//     synchronously after kill(), so a WS resize message arriving in the
//     kill()→onExit window short-circuits via safelyResizePty without
//     ioctl-ing a fd whose child has just SIGHUP'd.
//
//   • Item 1.2 — POST /api/sessions/:id/resize returns 410 Gone (not 409
//     Conflict, not 404 Not Found) when the session exists but its PTY has
//     exited. 410 is semantically correct: the resource was here, the
//     resource is now gone.
//
// Run: node --test packages/server/tests/crash-class-wiring.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// setInterval tracking — same shape as adapter-session-end-writer.test.js.
// createServer registers a 2s status_broadcast interval whose handle is not
// stored anywhere we can clearInterval from outside; without this wrapper
// the test process hangs after server.close().
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// Fake node-pty injected via require.cache before createServer is required.
// Each spawn returns a controllable term: callers can `_emitExit()` to
// trigger the registered onExit handler synchronously, or invoke `kill()`
// to drive the production kill→async-onExit pattern.
// ─────────────────────────────────────────────────────────────────────────

let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();

(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 88001;
  const fakeModule = {
    spawn(_shell, _args, _opts) {
      const handlers = { data: [], exit: [] };
      let killed = false;
      const term = {
        pid: nextPid++,
        _destroyed: false,
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write() {},
        resize() {},
        kill() {
          if (killed) return;
          killed = true;
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); } catch (_) { /* fail-soft */ }
            }
          });
        },
        _emitExit(payload) {
          for (const cb of handlers.exit) cb(payload || { exitCode: 0, signal: null });
        },
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
const { createServer, _resetTermdeckSecretsCache } = serverModule;

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness — keeps secrets.env loads isolated per test.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint63-t1-'));
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
  const { server, sessions, ptyReaper, transcriptWriter } = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return { server, port, sessions, ptyReaper, transcriptWriter };
}

async function closeTestServer({ server, ptyReaper, transcriptWriter }) {
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) {} }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) {} }
  try { server.closeAllConnections(); } catch (_) {}
  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (_) { resolve(); }
  });
  clearAllTrackedIntervals();
}

// ─────────────────────────────────────────────────────────────────────────
// Item 1.1 — `session.pty = null` after `term.onExit`.
//
// The PTY-leak fix appends a single line to the onExit handler in
// spawnTerminalSession. Asserts that after the exit handler runs:
//   • session.meta.status === 'exited' (pre-Sprint-63 behavior unchanged)
//   • session.pty === null            (Sprint 63 — the new invariant)
// ─────────────────────────────────────────────────────────────────────────

test('term.onExit nulls session.pty (PTY-leak fix)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const { port, sessions } = handle;
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', cwd: os.tmpdir(), type: 'shell' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();

      const session = sessions.get(created.id);
      assert.ok(session, 'session is registered in the manager');
      assert.ok(session.pty, 'session.pty is set immediately after spawn');
      assert.equal(session.meta.status, 'active', 'newly-spawned session starts active');

      const term = _fakeTermsByPid.get(created.pid);
      assert.ok(term, 'fake pty was captured for this session');

      // Drive the registered onExit lambda directly (synchronous).
      term._emitExit({ exitCode: 0, signal: null });

      // onExit runs sync; the only async piece is onPanelClose.catch(),
      // which is fire-and-forget and doesn't affect session.pty.
      assert.equal(session.meta.status, 'exited',
        'onExit sets meta.status="exited" (Sprint 50 pre-existing behavior)');
      assert.equal(session.pty, null,
        'Sprint 63 T1 1.1 — onExit MUST null session.pty so the wrapper is GC-eligible and `if (session.pty)` guards correctly identify the exited state');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1.2 — DELETE /api/sessions/:id stamps pty._destroyed=true.
//
// The DELETE handler kills the PTY synchronously then async-fires onExit.
// In the kill()→onExit window, a WS resize message could ioctl a fd whose
// child has just SIGHUP'd → EBADF/ENOTTY. Stamping `_destroyed = true`
// before sessions.remove() lets safelyResizePty short-circuit.
//
// Verified by: stub kill() to NOT auto-fire onExit so we can observe the
// window, then assert _destroyed=true on the fake term immediately after
// the DELETE response lands.
// ─────────────────────────────────────────────────────────────────────────

test('DELETE /api/sessions/:id stamps pty._destroyed=true (race-window guard)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const { port, sessions } = handle;
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', cwd: os.tmpdir(), type: 'shell' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      const term = _fakeTermsByPid.get(created.pid);
      assert.ok(term, 'fake pty captured');

      // Pre-DELETE: _destroyed is false (fake initializes it false).
      assert.equal(term._destroyed, false,
        'fake pty starts with _destroyed=false');

      // Override kill() to NOT fire onExit so the DELETE handler completes
      // BEFORE the async onExit runs. This isolates the synchronous
      // `_destroyed = true` stamp from the eventual onExit-driven cleanup.
      term.kill = function () { /* no-op for race-window inspection */ };

      const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);

      // Synchronously after DELETE: the fake term's _destroyed flag is true.
      // This is what safelyResizePty checks to short-circuit ioctls in the
      // kill→onExit window.
      assert.equal(term._destroyed, true,
        'Sprint 63 T1 1.2 — DELETE handler MUST stamp pty._destroyed=true after kill() so safelyResizePty can short-circuit before any ioctl');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 1.2 — POST /api/sessions/:id/resize returns 410 Gone on exited PTY.
//
// Pre-Sprint-63 the route returned either 404 (when session.pty was null
// after fix) or 409 (when safelyResizePty returned false). 410 Gone is
// semantically correct: the resource exists in the manager but the PTY
// has exited.
// ─────────────────────────────────────────────────────────────────────────

test('POST /resize returns 410 Gone after term.onExit (not 409, not 404)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const { port } = handle;
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', cwd: os.tmpdir(), type: 'shell' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      const term = _fakeTermsByPid.get(created.pid);
      term._emitExit({ exitCode: 0, signal: null });

      const resizeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 40 }),
      });
      assert.equal(resizeRes.status, 410,
        'Sprint 63 T1 1.2 — resize on exited PTY MUST return 410 Gone (semantic: resource was here, now gone). Pre-Sprint-63 this was 409 Conflict; Brad\'s 2026-05-07 patch suggestion #3 flagged 410 as the correct shape.');
      const body = await resizeRes.json();
      assert.match(body.error, /gone|exited/i,
        '410 response body explains the PTY is gone');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

test('POST /resize on missing session returns 404 (not 410 — distinct semantic)', { skip: !_ptyFakeAvailable }, async () => {
  // Distinguish "never existed" (404) from "existed and is gone" (410).
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const { port } = handle;
    try {
      const resizeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-session-id/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 40 }),
      });
      assert.equal(resizeRes.status, 404,
        'a session id that was never registered MUST return 404, not 410. 410 is reserved for sessions whose PTY has exited.');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('POST /resize succeeds (200) on a live session', { skip: !_ptyFakeAvailable }, async () => {
  // Sanity: the route still works when the PTY is alive — Sprint 63 only
  // changed the error path.
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const { port } = handle;
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: '/bin/sh', cwd: os.tmpdir(), type: 'shell' }),
      });
      const created = await createRes.json();
      const resizeRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}/resize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cols: 100, rows: 40 }),
      });
      assert.equal(resizeRes.status, 200);
      const body = await resizeRes.json();
      assert.equal(body.ok, true);
      assert.equal(body.cols, 100);
      assert.equal(body.rows, 40);
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

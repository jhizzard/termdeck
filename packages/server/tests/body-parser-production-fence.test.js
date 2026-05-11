// Sprint 63 T1 (Item 1.3) — body-parser PRODUCTION-PATH fence.
//
// T4-CODEX AUDIT-CONCERN (2026-05-11 13:20 ET): the companion
// `body-parser-rawbody.test.js` rebuilds the verify + error middleware
// inline. That fence proves the helpers work in isolation, but a
// production miswire (e.g. someone moves the verify-callback's
// `req.rawBody = Buffer.from(buf)` line below the control-char scan,
// or drops the error-middleware `hexEscapePrefix(req.rawBody)` call)
// would silently pass the rebuilt test.
//
// This file closes that gap by booting the REAL server via
// `createServer(config)` (the same shape used by
// `crash-class-wiring.test.js` and `adapter-session-end-writer.test.js`),
// spying on `console.warn` so the production warn line can be observed
// from the test process, and POSTing a malformed JSON body to a real
// route. Restore-claims-verified-by-diff: a code-path regression in
// `packages/server/src/index.js` would fail at least one assertion below.
//
// Run: node --test packages/server/tests/body-parser-production-fence.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// setInterval tracking — same shape as the other wiring fence files.
// Without this the 2s status_broadcast interval at createServer keeps the
// test process alive past server.close().
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
// Fake node-pty injected before createServer is required. Some POSTs in
// this file hit /api/sessions to drive the production spawn path; the
// fake keeps tests hermetic (no real shell, no real fds).
// ─────────────────────────────────────────────────────────────────────────

let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();
(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 77001;
  const fakeModule = {
    spawn(_shell, _args, _opts) {
      const handlers = { data: [], exit: [] };
      const term = {
        pid: nextPid++,
        _destroyed: false,
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write() {},
        resize() {},
        kill() {
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); } catch (_) {}
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

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint63-bp-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  try { return await fn(tmpHome); }
  finally {
    process.env.HOME = origHome;
    if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}
  }
}

async function bootTestServer() {
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
// console.warn spy — captures the production `[body-parser] ... prefix="..."`
// line emitted by the error middleware at packages/server/src/index.js:438-446.
// Restore-on-finally so a thrown assertion never leaks the spy across tests.
// ─────────────────────────────────────────────────────────────────────────

function spyConsoleWarn() {
  const captured = [];
  const orig = console.warn;
  console.warn = function (...args) {
    captured.push(args.map((a) => typeof a === 'string' ? a : String(a)).join(' '));
  };
  return {
    captured,
    restore() { console.warn = orig; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Production-path fence #1 — control-char body to a real express.json
// route. POST /api/sessions/<missing-id>/resize is the safest target: the
// route exists, requires no spawn, and short-circuits at the verify
// callback BEFORE the route handler can return a 404 (so the 400 from
// body-parser is conclusive).
// ─────────────────────────────────────────────────────────────────────────

test('production path: control-char body → 400 + hex prefix in production warn log',
  { skip: !_ptyFakeAvailable },
  async () => {
    await withTempHome(async () => {
      const handle = await bootTestServer();
      const { port } = handle;
      const spy = spyConsoleWarn();
      try {
        // Body contains \x07 (BEL) inside a JSON string — verify callback
        // at packages/server/src/index.js:386-435 must reject before any
        // route handler runs. BEL placed early so it falls within the
        // 32-byte prefix cap (hexEscapePrefix truncates past 32 bytes).
        const body = '{"label":"\x07evil"}';
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-id/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert.equal(res.status, 400,
          'verify callback must reject before route handler; 400 is conclusive (404 would mean the route ran)');
        const parsed = await res.json();
        assert.equal(parsed.error, 'Malformed JSON body',
          'production error middleware shape preserved');
        assert.equal(parsed.code, 'CONTROL_CHAR_IN_STRING',
          'production error middleware preserves the err.code from the verify callback');

        // Spy assertions — the warn line is emitted from the REAL error
        // middleware at packages/server/src/index.js:432-446, not a
        // rebuilt copy. A miswire (e.g. moving Buffer.from(buf) below the
        // control-char scan) would either fail to capture rawBody OR fail
        // to include the hex prefix in the warn.
        const warnLines = spy.captured.filter((l) => l.startsWith('[body-parser]'));
        assert.equal(warnLines.length, 1,
          `expected exactly one [body-parser] warn line; got ${warnLines.length}: ${JSON.stringify(spy.captured)}`);
        const line = warnLines[0];
        assert.ok(line.includes('CONTROL_CHAR_IN_STRING'),
          `production warn line must carry the error code; got: ${line}`);
        assert.ok(line.includes('prefix="'),
          `production warn line must carry the hex-escaped prefix="..." segment (Sprint 63 1.3); got: ${line}`);
        assert.ok(line.includes('\\x07'),
          `production warn line must render BEL as literal \\x07 (proves hexEscapePrefix is wired); got: ${line}`);
        assert.ok(line.includes('{"label":"'),
          `production warn line must preserve printable ASCII prefix verbatim; got: ${line}`);
        assert.ok(line.includes('evil'),
          `production warn line must preserve printable ASCII AFTER the control char too; got: ${line}`);
        assert.ok(line.includes('POST') && line.includes('/api/sessions/no-such-id/resize'),
          `production warn line must carry method + path for caller fingerprinting; got: ${line}`);
      } finally {
        spy.restore();
        _fakeTermsByPid.clear();
        await closeTestServer(handle);
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Production-path fence #2 — malformed (non-control-char) JSON. The
// verify callback succeeds (no control chars) and express.json's own
// JSON.parse throws SyntaxError. The error middleware still needs to
// emit the hex prefix — because the verify callback captured rawBody
// BEFORE attempting the scan, the SyntaxError path inherits the capture.
// ─────────────────────────────────────────────────────────────────────────

test('production path: malformed JSON (SyntaxError) → 400 + hex prefix in production warn log',
  { skip: !_ptyFakeAvailable },
  async () => {
    await withTempHome(async () => {
      const handle = await bootTestServer();
      const { port } = handle;
      const spy = spyConsoleWarn();
      try {
        const body = '{not valid json at all';
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-id/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert.equal(res.status, 400);
        const parsed = await res.json();
        assert.equal(parsed.error, 'Malformed JSON body');

        const warnLines = spy.captured.filter((l) => l.startsWith('[body-parser]'));
        assert.equal(warnLines.length, 1, 'one warn line per malformed POST');
        const line = warnLines[0];
        assert.ok(line.includes('prefix="'),
          'SyntaxError path must also carry the hex prefix — proves rawBody capture happens before the scan');
        // Printable-only body: prefix should include the literal first bytes.
        assert.ok(line.includes('{not valid json'),
          `SyntaxError path prefix must include the offending printable bytes; got: ${line}`);
      } finally {
        spy.restore();
        _fakeTermsByPid.clear();
        await closeTestServer(handle);
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Production-path fence #3 — valid JSON does NOT emit a warn line.
// Sanity: a well-formed body to a real route should never trip the error
// middleware. The body-parser warn signature must be specific to failure.
// ─────────────────────────────────────────────────────────────────────────

test('production path: valid JSON body does not emit body-parser warn',
  { skip: !_ptyFakeAvailable },
  async () => {
    await withTempHome(async () => {
      const handle = await bootTestServer();
      const { port } = handle;
      const spy = spyConsoleWarn();
      try {
        const body = JSON.stringify({ cols: 80, rows: 24 });
        // 404 from the route (session doesn't exist), but NO body-parser warn.
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-id/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert.equal(res.status, 404);
        const bodyParserWarns = spy.captured.filter((l) => l.startsWith('[body-parser]'));
        assert.equal(bodyParserWarns.length, 0,
          `valid JSON must NOT trigger body-parser warn; got: ${JSON.stringify(bodyParserWarns)}`);
      } finally {
        spy.restore();
        _fakeTermsByPid.clear();
        await closeTestServer(handle);
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────
// Production-path fence #4 — oversized body uses … truncation marker.
// Drives a 100+ byte body with a control char near the start; verifies
// the 32-byte cap is enforced inside the production warn pipeline.
// ─────────────────────────────────────────────────────────────────────────

test('production path: oversized control-char body — 32-byte prefix + … marker',
  { skip: !_ptyFakeAvailable },
  async () => {
    await withTempHome(async () => {
      const handle = await bootTestServer();
      const { port } = handle;
      const spy = spyConsoleWarn();
      try {
        const body = '{"label":"' + 'a'.repeat(80) + '\x01' + 'b'.repeat(20) + '"}';
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-id/resize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        assert.equal(res.status, 400);
        const line = spy.captured.find((l) => l.startsWith('[body-parser]'));
        assert.ok(line, 'warn line emitted');
        assert.ok(line.includes('…'),
          `oversized body must render the truncation marker (proves the 32-byte cap is enforced in production); got: ${line}`);
      } finally {
        spy.restore();
        _fakeTermsByPid.clear();
        await closeTestServer(handle);
      }
    });
  }
);

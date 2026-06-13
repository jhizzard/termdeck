// Sprint 76.1 (Bug B — Brad) — POST /api/sessions/:id/input `{submit:true}`
// server-sequenced submit + submit-confirm fence tests.
//
// Brad reported: a programmatic inject returns HTTP 200 but the text lands in
// the panel's input box unsubmitted and never becomes a turn. Root cause: the
// PTY /input route is a pass-through (one pty.write; 200 == "bytes written",
// not "became a turn"), and the documented two-stage dance (paste body, settle,
// lone `\r` as a SECOND POST) is a CALLER-side race whose trailing `\r` gets
// absorbed as bracketed-paste content under concurrent / mid-turn injects.
//
// The fix: `{submit:true}` makes the SERVER own the ordering — write the body,
// await a server-held settle, then write a lone `\r` as its own PTY write — so
// the OS chunk-boundary race is impossible. Plus a submit-confirm (`submitted`
// + `status` + `inputBufferLength`) so callers (Brad's tg-poll re-inject) can
// detect a stuck inject deterministically.
//
// Strategy mirrors session-lifecycle-api.test.js: a fake node-pty injected via
// require.cache BEFORE the server module loads, createServer on an ephemeral
// port, real fetch() against 127.0.0.1 — but the fake term CAPTURES writes so
// the test can assert the exact body-then-`\r` write sequence. Settle pinned to
// 0ms via TERMDECK_INPUT_SUBMIT_SETTLE_MS so the suite stays fast.
//
// Run: node --test packages/server/tests/input-submit-option.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pin the server-held settle to 0ms — read at call time by the route, so this
// makes `{submit:true}` near-instant without changing the write ordering logic.
process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '0';

// ─────────────────────────────────────────────────────────────────────────
// Track setInterval handles so the test process can drop createServer's 2s
// status_broadcast loop (its handle is never reachable from outside). Same
// pattern as session-lifecycle-api.test.js.
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
// Fake node-pty injected via require.cache BEFORE the server module loads.
// Unlike the lifecycle test's no-op write(), this fake APPENDS every write to
// term._writes so the test can assert the exact submit sequence.
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
        _writes: [],
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write(text) { this._writes.push(text); },
        resize() {},
        kill() {},
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
// Harness — HOME-override + ephemeral-port createServer (no real PTY, no RAG).
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-s76_1-input-'));
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
  try { json = await res.json(); } catch (_) { /* non-JSON body */ }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a shell panel, settle, and hand back its capture-term with a clean
// _writes array so a subsequent /input POST's writes are the only ones present.
async function freshPanel(port) {
  const created = await postJson(port, '/api/sessions', { type: 'shell' });
  assert.equal(created.status, 201, 'panel created');
  const term = _fakeTermsByPid.get(created.json.pid);
  assert.ok(term, 'capture-term resolved by pid');
  await sleep(20);          // let any spawn-time writes settle
  term._writes.length = 0;  // isolate the input-driven writes
  return { id: created.json.id, term };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 — submit:true performs the server-sequenced two-write submit (body, then a
//     LONE `\r`) — the core race-killer.
// ═══════════════════════════════════════════════════════════════════════════

test('submit:true writes the bracketed-paste body then a separate lone \\r',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        const body = '\x1b[200~hello world\nsecond line\x1b[201~';
        // The route CRLF-normalizes the body identically to the legacy
        // pass-through (zsh/readline Enter semantics) — internal \n ⇒ \r,
        // bracketed-paste markers preserved. The submit path then appends the
        // lone \r as a SEPARATE write. Parity with the proven two-stage body.
        const expectedBody = body.replace(/\r\n?/g, '\r').replace(/\n/g, '\r');
        const { status, json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: body, submit: true });

        assert.equal(status, 200);
        assert.equal(json.ok, true);
        assert.equal(json.submitted, true, 'submit-confirm present and true');
        assert.equal(term._writes.length, 2, 'exactly two PTY writes: body then submit');
        assert.equal(term._writes[0], expectedBody,
          'first write is the CRLF-normalized paste body (parity with the legacy pass-through)');
        assert.equal(term._writes[1], '\r', 'second write is a LONE carriage return — the submit');
        assert.equal(term._writes[0].endsWith('\r'), false,
          'the body write must not carry the submit \\r (the race this fixes — body ends at the paste close marker)');
        assert.equal(typeof json.status, 'string', 'submit-confirm carries status');
        assert.equal(typeof json.inputBufferLength, 'number', 'submit-confirm carries inputBufferLength');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2 — submit:true strips a caller-supplied trailing newline so the panel is
//     submitted EXACTLY once (no double Enter).
// ═══════════════════════════════════════════════════════════════════════════

test('submit:true strips a caller trailing CR/LF and submits exactly once',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        // Caller appends their own newline (the thing they used to do for the
        // one-POST case). It must NOT cause a double submit.
        const { json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: 'echo hi\n', submit: true });

        assert.equal(json.submitted, true);
        assert.equal(term._writes.length, 2, 'still exactly two writes (no double submit)');
        assert.equal(term._writes[0], 'echo hi', 'trailing newline stripped from the body write');
        assert.equal(term._writes[1], '\r', 'one and only one submit keystroke');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 3 — submit absent/false is BYTE-IDENTICAL to the pre-76.1 pass-through:
//     one write of the CRLF-normalized text, no appended \r, no `submitted`.
// ═══════════════════════════════════════════════════════════════════════════

test('submit absent ⇒ single pass-through write, normalized, no submitted key (back-compat)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        const { status, json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: 'echo hi\n' });

        assert.equal(status, 200);
        assert.equal(json.ok, true);
        assert.equal(term._writes.length, 1, 'pass-through is exactly one write');
        assert.equal(term._writes[0], 'echo hi\r', 'newline normalized to \\r, written as-is');
        assert.equal(json.bytes, 'echo hi\r'.length, 'bytes reflects the single normalized write');
        assert.equal('submitted' in json, false, 'no submitted key when submit not requested');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('submit:false (explicit) behaves as pass-through, not submit',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        const { json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: 'partial-line', submit: false });
        assert.equal(term._writes.length, 1, 'only submit===true triggers the two-write sequence');
        assert.equal(term._writes[0], 'partial-line');
        assert.equal('submitted' in json, false);
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 4 — submit:true on an empty body submits a bare Enter (just the \r).
// ═══════════════════════════════════════════════════════════════════════════

test('submit:true with empty text writes only the lone \\r (bare Enter)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        const { json } = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: '', submit: true });
        assert.equal(json.submitted, true);
        assert.equal(term._writes.length, 1, 'empty body ⇒ no body write, just the submit');
        assert.equal(term._writes[0], '\r');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 5 — the submit-confirm fields (status + inputBufferLength) are present on
//     EVERY /input response, so a caller can detect a stuck inject without a
//     separate GET /buffer poll (the second half of Brad's ask).
// ═══════════════════════════════════════════════════════════════════════════

test('every /input response carries status + inputBufferLength for submit-confirm',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id } = await freshPanel(h.port);
        const passthrough = await postJson(h.port, `/api/sessions/${id}/input`, { text: 'x' });
        assert.equal(typeof passthrough.json.status, 'string', 'status on pass-through');
        assert.equal(typeof passthrough.json.inputBufferLength, 'number', 'inputBufferLength on pass-through');

        const submitted = await postJson(h.port, `/api/sessions/${id}/input`,
          { text: '\x1b[200~y\x1b[201~', submit: true });
        assert.equal(typeof submitted.json.status, 'string', 'status on submit');
        assert.equal(typeof submitted.json.inputBufferLength, 'number', 'inputBufferLength on submit');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 6 — race-with-close: if the panel's PTY is torn down DURING the server-held
//     settle window, the submit returns a clean 410 panel_exited (not a hung
//     request, not a generic 500), and the lone `\r` is never written to the
//     dead PTY. Hardening surfaced by the OOD adversarial review.
// ═══════════════════════════════════════════════════════════════════════════

test('submit:true returns 410 (no hang) if the panel exits during the settle window',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      const prevSettle = process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS;
      // Open a real settle window so the exit can land mid-submit.
      process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '150';
      try {
        const { id, term } = await freshPanel(h.port);
        // Fire the submit (handler writes the body, then awaits ~150ms); kill
        // the PTY ~30ms in, well before the settle resolves.
        const pending = postJson(h.port, `/api/sessions/${id}/input`, { text: 'x', submit: true });
        setTimeout(() => {
          try { term._emitExit({ exitCode: 0, signal: null }); } catch (_) { /* fail-soft */ }
        }, 30);
        const { status, json } = await pending;

        assert.equal(status, 410, 'mid-settle close yields a clean 410, not a hang or 500');
        assert.equal(json.ok, false);
        assert.equal(json.code, 'panel_exited', 'distinct "panel closed mid-submit" signal');
        assert.equal(term._writes.includes('\r'), false,
          'the submit \\r is never written to the torn-down PTY');
      } finally {
        process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = prevSettle;
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

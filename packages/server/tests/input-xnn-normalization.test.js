// Sprint 80 T1 (BR-1 — Brad's 2026-06-26 fleet cascade) — `\xNN` normalization
// on POST /api/sessions/:id/input.
//
// Root chain (Brad's R730 log pull, confirmed against our tree): v1.11.0 moved
// packages/server to express 5 (body-parser 2.x). Bash/curl inject callers send
// JSON whose `text` contains the literal 4-char sequence `\x1b` (backslash, x,
// 1, b) — an INVALID JSON escape. express.json() rejects it (entity.parse.failed
// "Bad escaped character"); the Sprint 63 handler returns a structured 400 — but
// autonomous orch callers do NOT check the response, so the inject vanishes
// silently and the spawned panel never boots → self-rotation fails → 1M wall →
// host crash.
//
// The fix (PLANNING §3.1/§3.2, locked): a pre-parse middleware scoped to POST +
// /api/sessions/:id/input that rewrites `\xNN` → `\u00NN` in the raw body BEFORE
// express.json() parses it, so the real ESC-wrapped bracketed-paste lands in the
// PTY. All OTHER routes keep strict parsing. Malformed-after-normalization
// bodies still 400, now with an extended `hint` field.
//
// Harness: fake node-pty injected via require.cache before the server module
// loads (captures writes to term._writes), createServer on an ephemeral port,
// and — critically — RAW-WIRE POSTs so the literal backslash-x bytes reach the
// server exactly as Brad's curl sends them (JSON.stringify of a JS string would
// pre-encode `\x1b` to a real ESC → `` on the wire, which is NOT the bug).
//
// Run: node --test packages/server/tests/input-xnn-normalization.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TERMDECK_INPUT_SUBMIT_SETTLE_MS = '0';

// ── Interval tracking so createServer's status-broadcast loop can be dropped ──
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

// ── Fake node-pty (captures every write) injected before the server loads ──
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

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-s80-xnn-'));
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

// POST an OBJECT (JSON.stringify) — for the well-behaved control case.
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

// POST a RAW body string verbatim — this is how we reproduce Brad's exact wire
// bytes (literal backslash-x, NOT a pre-encoded ESC).
async function postRaw(port, p, rawBody, headers = {}) {
  const res = await fetch(url(port, p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
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
// 1 — BR-1 REPRODUCTION: Brad's exact failing shape. Literal `\x1b[200~…\x1b[201~`
//     (backslash-x on the wire) MUST land in the PTY as REAL ESC-wrapped paste
//     and return 200 — not the silent-loss 400.
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: literal \\x1b bracketed-paste normalizes to real ESC bytes and returns 200',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        // Raw wire body = Brad's curl -d '{"text":"\x1b[200~boot\x1b[201~"}'
        // In JS source, `\\x1b` = the 4 literal chars backslash-x-1-b.
        const raw = '{"text":"\\x1b[200~boot\\x1b[201~"}';
        const { status, json } = await postRaw(h.port, `/api/sessions/${id}/input`, raw);

        assert.equal(status, 200, 'inject must SUCCEED, not silently 400');
        assert.equal(json.ok, true);
        assert.equal(term._writes.length, 1, 'exactly one PTY write (pass-through)');
        // The PTY must receive REAL ESC (0x1b) bytes, not the literal text.
        assert.equal(term._writes[0], '\x1b[200~boot\x1b[201~',
          'PTY receives real ESC-wrapped bracketed paste');
        assert.equal(term._writes[0].charCodeAt(0), 0x1b, 'first byte is a real ESC');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2 — Back-compat: a proper `` payload is byte-identical to today.
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: proper \\u001b payload is unchanged (byte-identical pass-through)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        // Proper JSON unicode escape on the wire.
        const raw = '{"text":"\\u001b[200~boot\\u001b[201~"}';
        const { status, json } = await postRaw(h.port, `/api/sessions/${id}/input`, raw);
        assert.equal(status, 200);
        assert.equal(json.ok, true);
        assert.equal(term._writes.length, 1);
        assert.equal(term._writes[0], '\x1b[200~boot\x1b[201~',
          'proper unicode escape still yields real ESC bytes, identical to the \\xNN path');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 3 — Edge hex: uppercase `\X1B`, `\x00`, `\xff` all normalize.
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: uppercase \\X1B and boundary \\x00 / \\xff normalize to real bytes',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        // \X1B (capital X), \x00 (NUL), \xff (0xff) — no \r/\n so CRLF-normalize is a no-op.
        const raw = '{"text":"A\\X1BB\\x00C\\xffD"}';
        const { status } = await postRaw(h.port, `/api/sessions/${id}/input`, raw);
        assert.equal(status, 200, 'all \\xNN variants parse');
        assert.equal(term._writes.length, 1);
        assert.equal(term._writes[0], 'A\x1bB\x00C\xffD',
          'uppercase X + NUL + 0xff all become their real single bytes');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 4 — Even/odd backslash: a PROPERLY-escaped `\\x1b` (escaped backslash) must
//     stay the literal 4 chars backslash-x-1-b — only a REAL invalid `\x`
//     escape (odd backslash run) is normalized. This SHRINKS the accepted
//     hazard: valid-JSON literal-text intent (`\\x`) is preserved.
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: escaped \\\\x1b (even backslashes) stays literal text, not converted',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id, term } = await freshPanel(h.port);
        // Wire body: {"text":"a\\x1bZ"} — `\\` is a valid escaped backslash, so
        // the string VALUE is: a + backslash + x1bZ (literal). Must NOT become ESC.
        const raw = '{"text":"a\\\\x1bZ"}';
        const { status } = await postRaw(h.port, `/api/sessions/${id}/input`, raw);
        assert.equal(status, 200);
        assert.equal(term._writes.length, 1);
        assert.equal(term._writes[0], 'a\\x1bZ',
          'even backslash run ⇒ literal backslash preserved, no ESC conversion');
        assert.notEqual(term._writes[0].charCodeAt(1), 0x1b);
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 5 — Route-scoped: a NON-/input route with the same literal `\x1b` still
//     strict-400s (normalization must not leak to other routes).
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: non-/input route with literal \\x1b still returns strict 400',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const raw = '{"type":"shell","junk":"\\x1b[200~x"}';
        const { status, json } = await postRaw(h.port, '/api/sessions', raw);
        assert.equal(status, 400, 'other routes keep strict JSON parsing');
        assert.equal(json.error, 'Malformed JSON body');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 6 — Malformed-AFTER-normalization on /input still 400s, now with a `hint`.
//     A body that stays invalid post-normalization (e.g. a raw unescaped
//     control char, or a structural error) must not be swallowed.
// ═══════════════════════════════════════════════════════════════════════════

test('BR-1: still-malformed /input body 400s with an extended hint field',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const { id } = await freshPanel(h.port);
        // Structurally broken JSON that no \xNN normalization can rescue.
        const raw = '{"text":"unterminated';
        const { status, json } = await postRaw(h.port, `/api/sessions/${id}/input`, raw);
        assert.equal(status, 400, 'genuinely malformed body is NOT silently accepted');
        assert.equal(json.error, 'Malformed JSON body');
        assert.equal(typeof json.hint, 'string', 'the 400 now carries a hint naming the fix');
        assert.ok(json.hint.length > 0);
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

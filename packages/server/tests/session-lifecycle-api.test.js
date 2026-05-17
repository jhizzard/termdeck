// Sprint 65 T2 — Server lifecycle API fence tests.
//
// Route-level + WS-level coverage for the four net-new T2 sub-tasks:
//   2.1 — meta.role: POST /api/sessions accepts an optional `role` field
//         (orchestrator/worker/reviewer/auditor/null); unknown values 400.
//   2.2 — GET /api/sessions excludes exited (dead-PTY) sessions by default;
//         ?includeExited=true returns the legacy full shape.
//   2.3 — POST /api/sessions/:id/input returns 410 Gone (not the pre-Sprint-65
//         silent 404) when the target panel's PTY has exited.
//   2.4 — term.onExit broadcasts a `panel_exited` WS frame to all dashboard
//         clients; status_broadcast STILL carries exited sessions (R2 — see
//         the Sprint 65 STATUS.md [T2] FINDING 2026-05-16 20:01 ET).
// Plus the SQLite `sessions.role` column — fresh-install CREATE TABLE path
// and the existing-database PRAGMA-guarded ALTER migration path.
//
// Strategy mirrors adapter-session-end-writer.test.js: a fake node-pty
// injected via require.cache BEFORE the server module loads, createServer on
// an ephemeral port, real fetch()/WebSocket against 127.0.0.1. Hermetic — no
// external instance (sidesteps the T4-CODEX 19:47 stale-:3001 concern), runs
// clean under `npm test`.
//
// Run: node --test packages/server/tests/session-lifecycle-api.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// Track setInterval handles so the test process can drop createServer's 2s
// status_broadcast loop (its handle is never stored anywhere reachable from
// outside). Without this the process hangs after the last assert. Same
// pattern as adapter-session-end-writer.test.js.
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
// createServer's pty.spawn(...) returns one of these controllable fakes so
// the route tests can drive term.onExit without a real PTY.
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
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write() {},
        resize() {},
        kill() {
          if (killed) return;
          killed = true;
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); } catch (_e) { /* fail-soft */ }
            }
          });
        },
        // Test-only: drive onExit synchronously.
        _emitExit(payload) {
          for (const cb of handlers.exit) cb(payload || { exitCode: 0, signal: null });
        },
        _emitData(data) {
          for (const cb of handlers.data) cb(data);
        },
      };
      _fakeTermsByPid.set(term.pid, term);
      return term;
    },
  };
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fakeModule,
    parent: null,
    children: [],
    paths: [],
  };
  _ptyFakeAvailable = true;
})();

const serverModule = require('../src/index.js');
const { createServer, ALLOWED_SESSION_ROLES, _resetTermdeckSecretsCache } = serverModule;
const { SessionManager } = require('../src/session');
const { initDatabase } = require('../src/database');

let WebSocket;
try { WebSocket = require('ws'); } catch (_e) { WebSocket = null; }
let Database;
try { Database = require('better-sqlite3'); } catch (_e) { Database = null; }

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness — fresh tempdir per test.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint65-t2-'));
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

// Minimal inline config — every optional side-effect disabled. Do NOT call
// loadConfig() (it freezes CONFIG_PATH from the developer's real ~/.termdeck).
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
  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (_) { resolve(); }
  });
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

async function getJson(port, p) {
  const res = await fetch(url(port, p));
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON body */ }
  return { status: res.status, json };
}

async function patchJson(port, p, body) {
  const res = await fetch(url(port, p), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON body */ }
  return { status: res.status, json };
}

// Poll a predicate until true or timeout — for the async WS-delivery window.
async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

// Connect a dashboard WS client bound to `sessionId`; collect every frame.
function connectWsClient(port, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${sessionId}`);
    const frames = [];
    ws.on('message', (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch (_) { /* ignore non-JSON */ }
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('error', (err) => reject(err));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2.1 — meta.role validation on POST /api/sessions
// ═══════════════════════════════════════════════════════════════════════════

test('2.1 — POST /api/sessions accepts each whitelisted role + reflects it in meta.role',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor']) {
          const { status, json } = await postJson(h.port, '/api/sessions', { type: 'shell', role });
          assert.equal(status, 201, `role=${role} should create the session`);
          assert.equal(json.meta.role, role, `meta.role must echo ${role}`);
        }
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1 — POST /api/sessions with explicit role:null and with role absent both yield meta.role=null',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const explicitNull = await postJson(h.port, '/api/sessions', { type: 'shell', role: null });
        assert.equal(explicitNull.status, 201);
        assert.equal(explicitNull.json.meta.role, null, 'explicit role:null → meta.role null');

        const absent = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(absent.status, 201);
        assert.equal(absent.json.meta.role, null, 'absent role → meta.role defaults to null');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1 — POST /api/sessions rejects unknown role values with 400 invalid_role',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        // Case-sensitive exact match — a typo, wrong case, empty string, or a
        // non-string must all 400 so a mis-tagged panel surfaces immediately.
        const bad = ['bogus-role', 'Orchestrator', '', 'ORCH', 123, ['orchestrator'], { role: 'x' }];
        for (const role of bad) {
          const { status, json } = await postJson(h.port, '/api/sessions', { type: 'shell', role });
          assert.equal(status, 400, `role=${JSON.stringify(role)} must be rejected with 400`);
          assert.equal(json.ok, false);
          assert.equal(json.code, 'invalid_role');
          assert.ok(Array.isArray(json.allowed), '400 body lists the allowed roles');
          assert.ok(json.allowed.includes('orchestrator'), 'allowed array names orchestrator');
        }
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1 — ALLOWED_SESSION_ROLES is exported and is exactly the documented whitelist', () => {
  assert.ok(Array.isArray(ALLOWED_SESSION_ROLES), 'whitelist is exported as an array');
  assert.deepEqual(
    ALLOWED_SESSION_ROLES,
    ['orchestrator', 'worker', 'reviewer', 'auditor', null],
    'whitelist must be exactly orchestrator/worker/reviewer/auditor/null',
  );
});

test('2.1 — meta.role flows through GET /api/sessions and GET /api/sessions/:id',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell', role: 'orchestrator' });
        assert.equal(created.status, 201);
        const id = created.json.id;

        const list = await getJson(h.port, '/api/sessions');
        const row = list.json.find((s) => s.id === id);
        assert.ok(row, 'session appears in GET /api/sessions');
        assert.equal(row.meta.role, 'orchestrator', 'role flows through the list endpoint');

        const detail = await getJson(h.port, `/api/sessions/${id}`);
        assert.equal(detail.json.meta.role, 'orchestrator', 'role flows through the detail endpoint');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2.1b — meta.role is PATCH-mutable (Sprint 66 T1 Task 1.2). An operator can
// tag a LIVE panel as orchestrator in place — no destroy+recreate. Validation
// mirrors POST exactly (the route 400s an unknown value before updateMeta).
// ═══════════════════════════════════════════════════════════════════════════

test('2.1b — PATCH /api/sessions/:id mutates meta.role on a live panel (unroled → orchestrator → null)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(created.status, 201);
        assert.equal(created.json.meta.role, null, 'panel spawns unroled');
        const id = created.json.id;

        const marked = await patchJson(h.port, `/api/sessions/${id}`, { role: 'orchestrator' });
        assert.equal(marked.status, 200, 'PATCH role succeeds on a live panel');
        assert.equal(marked.json.meta.role, 'orchestrator', 'the PATCH response echoes the new role');

        const detail = await getJson(h.port, `/api/sessions/${id}`);
        assert.equal(detail.json.meta.role, 'orchestrator', 'the mutation is durable on the session');

        const unmarked = await patchJson(h.port, `/api/sessions/${id}`, { role: null });
        assert.equal(unmarked.status, 200);
        assert.equal(unmarked.json.meta.role, null, 'role:null unmarks the panel');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1b — PATCH role accepts every whitelisted value',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const id = created.json.id;
        for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor', null]) {
          const r = await patchJson(h.port, `/api/sessions/${id}`, { role });
          assert.equal(r.status, 200, `PATCH role=${JSON.stringify(role)} → 200`);
          assert.equal(r.json.meta.role, role, `meta.role echoes ${JSON.stringify(role)}`);
        }
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1b — PATCH rejects an unknown role with 400 invalid_role and leaves meta.role unchanged',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell', role: 'worker' });
        const id = created.json.id;
        // Case-sensitive exact match — same rejection set shape as POST.
        const bad = ['bogus-role', 'Orchestrator', '', 'ORCH', 123, ['orchestrator']];
        for (const role of bad) {
          const r = await patchJson(h.port, `/api/sessions/${id}`, { role });
          assert.equal(r.status, 400, `role=${JSON.stringify(role)} must be rejected with 400`);
          assert.equal(r.json.ok, false);
          assert.equal(r.json.code, 'invalid_role');
          assert.ok(Array.isArray(r.json.allowed) && r.json.allowed.includes('orchestrator'),
            '400 body lists the allowed roles (mirrors POST)');
        }
        // None of the rejected PATCHes touched the panel — role still 'worker'.
        const detail = await getJson(h.port, `/api/sessions/${id}`);
        assert.equal(detail.json.meta.role, 'worker', 'an invalid PATCH leaves meta.role intact');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1b — a non-role PATCH (theme) is unaffected; role stays a no-op when absent',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell', role: 'orchestrator' });
        const id = created.json.id;
        // A PATCH with no `role` key must not disturb the existing role.
        const r = await patchJson(h.port, `/api/sessions/${id}`, { label: 'renamed panel' });
        assert.equal(r.status, 200);
        assert.equal(r.json.meta.label, 'renamed panel', 'label still PATCHes');
        assert.equal(r.json.meta.role, 'orchestrator', 'an absent role key leaves role intact');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1b — PATCH role to a never-existed session is 404',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const r = await patchJson(h.port, '/api/sessions/no-such-session-id', { role: 'orchestrator' });
        assert.equal(r.status, 404, 'a valid-role PATCH to a missing session is 404');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.1b — a PATCHed role flows through status_broadcast (T1 ORCH-pin re-evaluation contract)',
  { skip: !_ptyFakeAvailable || !WebSocket }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      let client;
      try {
        const a = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const b = await postJson(h.port, '/api/sessions', { type: 'shell' });
        client = await connectWsClient(h.port, a.json.id);

        // PATCH panel B's role. The dashboard re-routes the ORCH pin off the
        // status_broadcast frame (reconcileOrchRow), so the new role MUST
        // surface there — not only in the PATCH response.
        const marked = await patchJson(h.port, `/api/sessions/${b.json.id}`, { role: 'orchestrator' });
        assert.equal(marked.status, 200);

        const carried = await waitFor(() => client.frames.some((f) =>
          f.type === 'status_broadcast'
          && Array.isArray(f.sessions)
          && f.sessions.some((s) => s.id === b.json.id && s.meta.role === 'orchestrator')
        ), 4000);
        assert.ok(carried, 'the PATCHed role appears in a subsequent status_broadcast frame');
      } finally {
        if (client && client.ws) { try { client.ws.close(); } catch (_) { /* fail-soft */ } }
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2.2 — GET /api/sessions excludes exited sessions by default
// ═══════════════════════════════════════════════════════════════════════════

test('2.2 — GET /api/sessions excludes exited panels by default; ?includeExited=true restores them',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const live = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const dead = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(live.status, 201);
        assert.equal(dead.status, 201);

        // Kill the second panel's PTY — faithful to Brad's bug shape (a panel
        // whose process exited, NOT an operator DELETE). The session stays in
        // the Map with status='exited'.
        const deadTerm = _fakeTermsByPid.get(dead.json.pid);
        assert.ok(deadTerm, 'fake term captured for the panel to be exited');
        deadTerm._emitExit({ exitCode: 0, signal: null });

        const def = await getJson(h.port, '/api/sessions');
        const defIds = def.json.map((s) => s.id);
        assert.ok(defIds.includes(live.json.id), 'live panel present in the default listing');
        assert.ok(!defIds.includes(dead.json.id),
          'exited panel must be excluded from the default listing (Brad D.5 item 3)');

        const all = await getJson(h.port, '/api/sessions?includeExited=true');
        const allIds = all.json.map((s) => s.id);
        assert.ok(allIds.includes(live.json.id) && allIds.includes(dead.json.id),
          '?includeExited=true returns the legacy full shape (both panels)');

        // Explicit ?includeExited=false matches the default.
        const explicitFalse = await getJson(h.port, '/api/sessions?includeExited=false');
        assert.ok(!explicitFalse.json.map((s) => s.id).includes(dead.json.id),
          '?includeExited=false also excludes the exited panel');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2.3 — POST /api/sessions/:id/input → 410 Gone on a dead panel
// ═══════════════════════════════════════════════════════════════════════════

test('2.3 — inject to an exited panel returns 410 Gone with the structured panel_exited body',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(created.status, 201);
        const term = _fakeTermsByPid.get(created.json.pid);
        assert.ok(term);
        term._emitExit({ exitCode: 3, signal: null });

        const res = await fetch(url(h.port, `/api/sessions/${created.json.id}/input`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'echo hi\n' }),
        });
        assert.equal(res.status, 410, 'dead-panel inject must be 410 Gone, not 404 or 200');
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.code, 'panel_exited', 'programmatic discriminator present');
        assert.ok(typeof body.error === 'string' && body.error.length > 0,
          '`error` key present — backward-compat with the client api()/sendReply() path (T4-CODEX 19:44)');
        assert.ok(typeof body.message === 'string' && body.message.length > 0, '`message` present');
        assert.equal(body.exitCode, 3, 'exitCode surfaced in the 410 body');
        assert.ok(typeof body.exitedAt === 'string' && body.exitedAt.length > 0,
          'exitedAt timestamp surfaced in the 410 body');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.3 — inject to a never-existed session is still 404 (distinct from 410-exited)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const res = await fetch(url(h.port, '/api/sessions/no-such-session-id/input'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        });
        assert.equal(res.status, 404, 'a session that never existed is 404, not 410');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.3 — inject to a LIVE panel still returns 200 (happy-path regression guard)',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(created.status, 201);
        const res = await fetch(url(h.port, `/api/sessions/${created.json.id}/input`), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'echo hi\n' }),
        });
        assert.equal(res.status, 200, 'inject to a live panel must still succeed');
        const body = await res.json();
        assert.equal(body.ok, true);
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// 2.4 — panel_exited WS frame + meta.exitedAt + status_broadcast unchanged
// ═══════════════════════════════════════════════════════════════════════════

test('2.4 — term.onExit broadcasts a panel_exited frame to all dashboard clients',
  { skip: !_ptyFakeAvailable || !WebSocket }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      let client;
      try {
        // Panel A — the observer client binds to it. Panel B — the subject we
        // exit. The broadcast must reach A's client even though it was created
        // for B (panel_exited goes to every wss client, not just B's socket).
        const a = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const b = await postJson(h.port, '/api/sessions', { type: 'shell' });
        assert.equal(a.status, 201);
        assert.equal(b.status, 201);

        client = await connectWsClient(h.port, a.json.id);
        const bTerm = _fakeTermsByPid.get(b.json.pid);
        assert.ok(bTerm);
        bTerm._emitExit({ exitCode: 0, signal: null });

        const got = await waitFor(() =>
          client.frames.some((f) => f.type === 'panel_exited' && f.sessionId === b.json.id));
        assert.ok(got, 'observer received a panel_exited frame for the exited panel');

        const frame = client.frames.find((f) => f.type === 'panel_exited' && f.sessionId === b.json.id);
        assert.equal(frame.type, 'panel_exited');
        assert.equal(frame.sessionId, b.json.id);
        assert.equal(frame.exitCode, 0, 'panel_exited carries the exit code');
        assert.equal(frame.signal, null, 'panel_exited carries signal (null when none)');
        assert.ok(typeof frame.exitedAt === 'string' && frame.exitedAt.length > 0,
          'panel_exited carries the exitedAt timestamp');
      } finally {
        if (client && client.ws) { try { client.ws.close(); } catch (_) { /* fail-soft */ } }
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.4 — status_broadcast STILL carries exited sessions after exit (R2 — missed-exit reconciliation intact)',
  { skip: !_ptyFakeAvailable || !WebSocket }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      let client;
      try {
        const a = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const b = await postJson(h.port, '/api/sessions', { type: 'shell' });
        client = await connectWsClient(h.port, a.json.id);
        const bTerm = _fakeTermsByPid.get(b.json.pid);
        bTerm._emitExit({ exitCode: 0, signal: null });

        // The 2s status_broadcast tick must still include the exited panel —
        // proves getAll() default behavior is unchanged so the dashboard's
        // missed-exit reconciliation keeps its data (resolves T4-CODEX 19:48).
        const carried = await waitFor(() => client.frames.some((f) =>
          f.type === 'status_broadcast'
          && Array.isArray(f.sessions)
          && f.sessions.some((s) => s.id === b.json.id && s.meta.status === 'exited')
        ), 4000);
        assert.ok(carried,
          'status_broadcast must still carry the exited session (R2 — only the route filters)');
      } finally {
        if (client && client.ws) { try { client.ws.close(); } catch (_) { /* fail-soft */ } }
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

test('2.4 — meta.exitedAt is stamped on PTY exit and visible via GET /api/sessions/:id',
  { skip: !_ptyFakeAvailable }, async () => {
    await withTempHome(async () => {
      const h = await bootTestServer();
      try {
        const created = await postJson(h.port, '/api/sessions', { type: 'shell' });
        const term = _fakeTermsByPid.get(created.json.pid);
        const before = Date.now();
        term._emitExit({ exitCode: 0, signal: null });

        const detail = await getJson(h.port, `/api/sessions/${created.json.id}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.json.meta.status, 'exited');
        assert.ok(typeof detail.json.meta.exitedAt === 'string',
          'meta.exitedAt is an ISO timestamp string after exit');
        const t = Date.parse(detail.json.meta.exitedAt);
        assert.ok(!Number.isNaN(t) && t >= before - 1000, 'exitedAt is a plausible recent timestamp');
      } finally {
        _fakeTermsByPid.clear();
        await closeTestServer(h);
      }
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// SQLite — sessions.role column: fresh-install CREATE TABLE + existing-db
// PRAGMA-guarded ALTER migration (database.js initDatabase()).
// ═══════════════════════════════════════════════════════════════════════════

test('SQLite — a fresh database has the sessions.role column and SessionManager.create persists it',
  { skip: !Database }, async () => {
    await withTempHome(async (home) => {
      // initDatabase writes to <HOME>/.termdeck/termdeck.db.
      const db = initDatabase(Database);
      try {
        const cols = db.prepare('PRAGMA table_info(sessions)').all();
        assert.ok(cols.some((c) => c.name === 'role'),
          'fresh-install CREATE TABLE includes the role column');

        const mgr = new SessionManager(db);
        mgr.create({ id: 'db-role-1', type: 'shell', role: 'orchestrator' });
        const row = db.prepare('SELECT role FROM sessions WHERE id = ?').get('db-role-1');
        assert.equal(row.role, 'orchestrator', 'SessionManager.create persists role into SQLite');

        mgr.create({ id: 'db-role-2', type: 'shell' });
        const row2 = db.prepare('SELECT role FROM sessions WHERE id = ?').get('db-role-2');
        assert.equal(row2.role, null, 'an unroled session persists role as NULL');
      } finally {
        try { db.close(); } catch (_) { /* fail-soft */ }
        void home;
      }
    });
  });

test('SQLite — initDatabase migrates an existing pre-Sprint-65 database (ALTER adds sessions.role)',
  { skip: !Database }, async () => {
    await withTempHome(async (home) => {
      const dbPath = path.join(home, '.termdeck', 'termdeck.db');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });

      // Build a pre-Sprint-65 `sessions` table — every column EXCEPT role.
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'shell',
          project TEXT,
          label TEXT,
          command TEXT,
          cwd TEXT,
          created_at TEXT NOT NULL,
          exited_at TEXT,
          exit_code INTEGER,
          reason TEXT,
          theme TEXT DEFAULT 'tokyo-night',
          theme_override TEXT
        );
      `);
      old.prepare(`INSERT INTO sessions (id, type, created_at) VALUES (?, ?, ?)`)
        .run('legacy-row', 'shell', new Date().toISOString());
      old.close();

      // Re-open through initDatabase — the PRAGMA-guarded migration must add
      // the role column without disturbing the pre-existing row.
      const migrated = initDatabase(Database);
      try {
        const cols = migrated.prepare('PRAGMA table_info(sessions)').all();
        assert.ok(cols.some((c) => c.name === 'role'),
          'initDatabase ALTERed role into the existing database');
        const legacy = migrated.prepare('SELECT id, role FROM sessions WHERE id = ?').get('legacy-row');
        assert.ok(legacy, 'the pre-existing row survived the migration');
        assert.equal(legacy.role, null, 'a pre-Sprint-65 row reads role as NULL (correct unroled default)');
      } finally {
        try { migrated.close(); } catch (_) { /* fail-soft */ }
      }
    });
  });

test('SQLite — SessionManager.updateMeta persists a role change to the sessions.role column (Sprint 66 T1)',
  { skip: !Database }, async () => {
    await withTempHome(async () => {
      const db = initDatabase(Database);
      try {
        const mgr = new SessionManager(db);
        mgr.create({ id: 'db-role-patch', type: 'shell', role: 'worker' });
        assert.equal(
          db.prepare('SELECT role FROM sessions WHERE id = ?').get('db-role-patch').role,
          'worker', 'the spawn-time role is persisted by create()');

        // Sprint 66 T1 (Task 1.2) — updateMeta writes a role change through to
        // SQLite, so a PATCH-tagged orchestrator survives a server restart.
        mgr.updateMeta('db-role-patch', { role: 'orchestrator' });
        assert.equal(
          db.prepare('SELECT role FROM sessions WHERE id = ?').get('db-role-patch').role,
          'orchestrator', 'updateMeta persisted the role change to the role column');

        mgr.updateMeta('db-role-patch', { role: null });
        assert.equal(
          db.prepare('SELECT role FROM sessions WHERE id = ?').get('db-role-patch').role,
          null, 'updateMeta persisted the unmark (role → NULL)');
      } finally {
        try { db.close(); } catch (_) { /* fail-soft */ }
      }
    });
  });

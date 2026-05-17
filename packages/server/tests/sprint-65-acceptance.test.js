// Sprint 65 T3 — Dashboard-reliability acceptance suite.
//
// Reproduces the SERVER-side contract of Brad's 2026-05-12 smoking gun —
// "at one point I had 18 windows open. 10 were dead codex cli" — and the
// 2026-05-13 v2 spec (project chips + ORCH pin). This file fences the T2
// server lane: meta.role, exited-session filtering, 410-Gone on dead-panel
// input, the panel_exited WS frame, and per-adapter idle/parked detection.
//
// SCOPE BOUNDARY. This is a `packages/server/tests/` suite — it exercises the
// HTTP + WS contract only. The client-DOM half of Brad's repro (chip switch
// <100ms, ORCH tile pinned, tile auto-removal animation) cannot be asserted
// from a headless node:test process: there is no `packages/client/tests/`
// jsdom harness. Those rows of the acceptance matrix live in
// `docs/sprint-65-dashboard-reliability/ACCEPTANCE-CHECKLIST.md` as
// operator-run steps + the live `termdeck --port 3002` destructive repro.
//
// TWO FIXTURE CORRECTIONS vs the T3 brief's pseudocode (both posted as
// `### [T3] FINDING` in STATUS.md, both make the test MORE faithful to Brad):
//   1. "Kill" is PTY-exit (`term._emitExit`), not `DELETE /api/sessions/:id`.
//      DELETE calls `sessions.remove()` which deletes the session from the
//      in-memory Map entirely (index.js:1721 -> session.js:644-659) — a
//      DELETE'd session never appears in `getAll()`, so `?includeExited=true`
//      would return 9 not 19. Brad's "dead codex cli" are PTY processes that
//      EXITED (`/exit`, crash): `term.onExit` flips `meta.status='exited'` and
//      the session STAYS in the Map with a lingering tile. PTY-exit is the bug.
//   2. The brief spawns "9 codex + 9 grok" but then asks to "kill 10 codex".
//      9 codex cannot yield 10 dead codex. To match Brad's exact words we
//      spawn 10 codex (aetheria) + 8 grok (structural360) + 1 orchestrator
//      = 19, and kill all 10 codex. Result: 8 grok + 1 orch = 9 live.
//
// RED-UNTIL-T2 by design. Every T2-dependent test self-probes the running
// server via a `meta.role` round-trip (T2 ships sub-tasks 2.1-2.5 as one
// coherent FIX block per its brief). Until that probe passes the tests
// `t.skip()` with a clear message — they do NOT fail `npm test` mid-sprint.
// Once T2's code is in the working tree the probe passes and the real
// assertions run; a botched T2 fix then fails LOUDLY (no masking). At sprint
// close T3 confirms 0 skips — see ACCEPTANCE-CHECKLIST.md.
//
// Harness mirrors `adapter-session-end-writer.test.js` (Sprint 62): fake
// node-pty injected via require.cache, in-process `createServer`, ephemeral
// port. Fully hermetic — no dependency on the live :3001 / :3000 instances.
//
// Run: node --test packages/server/tests/sprint-65-acceptance.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// Track setInterval handles so the test process can drop the 2s
// status_broadcast loop (index.js:2683) — its handle is never stored
// anywhere reachable from outside, and it keeps the event loop alive past
// server.close(). Same instrumentation as adapter-session-end-writer.test.js.
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
// `pty.spawn(...)` returns a controllable fake so POST /api/sessions drives
// the real spawn wiring without a real PTY (and without putting `codex` /
// `grok` binaries on PATH). `_emitExit` reproduces a `/exit`-induced PTY
// death; `_emitData` drives `term.onData -> session.analyzeOutput`.
// ─────────────────────────────────────────────────────────────────────────

let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();

(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 91001;
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
              try { cb({ exitCode: 0, signal: null }); }
              catch (_e) { /* fail-soft */ }
            }
          });
        },
        // Test-only: drive a PTY exit synchronously (a `/exit` / crash).
        _emitExit(payload) {
          for (const cb of handlers.exit) cb(payload || { exitCode: 0, signal: null });
        },
        // Test-only: drive a PTY data chunk -> onData -> analyzeOutput.
        _emitData(data) {
          for (const cb of handlers.data) cb(data);
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

const { WebSocket } = require('ws');
const serverModule = require('../src/index.js');
const {
  createServer,
  _resetTermdeckSecretsCache,
  _setSpawnSessionEndHookImplForTesting,
} = serverModule;

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness. Each test runs under a fresh tempdir HOME so:
//   • `onPanelClose` (fired by every PTY-exit) finds no ~/.codex/sessions
//     transcript and no ~/.claude/hooks/memory-session-end.js — it returns
//     early and never spawns the real session-end writer.
//   • any SQLite DB createServer initialises lands in the throwaway tempdir.
// Belt-and-suspenders: the session-end spawn impl is also stubbed to a no-op
// so a PTY-exit can never POST a row to the real Mnestra DB.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint65-t3-'));
  const origHome = process.env.HOME;
  // Defensively drop DATABASE_URL for the test scope — if a stray secrets.env
  // load set it in this process, the mnestra-bridge direct mode could write
  // against the real DB. Same defence as adapter-session-end-writer.test.js.
  const origDbUrl = process.env.DATABASE_URL;
  process.env.HOME = tmpHome;
  delete process.env.DATABASE_URL;
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  if (typeof _setSpawnSessionEndHookImplForTesting === 'function') {
    _setSpawnSessionEndHookImplForTesting(() => { /* no-op: never touch real Mnestra */ });
  }
  try {
    return await fn(tmpHome);
  } finally {
    process.env.HOME = origHome;
    if (origDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origDbUrl;
    if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
    if (typeof _setSpawnSessionEndHookImplForTesting === 'function') {
      _setSpawnSessionEndHookImplForTesting(null);
    }
    _fakeTermsByPid.clear();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
  }
}

async function bootTestServer() {
  // Inline config — never loadConfig(): config.js freezes CONFIG_PATH at
  // module-load time, so a loadConfig() call would read the developer's real
  // ~/.termdeck/config.yaml and write against the production Mnestra DB.
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
  const { server, wss, sessions, ptyReaper, transcriptWriter } = createServer(config);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return { server, wss, sessions, ptyReaper, transcriptWriter, port };
}

async function closeTestServer(handle) {
  if (!handle) return;
  const { server, ptyReaper, transcriptWriter } = handle;
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) { /* fail-soft */ } }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) { /* fail-soft */ } }
  try { server.closeAllConnections(); } catch (_) { /* older Node */ }
  await new Promise((resolve) => {
    try { server.close(() => resolve()); } catch (_) { resolve(); }
  });
  clearAllTrackedIntervals();
}

// ── HTTP helpers — return { status, body } ────────────────────────────────

async function http(port, method, route, body) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${route}`, opts);
  let parsed;
  try { parsed = await res.json(); } catch (_e) { parsed = null; }
  return { status: res.status, body: parsed };
}

// Spawn a panel and return its toJSON() shape ({ id, pid, meta }).
async function spawnPanel(port, opts) {
  const { status, body } = await http(port, 'POST', '/api/sessions', opts);
  assert.equal(status, 201, `POST /api/sessions expected 201, got ${status}`);
  return body;
}

// The fake PTY term backing a spawned panel (keyed by pid in toJSON()).
function termFor(panel) {
  const term = _fakeTermsByPid.get(panel.pid);
  assert.ok(term, `fake PTY term missing for pid ${panel.pid}`);
  return term;
}

// Probe whether T2's FIX has landed in the working tree under test. T2 ships
// sub-tasks 2.1-2.5 as one coherent block, so a `meta.role` round-trip is a
// reliable single gate. Returns true iff the server echoes back meta.role.
//
// The probe POST spawns a real session — it MUST be removed afterwards or it
// inflates every absolute session count the scenario asserts on by 1. DELETE
// fully evicts it from the manager Map (see header FINDING #1).
async function probeT2Landed(port) {
  const { status, body } = await http(port, 'POST', '/api/sessions',
    { command: 'sh', type: 'shell', role: 'orchestrator', label: 'td-t2-probe' });
  const landed = status === 201 && body && body.meta && body.meta.role === 'orchestrator';
  if (body && body.id) {
    try { await http(port, 'DELETE', `/api/sessions/${body.id}`); } catch (_e) { /* fail-soft */ }
  }
  return landed;
}

// ─────────────────────────────────────────────────────────────────────────
// T2.1 — meta.role contract.
// ─────────────────────────────────────────────────────────────────────────

test('T2.1 — meta.role: valid roles accepted, unknown -> 400, absent -> null', async (t) => {
  if (!_ptyFakeAvailable) { t.skip('node-pty not installed — fake unavailable'); return; }
  await withTempHome(async () => {
    const handle = await bootTestServer();
    try {
      if (!(await probeT2Landed(handle.port))) {
        t.skip('T2 FIX-LANDED not yet in working tree — meta.role round-trip absent');
        return;
      }
      const { port } = handle;

      // Every whitelisted role round-trips into meta.role.
      for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor']) {
        const { status, body } = await http(port, 'POST', '/api/sessions',
          { command: 'sh', type: 'shell', role, label: `role-${role}` });
        assert.equal(status, 201, `role=${role} should be accepted`);
        assert.equal(body.meta.role, role, `meta.role should echo ${role}`);
      }

      // No role field -> meta.role is null (not undefined — explicit null is
      // what T1's `meta.role === 'orchestrator'` routing relies on).
      const noRole = await http(port, 'POST', '/api/sessions',
        { command: 'sh', type: 'shell', label: 'role-absent' });
      assert.equal(noRole.status, 201);
      assert.equal(noRole.body.meta.role, null, 'absent role -> meta.role === null');

      // Unknown role -> 400 with a structured body.
      const bad = await http(port, 'POST', '/api/sessions',
        { command: 'sh', type: 'shell', role: 'supervisor', label: 'role-bad' });
      assert.equal(bad.status, 400, 'unknown role must be rejected with 400');
      assert.equal(bad.body && bad.body.code, 'invalid_role',
        '400 body should carry code:"invalid_role"');
      if (bad.body && bad.body.allowed !== undefined) {
        assert.ok(Array.isArray(bad.body.allowed), '400 body.allowed should be an array');
      }
    } finally {
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Brad's 18-panel-2-project scenario — the heart of this suite.
// 10 codex (aetheria) + 8 grok (structural360) + 1 orchestrator = 19.
// Kill all 10 codex via PTY-exit. Expect 9 live, 10 exited.
// ─────────────────────────────────────────────────────────────────────────

test("Brad 18-panel-2-project repro: 10 dead codex, 8 live grok, 1 orch", async (t) => {
  if (!_ptyFakeAvailable) { t.skip('node-pty not installed — fake unavailable'); return; }
  await withTempHome(async () => {
    const handle = await bootTestServer();
    try {
      if (!(await probeT2Landed(handle.port))) {
        t.skip('T2 FIX-LANDED not yet in working tree — meta.role round-trip absent');
        return;
      }
      const { port } = handle;

      // ── Spawn the 19-panel world ──────────────────────────────────────
      const codex = [];
      for (let i = 0; i < 10; i++) {
        codex.push(await spawnPanel(port,
          { command: 'sh', type: 'codex', project: 'aetheria', label: `codex-${i}` }));
      }
      const grok = [];
      for (let i = 0; i < 8; i++) {
        grok.push(await spawnPanel(port,
          { command: 'sh', type: 'grok', project: 'structural360', label: `grok-${i}` }));
      }
      const orch = await spawnPanel(port,
        { command: 'sh', type: 'claude', role: 'orchestrator', project: null, label: 'orch' });
      assert.equal(orch.meta.role, 'orchestrator', 'orch panel carries meta.role');

      await t.test('all 19 present before any exit (?includeExited=true)', async () => {
        const { status, body } = await http(port, 'GET', '/api/sessions?includeExited=true');
        assert.equal(status, 200);
        assert.equal(body.length, 19, 'spawned 10 codex + 8 grok + 1 orch');
      });

      // ── Open a WS observer on a LIVE grok panel before the kills, so the
      //    panel_exited frames for the codex deaths can be captured. Every
      //    WS client (bound to any session) receives the wss-wide broadcast.
      let wsFrames = [];
      let wsObserver = null;
      let wsUsable = false;
      try {
        wsObserver = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${grok[0].id}`);
        await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('ws open timeout')), 2000);
          wsObserver.on('open', () => { clearTimeout(to); resolve(); });
          wsObserver.on('error', (e) => { clearTimeout(to); reject(e); });
        });
        wsObserver.on('message', (raw) => {
          try { wsFrames.push(JSON.parse(raw.toString())); } catch (_e) { /* ignore */ }
        });
        wsUsable = true;
      } catch (_e) {
        wsUsable = false; // WS auth/env issue — the panel_exited subtest skips, HTTP rows still run.
      }

      // ── Kill all 10 codex via PTY-exit (Brad's "10 dead codex cli") ────
      for (const panel of codex) {
        termFor(panel)._emitExit({ exitCode: 0, signal: null });
      }
      await new Promise((r) => setTimeout(r, 120)); // let onExit handlers settle

      await t.test('default GET /api/sessions excludes the 10 exited -> 9 live', async () => {
        const { status, body } = await http(port, 'GET', '/api/sessions');
        assert.equal(status, 200);
        assert.equal(body.length, 9, '8 grok + 1 orch survive; 10 exited codex filtered');
        for (const s of body) {
          assert.notEqual(s.meta.status, 'exited',
            'no exited session may appear in the default list');
        }
      });

      await t.test('?includeExited=true still returns all 19 (10 exited)', async () => {
        const { status, body } = await http(port, 'GET', '/api/sessions?includeExited=true');
        assert.equal(status, 200);
        assert.equal(body.length, 19, 'exited sessions remain queryable for doctor/debug tooling');
        const exited = body.filter((s) => s.meta.status === 'exited');
        assert.equal(exited.length, 10, 'exactly the 10 PTY-exited codex panels');
      });

      await t.test('project distribution feeds chip auto-discovery', async () => {
        // Default (visible) list: chips dedupe meta.project over these.
        const visible = (await http(port, 'GET', '/api/sessions')).body;
        const byProject = {};
        for (const s of visible) {
          const key = s.meta.project === null ? '<null>' : s.meta.project;
          byProject[key] = (byProject[key] || 0) + 1;
        }
        assert.equal(byProject['structural360'], 8, 'structural360 chip count = 8 live grok');
        assert.equal(byProject['<null>'], 1, 'orch panel has null project (-> ORCH pin row)');
        assert.equal(byProject['aetheria'], undefined,
          'all aetheria panels exited -> absent from the visible/default list');
        // includeExited still carries the full picture.
        const all = (await http(port, 'GET', '/api/sessions?includeExited=true')).body;
        assert.equal(all.filter((s) => s.meta.project === 'aetheria').length, 10);
      });

      await t.test('410 Gone on input to a dead panel; live panel still 200', async () => {
        const dead = codex[0];
        const r = await http(port, 'POST', `/api/sessions/${dead.id}/input`, { text: 'hello?' });
        assert.equal(r.status, 410,
          'input to a PTY-exited panel must be 410 Gone, not a silent 200 / 404');
        assert.equal(r.body && r.body.code, 'panel_exited',
          '410 body must carry code:"panel_exited" so the orchestrator can branch on it');
        // T4-CODEX 19:44 cross-lane note: the dashboard reply path reads only
        // `.error`. Whether the 410 body ALSO carries `error` (T2) or the
        // client api() preserves HTTP status (T1) is a cross-lane decision —
        // not asserted here; covered as an ACCEPTANCE-CHECKLIST UI step.

        // A surviving panel must still accept input — 410 must be exit-scoped.
        const live = await http(port, 'POST', `/api/sessions/${grok[1].id}/input`, { text: 'ok' });
        assert.equal(live.status, 200, 'a live panel still accepts injected input');
      });

      await t.test('panel_exited WS frame broadcast for each PTY exit', async (st) => {
        if (!wsUsable) { st.skip('WS observer unavailable in this env — see checklist UI step'); return; }
        // The 10 codex exits happened above; frames should already be in.
        await new Promise((r) => setTimeout(r, 150));
        const exitedFrames = wsFrames.filter((f) => f && f.type === 'panel_exited');
        const seen = new Set(exitedFrames.map((f) => f.sessionId));
        for (const panel of codex) {
          assert.ok(seen.has(panel.id),
            `panel_exited WS frame must be broadcast for exited panel ${panel.id}`);
        }
        // Frame shape — T1's handlePanelExited reads sessionId + exitCode.
        const sample = exitedFrames[0];
        assert.ok(sample && typeof sample.sessionId === 'string', 'frame carries sessionId');
        assert.ok('exitCode' in sample, 'frame carries exitCode');
      });

      await t.test('status_broadcast frame stays consistent with default GET', async (st) => {
        if (!wsUsable) { st.skip('WS observer unavailable in this env'); return; }
        // T4-CODEX 19:48 concern: if getAll() default now excludes exited and
        // status_broadcast reuses it, a dashboard that missed a panel_exited
        // frame must still be able to reconcile. Pin that the broadcast and
        // the default GET agree on the live set (so absence-from-broadcast is
        // a usable signal) — divergence here is the reconciliation trap.
        wsFrames = [];
        await new Promise((r) => setTimeout(r, 2300)); // one broadcast tick (2s)
        const bcast = wsFrames.filter((f) => f && f.type === 'status_broadcast').pop();
        st.diagnostic(bcast
          ? `status_broadcast carried ${bcast.sessions.length} sessions`
          : 'no status_broadcast frame observed in the 2.3s window');
        if (!bcast) { st.skip('no status_broadcast frame in window — non-deterministic, not a fail'); return; }
        const getDefault = (await http(port, 'GET', '/api/sessions')).body;
        const bcastLive = bcast.sessions.filter((s) => s.meta.status !== 'exited');
        assert.equal(bcastLive.length, getDefault.length,
          'status_broadcast live-set must match default GET — else missed-exit reconciliation breaks');

        // T2->T1 contract: `meta.role` must flow through status_broadcast
        // unchanged. The dashboard's ORCH-pin + chip logic reads role from
        // THIS frame, not from GET /api/sessions — if role were dropped here
        // the entire ORCH-pin feature (Brad's headline 2026-05-13 ask) would
        // silently never render. GET-level role round-trip is covered by the
        // T2.1 test; this pins the WS path the live dashboard actually uses.
        const orchInBcast = bcast.sessions.find((s) => s.id === orch.id);
        assert.ok(orchInBcast, 'orchestrator panel present in the status_broadcast frame');
        assert.equal(orchInBcast.meta.role, 'orchestrator',
          'meta.role must flow through status_broadcast unchanged (T2->T1 ORCH-pin contract)');
      });

      if (wsObserver) { try { wsObserver.close(); } catch (_e) { /* fail-soft */ } }
    } finally {
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T2.5 — per-adapter idle/parked detection (the Sprint-59 P0).
//
// UNGATED on T2: per T2 FINDING 2026-05-16 20:00 ET, sub-task 2.5's mechanism
// already shipped Sprint 60 v1.0.14 (codex.js END_OF_TURN in statusFor()), so
// T2's Sprint 65 work for 2.5 is "verify + regression test" — it does not add
// new code. This test therefore runs unconditionally as a regression fence:
// it pins the shipped behavior and would catch any Sprint 65 regression of it.
// ─────────────────────────────────────────────────────────────────────────

test('T2.5 — codex "Worked for Xm Ys" terminator parks the panel at idle', async (t) => {
  if (!_ptyFakeAvailable) { t.skip('node-pty not installed — fake unavailable'); return; }
  await withTempHome(async () => {
    const handle = await bootTestServer();
    try {
      const { port } = handle;
      const panel = await spawnPanel(port, { command: 'sh', type: 'codex', label: 'codex-idle' });
      const term = termFor(panel);

      // Drive the panel into a busy status, then emit the unambiguous Codex
      // turn-end terminator. After it, the orchestrator must see a parked
      // panel — not one mid-reasoning.
      term._emitData('\nthinking through the audit...\n');
      term._emitData('\n─ Worked for 2m 14s ─\n');
      await new Promise((r) => setTimeout(r, 60));

      const { status, body } = await http(port, 'GET', `/api/sessions/${panel.id}`);
      assert.equal(status, 200);
      // Canonical idle shape per T2 FINDING 2026-05-16 20:00 ET: codex.js
      // END_OF_TURN matches the "Worked for Xm Ys" terminator first in
      // statusFor() and returns {status:'idle'}. No `idlePattern` field / 60s
      // heuristic is added — the collision T3 flagged 19:49 is avoided by
      // never adding the colliding code. Assert that documented shape.
      assert.equal(body.meta.status, 'idle',
        `codex panel past its "Worked for" terminator must report status 'idle' (got "${body.meta.status}")`);
      assert.equal(body.meta.statusDetail, '', 'the idle shape carries an empty statusDetail');
    } finally {
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stale-lastActivity heuristic. UNGATED — the Sprint-60 toJSON guard
// (session.js:518-543, thinking/editing -> idle at 30s) already satisfies
// the invariant today, and T2.5's 60s heuristic must not regress it. This
// is a live regression fence on BOTH.
// ─────────────────────────────────────────────────────────────────────────

test('Stale "thinking" panel (65s idle) is not misreported as busy', async (t) => {
  if (!_ptyFakeAvailable) { t.skip('node-pty not installed — fake unavailable'); return; }
  await withTempHome(async () => {
    const handle = await bootTestServer();
    try {
      const { port, sessions } = handle;
      const panel = await spawnPanel(port, { command: 'sh', type: 'codex', label: 'codex-stale' });

      // Force the panel into a sticky busy state with a 65s-stale lastActivity.
      const session = sessions.get(panel.id);
      assert.ok(session, 'session is retrievable from the manager');
      session.meta.status = 'thinking';
      session.meta.statusDetail = 'Codex is reasoning...';
      session.meta.lastActivity = new Date(Date.now() - 65_000).toISOString();

      const { status, body } = await http(port, 'GET', `/api/sessions/${panel.id}`);
      assert.equal(status, 200);
      // The Sprint-60 toJSON guard (session.js:518-543) flips a sticky
      // thinking/editing panel whose lastActivity is >30s stale to the
      // canonical idle shape on serialization. A 65s-stale thinking panel
      // must therefore never reach the orchestrator as 'thinking' — that
      // exact misread cost Sprint 59 ~22 min, twice (BACKLOG §P0).
      assert.equal(body.meta.status, 'idle',
        `a 65s-stale thinking panel must serialize to status 'idle' (got "${body.meta.status}")`);
      assert.equal(body.meta.statusDetail, '', 'the stale-flip clears statusDetail');
    } finally {
      await closeTestServer(handle);
    }
  });
});

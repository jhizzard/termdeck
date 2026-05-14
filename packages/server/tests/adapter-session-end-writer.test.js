// Sprint 62 T1 — Adapter session-end Mnestra writer tests.
//
// Sprint 50 T1 shipped the wire-up (`onPanelClose` at packages/server/src/index.js:192)
// AND a test file at the repo-root tests/per-agent-hook-trigger.test.js covering
// Codex + Gemini positive cases and the four skip rules (claude-code, no
// adapter, no transcript, no hook). Those tests pass but live OUTSIDE the
// `npm test` glob (`packages/server/tests/**/*.test.js`), so they don't fence
// regressions in the npm-test surface.
//
// This file picks up the missing cases that Sprint 62 acceptance demands:
//   • Grok positive — constructs a real ~/.grok/grok.db via better-sqlite3
//     (server already has it as a top-level dep) and verifies onPanelClose
//     fires the hook with source_agent='grok' + a tempfile transcript_path.
//   • Stale-JSONL guard — JSONL with mtime older than session.meta.createdAt
//     must NOT trigger a spawn. This is the codex resolver's createdAt filter
//     verified end-to-end via onPanelClose, not just at the resolver layer.
//   • JSONL rotation — multiple JSONLs in the day-dir, only the post-createdAt
//     one with matching cwd wins; pre-createdAt JSONLs don't fire spurious rows.
//   • source_agent normalization — the hook's normalizeSourceAgent gates the
//     allowed set; assert the server passes the canonical adapter name.
//
// Strategy mirrors the root-level test file: HOME-override harness via
// mkdtempSync, dependency-inject the spawn impl with
// _setSpawnSessionEndHookImplForTesting, capture the call deterministically.
// No live network, no live PTY — just file fixtures + the writer's own logic.
//
// Run: node --test packages/server/tests/adapter-session-end-writer.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// Sprint 62 T4-CODEX FINAL-VERDICT RED unblock — instrument setInterval so
// the test process can drop intervals registered by createServer (notably
// the 2s status_broadcast loop at index.js:2294 whose handle is never
// stored anywhere we can clearInterval from outside). Without this the
// test process hangs after the last assert because the interval keeps the
// event loop alive past server.close().
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
// Sprint 62 T4-CODEX FINAL-VERDICT RED unblock — node-pty fake injected via
// require.cache BEFORE the server module is required. createServer's
// `pty.spawn(...)` call returns one of these fakes, so the route-level
// wiring test below can exercise term.onExit → onPanelClose without a
// real PTY (and without putting a `codex` binary on PATH).
//
// The unit tests further down don't trigger pty.spawn at all — they call
// onPanelClose directly — so the fake is dormant for them.
// ─────────────────────────────────────────────────────────────────────────

let _ptyFakeAvailable = false;
const _fakeTermsByPid = new Map();

(function injectFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) {
    // node-pty isn't installed — the route test will skip. The unit tests
    // never reach pty.spawn so they still run.
    return;
  }
  let nextPid = 99001;
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
          // Mirror real PTY behavior: kill() returns synchronously, onExit
          // fires async. Use setImmediate so the DELETE handler's
          // sessions.remove() runs first (parity with the production race
          // window the wire-up has to tolerate).
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); }
              catch (e) { /* fail-soft so one bad cb can't break others */ }
            }
          });
        },
        // Test-only: drive onExit synchronously without going through kill.
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

const codexAdapter = require('../src/agent-adapters/codex');
const grokAdapter = require('../src/agent-adapters/grok');
const serverModule = require('../src/index.js');
const {
  createServer,
  loadConfig,
  onPanelClose,
  _resetTermdeckSecretsCache,
  _setSpawnSessionEndHookImplForTesting,
} = serverModule;

let Database;
try { Database = require('better-sqlite3'); }
catch (_e) { Database = null; }

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness — same shape as tests/per-agent-hook-trigger.test.js
// so the two suites have identical semantics. Each test gets a fresh tempdir.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint62-t1-'));
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

function installFakeHook(home) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  fs.writeFileSync(hookPath, '// fake hook — spawn impl mocked in tests\n', 'utf8');
  return hookPath;
}

// Build a Codex rollout JSONL fixture with mtime targeted to a specific
// timestamp. First line is `session_meta` so the resolver can match cwd;
// trailing lines are message-shape content. Returns the absolute path.
function writeCodexRollout(home, { cwd, name, mtime, body = '' }) {
  const dt = new Date(mtime);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, name);
  const meta = JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n';
  fs.writeFileSync(file, meta + body);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

// Build a synthetic ~/.grok/grok.db that mirrors the schema documented in
// packages/server/src/agent-adapters/grok.js header (workspaces, sessions,
// messages with message_json blob). The grok adapter's resolveTranscriptPath
// extracts user/assistant rows and writes a JSON envelope to os.tmpdir().
// We construct a STRICT-table-shape DB compatible with better-sqlite3
// (≥3.37) — same engine the production adapter uses.
function writeGrokDb(home, { cwd, sessionCreatedAtMs, messages }) {
  if (!Database) throw new Error('better-sqlite3 unavailable — test should be skipped');
  const grokDir = path.join(home, '.grok');
  fs.mkdirSync(grokDir, { recursive: true });
  const dbPath = path.join(grokDir, 'grok.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE workspaces (
        id INTEGER PRIMARY KEY,
        canonical_path TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        session_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    db.prepare('INSERT INTO workspaces (id, canonical_path) VALUES (?, ?)').run(1, cwd);
    db.prepare('INSERT INTO sessions (id, workspace_id, created_at) VALUES (?, ?, ?)')
      .run(42, 1, new Date(sessionCreatedAtMs).toISOString());
    const insertMsg = db.prepare(
      'INSERT INTO messages (session_id, seq, role, message_json, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    let seq = 0;
    for (const m of messages) {
      insertMsg.run(42, seq++, m.role, JSON.stringify(m), new Date(sessionCreatedAtMs + seq).toISOString());
    }
  } finally {
    db.close();
  }
  return dbPath;
}

// ─────────────────────────────────────────────────────────────────────────
// Grok positive — the case the root-level test suite explicitly skipped
// (per its comment block: "Live SQLite extraction is exercised by the
// substrate-probe smoke test ... synthetic STRICT-schema DB inside a unit
// test would re-create grok's migration scaffolding, which is out of scope
// for this lane.")
//
// Sprint 62 acceptance #2 demands Grok parity with Codex/Gemini, so we
// pay the schema-construction cost here — better-sqlite3 is already a
// production dep and the schema is small.
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose invokes hook with sessionType=grok and source_agent=grok', { skip: !Database }, async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/grok-real-proj';
    const sessionCreatedAtMs = Date.now() - 60_000;
    writeGrokDb(home, {
      cwd,
      sessionCreatedAtMs,
      messages: [
        { role: 'user', content: 'audit canary 2026-05-08 grok-positive' },
        { role: 'assistant', content: [{ type: 'text', text: 'understood, proceeding with audit' }] },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'audit complete' },
      ],
    });
    const session = {
      id: 'td-grok-pos-1',
      meta: { type: 'grok', cwd, createdAt: new Date(sessionCreatedAtMs).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload, env) => {
      calls.push({ hookPath, payload, env });
    });
    let tempfileToCleanup;
    try {
      await onPanelClose(session);
      assert.equal(calls.length, 1, 'grok /exit must fire the hook exactly once');
      const { hookPath, payload } = calls[0];
      assert.equal(hookPath, path.join(home, '.claude', 'hooks', 'memory-session-end.js'));
      assert.equal(payload.cwd, cwd);
      assert.equal(payload.session_id, 'td-grok-pos-1');
      assert.equal(payload.sessionType, 'grok');
      assert.equal(payload.source_agent, 'grok',
        'source_agent must be set explicitly per adapter (not inferred or NULL)');
      // Tempfile invariants — the grok adapter writes the envelope to os.tmpdir()
      // because the bundled hook can't `require('better-sqlite3')` from
      // ~/.claude/hooks/.
      tempfileToCleanup = payload.transcript_path;
      assert.ok(typeof tempfileToCleanup === 'string' && tempfileToCleanup.length > 0,
        'transcript_path is set');
      assert.ok(tempfileToCleanup.startsWith(os.tmpdir()),
        'grok transcript_path must point under os.tmpdir() — ~/.grok/grok.db itself is not safe to hand the hook (no SQLite reachable from ~/.claude/hooks/)');
      assert.ok(fs.existsSync(tempfileToCleanup), 'tempfile envelope was actually written');
      const envelope = JSON.parse(fs.readFileSync(tempfileToCleanup, 'utf8'));
      assert.ok(Array.isArray(envelope), 'envelope is a JSON array (parseGrokJson preferred shape)');
      assert.ok(envelope.length >= 4, 'all message rows survived extraction');
      assert.equal(envelope[0].role, 'user');
      assert.equal(envelope[0].content, 'audit canary 2026-05-08 grok-positive');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      if (tempfileToCleanup) try { fs.unlinkSync(tempfileToCleanup); } catch (_) { /* fail-soft */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Stale-JSONL guard via onPanelClose. The codex resolver filters by
// `mtime >= createdAtMs`, but the test at the resolver layer doesn't exercise
// the end-to-end skip (per-agent-hook-trigger.test.js verifies the codex
// resolver in isolation; here we verify onPanelClose fences a stale-only
// directory).
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose skips when JSONL mtime predates session.createdAt (stale-JSONL guard)', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-stale-only';
    // Stale rollout — mtime is 1 hour ago. Resolver's `mtime >= createdAtMs`
    // filter must reject it because session.meta.createdAt is "now".
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    writeCodexRollout(home, { cwd, name: 'rollout-stale.jsonl', mtime: oneHourAgo });
    const session = {
      id: 'td-stale-1',
      meta: { type: 'codex', cwd, createdAt: new Date().toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 0,
      'a JSONL whose mtime predates session.createdAt is from a prior session — must not trigger a spawn');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// JSONL rotation — multiple rollouts in the day-dir for the same cwd.
// Resolver picks the newest mtime that satisfies the createdAt filter; the
// stale rollout MUST NOT cause a second spawn. This is the empirical
// shape of "a panel re-running codex" — Codex creates a fresh rollout each
// session, leaving the previous one on disk.
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose fires exactly once even when multiple rollouts share the cwd (JSONL rotation)', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-rotated';
    const now = Date.now();
    // Older rollout — same cwd, but mtime is 30 minutes ago. Counts as a
    // different prior session that left state on disk.
    writeCodexRollout(home, { cwd, name: 'rollout-prev.jsonl', mtime: now - 30 * 60 * 1000 });
    // Current rollout — mtime is now.
    const fresh = writeCodexRollout(home, { cwd, name: 'rollout-curr.jsonl', mtime: now });
    const session = {
      id: 'td-rotate-1',
      meta: { type: 'codex', cwd, createdAt: new Date(now - 5 * 60 * 1000).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => {
      calls.push({ hookPath, payload });
    });
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 1, 'exactly one spawn for one /exit, regardless of how many rollouts share the cwd');
    assert.equal(calls[0].payload.transcript_path, fresh,
      'newest-mtime rollout wins; the prior session\'s rollout must not be re-ingested');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// source_agent canonicalization — the server hands the hook the literal
// adapter name. The bundled hook's `normalizeSourceAgent` gates the allowed
// set ({claude, codex, gemini, grok, orchestrator}). Belt-and-suspenders:
// the server-side payload uses adapter.name verbatim, which must already
// be in the allow-list — proves the contract is satisfied at the writer
// boundary, not lazily at the parser boundary.
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose payload.source_agent is the canonical adapter.name', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-canon';
    const now = Date.now();
    writeCodexRollout(home, { cwd, name: 'rollout-canon.jsonl', mtime: now });
    const session = {
      id: 'td-canon-1',
      meta: { type: 'codex', cwd, createdAt: new Date(now - 60_000).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => calls.push({ payload }));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 1);
    // adapter.name is the canonical id ('codex'), distinct from sessionType
    // (also 'codex' in this case but in general they can diverge —
    // claude.sessionType === 'claude-code' but claude.name === 'claude').
    assert.equal(calls[0].payload.source_agent, codexAdapter.name);
    assert.ok(['claude', 'codex', 'gemini', 'grok', 'orchestrator'].includes(calls[0].payload.source_agent),
      'source_agent must be in the bundled hook\'s ALLOWED_SOURCE_AGENTS set');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Adapter lookup tolerance — onPanelClose looks up by `meta.type`, but the
// AGENT_ADAPTERS registry is keyed by adapter.name. Codex and gemini happen
// to have name === sessionType, but claude does not (name='claude',
// sessionType='claude-code'). The dual-lookup at index.js:195-196 must
// resolve correctly for non-self-keyed adapters too — verified via the
// claude-code skip test in the root suite, but we add a parallel positive
// here that exercises the second branch directly.
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose resolves adapter via sessionType when registry key differs from sessionType', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/grok-keyed';
    if (!Database) {
      // Without better-sqlite3 the resolver returns null; the call still
      // exercises the registry-lookup branch but can't observe a spawn.
      const session = {
        id: 'td-keyed-1',
        meta: { type: 'grok', cwd, createdAt: new Date().toISOString() },
      };
      const calls = [];
      _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
      try { await onPanelClose(session); }
      finally { _setSpawnSessionEndHookImplForTesting(null); }
      assert.equal(calls.length, 0,
        'no DB → resolver returns null → no spawn, but no throw either');
      return;
    }
    const sessionCreatedAtMs = Date.now() - 60_000;
    writeGrokDb(home, {
      cwd, sessionCreatedAtMs,
      messages: [
        { role: 'user', content: 'lookup-via-sessionType test' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'done' },
      ],
    });
    const session = {
      id: 'td-keyed-1',
      meta: { type: 'grok', cwd, createdAt: new Date(sessionCreatedAtMs).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => calls.push({ payload }));
    let tempfileToCleanup;
    try {
      await onPanelClose(session);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].payload.source_agent, 'grok',
        'grok adapter found via sessionType fallback at index.js:196');
      assert.equal(calls[0].payload.sessionType, grokAdapter.sessionType);
      tempfileToCleanup = calls[0].payload.transcript_path;
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      if (tempfileToCleanup) try { fs.unlinkSync(tempfileToCleanup); } catch (_) { /* fail-soft */ }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sprint 62 T4-CODEX FINAL-VERDICT RED unblock — production wiring fence.
//
// The unit tests above call `onPanelClose(session)` directly. T4-CODEX
// flagged that this proves the helper but NOT the production close
// pathway: `term.onExit({...exitCode...})` at index.js:1140 wires through
// to `onPanelClose(session)` at :1163 inside the lambda, and that
// registration happens INSIDE the closure of `spawnTerminalSession` —
// inaccessible without booting the server.
//
// These tests boot a real Express app via `createServer`, replace
// node-pty's `spawn` with a controllable fake (above), POST /api/sessions
// to drive the spawn flow that registers the onExit handler, then either
// (a) emit onExit directly via the fake or (b) hit DELETE /api/sessions/:id
// to force kill→onExit. Both paths must reach onPanelClose with the right
// session and produce a single hook spawn carrying source_agent='codex'.
// ─────────────────────────────────────────────────────────────────────────

async function bootTestServer(_home) {
  // CRITICAL: do NOT call loadConfig() — config.js freezes CONFIG_PATH at
  // module-load time via `path.join(os.homedir(), '.termdeck', 'config.yaml')`,
  // so even after withTempHome flips process.env.HOME the loader still reads
  // the developer's real ~/.termdeck/config.yaml. That polluted earlier test
  // attempts with real RAG writes against the production Mnestra DB.
  //
  // Build the minimal inline config that createServer needs, with every
  // optional side-effect disabled:
  //   - rag.enabled=false         → no [rag] writes
  //   - ptyReaper.enabled=false   → no 30s interval keeping the loop alive
  //   - transcripts.enabled=false → no Postgres connection (DATABASE_URL
  //                                  may already be set in this process from
  //                                  a stray secrets.env load — clear it
  //                                  defensively for the test scope).
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
  // Stop everything that holds the event loop open — mirrors the production
  // handleShutdown flow at index.js:2530-2547. Without ptyReaper.stop() the
  // 30s interval keeps the test process alive after server.close() resolves.
  if (ptyReaper) {
    try { ptyReaper.stop(); } catch (_) { /* fail-soft */ }
  }
  if (transcriptWriter) {
    try { await transcriptWriter.close(); } catch (_) { /* fail-soft */ }
  }
  // Node's fetch keep-alives + the WebSocketServer mounted on `server`
  // can both leave sockets open after server.close() is called. close()
  // refuses to resolve until every socket drops, so without
  // closeAllConnections() the test process hangs after the last assert.
  // Available since Node 18.2; TermDeck supports Node 20+ per CI matrix.
  try { server.closeAllConnections(); } catch (_) { /* older Node */ }
  await new Promise((resolve) => {
    try { server.close(() => resolve()); }
    catch (_) { resolve(); }
  });
  // Drop the 2s status_broadcast interval at index.js:2294 (and any other
  // unreferenced intervals createServer registers). The handle isn't stored
  // anywhere we can reach, so we tracked it via the setInterval wrapper at
  // the top of this file.
  clearAllTrackedIntervals();
}

test('term.onExit wiring fences onPanelClose for codex panels (production close path)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-route-fence';

    const handle = await bootTestServer(home);
    const { port } = handle;
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload, env) => {
      calls.push({ hookPath, payload, env });
    });
    try {
      // POST /api/sessions explicitly with type='codex' so spawnTerminalSession
      // sets meta.type='codex' (defaults to 'shell' otherwise — adapter
      // detection runs from PTY output, which the fake doesn't emit).
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'codex', cwd, type: 'codex', label: 'sprint62-fence' }),
      });
      assert.equal(createRes.status, 201, `POST /api/sessions returned ${createRes.status}`);
      const created = await createRes.json();
      assert.ok(created.id, 'response carries session id');
      assert.equal(created.meta.type, 'codex', 'meta.type is codex per request body');
      const term = _fakeTermsByPid.get(created.pid);
      assert.ok(term, 'fake pty.spawn returned a term and createServer captured the pid');

      // Write the rollout fixture AFTER the POST so the file's birthtime is
      // strictly later than session.meta.spawnTimestampMs (set at pty.spawn
      // time inside the POST handler). Sprint 64 T2 carve-out 2.1 tightened
      // the codex resolver to strict birthtime gate (no epsilon on
      // birthtime-capable platforms — APFS/ext4/NTFS); fixtures created
      // before POST are now correctly rejected as cross-panel-contamination
      // candidates. This positive test models the real-world ordering: codex
      // CLI forks → pty.spawn returns → codex initializes → codex creates
      // its rollout file (birthtime >= spawnTimestampMs).
      //
      // Use a fixed mtime in the FUTURE so the day-dir (computed from mtime)
      // is deterministic and matches today's UTC date regardless of when
      // the test runs in the day.
      const fixtureMtime = Date.now() + 60_000;
      writeCodexRollout(home, { cwd, name: 'rollout-route.jsonl', mtime: fixtureMtime });

      // Drive the onExit pathway directly — same call shape as a real
      // /exit-induced PTY exit. Production index.js:1140 wired this lambda
      // when spawnTerminalSession ran; firing _emitExit invokes that lambda
      // synchronously, which in turn calls onPanelClose(session).catch(...)
      // (line :1163). onPanelClose itself is async, so we wait briefly for it
      // to land.
      term._emitExit({ exitCode: 0, signal: null });
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(calls.length, 1,
        'production wiring at index.js:1163 must invoke onPanelClose exactly once per term.onExit fire');
      const { payload } = calls[0];
      assert.equal(payload.session_id, created.id);
      assert.equal(payload.cwd, cwd);
      assert.equal(payload.sessionType, 'codex');
      assert.equal(payload.source_agent, 'codex',
        'source_agent must be set explicitly per adapter — same invariant as the helper-level tests, now proven through the production close path');
      assert.equal(payload.transcript_path, path.join(home, '.codex', 'sessions',
        String(new Date(fixtureMtime).getUTCFullYear()),
        String(new Date(fixtureMtime).getUTCMonth() + 1).padStart(2, '0'),
        String(new Date(fixtureMtime).getUTCDate()).padStart(2, '0'),
        'rollout-route.jsonl'));
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

test('DELETE /api/sessions/:id drives kill→onExit→onPanelClose (route-level fence)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-route-delete';

    const handle = await bootTestServer(home);
    const { port } = handle;
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => calls.push({ payload }));
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'codex', cwd, type: 'codex' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();

      // Sprint 64 T2 (carve-out 2.1) — see the sibling test above for why
      // the rollout fixture is created AFTER the POST. Strict birthtime gate
      // requires file.birthtime >= session.spawnTimestampMs.
      const fixtureMtime = Date.now() + 60_000;
      writeCodexRollout(home, { cwd, name: 'rollout-delete.jsonl', mtime: fixtureMtime });

      // DELETE drives the production close path: session.pty.kill() at
      // index.js:1360 → fake.kill() → setImmediate(onExit) → onPanelClose.
      const delRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      assert.deepEqual(await delRes.json(), { ok: true });

      // setImmediate + onPanelClose's async resolution.
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(calls.length, 1,
        'DELETE route → pty.kill() → onExit → onPanelClose must fire exactly once');
      assert.equal(calls[0].payload.source_agent, 'codex');
      assert.equal(calls[0].payload.sessionType, 'codex');
      assert.equal(calls[0].payload.session_id, created.id);
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

test('term.onExit on a non-adapter session (shell) is a no-op (production wiring fence — negative case)', { skip: !_ptyFakeAvailable }, async () => {
  // Mirror of the helper-level "no adapter, no spawn" assertion, but driven
  // through the same production wiring as the positive test. Locks the
  // contract that the wiring inherits the helper's skip semantics — so
  // legitimate non-agent shell panels don't spuriously POST session_summary
  // rows from PTY exit.
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/shell-route';
    const handle = await bootTestServer(home);
    const { port } = handle;
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'shell', cwd, type: 'shell' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      const term = _fakeTermsByPid.get(created.pid);
      assert.ok(term);
      term._emitExit({ exitCode: 0, signal: null });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(calls.length, 0,
        'shell-typed sessions have no adapter in AGENT_ADAPTERS — onPanelClose returns early at index.js:197');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

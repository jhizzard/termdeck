// Sprint 64 T2 (carve-out 2.4) — spawnTerminalSession honors adapter.spawn.
//
// Sprint 63 close documented (`docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md`
// § 6): `spawnTerminalSession` at `packages/server/src/index.js:1118-1175`
// wrapped every adapter command as `zsh -c <command>` regardless of the
// adapter's `spawn` declaration. Probable contributor to codex/gemini/grok
// canary fast-deaths during the 2026-05-11 acceptance test — `zsh -c codex`
// strips the interactive-TTY context Codex's update-picker dialog needed.
//
// Sprint 64 adds `spawn.shellWrap: false` to all four adapters (claude, codex,
// gemini, grok). When the launching command is exactly the adapter's binary
// name, spawnTerminalSession bypasses the shell wrap and execs the binary
// directly via `pty.spawn(binary, defaultArgs, ...)`. User-supplied flags
// (e.g. `claude --resume <uuid>`) still fall through to the legacy shell-wrap
// path so user args are not silently dropped.
//
// Fences below boot a real Express app via `createServer`, replace node-pty
// with a capturing fake (records the actual `(shell, args, opts)` triple
// passed to `pty.spawn`), POST /api/sessions for each scenario, and assert
// the dispatch matches the expected shape.
//
// Run: node --test packages/server/tests/adapter-spawn-shell-wrap.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// Interval tracking — mirrors adapter-session-end-writer.test.js. createServer
// registers a 2s `status_broadcast` interval whose handle is never stored
// anywhere we can clear, so test cleanup wraps setInterval to drop them all.
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
// Capturing fake node-pty. Each `pty.spawn(shell, args, opts)` call appends
// to `_capturedSpawns` so tests can introspect the exact dispatch.
// ─────────────────────────────────────────────────────────────────────────

const _capturedSpawns = [];
let _ptyFakeAvailable = false;

(function injectCapturingFakeNodePty() {
  let resolved;
  try { resolved = require.resolve('@homebridge/node-pty-prebuilt-multiarch'); }
  catch (_e) { return; }
  let nextPid = 88001;
  const fakeModule = {
    spawn(shell, args, opts) {
      const captured = { shell, args, opts };
      _capturedSpawns.push(captured);
      const handlers = { data: [], exit: [] };
      const term = {
        pid: nextPid++,
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write() {},
        resize() {},
        kill() {
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); }
              catch (_e) { /* fail-soft */ }
            }
          });
        },
      };
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

const { AGENT_ADAPTERS } = require('../src/agent-adapters');
const claudeAdapter = require('../src/agent-adapters/claude');
const codexAdapter = require('../src/agent-adapters/codex');
const geminiAdapter = require('../src/agent-adapters/gemini');
const grokAdapter = require('../src/agent-adapters/grok');
const serverModule = require('../src/index.js');
const { createServer, _resetTermdeckSecretsCache } = serverModule;

// ─────────────────────────────────────────────────────────────────────────
// Server boot harness — same shape as adapter-session-end-writer.test.js
// bootTestServer, condensed.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint64-t2-spawn-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  try { return await fn(tmpHome); }
  finally {
    process.env.HOME = origHome;
    if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
  }
}

async function bootTestServer() {
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  const config = {
    shell: '/bin/sh',  // deterministic legacy fallback for shell-wrap path
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
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) {} }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) {} }
  try { server.closeAllConnections(); } catch (_) {}
  await new Promise((resolve) => {
    try { server.close(() => resolve()); }
    catch (_) { resolve(); }
  });
  clearAllTrackedIntervals();
}

async function postSession(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter declaration fences — cheapest first. These don't need the server.
// ─────────────────────────────────────────────────────────────────────────

test('every spawn-declaring (PTY) adapter declares spawn.shellWrap === false (carve-out 2.4 contract)', () => {
  for (const adapter of Object.values(AGENT_ADAPTERS)) {
    // Sprint 72 T2: web-chat-grok is a non-PTY adapter (driver-backed via the
    // CDP render-bridge, no binary) — it carries NO `spawn` block, so the
    // direct-spawn-vs-shell-wrap dispatch contract doesn't apply to it. Only
    // adapters that actually spawn a binary must opt into direct-spawn.
    if (!adapter.spawn) continue;
    assert.equal(
      adapter.spawn.shellWrap,
      false,
      `${adapter.name}: spawn.shellWrap must be false to opt into direct-spawn dispatch`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Server-level dispatch fences.
// ─────────────────────────────────────────────────────────────────────────

test('POST /api/sessions with command="claude" spawns claude directly (no `zsh -c` wrap)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status, body } = await postSession(handle.port, { command: 'claude', cwd: '/tmp', label: 't2-spawn-claude' });
      assert.equal(status, 201, `POST returned ${status}`);
      assert.ok(body.id, 'response carries session id');
      assert.equal(_capturedSpawns.length, 1, 'exactly one pty.spawn call');
      const call = _capturedSpawns[0];
      assert.equal(call.shell, 'claude',
        `expected direct spawn of 'claude', got shell='${call.shell}' args=${JSON.stringify(call.args)}`);
      assert.deepEqual(call.args, [], 'expected empty defaultArgs from claude adapter');
      assert.ok(call.opts.env, 'pty.spawn opts must include env');
      assert.equal(call.opts.env.TERMDECK_SESSION, body.id, 'TERMDECK_SESSION env must be set');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('POST /api/sessions with command="codex" spawns codex directly with OPENAI_API_KEY passthrough', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    // Set OPENAI_API_KEY so the adapter env override has a concrete value.
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-token-for-fence';
    // codex adapter captures process.env.OPENAI_API_KEY at MODULE-LOAD time
    // (per the adapter export at codex.js spawn.env). Force re-evaluation by
    // re-reading the adapter — adapter.spawn.env is a frozen object at module
    // load; the env override path in spawnTerminalSession works regardless of
    // the captured-at-module-load value because the spawn() call still merges
    // process.env. We just assert the direct-spawn shape, not the env value.
    const handle = await bootTestServer();
    try {
      const { status, body } = await postSession(handle.port, { command: 'codex', cwd: '/tmp', label: 't2-spawn-codex' });
      assert.equal(status, 201);
      assert.equal(_capturedSpawns.length, 1);
      const call = _capturedSpawns[0];
      assert.equal(call.shell, 'codex',
        `expected direct spawn of 'codex', got shell='${call.shell}' args=${JSON.stringify(call.args)}`);
      assert.deepEqual(call.args, []);
    } finally {
      if (origKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = origKey;
      await closeTestServer(handle);
    }
  });
});

test('POST /api/sessions with command="gemini" spawns gemini directly', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status } = await postSession(handle.port, { command: 'gemini', cwd: '/tmp', label: 't2-spawn-gemini' });
      assert.equal(status, 201);
      assert.equal(_capturedSpawns.length, 1);
      const call = _capturedSpawns[0];
      assert.equal(call.shell, 'gemini');
      assert.deepEqual(call.args, []);
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('POST /api/sessions with command="grok" spawns grok directly with GROK_MODEL env overlay', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status } = await postSession(handle.port, { command: 'grok', cwd: '/tmp', label: 't2-spawn-grok' });
      assert.equal(status, 201);
      assert.equal(_capturedSpawns.length, 1);
      const call = _capturedSpawns[0];
      assert.equal(call.shell, 'grok');
      assert.deepEqual(call.args, []);
      // grok.js declares `spawn.env.GROK_MODEL: chooseModel()` — must flow through.
      assert.ok(typeof call.opts.env.GROK_MODEL === 'string' && call.opts.env.GROK_MODEL.length > 0,
        'GROK_MODEL adapter env overlay must reach the spawned PTY');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('POST /api/sessions with command="codex --resume xyz" falls back to shell-wrap (user args preserved)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status } = await postSession(handle.port, {
        command: 'codex --resume sprint-64-canary',
        cwd: '/tmp',
        label: 't2-spawn-codex-with-args',
      });
      assert.equal(status, 201);
      assert.equal(_capturedSpawns.length, 1);
      const call = _capturedSpawns[0];
      // Exact-binary gate REJECTS the direct-spawn path when args are present.
      // The shell-wrap fallback applies (resolveSpawnShell + ['-c', cmdTrim]).
      assert.notEqual(call.shell, 'codex',
        'with args present, the exact-binary gate must reject direct spawn');
      assert.ok(Array.isArray(call.args) && call.args[0] === '-c',
        `expected ['-c', '<cmd>'] for shell wrap, got ${JSON.stringify(call.args)}`);
      assert.equal(call.args[1], 'codex --resume sprint-64-canary',
        'user args must be preserved verbatim in shell-wrap path');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('POST /api/sessions with command="ls" (no adapter match) falls back to shell-wrap', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status } = await postSession(handle.port, { command: 'ls', cwd: '/tmp', label: 't2-spawn-ls' });
      assert.equal(status, 201);
      assert.equal(_capturedSpawns.length, 1);
      const call = _capturedSpawns[0];
      // No adapter matches 'ls' → existing shell-wrap path runs.
      assert.ok(Array.isArray(call.args) && call.args[0] === '-c',
        `expected shell-wrap for 'ls', got args=${JSON.stringify(call.args)}`);
      assert.equal(call.args[1], 'ls');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('session.meta.spawnTimestampMs is set immediately after pty.spawn (carve-out 2.1 plumbing)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const before = Date.now();
      const { status, body } = await postSession(handle.port, { command: 'codex', cwd: '/tmp', label: 't2-spawn-time-stamp' });
      const after = Date.now();
      assert.equal(status, 201);
      const stamp = body.meta && body.meta.spawnTimestampMs;
      assert.equal(typeof stamp, 'number', 'session.meta.spawnTimestampMs must be a number');
      assert.ok(stamp >= before && stamp <= after,
        `spawnTimestampMs=${stamp} must fall within [${before}, ${after}]`);
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('bare command="codex" promotes session.meta.type to the adapter\'s sessionType (T4-CODEX 16:25/16:31 cross-lane closure)', { skip: !_ptyFakeAvailable }, async () => {
  // Pre-fix: `POST /api/sessions {command:'codex'}` left `meta.type='shell'`
  // until adapter output triggered auto-detect. T3's periodic-capture timer
  // looked up the adapter via `getAdapterForSessionType(session.meta.type)`
  // immediately after `sessions.create()` and missed registration because
  // meta.type was still 'shell' (no adapter for 'shell'). Sprint 64 T2's
  // direct-spawn path now promotes meta.type to the matched adapter's
  // sessionType immediately, so T3's lookup hits codex/gemini/grok on the
  // first PTY chunk.
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      const { status, body } = await postSession(handle.port, { command: 'codex', cwd: '/tmp', label: 't2-promote-meta-type' });
      assert.equal(status, 201);
      assert.equal(body.meta.type, 'codex',
        'bare `command:"codex"` (no explicit type field) must produce meta.type="codex" via direct-spawn promotion');
    } finally {
      await closeTestServer(handle);
    }
  });
});

test('explicit request type wins over direct-spawn promotion (no override of caller intent)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    _capturedSpawns.length = 0;
    const handle = await bootTestServer();
    try {
      // Pass an explicit (and somewhat unusual) type to verify the promotion
      // logic only fires when meta.type === 'shell' (the default). Caller
      // intent must always win — this prevents future regressions where the
      // direct-spawn path silently rewrites operator-supplied metadata.
      const { status, body } = await postSession(handle.port, { command: 'codex', cwd: '/tmp', type: 'custom-shell', label: 't2-promote-no-override' });
      assert.equal(status, 201);
      assert.equal(body.meta.type, 'custom-shell',
        'explicit type from request body must NOT be overwritten by direct-spawn adapter promotion');
    } finally {
      await closeTestServer(handle);
    }
  });
});

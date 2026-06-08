// Sprint 70 T1 — Antigravity in-flight stdout capture, end-to-end.
//
// The brief's definition of done for T1: "an agy panel, on close, produces
// exactly ONE Mnestra row tagged source_agent='antigravity' — not zero, not
// two, not claude." agy has no on-disk transcript, so this fences the novel
// path: POST command='agy' → direct-spawn promotes meta.type='antigravity' AND
// inits session._stdoutCapture → PTY data is tee'd into the buffer → term.onExit
// → onPanelClose → agy.resolveTranscriptPath materializes the buffer into a
// tmpdir Gemini-envelope tempfile → the SessionEnd hook fires once with
// source_agent='antigravity' + sessionType='antigravity' + that tempfile.
//
// Harness mirrors adapter-session-end-writer.test.js: a fake node-pty injected
// via require.cache (exposes _emitData/_emitExit), HOME-override tempdir, and
// the dependency-injected SessionEnd hook spawn so the payload is captured
// deterministically — no live PTY, no live network, no `agy` binary on PATH.
//
// Run: node --test packages/server/tests/adapter-agy-capture.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────
// Interval tracking — createServer registers a 2s status_broadcast interval
// whose handle we can't otherwise clear; drop them all at teardown.
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
// Fake node-pty with _emitData/_emitExit, injected BEFORE the server module.
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
        onData(cb) { handlers.data.push(cb); },
        onExit(cb) { handlers.exit.push(cb); },
        write() {},
        resize() {},
        kill() {
          setImmediate(() => {
            for (const cb of handlers.exit) {
              try { cb({ exitCode: 0, signal: null }); } catch (_e) { /* fail-soft */ }
            }
          });
        },
        _emitData(data) { for (const cb of handlers.data) cb(data); },
        _emitExit(payload) { for (const cb of handlers.exit) cb(payload || { exitCode: 0, signal: null }); },
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
  createServer,
  _resetTermdeckSecretsCache,
  _setSpawnSessionEndHookImplForTesting,
  _resolveStdoutCaptureSpawn,
} = serverModule;

// ─────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint70-t1-agy-'));
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

function installFakeHook(home) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  fs.writeFileSync(hookPath, '// fake hook — spawn impl mocked in tests\n', 'utf8');
  return hookPath;
}

async function bootTestServer() {
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  const config = {
    shell: '/bin/sh',
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
  return { server, port: server.address().port, ptyReaper, transcriptWriter };
}

async function closeTestServer({ server, ptyReaper, transcriptWriter }) {
  if (ptyReaper) { try { ptyReaper.stop(); } catch (_) {} }
  if (transcriptWriter) { try { await transcriptWriter.close(); } catch (_) {} }
  try { server.closeAllConnections(); } catch (_) {}
  await new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
  clearAllTrackedIntervals();
}

async function postSession(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// A synthetic agy TUI chunk: SGR truecolor, alt-screen toggles, a box rule, a
// Braille spinner overdraw, a `>`-prompt user turn, and a multi-line assistant
// reply — the shapes the real 2026-06-07 capture exhibited.
const FAKE_AGY_TUI =
  '\x1b[?1049h\x1b[2J\x1b[H' +
  '\x1b[48;2;66;133;244m Antigravity CLI 1.0.6 \x1b[m\r\n' +
  '────────────────────────────\r\n' +
  '⠾ thinking\r⢷ thinking\r\x1b[?1049l\r\n' +
  '> explain the capture design\r\n' +
  '\x1b[38;2;120;200;120mThe adapter tees PTY stdout into a ring buffer.\x1b[m\r\n' +
  'On close it writes a Gemini-shaped envelope to a tempfile.\r\n' +
  'The bundled hook ingests that envelope as one antigravity row.\r\n';

// ─────────────────────────────────────────────────────────────────────────
// The proof.
// ─────────────────────────────────────────────────────────────────────────

test('bare command="agy" promotes meta.type and inits the stdout capture buffer', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    try {
      const { status, body } = await postSession(handle.port, { command: 'agy', cwd: '/tmp/agy-1', label: 'agy-promote' });
      assert.equal(status, 201);
      assert.equal(body.meta.type, 'antigravity',
        'bare command:"agy" must promote meta.type to antigravity via direct-spawn');
    } finally {
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

// NOTE: this fences the SERVER side — onPanelClose fires the SessionEnd hook
// exactly once with the antigravity payload + a captured-from-stdout tempfile
// envelope. The actual memory_items ROW insertion (the hook running
// processStdinPayload end-to-end, past the byte-gate, to a mocked Supabase POST)
// is proven separately in tests/agy-hook-insert-path.test.js. Keeping the two
// concerns in separate suites is deliberate: this one has no business mocking
// OpenAI/Supabase, and that one has no business booting a PTY.
test('agy panel close fires the SessionEnd hook exactly once with the antigravity payload + stdout-captured tempfile envelope', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/tmp/agy-capture-proof';
    const handle = await bootTestServer();
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload, env) => calls.push({ hookPath, payload, env }));
    let tmpfile;
    try {
      const { status, body } = await postSession(handle.port, { command: 'agy', cwd, label: 'agy-proof' });
      assert.equal(status, 201);
      const term = _fakeTermsByPid.get(body.pid);
      assert.ok(term, 'fake pty.spawn returned a term and the server captured the pid');

      // Drive the in-flight PTY stream (split across two chunks to prove the
      // tee accumulates, not overwrites).
      term._emitData(FAKE_AGY_TUI.slice(0, 120));
      term._emitData(FAKE_AGY_TUI.slice(120));

      // Close the panel → onExit → onPanelClose (async).
      term._emitExit({ exitCode: 0, signal: null });
      await new Promise((r) => setTimeout(r, 60));

      assert.equal(calls.length, 1, 'exactly one hook spawn per agy /exit — not zero, not two');
      const { hookPath, payload } = calls[0];
      assert.equal(hookPath, path.join(home, '.claude', 'hooks', 'memory-session-end.js'));
      assert.equal(payload.cwd, cwd);
      assert.equal(payload.session_id, body.id);
      assert.equal(payload.sessionType, 'antigravity');
      assert.equal(payload.source_agent, 'antigravity',
        'source_agent is the canonical antigravity — NOT claude, NOT agy');

      // Tempfile invariants: under os.tmpdir(), real file, Gemini-envelope shape
      // carrying the ANSI-stripped conversation captured from stdout.
      tmpfile = payload.transcript_path;
      assert.ok(typeof tmpfile === 'string' && tmpfile.startsWith(os.tmpdir()),
        'transcript_path is a tmpdir tempfile (no on-disk agy transcript exists)');
      assert.ok(fs.existsSync(tmpfile), 'envelope tempfile written');
      const envelope = JSON.parse(fs.readFileSync(tmpfile, 'utf8'));
      assert.ok(Array.isArray(envelope.messages) && envelope.messages.length > 0,
        'Gemini-envelope {messages:[...]} the bundled hook parseAutoDetect ingests');
      const joined = envelope.messages.map((m) => m.content).join(' | ');
      assert.ok(joined.includes('explain the capture design'), 'user turn captured');
      assert.ok(joined.includes('tees PTY stdout into a ring buffer'), 'assistant turn captured');
      assert.ok(!/\x1b/.test(joined), 'ANSI escapes stripped from the captured transcript');
      assert.ok(!envelope.messages.some((m) => /^─+$/.test(m.content)), 'box-rule chrome dropped');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _fakeTermsByPid.clear();
      if (tmpfile) try { fs.unlinkSync(tmpfile); } catch (_) { /* fail-soft */ }
      await closeTestServer(handle);
    }
  });
});

test('agy panel that produced no output is a clean no-op on close (no spurious row)', { skip: !_ptyFakeAvailable }, async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const handle = await bootTestServer();
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try {
      const { status, body } = await postSession(handle.port, { command: 'agy', cwd: '/tmp/agy-empty', label: 'agy-empty' });
      assert.equal(status, 201);
      const term = _fakeTermsByPid.get(body.pid);
      assert.ok(term);
      // No _emitData — the panel never produced output.
      term._emitExit({ exitCode: 0, signal: null });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(calls.length, 0,
        'empty capture → resolveTranscriptPath returns null → onPanelClose no-ops (no zero-content row)');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _fakeTermsByPid.clear();
      await closeTestServer(handle);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// _resolveStdoutCaptureSpawn — the residual stdbuf buffering-defense (DI, so
// the assertion holds whether or not a stdbuf-family tool is on the test host).
// ─────────────────────────────────────────────────────────────────────────

test('_resolveStdoutCaptureSpawn wraps with stdbuf when available, falls back bare otherwise', () => {
  const cap = { mode: 'stdout', unbuffer: true };
  // Tool present → exec-in-place stdbuf wrap, binary becomes an arg.
  assert.deepEqual(_resolveStdoutCaptureSpawn('agy', [], cap, () => 'stdbuf'),
    { binary: 'stdbuf', args: ['-oL', '-eL', 'agy'] });
  assert.deepEqual(_resolveStdoutCaptureSpawn('agy', ['--print'], cap, () => 'gstdbuf'),
    { binary: 'gstdbuf', args: ['-oL', '-eL', 'agy', '--print'] });
  // No tool → graceful fallback to the bare binary (the PTY tee still captures).
  assert.deepEqual(_resolveStdoutCaptureSpawn('agy', [], cap, () => null),
    { binary: 'agy', args: [] });
  // Not opted in → never rewrites (non-capture adapters are untouched).
  assert.deepEqual(_resolveStdoutCaptureSpawn('claude', [], undefined, () => 'stdbuf'),
    { binary: 'claude', args: [] });
  assert.deepEqual(_resolveStdoutCaptureSpawn('agy', [], { mode: 'stdout' }, () => 'stdbuf'),
    { binary: 'agy', args: [] }, 'capture without unbuffer:true is not wrapped');
});

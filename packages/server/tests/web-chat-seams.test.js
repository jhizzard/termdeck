// Sprint 72 T2 — web-chat server-seam integration tests.
//
// Proves the lane's "Done when": a `web-chat` session creates (pty:null),
// accepts injected text via POST /api/sessions/:id/input (routed to the driver,
// NOT pty.write, with the 4+1 two-stage submit assembled server-side),
// broadcasts the driver's response as {type:'output'}, reports status
// (starting→idle→thinking→idle), and captures to Mnestra on close — all with a
// FAKE driver injected via _setWebChatDriverImplForTesting (no Chrome / CDP /
// network) and the SessionEnd + periodic hooks captured via DI.
//
// Harness mirrors adapter-agy-capture.test.js (temp HOME, DI hook capture,
// tracked intervals) but injects a fake DRIVER instead of a fake node-pty.
//
// Run: node --test packages/server/tests/web-chat-seams.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

// ── Interval tracking — clear createServer's 2s status_broadcast + any
//    periodic-capture timers at teardown. ─────────────────────────────────────
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

const serverModule = require('../src/index.js');
const {
  createServer,
  _resetTermdeckSecretsCache,
  _setSpawnSessionEndHookImplForTesting,
  _setSpawnPeriodicCaptureHookImplForTesting,
  _setWebChatDriverImplForTesting,
} = serverModule;

// ── Fake web-chat driver ─────────────────────────────────────────────────────
// Mirrors the REAL contract: cdp.attach({userDataDir,port}) → handle with
// handle.screencast(cb)/sendInput(evt)/onDisconnect(cb)/close(); grok.inject(
// handle,text) returns Promise<finalText> AND fires onComplete listeners (push
// + pull, exactly like T3's grok/index.js); grok.onComplete(handle,cb) →
// unsubscribe. handle.page present (Blocker-2 resolved per ORCH).
function makeFakeDriver(opts = {}) {
  const state = {
    attachCalls: 0, attachArgs: null, injects: [], sendInputs: [],
    completeListeners: [], frameCb: null, disconnectCb: null, closed: false,
    unsubscribed: 0,
  };
  const handle = {
    page: {}, cdpSession: {},
    screencast(cb) { state.frameCb = cb; },
    sendInput(evt) { state.sendInputs.push(evt); },
    onDisconnect(cb) { state.disconnectCb = cb; },
    close() { state.closed = true; },
    _emitFrame(frame) { if (state.frameCb) state.frameCb(frame); },
    _disconnect() { if (state.disconnectCb) state.disconnectCb(); },
  };
  const driver = {
    cdp: {
      async attach(args) {
        state.attachCalls += 1; state.attachArgs = args;
        if (opts.attachThrows) throw new Error('attach boom');
        return handle;
      },
    },
    grok: {
      inject(h, text) {
        state.injects.push({ handle: h, text });
        const reply = opts.replyFor ? opts.replyFor(text) : `REPLY:${text}`;
        state.lastReply = reply;
        // mimic T3 grok/index.js: push to onComplete listeners (unless the test
        // drives completion manually) AND resolve with the reply (pull model).
        if (!opts.manualComplete) {
          setImmediate(() => { for (const cb of state.completeListeners.slice()) { try { cb(reply); } catch (_) {} } });
        }
        return Promise.resolve(reply);
      },
      onComplete(h, cb) {
        state.completeListeners.push(cb);
        return () => { state.unsubscribed += 1; const i = state.completeListeners.indexOf(cb); if (i >= 0) state.completeListeners.splice(i, 1); };
      },
    },
    _state: state, _handle: handle,
  };
  // Drive a completion on demand (for asserting the transient 'thinking' window
  // before the reply lands — a real grok.com turn takes seconds, the fake is
  // instant). Fires every registered onComplete listener.
  state.fireComplete = (reply) => {
    const r = reply !== undefined ? reply : state.lastReply;
    for (const cb of state.completeListeners.slice()) { try { cb(r); } catch (_) {} }
  };
  return driver;
}

// ── Server harness ───────────────────────────────────────────────────────────
async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint72-t2-'));
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

function installFakeHook(home, name) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, name);
  fs.writeFileSync(hookPath, '// fake hook — spawn impl mocked in tests\n', 'utf8');
  return hookPath;
}

async function bootTestServer() {
  if (typeof _resetTermdeckSecretsCache === 'function') _resetTermdeckSecretsCache();
  const config = {
    shell: '/bin/sh', projects: {}, rag: { enabled: false },
    ptyReaper: { enabled: false }, transcripts: { enabled: false },
    sessionLogs: { enabled: false }, defaultTheme: 'tokyo-night',
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

const base = (port) => `http://127.0.0.1:${port}`;
async function postSession(port, body) {
  const res = await fetch(`${base(port)}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function getSession(port, id) {
  const res = await fetch(`${base(port)}/api/sessions/${id}`);
  return { status: res.status, body: await res.json() };
}
async function getBuffer(port, id) {
  const res = await fetch(`${base(port)}/api/sessions/${id}/buffer`);
  return { status: res.status, body: await res.json() };
}
async function postInput(port, id, text) {
  const res = await fetch(`${base(port)}/api/sessions/${id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  return { status: res.status, body: await res.json() };
}
async function del(port, id) {
  const res = await fetch(`${base(port)}/api/sessions/${id}`, { method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollStatus(port, id, expected, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const { body } = await getSession(port, id);
    last = body && body.meta && body.meta.status;
    if (last === expected) return last;
    await sleep(15);
  }
  return last;
}

const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

// ─────────────────────────────────────────────────────────────────────────────

test('web-chat session creates with pty:null, attaches the driver, flips starting→idle', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const driver = makeFakeDriver();
    _setWebChatDriverImplForTesting(() => driver);
    try {
      const { status, body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-create', label: 'grok-web' });
      assert.equal(status, 201);
      assert.equal(body.meta.type, 'web-chat');
      assert.equal(body.pid, null, 'web-chat panel has no PTY pid');

      const settled = await pollStatus(handle.port, body.id, 'idle');
      assert.equal(settled, 'idle', 'status flips to idle once the driver attaches');
      assert.equal(driver._state.attachCalls, 1, 'cdp.attach called exactly once');
      const aa = driver._state.attachArgs;
      assert.ok(aa && aa.userDataDir, 'attach got a dedicated userDataDir (posture: never the default profile)');
      assert.equal(aa.userDataDir, 'grok', 'first panel uses the canonical warm-login profile name');
      assert.equal(aa.port, 9333, 'first panel uses the base CDP port');
      assert.equal(aa.startUrl, 'https://grok.com',
        'attach navigates the dedicated-profile tab to grok.com (not T1 attach default about:blank)');
    } finally {
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('POST /input two-stage: paste body buffers, lone-\\r submits ONE inject with the full text; status thinking', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    // manualComplete so the transient 'thinking' window is observable (a real
    // grok turn takes seconds; the fake would otherwise complete sub-ms).
    const driver = makeFakeDriver({ manualComplete: true });
    _setWebChatDriverImplForTesting(() => driver);
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-inject', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');

      // Stage 1: bracketed-paste body, NO trailing CR ⇒ buffered, no inject yet.
      const s1 = await postInput(handle.port, body.id, `${PASTE_OPEN}is this claim true?${PASTE_CLOSE}`);
      assert.equal(s1.status, 200);
      assert.equal(s1.body.buffered, true);
      assert.equal(s1.body.submitted, false);
      assert.equal(driver._state.injects.length, 0, 'stage-1 paste must NOT fire inject');

      // buffer endpoint shows the pending text (orchestrator introspection).
      const buf = await getBuffer(handle.port, body.id);
      assert.equal(buf.status, 200, 'web-chat /buffer is not a 404');
      assert.ok(buf.body.inputBufferPreview.includes('is this claim true?'));

      // Stage 2: lone CR ⇒ submit. ONE inject with the assembled full text.
      const s2 = await postInput(handle.port, body.id, '\r');
      assert.equal(s2.status, 200);
      assert.equal(s2.body.submitted, true);
      assert.equal(driver._state.injects.length, 1, 'exactly one inject for the two-stage submit');
      assert.equal(driver._state.injects[0].text, 'is this claim true?',
        'markers stripped + body assembled; the lone CR is the submit, not content');

      // Status is thinking right after submit (orchestrator inject-verify) —
      // deterministic because the fake hasn't completed yet.
      const thinking = await getSession(handle.port, body.id);
      assert.equal(thinking.body.meta.status, 'thinking');

      // …and returns to idle once the driver completes (push via onComplete).
      driver._state.fireComplete();
      const settled = await pollStatus(handle.port, body.id, 'idle');
      assert.equal(settled, 'idle');
    } finally {
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('driver response is broadcast over WS as {type:\'output\'} (seam 3)', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const driver = makeFakeDriver({ replyFor: (t) => `the answer to "${t}" is 42` });
    _setWebChatDriverImplForTesting(() => driver);
    let ws;
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-ws', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');

      ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?session=${body.id}`);
      const outputs = [];
      const gotOutput = new Promise((resolve) => {
        ws.on('message', (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
          if (m.type === 'output') { outputs.push(m.data); resolve(m.data); }
        });
      });
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });

      await postInput(handle.port, body.id, `${PASTE_OPEN}what is the meaning${PASTE_CLOSE}`);
      await postInput(handle.port, body.id, '\r');

      const data = await Promise.race([gotOutput, sleep(800).then(() => null)]);
      assert.ok(data && data.includes('the answer to'),
        'the completed Grok response is broadcast to the panel WS as {type:output}');
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('WS {type:\'web-chat-input\'} forwards a raw CDP event to the driver (direct interaction)', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    const driver = makeFakeDriver();
    _setWebChatDriverImplForTesting(() => driver);
    let ws;
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-rawin', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');
      ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?session=${body.id}`);
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.send(JSON.stringify({ type: 'web-chat-input', event: { type: 'mousePressed', x: 5, y: 7 } }));
      // give the server a beat to route it
      for (let i = 0; i < 40 && driver._state.sendInputs.length === 0; i++) await sleep(15);
      assert.equal(driver._state.sendInputs.length, 1, 'raw CDP event forwarded to handle.sendInput');
      assert.equal(driver._state.sendInputs[0].type, 'mousePressed');
    } finally {
      if (ws) try { ws.close(); } catch (_) {}
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('close (DELETE) fires the SessionEnd hook ONCE with sessionType=web-chat, source_agent=grok, + a tempfile envelope of BOTH turns', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home, 'memory-session-end.js');
    const handle = await bootTestServer();
    const driver = makeFakeDriver({ replyFor: (t) => `assistant reply for: ${t}` });
    _setWebChatDriverImplForTesting(() => driver);
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => calls.push({ hookPath, payload }));
    let tmpfile;
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-close', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');

      await postInput(handle.port, body.id, `${PASTE_OPEN}capture this turn${PASTE_CLOSE}`);
      await postInput(handle.port, body.id, '\r');
      await pollStatus(handle.port, body.id, 'idle'); // wait for onComplete

      const d = await del(handle.port, body.id);
      assert.equal(d.status, 200);
      await sleep(60); // onPanelClose is fire-and-forget

      assert.equal(calls.length, 1, 'exactly one SessionEnd hook spawn per web-chat close');
      const { hookPath, payload } = calls[0];
      assert.equal(hookPath, path.join(home, '.claude', 'hooks', 'memory-session-end.js'));
      assert.equal(payload.sessionType, 'web-chat');
      assert.equal(payload.source_agent, 'grok', 'ORCH zero-touch provenance — grok, not grok-web, not claude');
      assert.equal(payload.session_id, body.id);

      tmpfile = payload.transcript_path;
      assert.ok(typeof tmpfile === 'string' && tmpfile.startsWith(os.tmpdir()),
        'transcript_path is a tmpdir tempfile (no on-disk web-chat transcript)');
      const envelope = JSON.parse(fs.readFileSync(tmpfile, 'utf8'));
      const joined = envelope.messages.map((m) => `${m.type}:${m.content}`).join(' | ');
      assert.ok(joined.includes('user:capture this turn'), 'the injected user turn is captured');
      assert.ok(joined.includes('assistant:assistant reply for: capture this turn'), 'the Grok reply is captured');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _setWebChatDriverImplForTesting(null);
      if (tmpfile) try { fs.unlinkSync(tmpfile); } catch (_) {}
      await closeTestServer(handle);
    }
  });
});

test('close is idempotent: a disconnect race + DELETE fire onPanelClose exactly once', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home, 'memory-session-end.js');
    const handle = await bootTestServer();
    const driver = makeFakeDriver();
    _setWebChatDriverImplForTesting(() => driver);
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-idem', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');
      await postInput(handle.port, body.id, `${PASTE_OPEN}one turn${PASTE_CLOSE}`);
      await postInput(handle.port, body.id, '\r');
      await pollStatus(handle.port, body.id, 'idle');

      // Simulate the driver disconnecting AND the user deleting at ~the same time.
      driver._handle._disconnect();
      await del(handle.port, body.id);
      await sleep(60);
      assert.equal(calls.length, 1, 'onPanelClose fires once despite disconnect + DELETE (idempotent guard)');
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('periodic-capture timer fires the pre-compact hook for a web-chat panel (sessionType=web-chat, mode=periodic_checkpoint)', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home, 'memory-pre-compact.js');
    installFakeHook(home, 'memory-session-end.js'); // pre-compact loads helpers from it
    const origInterval = process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
    process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = '80';
    const handle = await bootTestServer();
    // Big reply so the materialized envelope exceeds the 1KB growth throttle.
    const driver = makeFakeDriver({ replyFor: () => 'Z'.repeat(2048) });
    _setWebChatDriverImplForTesting(() => driver);
    const periodicCalls = [];
    _setSpawnPeriodicCaptureHookImplForTesting((hookPath, payload) => periodicCalls.push({ hookPath, payload }));
    try {
      const { body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-periodic', label: 'grok-web' });
      await pollStatus(handle.port, body.id, 'idle');
      await postInput(handle.port, body.id, `${PASTE_OPEN}grow the transcript${PASTE_CLOSE}`);
      await postInput(handle.port, body.id, '\r');
      await pollStatus(handle.port, body.id, 'idle');

      // Wait for at least one periodic tick (interval 80ms).
      for (let i = 0; i < 40 && periodicCalls.length === 0; i++) await sleep(30);
      assert.ok(periodicCalls.length >= 1, 'periodic-capture hook fired for the web-chat panel');
      assert.equal(periodicCalls[0].payload.sessionType, 'web-chat');
      assert.equal(periodicCalls[0].payload.mode, 'periodic_checkpoint');
      assert.equal(periodicCalls[0].payload.source_agent, 'grok');
    } finally {
      _setSpawnPeriodicCaptureHookImplForTesting(null);
      _setWebChatDriverImplForTesting(null);
      if (origInterval === undefined) delete process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
      else process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = origInterval;
      await closeTestServer(handle);
    }
  });
});

test('driver unavailable ⇒ web-chat panel degrades to errored, server stays up (PTY path + Sprint 71 unaffected)', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    _setWebChatDriverImplForTesting(() => null); // simulate driver not built yet
    try {
      const { status, body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-nodriver', label: 'grok-web' });
      assert.equal(status, 201, 'spawn still returns a session (never throws)');
      const st = await pollStatus(handle.port, body.id, 'errored');
      assert.equal(st, 'errored');
      assert.equal(body.pid, null);

      // The server is alive — a subsequent request succeeds (no crash).
      const list = await fetch(`${base(handle.port)}/api/sessions`);
      assert.equal(list.status, 200, 'server still serving after a driver-less web-chat spawn');
    } finally {
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

test('attach throwing ⇒ errored status, no crash', async () => {
  await withTempHome(async () => {
    const handle = await bootTestServer();
    _setWebChatDriverImplForTesting(() => makeFakeDriver({ attachThrows: true }));
    try {
      const { status, body } = await postSession(handle.port, { type: 'web-chat', cwd: '/tmp/wc-attachthrow', label: 'grok-web' });
      assert.equal(status, 201);
      const st = await pollStatus(handle.port, body.id, 'errored');
      assert.equal(st, 'errored');
    } finally {
      _setWebChatDriverImplForTesting(null);
      await closeTestServer(handle);
    }
  });
});

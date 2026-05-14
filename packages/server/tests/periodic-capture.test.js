// Sprint 64 T3.4 — periodic-capture fence tests.
//
// Closes Investigation 2 of docs/CRITICAL-READ-FIRST-2026-05-07.md for non-
// Claude panels. Codex/Gemini/Grok have no PreCompact-equivalent harness
// hook, so the server fires memory-pre-compact.js on a timer.
//
// Fenced assertions:
//   • Codex panel registers a periodic-capture timer at spawn time.
//   • Claude-Code panel does NOT register a timer (its PreCompact hook
//     handles compaction-near coverage).
//   • Throttle: a fire whose transcript hasn't grown >= 1 KB since the
//     last fire is suppressed.
//   • Post-exit fires are suppressed (close-out capture handles that path).
//   • Payload shape carries `mode: 'periodic_checkpoint'`, `sessionType`,
//     `source_agent`, plus the canonical fields onPanelClose already sets.
//
// Strategy mirrors adapter-session-end-writer.test.js (Sprint 62 T1) —
// dependency-inject the spawn impl via the test-only setter, capture the
// call deterministically, run no live PTY and no live network.
//
// Run: node --test packages/server/tests/periodic-capture.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Suppress the production status_broadcast interval so the test process can
// exit cleanly after the last assert. Same pattern as the Sprint 62 T1 suite.
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
  onPanelPeriodicCapture,
  _setSpawnPeriodicCaptureHookImplForTesting,
  _resolvePeriodicCaptureIntervalMs,
  _resetTermdeckSecretsCache,
} = serverModule;

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint64-t3-'));
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

function installFakePreCompactHook(home) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-pre-compact.js');
  fs.writeFileSync(hookPath, '// fake hook — spawn impl mocked in tests\n', 'utf8');
  return hookPath;
}

// Build a fixture session shape mirroring what spawnTerminalSession sets up.
// The fake adapter mounted via `session.meta.type` resolves through the
// existing AGENT_ADAPTERS registry — we use a real adapter that ships in the
// repo (codex) so resolveTranscriptPath has a working code path.
function makeFakeCodexSession(home, { transcriptPath, transcriptBytes }) {
  // Write a synthetic JSONL transcript Codex's resolveTranscriptPath would
  // find (cwd-scoped under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, 'x'.repeat(transcriptBytes), 'utf8');
  return {
    id: 'sess-codex-fixture',
    meta: {
      type: 'codex',
      cwd: '/tmp/fixture',
      project: 'termdeck',
      status: 'active',
      createdAt: Date.now() - 5000,
      spawnTimestampMs: Date.now() - 5000,
    },
    _periodicCapture: { lastSize: 0, lastFireMs: 0, timer: null },
  };
}

test('_resolvePeriodicCaptureIntervalMs honors the env override and defaults to 10 min', () => {
  const origVal = process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
  try {
    delete process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
    assert.equal(_resolvePeriodicCaptureIntervalMs(), 10 * 60 * 1000);
    process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = '0';
    assert.equal(_resolvePeriodicCaptureIntervalMs(), 0);
    process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = '250';
    assert.equal(_resolvePeriodicCaptureIntervalMs(), 250);
    process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = 'banana';
    assert.equal(_resolvePeriodicCaptureIntervalMs(), 10 * 60 * 1000);
  } finally {
    if (origVal === undefined) delete process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS;
    else process.env.TERMDECK_PERIODIC_CAPTURE_INTERVAL_MS = origVal;
  }
});

test('onPanelPeriodicCapture skips when meta.status === "exited"', async () => {
  await withTempHome(async (home) => {
    installFakePreCompactHook(home);
    const captures = [];
    _setSpawnPeriodicCaptureHookImplForTesting((hookPath, payload, env) => {
      captures.push({ hookPath, payload, env });
      return { unref() {} };
    });
    try {
      const session = makeFakeCodexSession(home, {
        transcriptPath: path.join(home, '.codex', 'sessions', '2026', '05', '14', 'rollout-x.jsonl'),
        transcriptBytes: 6 * 1024,
      });
      session.meta.status = 'exited';
      await onPanelPeriodicCapture(session);
      assert.equal(captures.length, 0, 'no spawn after exited');
    } finally {
      _setSpawnPeriodicCaptureHookImplForTesting(null);
    }
  });
});

test('onPanelPeriodicCapture skips Claude-Code panels (PreCompact hook handles that path)', async () => {
  await withTempHome(async (home) => {
    installFakePreCompactHook(home);
    const captures = [];
    _setSpawnPeriodicCaptureHookImplForTesting((hookPath, payload) => {
      captures.push(payload);
      return { unref() {} };
    });
    try {
      const session = {
        id: 'sess-claude-fixture',
        meta: {
          type: 'claude-code',
          cwd: '/tmp/fixture',
          status: 'active',
          createdAt: Date.now() - 5000,
          spawnTimestampMs: Date.now() - 5000,
        },
        _periodicCapture: { lastSize: 0, lastFireMs: 0, timer: null },
      };
      await onPanelPeriodicCapture(session);
      assert.equal(captures.length, 0, 'no spawn for claude-code');
    } finally {
      _setSpawnPeriodicCaptureHookImplForTesting(null);
    }
  });
});

test('onPanelPeriodicCapture throttle: < 1 KB growth between fires is suppressed', async () => {
  await withTempHome(async (home) => {
    installFakePreCompactHook(home);
    const captures = [];
    _setSpawnPeriodicCaptureHookImplForTesting((hookPath, payload) => {
      captures.push(payload);
      return { unref() {} };
    });
    try {
      const transcriptPath = path.join(home, '.codex', 'sessions', '2026', '05', '14', 'rollout-y.jsonl');
      // First fire: 6 KB transcript with a session_meta header so codex's
      // resolveTranscriptPath returns it. The codex adapter requires the
      // first line to be a session_meta record whose payload.cwd matches
      // session.meta.cwd.
      const cwd = '/tmp/fixture-cwd';
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n';
      fs.writeFileSync(transcriptPath, header + 'x'.repeat(6 * 1024), 'utf8');

      const session = {
        id: 'sess-throttle-fixture',
        meta: {
          type: 'codex',
          cwd,
          project: 'termdeck',
          status: 'active',
          createdAt: Date.now() - 60_000,
          spawnTimestampMs: Date.now() - 60_000,
        },
        _periodicCapture: { lastSize: 0, lastFireMs: 0, timer: null },
      };

      await onPanelPeriodicCapture(session);
      const firstCount = captures.length;
      // Second fire WITHOUT growing the file: throttle should suppress.
      await onPanelPeriodicCapture(session);
      assert.equal(captures.length, firstCount, 'throttle suppressed no-growth fire');

      // Now grow the file by 2 KB and fire again — should land.
      fs.appendFileSync(transcriptPath, 'y'.repeat(2 * 1024));
      await onPanelPeriodicCapture(session);
      assert.equal(captures.length, firstCount + 1, 'fire after >= 1 KB growth lands');
    } finally {
      _setSpawnPeriodicCaptureHookImplForTesting(null);
    }
  });
});

test('onPanelPeriodicCapture payload carries mode=periodic_checkpoint + source_agent', async () => {
  await withTempHome(async (home) => {
    installFakePreCompactHook(home);
    const captures = [];
    _setSpawnPeriodicCaptureHookImplForTesting((hookPath, payload) => {
      captures.push(payload);
      return { unref() {} };
    });
    try {
      const cwd = '/tmp/payload-fixture-cwd';
      const transcriptPath = path.join(home, '.codex', 'sessions', '2026', '05', '14', 'rollout-z.jsonl');
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n';
      fs.writeFileSync(transcriptPath, header + 'x'.repeat(6 * 1024), 'utf8');

      const session = {
        id: 'sess-payload-fixture',
        meta: {
          type: 'codex',
          cwd,
          project: 'termdeck',
          status: 'active',
          createdAt: Date.now() - 60_000,
          spawnTimestampMs: Date.now() - 60_000,
        },
        _periodicCapture: { lastSize: 0, lastFireMs: 0, timer: null },
      };

      await onPanelPeriodicCapture(session);
      assert.equal(captures.length, 1, 'fire produced exactly one spawn');
      const payload = captures[0];
      assert.equal(payload.mode, 'periodic_checkpoint');
      assert.equal(payload.session_id, 'sess-payload-fixture');
      assert.equal(payload.sessionType, 'codex');
      assert.equal(payload.source_agent, 'codex');
      assert.equal(payload.cwd, cwd);
      // Bookmark must be advanced to the post-fire size so a subsequent
      // unchanged tick gets throttled.
      assert.ok(
        session._periodicCapture.lastSize > 0,
        'lastSize bookmark advanced'
      );
    } finally {
      _setSpawnPeriodicCaptureHookImplForTesting(null);
    }
  });
});

test.after(() => {
  clearAllTrackedIntervals();
});

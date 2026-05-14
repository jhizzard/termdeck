// Sprint 64 T2 (carve-out 2.1) — codex resolveTranscriptPath spawn-time gate.
//
// Sprint 63 EXIT-CAPTURE-VERIFICATION.md Finding #1: a codex panel's
// `resolveTranscriptPath` returned a DIFFERENT codex panel's rollout file when
// the other panel was still actively writing. Pre-fix gate (`mtimeMs >=
// createdAtMs`) was insufficient: an active concurrent panel's mtime keeps
// updating, so mtime alone can't disambiguate which rollout belongs to which
// panel. The fix prefers FILE BIRTHTIME (creation stamp) over mtime, and
// gates against `session.meta.spawnTimestampMs` (set in spawnTerminalSession
// immediately after `pty.spawn`, strictly later than `createdAt`).
//
// Fences:
//   1. cross-panel contamination — Panel-A rollout created BEFORE Panel-B
//      spawn, with Panel-A's mtime bumped to AFTER Panel-B spawn (simulating
//      Panel-A still active). Birthtime-based gate must reject Panel-A;
//      `resolveTranscriptPath` must return null (Panel-B's own rollout never
//      existed — pre-fix behavior would return Panel-A by mtime sort).
//   2. own-rollout positive — Panel created, then its own rollout file lands
//      after spawn. Adapter must return that file.
//   3. createdAt-only back-compat — when `spawnTimestampMs` is absent (older
//      session reloaded from SQLite that pre-dates this field), fall back to
//      `createdAtMs` so existing behavior is preserved.
//
// Run: node --test packages/server/tests/codex-resolve-transcript-spawn-time.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codexAdapter = require('../src/agent-adapters/codex');

const _ORIG_HOME = process.env.HOME;

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-codex-spawn-gate-'));
}
function rmDirRecursive(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
}

function writeRollout(home, { name, cwd, when }) {
  const dt = new Date(when);
  const yyyy = String(dt.getUTCFullYear());
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
  fs.mkdirSync(dayDir, { recursive: true });
  const full = path.join(dayDir, name);
  const meta = JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n';
  fs.writeFileSync(full, meta + '{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}\n');
  return full;
}

test('codex.resolveTranscriptPath rejects pre-spawn rollouts even when their mtime is post-spawn (Finding #1 cross-contamination guard)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });

    // Panel-A's rollout: created NOW, in the day-dir for the cwd, with an
    // mtime BUMPED to the future (simulating an active concurrent panel
    // still writing turns). Birthtime is now (set by file system on create).
    const now = Date.now();
    const panelARollout = writeRollout(tmpHome, {
      name: 'rollout-2026-05-14T13-12-30-aaaa.jsonl',
      cwd,
      when: now,
    });
    // Bump Panel-A's mtime to 30 minutes in the future to simulate it still
    // being actively written by the other panel — this is the exact failure
    // mode the pre-fix mtime-only gate could not detect.
    const futureSec = (now + 30 * 60 * 1000) / 1000;
    fs.utimesSync(panelARollout, futureSec, futureSec);

    // Panel-B "spawned" 14 minutes after Panel-A — this is the real-world
    // Sprint 63 gap (Panel-A active since 13:12, Panel-B spawn at 13:26).
    // The 1s epsilon in the resolver swallows sub-second timing noise; a
    // multi-minute gap is well outside that window. Using a synthetic future
    // timestamp keeps the test fast (no real `await sleep`); the resolver
    // doesn't care whether spawnTimestampMs is past, present, or future —
    // only the comparison against rollout file timestamps matters.
    const panelBSpawnMs = now + 14 * 60 * 1000;
    const panelB = {
      meta: {
        cwd,
        createdAt: new Date(now - 10).toISOString(),
        spawnTimestampMs: panelBSpawnMs,
      },
    };

    const result = await codexAdapter.resolveTranscriptPath(panelB);
    assert.equal(
      result,
      null,
      `expected null (Panel-A's pre-spawn rollout must not be returned as Panel-B's), got ${result}`
    );
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('codex.resolveTranscriptPath returns own rollout file when created after spawnTimestampMs (positive case)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });

    const spawnMs = Date.now();
    // Wait 50ms so the rollout's birthtime is strictly after spawnTimestampMs.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const ownRollout = writeRollout(tmpHome, {
      name: 'rollout-2026-05-14T13-26-00-bbbb.jsonl',
      cwd,
      when: Date.now(),
    });

    const panel = {
      meta: {
        cwd,
        createdAt: new Date(spawnMs - 10).toISOString(),
        spawnTimestampMs: spawnMs,
      },
    };

    const result = await codexAdapter.resolveTranscriptPath(panel);
    assert.equal(result, ownRollout, 'expected adapter to return own rollout file');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('codex.resolveTranscriptPath falls back to createdAtMs when spawnTimestampMs is absent (back-compat for reloaded sessions)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });

    const createdMs = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Roll-out file lands after createdAt.
    const ownRollout = writeRollout(tmpHome, {
      name: 'rollout-2026-05-14T13-30-00-cccc.jsonl',
      cwd,
      when: Date.now(),
    });

    // Older sessions reloaded from SQLite that pre-date the Sprint 64
    // spawnTimestampMs field — `session.meta.spawnTimestampMs` is undefined.
    // Behavior must remain functional: falls back to createdAtMs gate.
    const panel = {
      meta: {
        cwd,
        createdAt: new Date(createdMs - 100).toISOString(),
        // no spawnTimestampMs — pre-Sprint-64 reloaded session
      },
    };

    const result = await codexAdapter.resolveTranscriptPath(panel);
    assert.equal(
      result,
      ownRollout,
      'expected adapter to still return the rollout file using createdAtMs fallback'
    );
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('codex.resolveTranscriptPath rejects rollouts with min(birthtime, mtime) before spawnTimestampMs - epsilon (deterministic gate)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });

    // Old rollout created NOW.
    const oldRollout = writeRollout(tmpHome, {
      name: 'rollout-2026-05-14T12-00-00-dddd.jsonl',
      cwd,
      when: Date.now(),
    });

    // Panel "spawned" 30 seconds AFTER the rollout was created. The 5-second
    // epsilon (see _CODEX_GATE_EPSILON_MS in codex.js) absorbs FS-quantization
    // and route-latency jitter; a 30-second gap is well past that window.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const spawnMs = Date.now() + 30_000; // 30s into the future

    const panel = {
      meta: {
        cwd,
        createdAt: new Date(spawnMs - 100).toISOString(),
        spawnTimestampMs: spawnMs,
      },
    };

    const result = await codexAdapter.resolveTranscriptPath(panel);
    assert.equal(
      result,
      null,
      `expected null (rollout pre-dates spawn by 30s, exceeds 5s epsilon), got ${result}`
    );
    // Sanity check the fixture file is intact (we didn't accidentally remove it).
    assert.ok(fs.existsSync(oldRollout), 'rollout fixture should still exist on disk');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

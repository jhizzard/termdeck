// BR-9 (Brad 2026-08-06) — claude resolveTranscriptPath spawn-time gate.
//
// Port of the Sprint 64 carve-out 2.1 codex fix (see
// codex-resolve-transcript-spawn-time.test.js, which this file mirrors).
// Brad's fleet finding: after rotating panels sharing one cwd, successors
// locked onto their predecessor's transcript — the pre-fix gate (`mtimeMs >=
// createdAtMs`) admitted the predecessor's still-warm .jsonl, which then
// out-mtimed the successor's fresh file, freezing contextK at the
// predecessor's 442–664K against a real 45–50K. The fix prefers FILE
// BIRTHTIME over mtime (min of the two) and gates against
// `session.meta.spawnTimestampMs`, falling back to `createdAt` for older
// sessions that pre-date the field.
//
// Fences:
//   1. cross-panel contamination — predecessor transcript created BEFORE this
//      panel's spawn, mtime bumped AFTER spawn (still being written). Must be
//      rejected; resolveTranscriptPath returns null (pre-fix returned it).
//   2. own-transcript positive — a file born after spawn is returned.
//   3. createdAt-only back-compat — no spawnTimestampMs ⇒ gate on createdAt,
//      preserving pre-field behavior.
//   4. max-mtime tiebreak preserved among admitted candidates.
//
// Run: node --test packages/server/tests/claude-resolve-transcript-spawn-time.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeAdapter = require('../src/agent-adapters/claude');

const _ORIG_HOME = process.env.HOME;

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-claude-spawn-gate-'));
}
function rmDirRecursive(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
}

// Write a transcript .jsonl into the encoded projects dir for `cwd`.
// Birthtime is "now" (set by the filesystem on create); tests simulate
// pre-spawn files by moving the session's spawn timestamp into the future.
function writeTranscript(home, cwd, name) {
  const dirHash = cwd.replace(/\//g, '-');
  const projectsDir = path.join(home, '.claude', 'projects', dirHash);
  fs.mkdirSync(projectsDir, { recursive: true });
  const full = path.join(projectsDir, name);
  fs.writeFileSync(full, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  return full;
}

function sessionFor(cwd, { createdAt, spawnTimestampMs } = {}) {
  const meta = { cwd };
  if (createdAt) meta.createdAt = createdAt;
  if (typeof spawnTimestampMs === 'number') meta.spawnTimestampMs = spawnTimestampMs;
  return { meta };
}

test('claude.resolveTranscriptPath rejects a pre-spawn transcript even when its mtime is post-spawn (BR-9 rotation contamination guard)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = '/fake/projects/termdeck';
    const now = Date.now();

    // Predecessor panel's transcript: born now, mtime bumped 30 min into the
    // future (still being written / touched while awaiting reap). This is the
    // exact shape the pre-fix mtime-only gate admitted.
    const predecessor = writeTranscript(tmpHome, cwd, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl');
    const futureSec = (now + 30 * 60 * 1000) / 1000;
    fs.utimesSync(predecessor, futureSec, futureSec);

    // Successor panel spawned 14 minutes from now — the file's birthtime
    // (now) predates spawn, so it must be rejected regardless of mtime.
    const session = sessionFor(cwd, {
      createdAt: new Date(now + 14 * 60 * 1000 - 500).toISOString(),
      spawnTimestampMs: now + 14 * 60 * 1000,
    });

    const resolved = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(resolved, null,
      'pre-spawn transcript must be rejected (pre-fix behavior returned it by mtime sort)');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('claude.resolveTranscriptPath returns the panel\'s own post-spawn transcript', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = '/fake/projects/termdeck';
    const now = Date.now();
    const session = sessionFor(cwd, {
      createdAt: new Date(now - 60 * 1000).toISOString(),
      spawnTimestampMs: now - 60 * 1000,
    });
    const own = writeTranscript(tmpHome, cwd, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl');

    const resolved = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(resolved, own, 'own post-spawn transcript must be admitted');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('claude.resolveTranscriptPath falls back to createdAt when spawnTimestampMs is absent (back-compat)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = '/fake/projects/termdeck';
    const now = Date.now();
    // Session created a minute ago, no spawnTimestampMs (older row reloaded
    // from SQLite). File born now (post-createdAt) must still resolve.
    const session = sessionFor(cwd, {
      createdAt: new Date(now - 60 * 1000).toISOString(),
    });
    const own = writeTranscript(tmpHome, cwd, 'cccccccc-1111-2222-3333-444444444444.jsonl');

    const resolved = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(resolved, own, 'createdAt-gated behavior must be preserved without spawnTimestampMs');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('claude.resolveTranscriptPath keeps the max-mtime tiebreak among admitted candidates', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = '/fake/projects/termdeck';
    const now = Date.now();
    const session = sessionFor(cwd, {
      createdAt: new Date(now - 60 * 1000).toISOString(),
      spawnTimestampMs: now - 60 * 1000,
    });
    const older = writeTranscript(tmpHome, cwd, 'dddddddd-1111-2222-3333-444444444444.jsonl');
    const newer = writeTranscript(tmpHome, cwd, 'eeeeeeee-1111-2222-3333-444444444444.jsonl');
    // Both post-spawn; bump `newer`'s mtime ahead so it must win the sort.
    const aheadSec = (now + 5 * 1000) / 1000;
    fs.utimesSync(newer, aheadSec, aheadSec);
    const behindSec = (now + 1 * 1000) / 1000;
    fs.utimesSync(older, behindSec, behindSec);

    const resolved = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(resolved, newer, 'max-mtime among admitted candidates must still win');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

// Sprint 63 T2 — fence test for Finding #2.
//
// Before Sprint 63: `packages/server/src/agent-adapters/gemini.js:86` rejected
// every gemini chat file whose extension wasn't `.json`. Gemini CLI quietly
// switched its persistence format to `.jsonl` at some point between
// 2026-05-02 and 2026-05-08 (per the substrate probe in T2 acceptance —
// docs/sprint-63-wave-2/EXIT-CAPTURE-VERIFICATION.md Finding #2). Result:
// every gemini panel that closed in TermDeck produced ZERO Mnestra rows for
// the affected window — pure silent data loss.
//
// Sprint 63 T2 lands the adapter-level filter relaxation (one-line change,
// scoped per ORCH SCOPE 13:51 ET). This fence test pins the new behavior:
//
//   1. .jsonl positive       — a freshly created session-*.jsonl is found
//   2. .json positive (regression) — the legacy single-object format still works
//   3. createdAt filter       — old files (mtime < session.meta.createdAt) skipped
//   4. session- prefix gate   — files without the session- prefix ignored
//   5. fallback-walk          — if basename(cwd) dir is empty, walk other proj dirs
//
// Harness: HOME-override via mkdtempSync, no live network, no live PTY.
// Adapter is purely filesystem-driven; we only need a synthetic ~/.gemini.
// Downstream JSONL parser handling (parseGeminiJson does single-object
// JSON.parse over the whole file, which fails on JSONL) is a Sprint 64
// candidate — this fence intentionally asserts only the adapter contract.
//
// Run: node --test packages/server/tests/gemini-resolve-transcript-extension.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const geminiAdapter = require('../src/agent-adapters/gemini');

// Snapshot HOME once; restore after each test (Node test isolation isn't
// per-test by default for env vars).
const _ORIG_HOME = process.env.HOME;

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-gemini-fence-'));
}
function rmDirRecursive(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
}
function nowMinus(ms) {
  return new Date(Date.now() - ms).toISOString();
}

test('gemini.resolveTranscriptPath finds .jsonl session file (Finding #2 fix)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    // .jsonl file with mtime AFTER session.createdAt — should be the winner.
    const target = path.join(chatsDir, 'session-2026-05-11T17-27-dce3289b.jsonl');
    fs.writeFileSync(target, '{"sessionId":"x"}\n{"type":"user","content":[{"text":"hi"}]}\n', 'utf8');

    const session = {
      meta: { cwd, createdAt: nowMinus(60_000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, target, 'expected adapter to return the .jsonl file path');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('gemini.resolveTranscriptPath still finds .json session file (regression guard)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    const target = path.join(chatsDir, 'session-2026-05-02T18-06-337fb47e.json');
    fs.writeFileSync(target, JSON.stringify({ sessionId: 'legacy', messages: [] }), 'utf8');

    const session = {
      meta: { cwd, createdAt: nowMinus(60_000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, target, 'expected adapter to still return the legacy .json file path');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('gemini.resolveTranscriptPath picks newer .jsonl over older .json (mtime preference)', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    const oldFile = path.join(chatsDir, 'session-2026-05-02T18-06-337fb47e.json');
    const newFile = path.join(chatsDir, 'session-2026-05-11T17-27-dce3289b.jsonl');
    fs.writeFileSync(oldFile, '{"sessionId":"old","messages":[]}', 'utf8');
    fs.writeFileSync(newFile, '{"sessionId":"new"}\n', 'utf8');
    // Force the .json file's mtime far in the past so the .jsonl wins on mtime.
    // Both are still >= session.createdAt (we set createdAt 24h ago).
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(oldFile, oneHourAgo / 1000, oneHourAgo / 1000);

    const session = {
      meta: { cwd, createdAt: nowMinus(24 * 60 * 60 * 1000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, newFile, 'expected newer .jsonl to win over older .json');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('gemini.resolveTranscriptPath skips files with mtime < session.createdAt', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    const stale = path.join(chatsDir, 'session-stale.jsonl');
    fs.writeFileSync(stale, '{"sessionId":"stale"}\n', 'utf8');
    // Backdate the file to 1h before the session starts.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    fs.utimesSync(stale, oneHourAgo / 1000, oneHourAgo / 1000);

    const session = {
      // createdAt = 30s ago — much newer than the stale file's mtime
      meta: { cwd, createdAt: nowMinus(30_000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, null, 'expected pre-createdAt stale file to be skipped');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('gemini.resolveTranscriptPath ignores files without session- prefix', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    const chatsDir = path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });

    fs.writeFileSync(path.join(chatsDir, 'random-2026-05-11.jsonl'), '{}', 'utf8');
    fs.writeFileSync(path.join(chatsDir, 'notes.jsonl'), '{}', 'utf8');
    fs.writeFileSync(path.join(chatsDir, 'session.jsonl'), '{}', 'utf8'); // no dash after session

    const session = {
      meta: { cwd, createdAt: nowMinus(60_000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, null, 'expected no match — no file starts with session-');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

test('gemini.resolveTranscriptPath fallback-walks other project dirs when basename dir is empty', async () => {
  const tmpHome = makeTmpHome();
  process.env.HOME = tmpHome;
  try {
    const cwd = path.join(tmpHome, 'fake-projects', 'termdeck');
    fs.mkdirSync(cwd, { recursive: true });
    // Empty primary chats dir (Gemini renormalized project name, etc.)
    fs.mkdirSync(path.join(tmpHome, '.gemini', 'tmp', 'termdeck', 'chats'), { recursive: true });
    // Another project dir under tmp root that DOES have the canary file
    const otherChats = path.join(tmpHome, '.gemini', 'tmp', 'termdeck-renamed', 'chats');
    fs.mkdirSync(otherChats, { recursive: true });
    const fallback = path.join(otherChats, 'session-2026-05-11T17-27-fallback.jsonl');
    fs.writeFileSync(fallback, '{"sessionId":"fallback"}\n', 'utf8');

    const session = {
      meta: { cwd, createdAt: nowMinus(60_000) },
    };

    const result = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(result, fallback, 'expected fallback walk to find the .jsonl in another proj dir');
  } finally {
    process.env.HOME = _ORIG_HOME;
    rmDirRecursive(tmpHome);
  }
});

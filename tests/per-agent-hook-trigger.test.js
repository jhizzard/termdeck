// Sprint 50 T1 — Per-agent SessionEnd hook trigger tests.
//
// Two surfaces under test:
//   1. `onPanelClose(session)` exported from packages/server/src/index.js.
//      Routes through the adapter registry, skips claude-typed sessions
//      (Claude's own SessionEnd hook handles those), short-circuits when
//      the resolver returns null or the hook script isn't installed,
//      otherwise spawns `node ~/.claude/hooks/memory-session-end.js` with
//      a payload that includes `source_agent` (T2 consumes this column).
//   2. `resolveTranscriptPath(session)` — the new 10th adapter field for
//      claude, codex, gemini, grok. Locates the agent's chat-shape
//      transcript on disk given a session's cwd + createdAt.
//
// Strategy: for each test, point HOME at a fresh tempdir, lay down only
// the fixtures that test cares about, run the function, and assert.
// onPanelClose's spawn step is observed via the
// `_setSpawnSessionEndHookImplForTesting` injection — capturing the
// hookPath, payload, and env arguments directly. This avoids the
// `node:test` runner's race with detached + ignore-stdio children
// (verified — direct spawn with the same options doesn't even reach the
// hook script's first line under the test runner).
//
// Run: node --test tests/per-agent-hook-trigger.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeAdapter = require('../packages/server/src/agent-adapters/claude');
const codexAdapter = require('../packages/server/src/agent-adapters/codex');
const geminiAdapter = require('../packages/server/src/agent-adapters/gemini');
const grokAdapter = require('../packages/server/src/agent-adapters/grok');
const serverModule = require('../packages/server/src/index.js');
const {
  onPanelClose,
  _resetTermdeckSecretsCache,
  _setSpawnSessionEndHookImplForTesting,
} = serverModule;

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness. Each test gets a fresh tempdir; cleanup runs
// regardless of pass/fail. The cached secrets reader is also reset so the
// first call inside the test re-reads under the new HOME.
// ─────────────────────────────────────────────────────────────────────────

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint50-t1-'));
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

// Lay down a hook file at the path onPanelClose checks before spawning.
// Contents are a no-op — the spawn impl is mocked via
// _setSpawnSessionEndHookImplForTesting, so the script never executes.
// onPanelClose still gates on `fs.existsSync(hookPath)`, so this file
// has to exist for the spawn-impl to be invoked.
function installFakeHook(home) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  fs.writeFileSync(hookPath, '// fake hook — spawn impl is mocked\n', 'utf8');
  return hookPath;
}

// ─────────────────────────────────────────────────────────────────────────
// Adapter contract — every adapter exposes `resolveTranscriptPath` as a
// function. The 10th field. Sprint 50 T1 brief.
// ─────────────────────────────────────────────────────────────────────────

test('every adapter exposes resolveTranscriptPath as a function', () => {
  for (const adapter of [claudeAdapter, codexAdapter, geminiAdapter, grokAdapter]) {
    assert.equal(typeof adapter.resolveTranscriptPath, 'function',
      `${adapter.name}.resolveTranscriptPath should be a function`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Claude. Returns latest mtime .jsonl in
// ~/.claude/projects/<dir-hash>/ or null when missing.
// ─────────────────────────────────────────────────────────────────────────

test('claude.resolveTranscriptPath returns null when projects dir is missing', async () => {
  await withTempHome(async (home) => {
    const session = {
      id: 'td-1',
      meta: { type: 'claude-code', cwd: '/some/path', createdAt: new Date().toISOString() },
    };
    const got = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(got, null);
  });
});

test('claude.resolveTranscriptPath finds latest .jsonl in dir-hash dir', async () => {
  await withTempHome(async (home) => {
    const cwd = '/Users/test/myproj';
    const dirHash = cwd.replace(/\//g, '-');  // -Users-test-myproj
    const projectsDir = path.join(home, '.claude', 'projects', dirHash);
    fs.mkdirSync(projectsDir, { recursive: true });
    const old = path.join(projectsDir, 'old-uuid.jsonl');
    const fresh = path.join(projectsDir, 'fresh-uuid.jsonl');
    fs.writeFileSync(old, '{}\n');
    fs.writeFileSync(fresh, '{}\n');
    // Force `fresh` to have the larger mtime regardless of write order.
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 60_000), new Date(now - 60_000));
    fs.utimesSync(fresh, new Date(now), new Date(now));
    const session = {
      id: 'td-2',
      meta: { type: 'claude-code', cwd, createdAt: new Date(now - 120_000).toISOString() },
    };
    const got = await claudeAdapter.resolveTranscriptPath(session);
    assert.equal(got, fresh);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Codex. Walks today's + yesterday's session dir;
// matches first line's session_meta.payload.cwd against the panel cwd.
// ─────────────────────────────────────────────────────────────────────────

test('codex.resolveTranscriptPath finds rollout matching cwd via session_meta first line', async () => {
  await withTempHome(async (home) => {
    const cwd = '/Users/test/codex-proj';
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
    fs.mkdirSync(dayDir, { recursive: true });
    // Wrong-cwd rollout — must be ignored.
    const wrong = path.join(dayDir, 'rollout-wrong.jsonl');
    fs.writeFileSync(wrong,
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/somewhere/else' } }) + '\n');
    // Right-cwd rollout — must be returned.
    const right = path.join(dayDir, 'rollout-right.jsonl');
    fs.writeFileSync(right,
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n');
    // mtime on `right` must be the most recent so candidates sort puts it first.
    const ts = Date.now();
    fs.utimesSync(wrong, new Date(ts - 30_000), new Date(ts - 30_000));
    fs.utimesSync(right, new Date(ts), new Date(ts));
    const session = {
      id: 'td-3',
      meta: { type: 'codex', cwd, createdAt: new Date(ts - 60_000).toISOString() },
    };
    const got = await codexAdapter.resolveTranscriptPath(session);
    assert.equal(got, right);
  });
});

test('codex.resolveTranscriptPath returns null when no rollout matches the cwd', async () => {
  await withTempHome(async (home) => {
    const cwd = '/Users/test/codex-proj';
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, 'rollout-elsewhere.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/elsewhere' } }) + '\n');
    const session = {
      id: 'td-4',
      meta: { type: 'codex', cwd, createdAt: new Date().toISOString() },
    };
    const got = await codexAdapter.resolveTranscriptPath(session);
    assert.equal(got, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Gemini. Walks ~/.gemini/tmp/<basename>/chats/.
// ─────────────────────────────────────────────────────────────────────────

test('gemini.resolveTranscriptPath finds session-*.json in basename(cwd)/chats', async () => {
  await withTempHome(async (home) => {
    const cwd = '/Users/test/myproj';
    const chatsDir = path.join(home, '.gemini', 'tmp', 'myproj', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const a = path.join(chatsDir, 'session-2026-05-02T18-06-aaa.json');
    const b = path.join(chatsDir, 'session-2026-05-02T18-30-bbb.json');
    fs.writeFileSync(a, '{}');
    fs.writeFileSync(b, '{}');
    const ts = Date.now();
    fs.utimesSync(a, new Date(ts - 60_000), new Date(ts - 60_000));
    fs.utimesSync(b, new Date(ts), new Date(ts));
    const session = {
      id: 'td-5',
      meta: { type: 'gemini', cwd, createdAt: new Date(ts - 120_000).toISOString() },
    };
    const got = await geminiAdapter.resolveTranscriptPath(session);
    assert.equal(got, b);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveTranscriptPath — Grok. Returns null when DB is missing.
// (Live SQLite extraction is exercised by the substrate-probe smoke test
// in Sprint 50 T4 dogfood close-out — running better-sqlite3 against a
// synthetic STRICT-schema DB inside a unit test would re-create grok's
// migration scaffolding, which is out of scope for this lane.)
// ─────────────────────────────────────────────────────────────────────────

test('grok.resolveTranscriptPath returns null when ~/.grok/grok.db is missing', async () => {
  await withTempHome(async () => {
    const session = {
      id: 'td-6',
      meta: { type: 'grok', cwd: '/Users/test/proj', createdAt: new Date().toISOString() },
    };
    const got = await grokAdapter.resolveTranscriptPath(session);
    assert.equal(got, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// onPanelClose — dispatch + skip rules.
// ─────────────────────────────────────────────────────────────────────────

test('onPanelClose skips claude-code sessions (no double-write)', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const session = {
      id: 'td-7',
      meta: {
        type: 'claude-code',
        cwd: '/Users/test/proj',
        createdAt: new Date().toISOString(),
      },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((p1, p2, p3) => calls.push({ p1, p2, p3 }));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 0,
      'claude-code panels must not fire the bundled hook — Claude\'s own SessionEnd hook handles them');
  });
});

test('onPanelClose skips when adapter type is unknown (shell, python-server, etc.)', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const session = {
      id: 'td-8',
      meta: {
        type: 'shell',
        cwd: '/Users/test/proj',
        createdAt: new Date().toISOString(),
      },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 0);
  });
});

test('onPanelClose skips when resolveTranscriptPath returns null', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    // Codex adapter + a cwd that has no matching rollout → resolver returns null.
    const session = {
      id: 'td-9',
      meta: {
        type: 'codex',
        cwd: '/Users/test/no-such-project',
        createdAt: new Date().toISOString(),
      },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 0);
  });
});

test('onPanelClose skips when ~/.claude/hooks/memory-session-end.js is missing', async () => {
  await withTempHome(async (home) => {
    // Lay down a real Gemini transcript so the resolver returns a path.
    const cwd = '/Users/test/myproj';
    const chatsDir = path.join(home, '.gemini', 'tmp', 'myproj', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, 'session-x.json'), '{}');
    // Intentionally do NOT install the fake hook.
    const session = {
      id: 'td-10',
      meta: { type: 'gemini', cwd, createdAt: new Date(Date.now() - 60_000).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting(() => calls.push(true));
    try { await onPanelClose(session); }
    finally { _setSpawnSessionEndHookImplForTesting(null); }
    assert.equal(calls.length, 0,
      'no spawn fires when the bundled hook script isn\'t installed');
  });
});

test('onPanelClose invokes hook with full payload (incl source_agent) for codex', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/codex-real';
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const dayDir = path.join(home, '.codex', 'sessions', yyyy, mm, dd);
    fs.mkdirSync(dayDir, { recursive: true });
    const rollout = path.join(dayDir, 'rollout-real.jsonl');
    fs.writeFileSync(rollout,
      JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n');
    const ts = Date.now();
    fs.utimesSync(rollout, new Date(ts), new Date(ts));
    const session = {
      id: 'td-11',
      meta: { type: 'codex', cwd, createdAt: new Date(ts - 60_000).toISOString() },
    };

    // Capture spawn args via the test injection point. Using the real
    // detached + ignore-stdio child_process under node:test runner is
    // unreliable (the runner deprioritizes detached children's I/O), so
    // production exposes `_setSpawnSessionEndHookImplForTesting` to swap
    // the spawn impl for a closure that records the call deterministically.
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload, env) => {
      calls.push({ hookPath, payload, env });
    });
    try {
      await onPanelClose(session);
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);  // restore default
    }

    assert.equal(calls.length, 1, 'hook impl should fire exactly once');
    const { hookPath, payload } = calls[0];
    assert.equal(hookPath, path.join(home, '.claude', 'hooks', 'memory-session-end.js'));
    assert.equal(payload.transcript_path, rollout);
    assert.equal(payload.cwd, cwd);
    assert.equal(payload.session_id, 'td-11');
    assert.equal(payload.sessionType, 'codex');
    assert.equal(payload.source_agent, 'codex',
      'source_agent populates the column T2 consumes — this is the v1.0.0 trust signal');
  });
});

test('onPanelClose invokes hook with sessionType=gemini and source_agent=gemini', async () => {
  await withTempHome(async (home) => {
    installFakeHook(home);
    const cwd = '/Users/test/gemini-proj';
    const chatsDir = path.join(home, '.gemini', 'tmp', 'gemini-proj', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const file = path.join(chatsDir, 'session-2026-05-02T18-00-aaa.json');
    fs.writeFileSync(file, '{}');
    const ts = Date.now();
    fs.utimesSync(file, new Date(ts), new Date(ts));
    const session = {
      id: 'td-12',
      meta: { type: 'gemini', cwd, createdAt: new Date(ts - 60_000).toISOString() },
    };
    const calls = [];
    _setSpawnSessionEndHookImplForTesting((hookPath, payload) => {
      calls.push({ hookPath, payload });
    });
    try {
      await onPanelClose(session);
    } finally {
      _setSpawnSessionEndHookImplForTesting(null);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.sessionType, 'gemini');
    assert.equal(calls[0].payload.source_agent, 'gemini');
    assert.equal(calls[0].payload.transcript_path, file);
  });
});

test('onPanelClose does not throw when session is malformed', async () => {
  await withTempHome(async () => {
    await onPanelClose(null);
    await onPanelClose(undefined);
    await onPanelClose({});
    await onPanelClose({ meta: {} });
    assert.ok(true);
  });
});

// Sprint 80 T2 — context-telemetry WIRING tests (index.js integration).
//
// Exercises the index.js side of FR-5/FR-6 with a fake session, a real Claude
// transcript fixture (so the SHARED claude-adapter resolveTranscriptPath is the
// path actually used — the Sprint-64 reuse mandate), and STUBBED action impls.
// No live server, no live PTY, no submit:true — the production submitToPty path
// is under the 2026-07-01 crash INCIDENT and only the opt-in `inject` action
// touches it; here it's replaced by a recording stub.
//
// Run: node --test packages/server/tests/context-telemetry-wiring.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Suppress the production status_broadcast interval that createServer would
// otherwise leave running — we never call createServer here, but require()ing
// index.js is guarded by `require.main === module`, so import is side-effect-free.
const idx = require('../src/index');
const {
  updatePanelContext,
  enforceContext,
  fireContextAction,
  isMidToolUse,
  resolveContextConfig,
  _setContextConfigProvider,
  _setContextSubmitImplForTesting,
  _setContextKillImpl,
  _setContextWebhookImplForTesting,
} = idx;

// ── fixtures: write a Claude transcript where the resolver will find it ───────
// resolveTranscriptPath scans ~/.claude/projects/<cwd-with-slashes→dashes>/ for
// the newest *.jsonl ≥ createdAt. We fabricate a unique cwd, materialize that
// dir, and drop a fixture there. Cleaned up in test.after.

const _createdDirs = [];
function fixtureCwdWithTranscript(usageLines) {
  const uniq = `termdeck-ctxwire-${process.pid}-${_createdDirs.length}`;
  const cwd = path.join(os.tmpdir(), uniq);
  const dirHash = cwd.replace(/\//g, '-');
  const projDir = path.join(os.homedir(), '.claude', 'projects', dirHash);
  fs.mkdirSync(projDir, { recursive: true });
  const jsonl = path.join(projDir, 'session-fixture.jsonl');
  const lines = usageLines.map((u) =>
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: u } }));
  fs.writeFileSync(jsonl, lines.join('\n') + '\n');
  _createdDirs.push(projDir);
  return cwd;
}
function fakeClaudeSession(cwd, metaExtra = {}) {
  return {
    id: 'test-sess-' + Math.random().toString(36).slice(2, 8),
    pty: { write() {}, kill() {} },
    meta: {
      type: 'claude-code',
      cwd,
      createdAt: '2000-01-01T00:00:00.000Z', // old → fixture always passes the mtime gate
      status: 'idle',
      ...metaExtra,
    },
    trackInput() {},
  };
}

test.after(() => {
  for (const d of _createdDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* noop */ } }
  // Restore module defaults so other suites in the same runner aren't polluted.
  _setContextConfigProvider(null);
  _setContextSubmitImplForTesting(null);
  _setContextKillImpl(null);
  _setContextWebhookImplForTesting(null);
});

function withConfig(ctx) {
  _setContextConfigProvider(() => ctx);
}

// ── updatePanelContext (FR-5) ────────────────────────────────────────────────

test('updatePanelContext computes contextK + contextLevel for a Claude panel', async () => {
  withConfig({ warnK: 350, overK: 400 });
  const cwd = fixtureCwdWithTranscript([
    { input_tokens: 100, cache_read_input_tokens: 359900, cache_creation_input_tokens: 0 }, // 360K → warn
  ]);
  const s = fakeClaudeSession(cwd);
  await updatePanelContext(s);
  assert.equal(s.meta.contextK, 360);
  assert.equal(s.meta.contextLevel, 'warn');
});

test('updatePanelContext: server value WINS over a pre-set (PATCH) contextK', async () => {
  withConfig({ warnK: 350, overK: 400 });
  const cwd = fixtureCwdWithTranscript([
    { input_tokens: 0, cache_read_input_tokens: 410000, cache_creation_input_tokens: 0 }, // 410K
  ]);
  const s = fakeClaudeSession(cwd, { contextK: 5 }); // stale external PATCH value
  await updatePanelContext(s);
  assert.equal(s.meta.contextK, 410); // server-computed overwrote the PATCH value
  assert.equal(s.meta.contextLevel, 'over');
});

test('updatePanelContext: unreadable transcript RETAINS the prior (PATCH fallback) value', async () => {
  withConfig({ warnK: 350, overK: 400 });
  // cwd whose projects dir has no jsonl → resolver returns null → retain prior.
  const cwd = path.join(os.tmpdir(), `termdeck-ctxwire-empty-${process.pid}`);
  const s = fakeClaudeSession(cwd, { contextK: 77 });
  await updatePanelContext(s);
  assert.equal(s.meta.contextK, 77); // untouched
});

test('updatePanelContext is a no-op for non-Claude panels (PATCH-only degrade)', async () => {
  withConfig({ warnK: 350, overK: 400 });
  const s = fakeClaudeSession('/whatever', { type: 'codex', contextK: 42 });
  await updatePanelContext(s);
  assert.equal(s.meta.contextK, 42); // never touched
  assert.equal(s.meta.contextLevel, undefined);
});

test('updatePanelContext skips exited panels', async () => {
  withConfig({ warnK: 350, overK: 400 });
  const cwd = fixtureCwdWithTranscript([{ input_tokens: 0, cache_read_input_tokens: 500000, cache_creation_input_tokens: 0 }]);
  const s = fakeClaudeSession(cwd, { status: 'exited', contextK: 9 });
  await updatePanelContext(s);
  assert.equal(s.meta.contextK, 9);
});

// ── isMidToolUse ─────────────────────────────────────────────────────────────

test('isMidToolUse: at-rest states are safe to kill, live states defer', () => {
  for (const status of ['idle', 'exited', 'errored']) {
    assert.equal(isMidToolUse({ meta: { status } }), false, status);
  }
  for (const status of ['thinking', 'editing', 'active']) {
    assert.equal(isMidToolUse({ meta: { status } }), true, status);
  }
});

// ── resolveContextConfig precedence ──────────────────────────────────────────

test('resolveContextConfig: per-session meta overrides win over global config', () => {
  withConfig({ warnK: 350, overK: 400, maxContextK: 400, contextAction: 'notify' });
  const cfg = resolveContextConfig({ meta: { maxContextK: 200, contextAction: 'kill' } });
  assert.equal(cfg.maxContextK, 200);
  assert.equal(cfg.contextAction, 'kill');
  assert.equal(cfg.warnK, 350); // inherited
});

test('resolveContextConfig: maxContextK disabled unless a positive number', () => {
  withConfig({ maxContextK: 0 });
  assert.equal(resolveContextConfig({ meta: {} }).maxContextK, undefined);
  withConfig({ maxContextK: 'nope' });
  assert.equal(resolveContextConfig({ meta: {} }).maxContextK, undefined);
  withConfig({ maxContextK: 400 });
  assert.equal(resolveContextConfig({ meta: {} }).maxContextK, 400);
});

// ── enforceContext + fireContextAction (FR-6) ────────────────────────────────

test('enforce notify: alert set once, cleared on rotation, re-fires after re-arm', () => {
  let webhookCalls = 0;
  _setContextWebhookImplForTesting(() => { webhookCalls++; });
  withConfig({ warnK: 350, overK: 400, maxContextK: 400, contextAction: 'notify', webhookUrl: 'https://hook.example' });
  const s = fakeClaudeSession('/x');

  enforceContext(s, 410, resolveContextConfig(s));
  assert.equal(s.meta.contextAlert.action, 'notify');
  assert.equal(s.meta.contextAlert.contextK, 410);
  assert.equal(webhookCalls, 1);

  // Still over cap → latched, no second fire.
  enforceContext(s, 420, resolveContextConfig(s));
  assert.equal(webhookCalls, 1);

  // Rotation below warn → reset clears the alert.
  enforceContext(s, 120, resolveContextConfig(s));
  assert.equal(s.meta.contextAlert, null);

  // Breach again → fires again.
  enforceContext(s, 405, resolveContextConfig(s));
  assert.equal(webhookCalls, 2);
});

test('enforce inject: calls the (stubbed) submit path with the configured message', () => {
  const calls = [];
  _setContextSubmitImplForTesting((session, text) => { calls.push({ id: session.id, text }); return Promise.resolve({ ok: true }); });
  withConfig({ maxContextK: 400, warnK: 350, contextAction: 'inject', contextInjectText: 'ROTATE NOW' });
  const s = fakeClaudeSession('/x');
  enforceContext(s, 450, resolveContextConfig(s));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'ROTATE NOW');
  assert.equal(s.meta.contextAlert.action, 'inject');
});

test('enforce kill (at rest): calls the stubbed kill impl with respawn flag', () => {
  const kills = [];
  _setContextKillImpl((session, opts) => { kills.push({ id: session.id, opts }); });
  withConfig({ maxContextK: 400, warnK: 350, contextAction: 'kill', respawnOnKill: true });
  const s = fakeClaudeSession('/x', { status: 'idle' });
  enforceContext(s, 999, resolveContextConfig(s));
  assert.equal(kills.length, 1);
  assert.equal(kills[0].opts.respawn, true);
});

test('enforce kill (mid-tool-use): DEFERS — kill impl NOT called synchronously', () => {
  const kills = [];
  _setContextKillImpl((session) => { kills.push(session.id); });
  // Large grace so the deferred recheck timer never fires during the test; it is
  // unref'd so it won't keep the process alive either.
  withConfig({ maxContextK: 400, warnK: 350, contextAction: 'kill', killGraceMs: 10 * 60 * 1000, killMaxDeferrals: 3 });
  const s = fakeClaudeSession('/x', { status: 'thinking' }); // mid-tool-use
  enforceContext(s, 999, resolveContextConfig(s));
  assert.equal(kills.length, 0, 'kill must be deferred, not fired, mid-tool-use');
  assert.equal(s._contextEnforce.deferrals, 1);
  // Clean up the pending grace timer so the runner is tidy.
  if (s._contextKillTimer) clearTimeout(s._contextKillTimer);
});

test('fireContextAction notify records an alert with no side channels configured', () => {
  _setContextWebhookImplForTesting(() => { throw new Error('should not be called without webhookUrl'); });
  withConfig({ maxContextK: 400, warnK: 350, contextAction: 'notify' });
  const s = fakeClaudeSession('/x');
  fireContextAction(s, 'notify', 405, resolveContextConfig(s));
  assert.equal(s.meta.contextAlert.action, 'notify');
  assert.equal(s.meta.contextAlert.contextK, 405);
});

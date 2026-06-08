// Sprint 70 T1 (A1 RED fix) — Antigravity hook INSERT-PATH proof.
//
// The original capture e2e (packages/server/tests/adapter-agy-capture.test.js)
// asserted hook-SPAWN shape only — a false green per T4-CODEX AUDIT-RED
// (STATUS:402-408): it mocked the hook spawn and never ran the hook itself, so
// it never hit `memory-session-end.js`'s `if (stat.size < MIN_TRANSCRIPT_BYTES)
// return;` which silently drops a compact (<5KB) agy envelope BEFORE parsing →
// ZERO memory_items rows.
//
// This suite runs the BUNDLED hook's `processStdinPayload` for real, with the
// network mocked at `global.fetch`, default MIN_TRANSCRIPT_BYTES (5000), and a
// genuinely-short agy envelope — and asserts EXACTLY ONE `/rest/v1/memory_items`
// POST carrying `source_agent='antigravity'`. Plus the two guard rails the ORCH
// 19:21 decision requires the byte-gate exemption to preserve:
//   • a no-assistant-turn agy transcript still no-ops (empty-capture safety);
//   • a short NON-antigravity transcript is STILL dropped by the byte floor
//     (the exemption is scoped to antigravity — the global floor is intact).
//
// Run: node --test tests/agy-hook-insert-path.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// MIN_TRANSCRIPT_BYTES is frozen at module-load from TERMDECK_HOOK_MIN_BYTES;
// clear it BEFORE require so the suite exercises the real 5000-byte default.
delete process.env.TERMDECK_HOOK_MIN_BYTES;
delete process.env.TERMDECK_HOOK_MIN_MESSAGES;
delete process.env.TERMDECK_SESSION_TYPE;
delete process.env.TERMDECK_SOURCE_AGENT;

const hook = require('../packages/stack-installer/assets/hooks/memory-session-end.js');

// ─────────────────────────────────────────────────────────────────────────
// Hermetic env + network mock.
// ─────────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY',
  'TERMDECK_HOOK_SECRETS_PATH', 'TERMDECK_HOOK_DEBUG',
];

function withMockedHookEnv(fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const savedFetch = global.fetch;
  // Concrete creds win over the secrets.env fallback; point the fallback at a
  // nonexistent path so it never reads the developer's real ~/.termdeck/secrets.env.
  process.env.SUPABASE_URL = 'https://mock-ref.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.OPENAI_API_KEY = 'sk-mock-test-key';
  process.env.TERMDECK_HOOK_SECRETS_PATH = path.join(os.tmpdir(), 'nonexistent-agy-secrets.env');
  delete process.env.TERMDECK_HOOK_DEBUG;

  const calls = { embed: 0, memoryItems: [], memorySessions: [], unexpected: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.openai.com/v1/embeddings')) {
      calls.embed += 1;
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: new Array(8).fill(0.0123) }] }), text: async () => '' };
    }
    if (u.includes('/rest/v1/memory_items')) {
      calls.memoryItems.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    }
    if (u.includes('/rest/v1/memory_sessions')) {
      calls.memorySessions.push({ url: u, body: JSON.parse(opts.body || '{}') });
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    }
    calls.unexpected.push(u);
    return { ok: false, status: 404, text: async () => `unexpected ${u}`, json: async () => ({}) };
  };

  const restore = () => {
    global.fetch = savedFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return Promise.resolve(fn(calls)).finally(restore);
}

function writeTemp(name, content) {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}-${Math.floor(performance.now())}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ─────────────────────────────────────────────────────────────────────────
// The real proof.
// ─────────────────────────────────────────────────────────────────────────

test('short agy envelope (<5KB) writes EXACTLY ONE memory_items row tagged antigravity', async () => {
  await withMockedHookEnv(async (calls) => {
    // The exact shape agy.resolveTranscriptPath emits — a COMPACT Gemini envelope.
    const envelope = JSON.stringify({
      messages: [
        { type: 'user', content: 'explain the capture design' },
        { type: 'assistant', content: 'It tees PTY stdout into a ring buffer, then writes a compact envelope at close.' },
      ],
    });
    assert.ok(Buffer.byteLength(envelope) < 5000, `envelope must be <5KB to prove the exemption (got ${Buffer.byteLength(envelope)}B)`);
    const transcriptPath = writeTemp('termdeck-agy-proof', envelope);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/Users/x/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck',
        session_id: 'agy-insert-1',
        sessionType: 'antigravity',
        source_agent: 'antigravity',
      }));

      assert.equal(calls.unexpected.length, 0, `no unexpected fetch URLs: ${calls.unexpected.join(', ')}`);
      assert.equal(calls.embed, 1, 'embedding requested exactly once');
      assert.equal(calls.memoryItems.length, 1,
        'EXACTLY ONE memory_items POST — the real insert path, not a hook-spawn count');
      const row = calls.memoryItems[0].body;
      assert.equal(row.source_agent, 'antigravity', 'row tagged antigravity (NOT coerced to claude, NOT dropped)');
      assert.equal(row.source_type, 'session_summary');
      assert.ok(typeof row.content === 'string' && row.content.includes('ring buffer'),
        'the captured assistant content reached the row');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

test('agy transcript with NO assistant turn no-ops (content guard preserves empty-capture safety)', async () => {
  await withMockedHookEnv(async (calls) => {
    // User-only envelope — the model never replied. >= 1 assistant turn guard must skip.
    const envelope = JSON.stringify({ messages: [{ type: 'user', content: 'are you there?' }] });
    const transcriptPath = writeTemp('termdeck-agy-noassist', envelope);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/tmp/agy-noassist',
        session_id: 'agy-noassist-1',
        sessionType: 'antigravity',
        source_agent: 'antigravity',
      }));
      assert.equal(calls.memoryItems.length, 0,
        'no assistant turn → no row (empty/no-model-output capture still no-ops)');
      assert.equal(calls.embed, 0, 'short-circuits before embedding');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

test('CONTROL: a short NON-antigravity transcript is STILL dropped by the byte floor (exemption is scoped)', async () => {
  await withMockedHookEnv(async (calls) => {
    // A tiny (<5KB) but otherwise valid claude transcript: parses to 1 message,
    // so the ONLY reason to drop it is the byte floor — which must still apply.
    const claudeJsonl = `${JSON.stringify({ message: { role: 'assistant', content: 'hi from claude' } })}\n`;
    assert.ok(Buffer.byteLength(claudeJsonl) < 5000);
    const transcriptPath = writeTemp('termdeck-claude-short', claudeJsonl);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/tmp/claude-short',
        session_id: 'claude-short-1',
        sessionType: 'claude-code',
        source_agent: 'claude',
      }));
      assert.equal(calls.memoryItems.length, 0,
        'global 5KB floor still drops short non-antigravity transcripts — exemption did NOT weaken the global gate');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

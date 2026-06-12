// Sprint 73 T1 — web-chat (grok-web) hook INSERT-PATH proof.
//
// Mirror of tests/agy-hook-insert-path.test.js (Sprint 70 T1's A1 RED fix
// suite) for the web-chat sessionType. The web-chat adapter materializes a
// COMPACT Gemini-shaped envelope from the in-memory turn buffer — 48/49 live
// Sprint-72 envelopes in $TMPDIR measured <5 KB — so without the Sprint 73 T1
// byte-floor exemption the hook's `if (stat.size < MIN_TRANSCRIPT_BYTES)
// return;` silently drops a short-but-substantive web-chat session BEFORE
// parsing → ZERO memory_items rows (the same false-green shape T4-CODEX caught
// on agy at Sprint 70).
//
// This suite runs the BUNDLED hook's `processStdinPayload` for real, with the
// network mocked at `global.fetch`, default MIN_TRANSCRIPT_BYTES (5000), and a
// genuinely-short web-chat envelope — and asserts EXACTLY ONE
// `/rest/v1/memory_items` POST carrying `source_agent='grok-web'`. Plus the
// guard rails the exemption must preserve:
//   • a no-assistant-turn web-chat envelope still no-ops (empty-capture safety);
//   • the adapter REGISTRY name `web-chat-grok` aliases to `grok-web` through
//     the real insert path (never coerced to 'claude');
//   • a short CLI-grok (sessionType 'grok') transcript is STILL dropped by the
//     byte floor — the exemption is scoped to web-chat, not to the provider.
//
// Lives in packages/stack-installer/tests/ (NOT top-level tests/) so the root
// `npm test` glob actually runs it — the Sprint 62 lesson: a fence test that
// isn't in the gate is a false green.
//
// Run: node --test packages/stack-installer/tests/web-chat-hook-insert-path.test.js

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

const hook = require('../assets/hooks/memory-session-end.js');

// ─────────────────────────────────────────────────────────────────────────
// Hermetic env + network mock (same harness shape as agy-hook-insert-path).
// ─────────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY',
  'TERMDECK_HOOK_SECRETS_PATH', 'TERMDECK_HOOK_DEBUG',
];

function withMockedHookEnv(fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const savedFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://mock-ref.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  process.env.OPENAI_API_KEY = 'sk-mock-test-key';
  process.env.TERMDECK_HOOK_SECRETS_PATH = path.join(os.tmpdir(), 'nonexistent-webchat-secrets.env');
  delete process.env.TERMDECK_HOOK_DEBUG;

  const calls = { embed: 0, embedBodies: [], memoryItems: [], memorySessions: [], unexpected: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.openai.com/v1/embeddings')) {
      calls.embed += 1;
      calls.embedBodies.push(JSON.parse(opts.body || '{}'));
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

test('short web-chat envelope (<5KB) writes EXACTLY ONE memory_items row tagged grok-web', async () => {
  await withMockedHookEnv(async (calls) => {
    // The exact shape web-chat-grok.resolveTranscriptPath emits — a COMPACT
    // Gemini envelope materialized from session._webChatTranscript.turns.
    const envelope = JSON.stringify({
      messages: [
        { type: 'user', content: 'summarize the provenance flip design' },
        { type: 'assistant', content: 'The adapter declares sourceAgent grok-web; onPanelClose forwards it; the bundled hook allow-lists it and exempts the compact envelope from the byte floor.' },
      ],
    });
    assert.ok(Buffer.byteLength(envelope) < 5000, `envelope must be <5KB to prove the exemption (got ${Buffer.byteLength(envelope)}B)`);
    const transcriptPath = writeTemp('termdeck-webchat-proof', envelope);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/Users/x/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck',
        session_id: 'webchat-insert-1',
        sessionType: 'web-chat',
        source_agent: 'grok-web',
      }));

      assert.equal(calls.unexpected.length, 0, `no unexpected fetch URLs: ${calls.unexpected.join(', ')}`);
      assert.equal(calls.embed, 1, 'embedding requested exactly once');
      assert.equal(calls.memoryItems.length, 1,
        'EXACTLY ONE memory_items POST — the real insert path, not a hook-spawn count');
      const row = calls.memoryItems[0].body;
      assert.equal(row.source_agent, 'grok-web', 'row tagged grok-web (NOT coerced to claude, NOT folded into CLI grok, NOT dropped)');
      assert.equal(row.source_type, 'session_summary');
      assert.ok(typeof row.content === 'string' && row.content.includes('byte floor'),
        'the captured assistant content reached the row');
      assert.equal(calls.memorySessions.length, 1,
        'the companion memory_sessions row fires for web-chat too');
      // Sprint 73 T1 v5 — recall-parity embedding contract. The request must
      // match mnestra's query embedder (3-large @ 1536) exactly; dimensions
      // is load-bearing (3-large is natively 3072-dim, column is vector(1536)).
      assert.equal(calls.embedBodies[0].model, 'text-embedding-3-large');
      assert.equal(calls.embedBodies[0].dimensions, 1536);
      // And the row carries the backfill-idempotency marker Sprint 74 T3's
      // re-embed script keys on.
      assert.deepEqual(row.metadata, { embedding_model: 'text-embedding-3-large@1536' });
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

test('web-chat envelope with NO assistant turn no-ops (content guard preserves empty-capture safety)', async () => {
  await withMockedHookEnv(async (calls) => {
    // User-only envelope — prompt injected, Grok never completed a reply.
    const envelope = JSON.stringify({ messages: [{ type: 'user', content: 'are you there?' }] });
    const transcriptPath = writeTemp('termdeck-webchat-noassist', envelope);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/tmp/webchat-noassist',
        session_id: 'webchat-noassist-1',
        sessionType: 'web-chat',
        source_agent: 'grok-web',
      }));
      assert.equal(calls.memoryItems.length, 0,
        'no assistant turn → no row (empty/no-model-output capture still no-ops)');
      assert.equal(calls.embed, 0, 'short-circuits before embedding');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

test('registry-name alias: payload source_agent=web-chat-grok lands as grok-web through the real insert path', async () => {
  await withMockedHookEnv(async (calls) => {
    // A caller passing the adapter REGISTRY name instead of the canonical tag
    // (the agy → antigravity failure shape) must alias, not coerce to claude.
    const envelope = JSON.stringify({
      messages: [
        { type: 'user', content: 'alias check' },
        { type: 'assistant', content: 'registry name folds to the canonical provenance tag' },
      ],
    });
    const transcriptPath = writeTemp('termdeck-webchat-alias', envelope);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/tmp/webchat-alias',
        session_id: 'webchat-alias-1',
        sessionType: 'web-chat',
        source_agent: 'web-chat-grok',
      }));
      assert.equal(calls.memoryItems.length, 1);
      assert.equal(calls.memoryItems[0].body.source_agent, 'grok-web',
        'web-chat-grok (registry name) aliases to grok-web — never claude');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

test('CONTROL: a short CLI-grok transcript is STILL dropped by the byte floor (exemption scoped to web-chat, not the provider)', async () => {
  await withMockedHookEnv(async (calls) => {
    // A tiny (<5KB) but otherwise valid grok CLI transcript: parses to 1
    // message via parseGrokJson, so the ONLY reason to drop it is the byte
    // floor — which must still apply to sessionType 'grok'.
    const grokJson = JSON.stringify([{ role: 'assistant', content: 'hi from the grok CLI' }]);
    assert.ok(Buffer.byteLength(grokJson) < 5000);
    const transcriptPath = writeTemp('termdeck-grok-cli-short', grokJson);
    try {
      await hook.processStdinPayload(JSON.stringify({
        transcript_path: transcriptPath,
        cwd: '/tmp/grok-cli-short',
        session_id: 'grok-cli-short-1',
        sessionType: 'grok',
        source_agent: 'grok',
      }));
      assert.equal(calls.memoryItems.length, 0,
        'global 5KB floor still drops short CLI-grok transcripts — the web-chat exemption keys on sessionType, not provider');
    } finally {
      try { fs.unlinkSync(transcriptPath); } catch (_) { /* fail-soft */ }
    }
  });
});

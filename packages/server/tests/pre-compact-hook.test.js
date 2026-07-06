// Sprint 64 T3.2 — bundled memory-pre-compact.js fence tests.
// Sprint 81 T3 — upgraded for the ingest_capture switch (v3) + fallback matrix.
//
// Investigation 2 of docs/CRITICAL-READ-FIRST-2026-05-07.md. The bundled
// hook ships at packages/stack-installer/assets/hooks/memory-pre-compact.js
// and gets vendored to ~/.claude/hooks/ by `npx @jhizzard/termdeck-stack`
// + `termdeck init --mnestra`.
//
// Sprint 81 (v3): the PRIMARY write path is now the ingest_capture(jsonb) RPC
// (POST /rest/v1/rpc/ingest_capture), with a transition-safe FALLBACK to the
// raw /rest/v1/memory_items append on any non-clear-success. These fences are
// the ORCH-R3 "actual RPC round-trip" proof at the unit level: they emulate the
// redefined-arbiter-free RPC's success contract ({ok:true}) AND every failure
// mode (42P10 no-arbiter, PGRST202 undeployed, {ok:false}, network throw) and
// assert the correct path + that success is NEVER double-written.
//
//   • PreCompact STDIN → ingest_capture PRIMARY, one rpc POST, no fallback.
//   • periodic_checkpoint STDIN → ingest_capture with adapter source_agent.
//   • ingest_capture non-success (4 modes) → raw-append fallback.
//   • ingest_capture success → NO fallback (no double-write).
//   • both paths fail → insert-failed.
//   • payload round-trip shape ({p_payload:{...}}).
//   • Small-transcript / no-session-id / env-missing skips → zero writes.
//
// Run: node --test packages/server/tests/pre-compact-hook.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(
  __dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-pre-compact.js'
);
const HELPERS_PATH = path.join(
  __dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js'
);

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-sprint64-precompact-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    fs.mkdirSync(path.join(tmpHome, '.claude', 'hooks'), { recursive: true });
    return await fn(tmpHome);
  } finally {
    process.env.HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* fail-soft */ }
  }
}

function writeClaudeTranscript(home, { name = 'transcript.jsonl', messageCount = 20 } = {}) {
  const file = path.join(home, name);
  const lines = [];
  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    lines.push(JSON.stringify({
      timestamp: new Date(Date.now() - (messageCount - i) * 1000).toISOString(),
      message: {
        role,
        content: [{ type: 'text', text: `msg ${i} from ${role} — padding to push over MIN_TRANSCRIPT_BYTES floor`.padEnd(600, '.') }],
      },
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Replace global.fetch so we can intercept embed + the ingest_capture RPC +
// the raw-append fallback without hitting the network. `opts` overrides the RPC
// / append responses to drive the fallback matrix. Embed responds with a
// synthetic vector; ingest_capture defaults to the {ok:true} success contract;
// memory_items append defaults to 201.
function installFetchMock(opts = {}) {
  const state = {
    embedCalls: [],
    rpcCalls: [],       // POST /rest/v1/rpc/ingest_capture (PRIMARY)
    supabaseCalls: [],  // POST /rest/v1/memory_items (FALLBACK append)
    embedResponse: { ok: true, vector: new Array(8).fill(0.0).concat([1, 0, 0, 0]) },
    rpcResponse: opts.rpcResponse || { ok: true, status: 200, body: JSON.stringify({ ok: true, id: 'fixture-id', action: 'inserted' }) },
    supabaseResponse: opts.supabaseResponse || { ok: true, status: 201, body: '' },
    rpcThrows: !!opts.rpcThrows, // simulate a network error on the RPC fetch itself
  };
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('openai.com')) {
      state.embedCalls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: state.embedResponse.ok,
        status: state.embedResponse.ok ? 200 : 500,
        async text() { return state.embedResponse.ok ? '' : 'mocked-embed-fail'; },
        async json() { return { data: [{ embedding: state.embedResponse.vector }] }; },
      };
    }
    if (typeof url === 'string' && url.includes('/rest/v1/rpc/ingest_capture')) {
      state.rpcCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (state.rpcThrows) throw new Error('mocked-rpc-network-error');
      const r = state.rpcResponse;
      return { ok: r.ok, status: r.status, async text() { return r.body != null ? r.body : ''; } };
    }
    if (typeof url === 'string' && url.includes('/rest/v1/memory_items')) {
      state.supabaseCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const r = state.supabaseResponse;
      return { ok: r.ok, status: r.status, async text() { return r.body != null ? r.body : (r.ok ? '' : 'mocked-supabase-fail'); } };
    }
    throw new Error(`unhandled fetch in test: ${url}`);
  };
  return { state, restore() { global.fetch = origFetch; } };
}

function setEnvForHook() {
  process.env.SUPABASE_URL = 'https://fixture.supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-key';
  process.env.OPENAI_API_KEY = 'fixture-openai-key';
  process.env.TERMDECK_HOOK_HELPERS_PATH = HELPERS_PATH;
}

function freshHook() {
  delete require.cache[require.resolve(HOOK_PATH)];
  delete require.cache[require.resolve(HELPERS_PATH)];
  return require(HOOK_PATH);
}

function precompactPayload(overrides = {}) {
  return JSON.stringify(Object.assign({
    session_id: 'fixture-precompact-session',
    hook_event_name: 'PreCompact',
    trigger: 'auto',
  }, overrides));
}

// ── PRIMARY: ingest_capture round-trip ──────────────────────────────────────

test('PRIMARY: PreCompact STDIN writes via ingest_capture RPC (one rpc POST, no fallback)', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'claude-precompact.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(precompactPayload({
        transcript_path: transcript,
        cwd: '/Users/test/SideHustles/TermDeck/termdeck',
      }), helpers);

      assert.equal(result.status, 'ingested');
      assert.equal(result.via, 'ingest_capture', 'used the PRIMARY path');
      assert.equal(mock.state.rpcCalls.length, 1, 'exactly one ingest_capture RPC POST');
      assert.equal(mock.state.supabaseCalls.length, 0, 'no raw-append fallback on success (no double-write)');

      const rpcBody = mock.state.rpcCalls[0].body;
      assert.ok(rpcBody.p_payload, 'RPC body nests the jsonb arg under p_payload');
      const p = rpcBody.p_payload;
      assert.equal(p.source_type, 'pre_compact_snapshot');
      assert.equal(p.category, 'workflow');
      assert.equal(p.source_session_id, 'fixture-precompact-session');
      assert.equal(p.source_agent, 'claude');
      assert.equal(p.project, 'termdeck', 'project resolved from cwd via PROJECT_MAP');
      assert.equal(typeof p.embedding, 'string');
      assert.ok(p.embedding.startsWith('['), 'embedding is the [..] vector literal string');
      assert.ok(p.content.startsWith('[CHECKPOINT mode=pre_compact trigger=auto'), 'header carries mode + trigger');
      assert.deepEqual(p.metadata, { embedding_model: helpers.EMBEDDING_MODEL_MARKER });
      assert.equal(helpers.EMBEDDING_MODEL_MARKER, 'text-embedding-3-large@1536');
    } finally {
      mock.restore();
    }
  });
});

test('PRIMARY: periodic_checkpoint mode routes through ingest_capture with adapter source_agent', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'codex-periodic.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(JSON.stringify({
        session_id: 'fixture-periodic-session',
        transcript_path: transcript,
        cwd: '/Users/test/SideHustles/TermDeck/termdeck',
        sessionType: 'claude-code',
        source_agent: 'codex',
        mode: 'periodic_checkpoint',
      }), helpers);

      assert.equal(result.status, 'ingested');
      assert.equal(result.via, 'ingest_capture');
      assert.equal(mock.state.rpcCalls.length, 1);
      const p = mock.state.rpcCalls[0].body.p_payload;
      assert.equal(p.source_type, 'pre_compact_snapshot');
      assert.equal(p.source_agent, 'codex');
      assert.ok(p.content.startsWith('[CHECKPOINT mode=periodic_checkpoint trigger=periodic'),
        'header reflects periodic_checkpoint + periodic trigger');
    } finally {
      mock.restore();
    }
  });
});

// ── FALLBACK matrix: ingest_capture non-success → raw append ─────────────────

const FALLBACK_CASES = [
  {
    name: '42P10 no-arbiter (index not yet created)',
    opts: { rpcResponse: { ok: false, status: 400, body: JSON.stringify({ code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' }) } },
  },
  {
    name: 'PGRST202 undeployed (ingest_capture not applied on this DB)',
    opts: { rpcResponse: { ok: false, status: 404, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.ingest_capture(p_payload) in the schema cache' }) } },
  },
  {
    name: '2xx but {ok:false} (RPC rejected the payload)',
    opts: { rpcResponse: { ok: true, status: 200, body: JSON.stringify({ ok: false, error: 'content is required' }) } },
  },
  {
    name: 'network throw on the RPC fetch',
    opts: { rpcThrows: true },
  },
];

for (const c of FALLBACK_CASES) {
  test(`FALLBACK: ingest_capture ${c.name} → raw-append fallback`, async () => {
    await withTempHome(async (home) => {
      setEnvForHook();
      const mock = installFetchMock(c.opts);
      try {
        const transcript = writeClaudeTranscript(home, { name: 'fallback.jsonl', messageCount: 25 });
        const hook = freshHook();
        const helpers = require(HELPERS_PATH);
        const result = await hook.processPreCompactPayload(precompactPayload({
          transcript_path: transcript,
          cwd: '/Users/test/SideHustles/TermDeck/termdeck',
        }), helpers);

        assert.equal(result.status, 'ingested');
        assert.equal(result.via, 'append-fallback', 'fell back to the raw append');
        assert.equal(mock.state.rpcCalls.length, 1, 'tried ingest_capture first');
        assert.equal(mock.state.supabaseCalls.length, 1, 'appended exactly once via fallback');
        // The fallback row shape is byte-identical to the RPC payload (shared
        // buildCapturePayload) — the append is a raw /rest/v1/memory_items body,
        // NOT wrapped in p_payload.
        const appendBody = mock.state.supabaseCalls[0].body;
        assert.equal(appendBody.source_type, 'pre_compact_snapshot');
        assert.equal(appendBody.source_session_id, 'fixture-precompact-session');
        assert.equal(appendBody.p_payload, undefined, 'append body is NOT the RPC envelope');
      } finally {
        mock.restore();
      }
    });
  });
}

test('BOTH FAIL: ingest_capture non-success AND append non-success → insert-failed', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock({
      rpcResponse: { ok: false, status: 500, body: 'rpc-boom' },
      supabaseResponse: { ok: false, status: 500, body: 'append-boom' },
    });
    try {
      const transcript = writeClaudeTranscript(home, { name: 'bothfail.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(precompactPayload({
        transcript_path: transcript,
        cwd: '/tmp',
      }), helpers);

      assert.equal(result.status, 'insert-failed');
      assert.equal(result.via, undefined);
      assert.equal(mock.state.rpcCalls.length, 1);
      assert.equal(mock.state.supabaseCalls.length, 1, 'tried the fallback once, then gave up (fail-soft)');
    } finally {
      mock.restore();
    }
  });
});

// ── Skips: no writes on either path ──────────────────────────────────────────

test('SKIP: transcript below MIN_TRANSCRIPT_BYTES → zero writes (rpc + append)', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const tiny = path.join(home, 'tiny.jsonl');
      fs.writeFileSync(tiny, 'x'.repeat(1024));
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(precompactPayload({
        session_id: 'fixture-tiny', transcript_path: tiny, cwd: '/tmp',
      }), helpers);
      assert.equal(result.status, 'small-transcript');
      assert.equal(mock.state.rpcCalls.length, 0);
      assert.equal(mock.state.supabaseCalls.length, 0);
    } finally {
      mock.restore();
    }
  });
});

test('SKIP: missing session_id → no-session-id, zero writes', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'orphan.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(JSON.stringify({
        transcript_path: transcript, cwd: '/tmp', hook_event_name: 'PreCompact', trigger: 'manual',
      }), helpers);
      assert.equal(result.status, 'no-session-id');
      assert.equal(mock.state.rpcCalls.length, 0);
      assert.equal(mock.state.supabaseCalls.length, 0);
    } finally {
      mock.restore();
    }
  });
});

test('SKIP: env-var-missing → env-missing, zero writes', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    delete process.env.SUPABASE_URL;
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'env-missing.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const result = await hook.processPreCompactPayload(precompactPayload({
        session_id: 'fixture-env-missing', transcript_path: transcript, cwd: '/tmp',
      }), helpers);
      assert.equal(result.status, 'env-missing');
      assert.equal(mock.state.rpcCalls.length, 0);
      assert.equal(mock.state.supabaseCalls.length, 0);
    } finally {
      mock.restore();
      process.env.SUPABASE_URL = 'https://fixture.supabase.invalid';
    }
  });
});

// Sprint 64 T3.2 — bundled memory-pre-compact.js fence tests.
//
// Investigation 2 of docs/CRITICAL-READ-FIRST-2026-05-07.md. The bundled
// hook ships at packages/stack-installer/assets/hooks/memory-pre-compact.js
// and gets vendored to ~/.claude/hooks/ by `npx @jhizzard/termdeck-stack`
// + `termdeck init --mnestra`. These fences exercise:
//
//   • PreCompact STDIN shape (Claude Code harness fire) → POST with
//     source_type='pre_compact_snapshot'.
//   • periodic_checkpoint STDIN shape (TermDeck server fire for non-Claude
//     panels) → POST with source_agent reflecting the adapter.
//   • Small-transcript skip (below MIN_TRANSCRIPT_BYTES_PRE_COMPACT).
//   • Env-var-missing skip (readEnv returns null → no POSTs).
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

// Build a Claude Code-shaped transcript JSONL with enough message lines that
// buildSummary doesn't early-return on the <5 floor. Returns the absolute
// path to the temp file. Each line is the canonical
// `{message: {role, content: [{type:"text", text: ...}]}}` shape.
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

// Replace global.fetch so we can intercept embed + supabase POST without
// hitting the network. Returns a state object the test inspects after the
// hook completes. Embed responds with a synthetic 1536-element vector;
// supabase responds 201. Restore on cleanup.
function installFetchMock() {
  const state = {
    embedCalls: [],
    supabaseCalls: [],
    embedResponse: { ok: true, vector: new Array(8).fill(0.0).concat([1, 0, 0, 0]) },
    supabaseResponse: { ok: true, status: 201 },
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
    if (typeof url === 'string' && url.includes('/rest/v1/memory_items')) {
      state.supabaseCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: state.supabaseResponse.ok,
        status: state.supabaseResponse.status,
        async text() { return state.supabaseResponse.ok ? '' : 'mocked-supabase-fail'; },
      };
    }
    throw new Error(`unhandled fetch in test: ${url}`);
  };
  return {
    state,
    restore() { global.fetch = origFetch; },
  };
}

function setEnvForHook(home) {
  process.env.SUPABASE_URL = 'https://fixture.supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-key';
  process.env.OPENAI_API_KEY = 'fixture-openai-key';
  process.env.TERMDECK_HOOK_HELPERS_PATH = HELPERS_PATH;
  // Make sure the hook's loadHelpers() picks the bundled file (the override
  // wins over any installed ~/.claude/hooks/memory-session-end.js residue).
}

// Re-require the bundled hook fresh each test so the require-cache snapshot
// (which captures TERMDECK_HOOK_HELPERS_PATH at module-load time) doesn't
// stick across cases.
function freshHook() {
  delete require.cache[require.resolve(HOOK_PATH)];
  delete require.cache[require.resolve(HELPERS_PATH)];
  return require(HOOK_PATH);
}

test('processPreCompactPayload writes source_type=pre_compact_snapshot under PreCompact STDIN', async () => {
  await withTempHome(async (home) => {
    setEnvForHook(home);
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'claude-precompact.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const payload = JSON.stringify({
        session_id: 'fixture-precompact-session',
        transcript_path: transcript,
        cwd: '/Users/test/SideHustles/TermDeck/termdeck',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      });
      const result = await hook.processPreCompactPayload(payload, helpers);
      assert.equal(result.status, 'ingested');
      assert.equal(mock.state.supabaseCalls.length, 1, 'one POST to memory_items');
      const body = mock.state.supabaseCalls[0].body;
      assert.equal(body.source_type, 'pre_compact_snapshot');
      assert.equal(body.category, 'workflow');
      assert.equal(body.source_session_id, 'fixture-precompact-session');
      assert.equal(body.source_agent, 'claude');
      assert.equal(body.project, 'termdeck', 'project resolved from cwd via PROJECT_MAP');
      assert.ok(body.content.startsWith('[CHECKPOINT mode=pre_compact trigger=auto'), 'header carries mode + trigger');
    } finally {
      mock.restore();
    }
  });
});

test('processPreCompactPayload honors periodic_checkpoint mode with adapter source_agent', async () => {
  await withTempHome(async (home) => {
    setEnvForHook(home);
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'codex-periodic.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const payload = JSON.stringify({
        session_id: 'fixture-periodic-session',
        transcript_path: transcript,
        cwd: '/Users/test/SideHustles/TermDeck/termdeck',
        sessionType: 'claude-code', // the parser uses claude-code shape on the synthetic transcript
        source_agent: 'codex',
        mode: 'periodic_checkpoint',
      });
      const result = await hook.processPreCompactPayload(payload, helpers);
      assert.equal(result.status, 'ingested');
      const body = mock.state.supabaseCalls[0].body;
      assert.equal(body.source_type, 'pre_compact_snapshot');
      assert.equal(body.source_agent, 'codex');
      assert.ok(body.content.startsWith('[CHECKPOINT mode=periodic_checkpoint trigger=periodic'),
        'header reflects periodic_checkpoint + periodic trigger');
    } finally {
      mock.restore();
    }
  });
});

test('processPreCompactPayload skips transcripts smaller than MIN_TRANSCRIPT_BYTES_PRE_COMPACT', async () => {
  await withTempHome(async (home) => {
    setEnvForHook(home);
    const mock = installFetchMock();
    try {
      const tiny = path.join(home, 'tiny.jsonl');
      fs.writeFileSync(tiny, 'x'.repeat(1024)); // 1 KB << 5 KB default floor
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const payload = JSON.stringify({
        session_id: 'fixture-tiny',
        transcript_path: tiny,
        cwd: '/tmp',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      });
      const result = await hook.processPreCompactPayload(payload, helpers);
      assert.equal(result.status, 'small-transcript');
      assert.equal(mock.state.supabaseCalls.length, 0, 'no Supabase POSTs for sub-threshold transcripts');
    } finally {
      mock.restore();
    }
  });
});

test('processPreCompactPayload returns no-session-id without a session_id', async () => {
  await withTempHome(async (home) => {
    setEnvForHook(home);
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'orphan.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const payload = JSON.stringify({
        transcript_path: transcript,
        cwd: '/tmp',
        hook_event_name: 'PreCompact',
        trigger: 'manual',
      });
      const result = await hook.processPreCompactPayload(payload, helpers);
      assert.equal(result.status, 'no-session-id');
      assert.equal(mock.state.supabaseCalls.length, 0);
    } finally {
      mock.restore();
    }
  });
});

test('processPreCompactPayload short-circuits cleanly on env-var-missing', async () => {
  await withTempHome(async (home) => {
    setEnvForHook(home);
    delete process.env.SUPABASE_URL; // simulate env-missing trap
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home, { name: 'env-missing.jsonl', messageCount: 25 });
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const payload = JSON.stringify({
        session_id: 'fixture-env-missing',
        transcript_path: transcript,
        cwd: '/tmp',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      });
      const result = await hook.processPreCompactPayload(payload, helpers);
      assert.equal(result.status, 'env-missing');
      assert.equal(mock.state.supabaseCalls.length, 0);
    } finally {
      mock.restore();
      // Restore env so a later test isn't poisoned by the deletion.
      process.env.SUPABASE_URL = 'https://fixture.supabase.invalid';
    }
  });
});

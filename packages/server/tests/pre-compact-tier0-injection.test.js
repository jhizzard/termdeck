// Sprint 71 B-T2 — PreCompact hook v4: tier-0 re-injection at the compaction
// boundary.
//
// The claim under test is narrow and load-bearing: **capture and injection are
// independent**. v4 must be a strict superset of v3 — every v3 outcome
// (ingested / small-transcript / no-session-id / env-missing) has to survive
// unchanged whether or not objectives exist, and injection has to happen (or
// not) on its own terms. If those two ever couple, a store with no objectives
// silently stops checkpointing, which is the failure v3 exists to prevent.
//
// Also pinned: the hook NEVER writes objective text into the captured row.
// Tier 0 is injected, not retrieved (sprint seam §3); folding it into a
// pre_compact_snapshot row would push the objectives back into the tier-2
// evidence pool they exist to sit above, where recall would rank and decay
// them like any other memory.
//
// Run: node --test packages/server/tests/pre-compact-tier0-injection.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.join(
  __dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-pre-compact.js',
);
const HELPERS_PATH = path.join(
  __dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js',
);

const OBJECTIVES = [
  { id: 'o1', text: 'Zero build step is locked.', rank: 1, ratified_at: '2026-08-01' },
  { id: 'o2', text: 'Never leak the internal project name externally.', rank: 2 },
];

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tier0-precompact-'));
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

function writeClaudeTranscript(home, { name = 'transcript.jsonl', messageCount = 25 } = {}) {
  const file = path.join(home, name);
  const lines = [];
  for (let i = 0; i < messageCount; i++) {
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `fixture message ${i} — ${'padding '.repeat(30)}` }],
      },
      timestamp: new Date(Date.UTC(2026, 7, 5, 12, i)).toISOString(),
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Fetch mock covering the three endpoint families the hook can touch:
// the capture RPC, the raw-append fallback, and the tier-0 lookups.
function installFetchMock({ objectives = OBJECTIVES, tier0Mode = 'rpc' } = {}) {
  const origFetch = global.fetch;
  const state = { captureCalls: [], appendCalls: [], tier0Calls: [] };
  global.fetch = async (url, init = {}) => {
    if (typeof url === 'string' && url.includes('/rest/v1/rpc/ingest_capture')) {
      state.captureCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } };
    }
    if (typeof url === 'string' && url.includes('/rest/v1/memory_items')) {
      state.appendCalls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, async text() { return ''; } };
    }
    if (typeof url === 'string' && url.includes('/rest/v1/rpc/objective_list')) {
      state.tier0Calls.push({ url, kind: 'rpc', body: JSON.parse(init.body) });
      if (tier0Mode === 'rpc') {
        return { ok: true, status: 200, async json() { return objectives; }, async text() { return ''; } };
      }
      return {
        ok: false, status: 404,
        async text() { return 'Could not find the function public.objective_list'; },
        async json() { return null; },
      };
    }
    if (typeof url === 'string' && url.includes('/rest/v1/memory_objectives')) {
      state.tier0Calls.push({ url, kind: 'table' });
      if (tier0Mode === 'table') {
        return { ok: true, status: 200, async json() { return objectives; }, async text() { return ''; } };
      }
      return { ok: false, status: 404, async json() { return null; }, async text() { return ''; } };
    }
    if (typeof url === 'string' && url.includes('api.openai.com')) {
      return {
        ok: true, status: 200,
        async json() { return { data: [{ embedding: new Array(1536).fill(0.001) }] }; },
        async text() { return ''; },
      };
    }
    if (typeof url === 'string' && url.includes('tier0-throws')) throw new Error('boom');
    throw new Error(`unhandled fetch in test: ${url}`);
  };
  return { state, restore() { global.fetch = origFetch; } };
}

// stdout capture — the injection channel IS process.stdout, so the assertion
// has to read what the harness would actually receive.
function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = orig; })
    .then((result) => ({ result, stdout: chunks.join('') }));
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

function payload(overrides = {}) {
  return JSON.stringify(Object.assign({
    session_id: 'fixture-tier0-session',
    hook_event_name: 'PreCompact',
    trigger: 'auto',
  }, overrides));
}

// ── injection happens, and in the documented shape ──────────────────────────

test('PreCompact — emits tier-0 as hookSpecificOutput.additionalContext', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));

      assert.equal(result.tier0_status, 'injected');
      assert.equal(result.tier0_count, 2);

      const emitted = JSON.parse(stdout.trim());
      assert.equal(emitted.hookSpecificOutput.hookEventName, 'PreCompact',
        'the event name must echo the event that fired, or the harness cannot '
        + 'associate the context with anything');
      assert.equal(emitted.suppressOutput, true,
        'the model is the audience here, not the operator scrollback');
      const ctx = emitted.hookSpecificOutput.additionalContext;
      assert.match(ctx, /^## Objectives \(tier 0\)$/m);
      assert.match(ctx, /1\. Zero build step is locked\./);
      assert.match(ctx, /2\. Never leak the internal project name externally\./);
    } finally {
      mock.restore();
    }
  });
});

test('PreCompact — capture still happens alongside injection (superset, not swap)', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.status, 'ingested', 'v3 capture behavior is unchanged');
      assert.equal(result.via, 'ingest_capture');
      assert.equal(mock.state.captureCalls.length, 1);
      assert.equal(result.tier0_status, 'injected');
    } finally {
      mock.restore();
    }
  });
});

test('SEAM §3 — objective text NEVER enters the captured row', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      const written = JSON.stringify(mock.state.captureCalls[0].body);
      assert.ok(!written.includes('Zero build step is locked'),
        'objectives written into a pre_compact_snapshot row would land back in '
        + 'the tier-2 evidence pool, where recall ranks and decays them — which '
        + 'is precisely what tier 0 exists to be immune to');
      assert.ok(!written.includes('Objectives (tier 0)'));
    } finally {
      mock.restore();
    }
  });
});

test('tier-0 falls back to the table read when the RPC is absent', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock({ tier0Mode: 'table' });
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.tier0_status, 'injected');
      assert.ok(mock.state.tier0Calls.some((c) => c.kind === 'table'));
    } finally {
      mock.restore();
    }
  });
});

// ── independence: neither half can take the other down ──────────────────────

test('INDEPENDENCE — no objectives in the store still captures, and emits no stdout', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock({ objectives: [], tier0Mode: 'rpc' });
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.status, 'ingested');
      assert.equal(result.tier0_status, 'none');
      assert.equal(stdout, '',
        'silence on an objectives-free store keeps the pre-v4 stdout behavior '
        + 'byte-identical, which today is every store');
    } finally {
      mock.restore();
    }
  });
});

test('INDEPENDENCE — a pre-038 store (RPC + table both 404) still captures', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock({ tier0Mode: 'none' });
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.status, 'ingested');
      assert.equal(result.tier0_status, 'none');
      assert.equal(stdout, '');
    } finally {
      mock.restore();
    }
  });
});

test('INDEPENDENCE — a sub-threshold transcript skips capture but STILL re-injects', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const tiny = path.join(home, 'tiny.jsonl');
      fs.writeFileSync(tiny, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: tiny, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.status, 'small-transcript', 'v3 skip behavior preserved');
      assert.equal(mock.state.captureCalls.length, 0);
      assert.equal(result.tier0_status, 'injected',
        'the objectives are still worth re-injecting even when there is nothing '
        + 'worth checkpointing — the two halves are independent');
      assert.match(stdout, /Objectives \(tier 0\)/);
    } finally {
      mock.restore();
    }
  });
});

test('FAIL-SOFT — a throwing tier-0 fetch neither breaks capture nor emits stdout', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const origFetch = global.fetch;
    const captureCalls = [];
    global.fetch = async (url, init = {}) => {
      if (typeof url === 'string' && url.includes('api.openai.com')) {
        return { ok: true, status: 200, async json() { return { data: [{ embedding: new Array(1536).fill(0.001) }] }; }, async text() { return ''; } };
      }
      if (typeof url === 'string' && url.includes('/rpc/ingest_capture')) {
        captureCalls.push(JSON.parse(init.body));
        return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } };
      }
      throw new Error('objectives backend exploded');
    };
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({ transcript_path: transcript, cwd: '/Users/test/SideHustles/TermDeck/termdeck' }),
        helpers,
      ));
      assert.equal(result.status, 'ingested', 'losing objectives must never cost the checkpoint');
      assert.equal(captureCalls.length, 1);
      assert.equal(result.tier0_status, 'none');
      assert.equal(stdout, '');
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ── PostCompact: inject-only ────────────────────────────────────────────────

test('PostCompact — injects and captures NOTHING (no duplicate snapshot row)', async () => {
  await withTempHome(async (home) => {
    setEnvForHook();
    const mock = installFetchMock();
    try {
      const transcript = writeClaudeTranscript(home);
      const hook = freshHook();
      const helpers = require(HELPERS_PATH);
      const { result, stdout } = await captureStdout(() => hook.processPreCompactPayload(
        payload({
          transcript_path: transcript,
          cwd: '/Users/test/SideHustles/TermDeck/termdeck',
          hook_event_name: 'PostCompact',
        }),
        helpers,
      ));
      assert.equal(result.status, 'post-compact-inject-only');
      assert.equal(mock.state.captureCalls.length, 0,
        'the PreCompact fire moments earlier already wrote the snapshot; a '
        + 'second write here is the duplicate-row pattern of ledger #16');
      assert.equal(mock.state.appendCalls.length, 0);
      assert.equal(result.tier0_status, 'injected');
      const emitted = JSON.parse(stdout.trim());
      assert.equal(emitted.hookSpecificOutput.hookEventName, 'PostCompact');
    } finally {
      mock.restore();
    }
  });
});

test('resolveFiringContext — PostCompact resolves before the PreCompact branch', () => {
  const helpers = require(HELPERS_PATH);
  const hook = freshHook();
  assert.equal(
    hook.resolveFiringContext({ hook_event_name: 'PostCompact', trigger: 'manual' }, helpers).mode,
    'post_compact',
  );
  assert.equal(
    hook.resolveFiringContext({ hook_event_name: 'PreCompact', trigger: 'auto' }, helpers).mode,
    'pre_compact',
  );
  assert.equal(
    hook.resolveFiringContext({ mode: 'periodic_checkpoint', sessionType: 'codex' }, helpers).mode,
    'periodic_checkpoint',
  );
});

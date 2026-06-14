'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTermdeckClient } = require('../src/clients/termdeck');
const { createMnestraClient } = require('../src/clients/mnestra');

// A recording fake fetch. `handler(url, init)` returns { status?, body? }.
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {},
    });
    const r = (handler ? handler(String(url), init) : {}) || {};
    const status = r.status || 200;
    const bodyObj = r.body !== undefined ? r.body : {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)),
    };
  };
  return { fetchImpl, calls };
}

// ── TermDeck client ──────────────────────────────────────────────────────────

test('termdeck.listSessions: GET /api/sessions, excludes exited by default', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: [{ id: 'a', pid: 1, meta: { label: 'A' } }] }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  const out = await td.listSessions();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://x:3000/api/sessions');
  assert.equal(out[0].id, 'a');
});

test('termdeck.listSessions: includeExited adds query param', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: [] }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  await td.listSessions({ includeExited: true });
  assert.equal(calls[0].url, 'http://x:3000/api/sessions?includeExited=true');
});

test('termdeck.getTranscript: builds limit query, returns content', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { content: 'hello', lines: ['hello'], chunks: [] } }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  const out = await td.getTranscript('s 1', { limit: 200 });
  assert.equal(calls[0].url, 'http://x:3000/api/transcripts/s%201?limit=200');
  assert.equal(out.content, 'hello');
});

test('termdeck.getRecentTranscripts: unwraps { sessions: [...] }', async () => {
  const { fetchImpl } = makeFetch(() => ({ body: { sessions: [{ session_id: 'a', chunks: [] }] } }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  const out = await td.getRecentTranscripts({ minutes: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, 'a');
});

test('termdeck client issues ONLY GET requests (read-only by construction)', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { content: '', sessions: [] } }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  await td.listSessions();
  await td.getSession('a');
  await td.getBuffer('a');
  await td.getTranscript('a');
  await td.getRecentTranscripts();
  assert.ok(calls.length >= 5);
  for (const c of calls) assert.equal(c.method, 'GET', `unexpected ${c.method} ${c.url}`);
});

test('termdeck client throws on non-2xx with .status', async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 500, body: { error: 'boom' } }));
  const td = createTermdeckClient({ baseUrl: 'http://x:3000', fetchImpl });
  await assert.rejects(() => td.getSession('a'), (e) => e.status === 500 && /boom/.test(e.message));
});

// ── Mnestra client ───────────────────────────────────────────────────────────

test('mnestra.recall: reads the LIVE webhook { hits } shape, normalizes to the field allowlist', async () => {
  // The live webhook recall op returns rows under `hits` (RAG shape:
  // { ok, hits, text, tokens_used }) — NOT `memories`. This pins the REAL
  // contract; the prior version mocked `{memories:[...]}`, a shape the webhook
  // never emits, which let a recall-returns-empty bug ship past the unit tests
  // (caught only by the live connector smoke on 2026-06-08).
  const { fetchImpl, calls } = makeFetch(() => ({ body: {
    ok: true,
    tokens_used: 42,
    text: 'synthesized RAG answer — the client returns rows, not this text',
    hits: [{ content: 'm1', source_type: 'decision', project: 'termdeck', similarity: 0.8, created_at: '2026-01-01', secret_extra: 'LEAK' }],
  } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  const out = await mn.recall({ query: 'hi', project: 'termdeck' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.op, 'recall');
  assert.equal(calls[0].body.question, 'hi');
  assert.equal(calls[0].body.project, 'termdeck');
  assert.equal(out.total, 1);
  assert.equal(out.memories[0].content, 'm1');
  assert.equal(out.memories[0].similarity, 0.8);
  // allowlist projection: an unexpected field on the row must NOT survive
  assert.equal(out.memories[0].secret_extra, undefined);
});

test('mnestra.recall: falls back to a { memories } shape (score → similarity) for compat', async () => {
  const { fetchImpl } = makeFetch(() => ({ body: {
    ok: true,
    memories: [{ content: 'm2', source_type: 'decision', score: 0.5 }],
  } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  const out = await mn.recall({ query: 'hi' });
  assert.equal(out.total, 1);
  assert.equal(out.memories[0].content, 'm2');
  assert.equal(out.memories[0].similarity, 0.5); // score → similarity
});

test('mnestra.search: POST op=search, reads { hits }', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, hits: [{ content: 'h1', source_type: 'reference' }] } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  const out = await mn.search({ query: 'q', sourceType: 'reference' });
  assert.equal(calls[0].body.op, 'search');
  assert.equal(calls[0].body.query, 'q');
  assert.equal(calls[0].body.source_type, 'reference');
  assert.equal(out.hits[0].content, 'h1');
});

test('mnestra client emits ONLY read ops (recall|search|status), never a write op', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { memories: [], hits: [] } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await mn.recall({ query: 'a' });
  await mn.search({ query: 'b' });
  await mn.status();
  const ops = calls.map((c) => c.body && c.body.op);
  assert.deepEqual([...new Set(ops)].sort(), ['recall', 'search', 'status']);
  for (const op of ops) assert.ok(['recall', 'search', 'status'].includes(op), `forbidden op: ${op}`);
});

test('mnestra.recall rejects an empty query before any network call', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: {} }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await assert.rejects(() => mn.recall({ query: '   ' }), /non-empty query/);
  assert.equal(calls.length, 0);
});

test('mnestra client clamps min_results into [1,25]', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { memories: [] } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await mn.recall({ query: 'a', minResults: 9999 });
  assert.equal(calls[0].body.min_results, 25);
});

// ── webhook shared-secret (mnestra ≥ 0.7.0 fail-closed gate) ──────────────────

function secretHeaderOf(call) {
  // makeFetch records init.headers verbatim; the client merges authHeaders in
  // via requestJson's { accept, ...headers }. Look up case-insensitively.
  const h = call.headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-mnestra-secret') return h[k];
  return undefined;
}

test('mnestra: attaches x-mnestra-secret from env.MNESTRA_WEBHOOK_SECRET on every read op', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, hits: [] } }));
  const mn = createMnestraClient({
    webhookUrl: 'http://x:37778/mnestra',
    fetchImpl,
    env: { MNESTRA_WEBHOOK_SECRET: 'sek-from-env' },
  });
  await mn.recall({ query: 'a' });
  await mn.search({ query: 'b' });
  await mn.status();
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(secretHeaderOf(c), 'sek-from-env');
});

test('mnestra: opts.secret overrides env and rides the propose write op too', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, id: 'inbox-1', status: 'pending' } }));
  const mn = createMnestraClient({
    webhookUrl: 'http://x:37778/mnestra',
    fetchImpl,
    secret: 'explicit-sek',
    env: { MNESTRA_WEBHOOK_SECRET: 'ignored-env-sek' },
  });
  const out = await mn.propose({ sourceAgent: 'claude-web', text: 'hello' });
  assert.equal(out.id, 'inbox-1');
  assert.equal(calls[0].body.op, 'propose');
  assert.equal(secretHeaderOf(calls[0]), 'explicit-sek');
});

test('mnestra: NO secret header when none is configured (backward-compat with a pre-0.7.0 ungated webhook)', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, hits: [] } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl, env: {} });
  await mn.recall({ query: 'a' });
  assert.equal(secretHeaderOf(calls[0]), undefined);
});

test('mnestra: the secret is a HEADER only — never leaks into the request body', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, hits: [] } }));
  const mn = createMnestraClient({
    webhookUrl: 'http://x:37778/mnestra',
    fetchImpl,
    env: { MNESTRA_WEBHOOK_SECRET: 'top-secret-value' },
  });
  await mn.recall({ query: 'a', project: 'termdeck' });
  const bodyStr = JSON.stringify(calls[0].body);
  assert.ok(!bodyStr.includes('top-secret-value'), 'secret must not appear in the request body');
  assert.equal(secretHeaderOf(calls[0]), 'top-secret-value');
});

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_session_record (Sprint 84 T2) — end-of-conversation capture for web
// surfaces.
//
// Covers: caps boundaries, the dedicated token bucket, the mnestra client's
// sessionRecord() op-shape + 400/501 mapping, connector-identity resolution
// (explicit map wins / heuristic fallback / STRICT-MAP mode / unmappable
// rejects / caller-supplied source_agent IGNORED), the ingress
// reject-not-scrub scan, the dark-ship mount gate
// (TERMDECK_BRIDGE_ENABLE_SESSION_RECORD, independent of the propose gate),
// registerTools annotation preservation, the honest sweep-floor report, and
// the invariant the whole design rests on: NO session_id ever crosses the
// wire.
//
// Hermetic by construction: every env bag points the redact + propose-map
// loaders at /nonexistent files, so no test ever reads ~/.termdeck state.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/policy');
const { buildTools } = require('../src/tools');
const {
  buildSessionRecordTools, createSessionRecordRateLimiter, checkSessionRecordCaps,
  SUMMARY_MAX_CHARS, CONVERSATION_KEY_MAX_CHARS, PROJECT_MAX_CHARS,
  TOPICS_MAX, TOPIC_MAX_CHARS, METADATA_MAX_BYTES, RUMEN_SWEEP_MIN_MESSAGES,
} = require('../src/tools/session-record');
const { createMnestraClient } = require('../src/clients/mnestra');

// Hermetic env: never read real ~/.termdeck files; session-record enabled.
function hermeticEnv(extra = {}) {
  return {
    TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
    TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/bridge-propose.json',
    TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1',
    ...extra,
  };
}

function fakeSessionClients(impl) {
  const calls = [];
  return {
    calls,
    clients: {
      mnestra: {
        recall: async () => ({ memories: [], total: 0 }),
        search: async () => ({ hits: [], total: 0 }),
        status: async () => ({ ok: true }),
        propose: async () => ({ id: 'inbox-1', status: 'pending' }),
        sessionRecord: async (args) => {
          calls.push(args);
          return impl
            ? impl(args)
            : { id: 'sess-uuid-1', sessionId: `web:${args.sourceAgent}:${args.conversationKey}` };
        },
      },
      termdeck: {
        listSessions: async () => [],
        getSession: async () => ({}),
        getBuffer: async () => ({}),
        getTranscript: async () => ({ content: '', lines: [], chunks: [] }),
        getRecentTranscripts: async () => [],
      },
    },
  };
}

function fakeIdentity(records = {}) {
  return { getClient: async (id) => records[id] };
}

function extraFor(clientId) {
  return { authInfo: { token: 't', clientId, scopes: [], expiresAt: 0 } };
}

function buildHandler({ records, env, now, impl } = {}) {
  const { clients, calls } = fakeSessionClients(impl);
  const tools = buildSessionRecordTools({
    clients,
    identity: fakeIdentity(records || { mcp_claude: { client_id: 'mcp_claude', client_name: 'Claude' } }),
    policy,
    env: env || hermeticEnv(),
    now,
  });
  assert.equal(tools.length, 1);
  return { handler: tools[0].handler, descriptor: tools[0], calls };
}

const OK_ARGS = {
  conversation_key: 'conv-alpha',
  summary: 'We settled on the two-guard upsert for the session-record RPC.',
  project: 'termdeck',
  messages_count: 12,
};

function textOf(res) {
  return (res && res.content && res.content[0] && res.content[0].text) || '';
}

// ── caps ─────────────────────────────────────────────────────────────────────

test('caps: conversation_key required, trimmed, 200-char boundary, charset gated', () => {
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k', summary: 's' }).ok, true);
  assert.equal(checkSessionRecordCaps({ summary: 's' }).ok, false);
  assert.equal(checkSessionRecordCaps({ conversationKey: '   ', summary: 's' }).ok, false);
  assert.equal(checkSessionRecordCaps({ conversationKey: 42, summary: 's' }).ok, false);
  assert.equal(
    checkSessionRecordCaps({ conversationKey: 'k'.repeat(CONVERSATION_KEY_MAX_CHARS), summary: 's' }).ok,
    true, '200 exactly is fine');
  const over = checkSessionRecordCaps({ conversationKey: 'k'.repeat(CONVERSATION_KEY_MAX_CHARS + 1), summary: 's' });
  assert.equal(over.ok, false);
  assert.match(over.reason, /200/);
  for (const bad of ['has space', 'sl/ash', 'quote"', 'semi;colon', 'new\nline', 'per%cent']) {
    assert.equal(checkSessionRecordCaps({ conversationKey: bad, summary: 's' }).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(checkSessionRecordCaps({ conversationKey: 'aZ0._-:@', summary: 's' }).ok, true);
});

test('caps: summary required, trimmed, 8000-char boundary enforced', () => {
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k' }).ok, false);
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k', summary: '  ' }).ok, false);
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k', summary: 42 }).ok, false);
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k', summary: 'A'.repeat(SUMMARY_MAX_CHARS) }).ok, true);
  const over = checkSessionRecordCaps({ conversationKey: 'k', summary: 'A'.repeat(SUMMARY_MAX_CHARS + 1) });
  assert.equal(over.ok, false);
  assert.match(over.reason, /8000/);
  // post-trim semantics
  assert.equal(
    checkSessionRecordCaps({ conversationKey: 'k', summary: `  ${'A'.repeat(SUMMARY_MAX_CHARS)}  ` }).ok, true);
  // multi-unit code points count as UTF-16 length (stricter than the DB)
  assert.equal(checkSessionRecordCaps({ conversationKey: 'k', summary: '😀'.repeat(4001) }).ok, false);
});

test('caps: project boundary; messages_count non-negative + truncated', () => {
  const base = { conversationKey: 'k', summary: 's' };
  assert.equal(checkSessionRecordCaps({ ...base, project: 'p'.repeat(PROJECT_MAX_CHARS) }).ok, true);
  const over = checkSessionRecordCaps({ ...base, project: 'p'.repeat(PROJECT_MAX_CHARS + 1) });
  assert.equal(over.ok, false);
  assert.match(over.reason, /128/);
  assert.equal(checkSessionRecordCaps({ ...base, project: '   ' }).value.project, undefined);

  assert.equal(checkSessionRecordCaps({ ...base, messagesCount: -1 }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, messagesCount: 'five' }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, messagesCount: Number.NaN }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, messagesCount: 0 }).value.messagesCount, 0);
  assert.equal(checkSessionRecordCaps({ ...base, messagesCount: 7.9 }).value.messagesCount, 7);
});

test('caps: timestamps must be ISO-ish and ordered; normalized to ISO', () => {
  const base = { conversationKey: 'k', summary: 's' };
  assert.equal(checkSessionRecordCaps({ ...base, ended_at: 'nope' }).ok, true, 'snake_case key is not the contract');
  assert.equal(checkSessionRecordCaps({ ...base, endedAt: 'nope' }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, startedAt: 42 }).ok, false);
  const bad = checkSessionRecordCaps({
    ...base, startedAt: '2026-07-31T12:00:00Z', endedAt: '2026-07-31T11:00:00Z',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /started_at is after ended_at/);
  const good = checkSessionRecordCaps({
    ...base, startedAt: '2026-07-31T11:00:00Z', endedAt: '2026-07-31T12:00:00Z',
  });
  assert.equal(good.value.startedAt, '2026-07-31T11:00:00.000Z');
  assert.equal(good.value.endedAt, '2026-07-31T12:00:00.000Z');
});

test('caps: topics array bounds; metadata plain object within 8192 bytes', () => {
  const base = { conversationKey: 'k', summary: 's' };
  assert.equal(checkSessionRecordCaps({ ...base, topics: 'nope' }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, topics: [1] }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, topics: Array(TOPICS_MAX).fill('t') }).ok, true);
  assert.equal(checkSessionRecordCaps({ ...base, topics: Array(TOPICS_MAX + 1).fill('t') }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, topics: ['t'.repeat(TOPIC_MAX_CHARS + 1)] }).ok, false);
  // blank entries are dropped, not rejected
  assert.deepEqual(checkSessionRecordCaps({ ...base, topics: ['a', '  ', 'b'] }).value.topics, ['a', 'b']);

  assert.equal(checkSessionRecordCaps({ ...base, metadata: { a: 1 } }).ok, true);
  assert.equal(checkSessionRecordCaps({ ...base, metadata: ['array'] }).ok, false);
  assert.equal(checkSessionRecordCaps({ ...base, metadata: { pad: 'x'.repeat(METADATA_MAX_BYTES - 10) } }).ok, true);
  const overMeta = checkSessionRecordCaps({ ...base, metadata: { pad: 'x'.repeat(METADATA_MAX_BYTES - 9) } });
  assert.equal(overMeta.ok, false);
  assert.match(overMeta.reason, /8192/);
  const circ = {}; circ.self = circ;
  assert.equal(checkSessionRecordCaps({ ...base, metadata: circ }).ok, false);
});

// ── rate limiter ─────────────────────────────────────────────────────────────

test('rate limiter: separate bucket set, burst 2 default, refill, per-key isolation', () => {
  let t = 0;
  const lim = createSessionRecordRateLimiter({ ratePerHour: 6, burst: 2, now: () => t });
  assert.equal(lim.check('a').ok, true);
  assert.equal(lim.check('a').ok, true);
  const denied = lim.check('a');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec > 0);
  // a different connector is unaffected
  assert.equal(lim.check('b').ok, true);
  // 10 minutes = one token at 6/hour
  t += 10 * 60 * 1000;
  assert.equal(lim.check('a').ok, true);
});

// ── connector identity ───────────────────────────────────────────────────────

test('identity: explicit map wins over the client_name heuristic', async () => {
  const { handler, calls } = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'Claude' } },
    env: hermeticEnv({ TERMDECK_BRIDGE_PROPOSE_MAP: 'mcp_x=grok-web' }),
  });
  const res = await handler(OK_ARGS, extraFor('mcp_x'));
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].sourceAgent, 'grok-web');
});

test('identity: ChatGPT and Grok connectors resolve by name when the map is silent', async () => {
  // This is the Sprint-84 FINDING in test form: an unmapped connector still
  // resolves through the heuristic, which is why strict mode exists below.
  for (const [name, agent] of [
    ['ChatGPT', 'chatgpt-web'],
    ['OpenAI ChatGPT', 'chatgpt-web'],
    ['Grok', 'grok-web'],
    ['xAI Grok', 'grok-web'],
    ['Claude', 'claude-web'],
  ]) {
    const { handler, calls } = buildHandler({
      records: { mcp_x: { client_id: 'mcp_x', client_name: name } },
    });
    const res = await handler(OK_ARGS, extraFor('mcp_x'));
    assert.equal(res.isError, undefined, `${name} should resolve`);
    assert.equal(calls[0].sourceAgent, agent);
  }
});

test('identity: STRICT MAP mode refuses everything the operator has not listed', async () => {
  const env = hermeticEnv({ TERMDECK_BRIDGE_PROPOSE_STRICT_MAP: '1' });
  assert.equal(policy.isStrictMapMode(env), true);
  assert.equal(policy.isStrictMapMode(hermeticEnv()), false, 'strict mode is OFF by default');

  // Named "ChatGPT" but unmapped → refused under strict mode.
  const { handler, calls } = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'ChatGPT' } },
    env,
  });
  const res = await handler(OK_ARGS, extraFor('mcp_x'));
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not mapped to a web source agent/);
  assert.equal(calls.length, 0, 'an unmapped connector must never reach the store');

  // Same connector, now explicitly mapped → accepted under strict mode.
  const mapped = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'ChatGPT' } },
    env: hermeticEnv({
      TERMDECK_BRIDGE_PROPOSE_STRICT_MAP: '1',
      TERMDECK_BRIDGE_PROPOSE_MAP: 'mcp_x=chatgpt-web',
    }),
  });
  const res2 = await mapped.handler(OK_ARGS, extraFor('mcp_x'));
  assert.equal(res2.isError, undefined);
  assert.equal(mapped.calls[0].sourceAgent, 'chatgpt-web');
});

test('identity: unmappable / anonymous / unresolvable clients are refused with no write', async () => {
  // No authInfo at all
  const a = buildHandler();
  assert.equal((await a.handler(OK_ARGS, {})).isError, true);
  assert.equal(a.calls.length, 0);

  // client_name that matches no family
  const b = buildHandler({ records: { mcp_x: { client_id: 'mcp_x', client_name: 'Acme Bot' } } });
  assert.equal((await b.handler(OK_ARGS, extraFor('mcp_x'))).isError, true);
  assert.equal(b.calls.length, 0);

  // ambiguous name matching two families
  const c = buildHandler({ records: { mcp_x: { client_id: 'mcp_x', client_name: 'Claude via Google' } } });
  assert.equal((await c.handler(OK_ARGS, extraFor('mcp_x'))).isError, true);
  assert.equal(c.calls.length, 0);

  // identity.getClient throws → no name → fail closed
  const { clients, calls } = fakeSessionClients();
  const tools = buildSessionRecordTools({
    clients,
    identity: { getClient: async () => { throw new Error('store down'); } },
    policy,
    env: hermeticEnv(),
  });
  assert.equal((await tools[0].handler(OK_ARGS, extraFor('mcp_x'))).isError, true);
  assert.equal(calls.length, 0);
});

test('identity: a caller-supplied source_agent is IGNORED, never honored', async () => {
  const { handler, calls } = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'Grok' } },
  });
  const res = await handler(
    { ...OK_ARGS, source_agent: 'claude', sourceAgent: 'orchestrator' },
    extraFor('mcp_x'),
  );
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].sourceAgent, 'grok-web', 'identity comes from the connector, never the args');
});

// ── the session_id guard ─────────────────────────────────────────────────────

test('no session_id is ever forwarded — the store mints it', async () => {
  const { handler, calls } = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'Grok' } },
  });
  const cliSessionUuid = '4cf3a05f-d627-4c96-80fe-ef39d85e357f';
  const res = await handler(
    {
      ...OK_ARGS,
      conversation_key: cliSessionUuid,
      // every spelling a caller might try
      session_id: cliSessionUuid,
      sessionId: cliSessionUuid,
    },
    extraFor('mcp_x'),
  );
  assert.equal(res.isError, undefined);
  const forwarded = Object.keys(calls[0]);
  assert.ok(
    !forwarded.some((k) => /session_?id/i.test(k)),
    `no session-id argument may be forwarded; got ${forwarded.join(',')}`,
  );
  assert.equal(res.structuredContent.session_id, `web:grok-web:${cliSessionUuid}`);
});

// ── the honest sweep-floor report ────────────────────────────────────────────

test('a sub-floor conversation is recorded and SAID to be sub-floor, never inflated', async () => {
  const { handler, calls } = buildHandler({ impl: () => ({ id: 's1', sessionId: 'web:claude-web:conv-alpha' }) });
  const res = await handler({ ...OK_ARGS, messages_count: 1 }, extraFor('mcp_claude'));
  assert.equal(res.isError, undefined);
  assert.equal(calls[0].messagesCount, 1, 'the count is forwarded exactly as reported');
  assert.equal(res.structuredContent.below_sweep_floor, true);
  assert.match(textOf(res), new RegExp(`${RUMEN_SWEEP_MIN_MESSAGES}-message threshold`));
  assert.match(textOf(res), /Do not re-send it with an inflated count/);
});

test('an absent messages_count counts as 0 and is reported sub-floor', async () => {
  const { handler } = buildHandler();
  const res = await handler(
    { conversation_key: 'k', summary: 'a summary' },
    extraFor('mcp_claude'),
  );
  assert.equal(res.structuredContent.messages_count, 0);
  assert.equal(res.structuredContent.below_sweep_floor, true);
});

test('an at-floor conversation carries no sub-floor warning', async () => {
  const { handler } = buildHandler();
  const res = await handler(
    { ...OK_ARGS, messages_count: RUMEN_SWEEP_MIN_MESSAGES },
    extraFor('mcp_claude'),
  );
  assert.equal(res.structuredContent.below_sweep_floor, false);
  assert.ok(!/threshold/.test(textOf(res)));
});

// ── provenance stamp ─────────────────────────────────────────────────────────

test('the bridge provenance stamp cannot be spoofed by caller metadata', async () => {
  const { handler, calls } = buildHandler({
    records: { mcp_x: { client_id: 'mcp_x', client_name: 'Grok' } },
  });
  await handler(
    { ...OK_ARGS, metadata: { topic: 'x', bridge: { client_id: 'FORGED', source_agent: 'claude' } } },
    extraFor('mcp_x'),
  );
  assert.deepEqual(calls[0].metadata.bridge, {
    client_id: 'mcp_x', client_name: 'Grok', source_agent: 'grok-web',
  });
  assert.equal(calls[0].metadata.topic, 'x', 'caller metadata is preserved alongside the stamp');
});

// ── ingress secret scan ──────────────────────────────────────────────────────

test('a summary carrying a secret is REFUSED, not scrubbed — and the reason never echoes it', async () => {
  const secret = 'sk-ant-' + 'A1b2C3d4'.repeat(6);
  const { handler, calls } = buildHandler();
  const res = await handler(
    { ...OK_ARGS, summary: `We fixed the auth bug. The key was ${secret}` },
    extraFor('mcp_claude'),
  );
  assert.equal(res.isError, true);
  assert.match(textOf(res), /rule class/i);
  assert.ok(!textOf(res).includes(secret), 'the matched secret must never echo back through the cloud');
  assert.equal(calls.length, 0, 'nothing is stored, and nothing is scrubbed-and-forwarded');
});

test('the scan covers metadata and topics too, not just the summary', async () => {
  const secret = 'sk-ant-' + 'Z9y8X7w6'.repeat(6);
  const meta = buildHandler();
  assert.equal((await meta.handler({ ...OK_ARGS, metadata: { note: secret } }, extraFor('mcp_claude'))).isError, true);
  assert.equal(meta.calls.length, 0);
  const tops = buildHandler();
  assert.equal((await tops.handler({ ...OK_ARGS, topics: [secret.slice(0, 60)] }, extraFor('mcp_claude'))).isError, true);
  assert.equal(tops.calls.length, 0);
});

// ── the mnestra client wire shape ────────────────────────────────────────────

function fakeFetch(handlerFn) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const out = handlerFn(body, url, init);
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status || 200,
      headers: { get: () => 'application/json' },
      json: async () => out.body,
      text: async () => JSON.stringify(out.body),
    };
  };
}

test('client: sessionRecord posts op=session_record with snake_case args and no session_id', async () => {
  let seen = null;
  const client = createMnestraClient({
    env: {}, fetchImpl: fakeFetch((body) => {
      seen = body;
      return { body: { ok: true, id: 'row-1', session_id: 'web:grok-web:k' } };
    }),
  });
  const out = await client.sessionRecord({
    sourceAgent: 'grok-web',
    conversationKey: 'k',
    summary: 'body',
    project: 'termdeck',
    messagesCount: 4,
    startedAt: '2026-07-31T10:00:00.000Z',
    endedAt: '2026-07-31T10:30:00.000Z',
    topics: ['a'],
    metadata: { m: 1 },
  });
  assert.deepEqual(out, { id: 'row-1', sessionId: 'web:grok-web:k' });
  assert.equal(seen.op, 'session_record');
  assert.deepEqual(Object.keys(seen).sort(), [
    'conversation_key', 'ended_at', 'messages_count', 'metadata', 'op',
    'project', 'source_agent', 'started_at', 'summary', 'topics',
  ]);
});

test('client: sessionRecord requires a resolved agent, key and summary', async () => {
  const client = createMnestraClient({ env: {}, fetchImpl: fakeFetch(() => ({ body: { ok: true, id: 'x' } })) });
  await assert.rejects(client.sessionRecord({ conversationKey: 'k', summary: 's' }), /resolved source agent/);
  await assert.rejects(client.sessionRecord({ sourceAgent: 'grok-web', summary: 's' }), /conversation key/);
  await assert.rejects(client.sessionRecord({ sourceAgent: 'grok-web', conversationKey: 'k' }), /non-empty summary/);
});

test('client: a 400 becomes a refusal carrying the reason; a 501 names the upgrade', async () => {
  const four = createMnestraClient({
    env: {}, fetchImpl: fakeFetch(() => ({
      status: 400, body: { ok: false, error: 'MEMORY_SESSION_RECORD_REJECTED: session_locked' },
    })),
  });
  await assert.rejects(
    four.sessionRecord({ sourceAgent: 'grok-web', conversationKey: 'k', summary: 's' }),
    /session record refused:.*session_locked/,
  );

  const five = createMnestraClient({
    env: {}, fetchImpl: fakeFetch(() => ({ status: 501, body: { ok: false, error: 'not available' } })),
  });
  await assert.rejects(
    five.sessionRecord({ sourceAgent: 'grok-web', conversationKey: 'k', summary: 's' }),
    /no session_record op.*migration 035/,
  );
});

test('client: an ok:false or id-less 200 is not treated as success', async () => {
  const c = createMnestraClient({ env: {}, fetchImpl: fakeFetch(() => ({ body: { ok: true } })) });
  await assert.rejects(
    c.sessionRecord({ sourceAgent: 'grok-web', conversationKey: 'k', summary: 's' }),
    /unexpected session_record response/,
  );
});

// ── mount gate ───────────────────────────────────────────────────────────────

function mountClients({ withSessionRecord = true } = {}) {
  const { clients } = fakeSessionClients();
  if (!withSessionRecord) delete clients.mnestra.sessionRecord;
  return clients;
}

const IDENTITY = { getClient: async () => ({ client_id: 'mcp_x', client_name: 'Claude' }) };
const wrap = (h) => h;

function namesFor(env, opts = {}) {
  const tools = buildTools({
    withEgressRedaction: wrap,
    policy,
    clients: opts.clients || mountClients(),
    identity: 'identity' in opts ? opts.identity : IDENTITY,
    env,
  });
  return tools.map((t) => t.name);
}

test('mount gate: absent the flag, memory_session_record does not exist at all', () => {
  const names = namesFor({ TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/x.json' });
  assert.ok(!names.includes('memory_session_record'));
  assert.equal(names.length, 6, 'the six read-only tools only');
});

test('mount gate: the two write channels are independently gated', () => {
  const base = { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/x.json', TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/p.json' };
  const sessionOnly = namesFor({ ...base, TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1' });
  assert.ok(sessionOnly.includes('memory_session_record'));
  assert.ok(!sessionOnly.includes('memory_propose'), 'enabling session record must not enable propose');

  const proposeOnly = namesFor({ ...base, TERMDECK_BRIDGE_ENABLE_PROPOSE: '1' });
  assert.ok(proposeOnly.includes('memory_propose'));
  assert.ok(!proposeOnly.includes('memory_session_record'), 'enabling propose must not enable session record');

  const both = namesFor({ ...base, TERMDECK_BRIDGE_ENABLE_PROPOSE: '1', TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1' });
  assert.equal(both.length, 8, 'the operator-visible /healthz tool count moves 6 -> 7 -> 8');
  assert.deepEqual(both.slice(-2), ['memory_propose', 'memory_session_record']);
});

test('mount gate: flag ON but a pipeline piece missing ⇒ the tool is still absent', () => {
  const env = { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/x.json', TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1' };
  assert.ok(!namesFor(env, { identity: null }).includes('memory_session_record'), 'no identity source ⇒ no channel');
  assert.ok(
    !namesFor(env, { clients: mountClients({ withSessionRecord: false }) }).includes('memory_session_record'),
    'a client without sessionRecord() ⇒ no channel',
  );
});

test('mount gate: the mounted descriptor keeps HONEST annotations and is approval-gated', () => {
  const tools = buildTools({
    withEgressRedaction: wrap,
    policy,
    clients: mountClients(),
    identity: IDENTITY,
    env: { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/x.json', TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1' },
  });
  const t = tools.find((x) => x.name === 'memory_session_record');
  assert.equal(t.annotations.readOnlyHint, false, 'the tool must not lie about being a write');
  assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.annotations.idempotentHint, false);
  assert.equal(t.annotations.openWorldHint, true);
  assert.equal(t.approval, true, 'a write crossing the bridge gets per-call human approval');
  assert.equal(policy.requiresApproval('memory_session_record'), true);
});

test('policy: assertReadOnly admits the honest shape and rejects every impostor', () => {
  const HONEST = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  assert.equal(policy.assertReadOnly({ name: 'memory_session_record', annotations: HONEST }), true);
  assert.throws(
    () => policy.assertReadOnly({ name: 'memory_session_record', annotations: { ...HONEST, readOnlyHint: true } }),
    /honest/i, 'a lying readOnlyHint:true must not mount');
  assert.throws(
    () => policy.assertReadOnly({ name: 'memory_session_record', annotations: { ...HONEST, destructiveHint: true } }),
    /honest/i);
  // an unregistered near-name is caught by the verb heuristic, honest shape or not
  for (const name of ['session_record', 'panel_record', 'memory_capture']) {
    assert.throws(() => policy.assertReadOnly({ name, annotations: HONEST }), /read-only/i,
      `${name} is not in the registry and must be rejected`);
    assert.throws(() => policy.assertReadOnly({ name, annotations: { readOnlyHint: true } }), /read-only/i,
      `${name} lying readOnlyHint:true must still be rejected by the name heuristic`);
  }
});

// ── egress redaction still applies to the RESULT path ────────────────────────

test('the tool result still passes egress redaction', async () => {
  const { withEgressRedaction } = require('../src/server');
  const { clients } = fakeSessionClients(() => ({
    id: 'row-1',
    sessionId: 'web:claude-web:' + ('sk-ant-' + 'A1b2C3d4'.repeat(6)).slice(0, 40),
  }));
  const tools = buildTools({
    withEgressRedaction,
    policy,
    clients,
    identity: IDENTITY,
    env: { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/x.json', TERMDECK_BRIDGE_ENABLE_SESSION_RECORD: '1' },
  });
  const t = tools.find((x) => x.name === 'memory_session_record');
  const res = await t.handler(OK_ARGS, extraFor('mcp_x'));
  const serialized = JSON.stringify(res);
  assert.ok(!/sk-ant-A1b2C3d4A1b2C3d4/.test(serialized), 'a secret echoed by the store must not egress');
});

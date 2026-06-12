'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// memory_propose (Sprint 76) — the quarantined proposal channel.
//
// Covers (per T2 brief § 7): caps boundaries, the per-connector token bucket,
// the mnestra client's propose() op-shape + 400 mapping, connector-identity
// resolution (explicit map wins / heuristic fallback / unmappable rejects /
// caller-supplied source_agent IGNORED), the ingress reject-not-scrub scan
// (reason names rule classes, never the matched text), the dark-ship mount
// gate (TERMDECK_BRIDGE_ENABLE_PROPOSE), end-to-end handler runs with a
// mocked webhook, registerTools annotation preservation (honest
// readOnlyHint:false survives registration), and a leak-gate-style proof that
// the tool RESULT path still passes egress redaction.
//
// Hermetic by construction: every env bag points the redact + propose loaders
// at /nonexistent files, so no test ever reads ~/.termdeck state.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/policy');
const redact = require('../src/redact');
const { buildTools } = require('../src/tools');
const {
  buildProposeTools, createProposeRateLimiter, checkProposalCaps,
  TEXT_MAX_CHARS, PROJECT_HINT_MAX_CHARS, METADATA_MAX_BYTES,
} = require('../src/tools/propose');
const { createMnestraClient } = require('../src/clients/mnestra');

const IDENTITY_WRAP = (h) => h;

// Hermetic env: never read real ~/.termdeck files; propose channel enabled.
function hermeticEnv(extra = {}) {
  return {
    TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/bridge-redact.json',
    TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/bridge-propose.json',
    TERMDECK_BRIDGE_ENABLE_PROPOSE: '1',
    ...extra,
  };
}

// Recording fake of the mnestra client's propose() — the unit seam for handler
// tests (the wire shape itself is pinned by the createMnestraClient tests).
function fakeProposeClients(impl) {
  const calls = [];
  return {
    calls,
    clients: {
      mnestra: {
        recall: async () => ({ memories: [], total: 0 }),
        search: async () => ({ hits: [], total: 0 }),
        status: async () => ({ ok: true }),
        propose: async (args) => {
          calls.push(args);
          return impl ? impl(args) : { id: 'inbox-uuid-1', status: 'pending' };
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
  const { clients, calls } = fakeProposeClients(impl);
  const tools = buildProposeTools({
    clients,
    identity: fakeIdentity(records || { mcp_claude: { client_id: 'mcp_claude', client_name: 'Claude' } }),
    policy,
    env: env || hermeticEnv(),
    now,
  });
  assert.equal(tools.length, 1);
  return { handler: tools[0].handler, descriptor: tools[0], calls };
}

// Runtime-built secret canaries (gitleaks-inert source, real shapes).
const mkAnthropic = () => 'sk-ant-' + 'A1b2C3d4'.repeat(6);
const FIXTURE_LITERAL = 'ACME-INTERNAL-S76';

// ── caps ─────────────────────────────────────────────────────────────────────

test('caps: text required, trimmed, 4000-char boundary enforced', () => {
  assert.equal(checkProposalCaps({ text: 'a fact' }).ok, true);
  assert.equal(checkProposalCaps({}).ok, false);
  assert.equal(checkProposalCaps({ text: '   ' }).ok, false);
  assert.equal(checkProposalCaps({ text: 42 }).ok, false);
  assert.equal(checkProposalCaps({ text: 'A'.repeat(TEXT_MAX_CHARS) }).ok, true, '4000 exactly is fine');
  const over = checkProposalCaps({ text: 'A'.repeat(TEXT_MAX_CHARS + 1) });
  assert.equal(over.ok, false, '4001 must be rejected');
  assert.match(over.reason, /4000/);
  // post-trim semantics: 4000 chars + surrounding whitespace is fine
  assert.equal(checkProposalCaps({ text: `  ${'A'.repeat(TEXT_MAX_CHARS)}  ` }).ok, true);
  // multi-unit code points count as UTF-16 length (stricter than the DB — conservative direction)
  assert.equal(checkProposalCaps({ text: '😀'.repeat(2001) }).ok, false);
});

test('caps: project_hint 128-char boundary; empty collapses to absent', () => {
  assert.equal(checkProposalCaps({ text: 'x', projectHint: 'p'.repeat(PROJECT_HINT_MAX_CHARS) }).ok, true);
  const over = checkProposalCaps({ text: 'x', projectHint: 'p'.repeat(PROJECT_HINT_MAX_CHARS + 1) });
  assert.equal(over.ok, false);
  assert.match(over.reason, /128/);
  assert.equal(checkProposalCaps({ text: 'x', projectHint: 42 }).ok, false);
  assert.equal(checkProposalCaps({ text: 'x', projectHint: '   ' }).value === undefined, false);
  assert.equal(checkProposalCaps({ text: 'x', projectHint: '   ' }).value.projectHint, undefined);
});

test('caps: metadata must be a plain object within 8192 serialized bytes', () => {
  assert.equal(checkProposalCaps({ text: 'x', metadata: { a: 1 } }).ok, true);
  assert.equal(checkProposalCaps({ text: 'x', metadata: ['array'] }).ok, false);
  assert.equal(checkProposalCaps({ text: 'x', metadata: 'string' }).ok, false);
  // {"pad":"<N x's>"} serializes to N + 10 bytes
  assert.equal(checkProposalCaps({ text: 'x', metadata: { pad: 'x'.repeat(METADATA_MAX_BYTES - 10) } }).ok, true);
  const over = checkProposalCaps({ text: 'x', metadata: { pad: 'x'.repeat(METADATA_MAX_BYTES - 9) } });
  assert.equal(over.ok, false);
  assert.match(over.reason, /8192/);
  // circular → not serializable → rejected, not thrown
  const circ = {}; circ.self = circ;
  assert.equal(checkProposalCaps({ text: 'x', metadata: circ }).ok, false);
});

// ── rate limiter ─────────────────────────────────────────────────────────────

test('rate limiter: burst, deny with retry window, refill, per-key isolation', () => {
  let t = 0;
  const rl = createProposeRateLimiter({ ratePerHour: 10, burst: 3, now: () => t });
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.check('a').ok, true);
  assert.equal(rl.check('a').ok, true, 'burst of 3 admits 3 immediately');
  const denied = rl.check('a');
  assert.equal(denied.ok, false, '4th within the window is denied');
  assert.equal(denied.retryAfterSec, 360, '1 token at 10/h accrues in 360s');
  assert.equal(rl.check('b').ok, true, 'a different connector has its own bucket');
  t += 360_000; // one token accrues
  assert.equal(rl.check('a').ok, true, 'refilled after the retry window');
  assert.equal(rl.check('a').ok, false, 'and only one token accrued');
});

test('rate limiter: steady-state rate is bounded by ratePerHour, not burst', () => {
  let t = 0;
  const rl = createProposeRateLimiter({ ratePerHour: 3600, burst: 1, now: () => t });
  assert.equal(rl.check('k').ok, true);
  assert.equal(rl.check('k').ok, false);
  t += 1000; // 1/s refill
  assert.equal(rl.check('k').ok, true);
});

// ── mnestra client propose() ─────────────────────────────────────────────────

function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const r = (handler ? handler(String(url), init) : {}) || {};
    const status = r.status || 200;
    const bodyObj = r.body !== undefined ? r.body : {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(bodyObj) };
  };
  return { fetchImpl, calls };
}

test('mnestra.propose: emits the exact T1 wire shape, bounded {id,status} projection', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, id: 'uuid-1', status: 'pending', full_row: 'NEVER' } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  const out = await mn.propose({ sourceAgent: 'claude-web', text: 'a fact', projectHint: 'termdeck', metadata: { bridge: { client_id: 'mcp_x' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    op: 'propose',
    source_agent: 'claude-web',
    text: 'a fact',
    project_hint: 'termdeck',
    metadata: { bridge: { client_id: 'mcp_x' } },
  });
  assert.deepEqual(out, { id: 'uuid-1', status: 'pending' }, 'projection is id+status ONLY — never the row');
});

test('mnestra.propose: optional fields omitted from the wire when absent', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, id: 'u', status: 'pending' } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await mn.propose({ sourceAgent: 'grok-web', text: 't' });
  assert.equal('project_hint' in calls[0].body, false);
  assert.equal('metadata' in calls[0].body, false);
});

test('mnestra.propose: webhook 400 is rethrown carrying the webhook reason', async () => {
  const { fetchImpl } = makeFetch(() => ({ status: 400, body: { ok: false, error: 'MEMORY_PROPOSE_REJECTED: text exceeds 4000 chars' } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await assert.rejects(
    () => mn.propose({ sourceAgent: 'claude-web', text: 'x' }),
    /proposal refused by the memory inbox: .*MEMORY_PROPOSE_REJECTED: text exceeds 4000 chars/,
  );
});

test('mnestra.propose: validates sourceAgent + text before any network call; rejects malformed 200s', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, id: 'u' } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await assert.rejects(() => mn.propose({ text: 'x' }), /source agent/);
  await assert.rejects(() => mn.propose({ sourceAgent: 'claude-web', text: '  ' }), /non-empty text/);
  assert.equal(calls.length, 0, 'no network hop for locally-invalid input');
  const bad = makeFetch(() => ({ body: { ok: false } }));
  const mn2 = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl: bad.fetchImpl });
  await assert.rejects(() => mn2.propose({ sourceAgent: 'claude-web', text: 'x' }), /unexpected propose response/);
});

test('mnestra client still emits no canonical write op — propose is the only addition', async () => {
  const { fetchImpl, calls } = makeFetch(() => ({ body: { ok: true, id: 'u', status: 'pending', hits: [], memories: [] } }));
  const mn = createMnestraClient({ webhookUrl: 'http://x:37778/mnestra', fetchImpl });
  await mn.recall({ query: 'a' });
  await mn.search({ query: 'b' });
  await mn.status();
  await mn.propose({ sourceAgent: 'claude-web', text: 'c' });
  const ops = calls.map((c) => c.body && c.body.op);
  assert.deepEqual([...new Set(ops)].sort(), ['propose', 'recall', 'search', 'status']);
  assert.equal(typeof mn.remember, 'undefined');
  assert.equal(typeof mn.forget, 'undefined');
  assert.equal(typeof mn.post, 'undefined', 'no generic post(op) escape hatch');
});

// ── mount gating (dark ship + fail-closed identity) ──────────────────────────

function mountEnvTools({ env, identity } = {}) {
  const { clients } = fakeProposeClients();
  return buildTools({
    withEgressRedaction: IDENTITY_WRAP,
    policy,
    clients,
    identity: identity === undefined ? fakeIdentity({}) : identity,
    env,
  });
}

test('mount: enabled flag + identity → memory_propose present with honest annotations + approval', () => {
  const tools = mountEnvTools({ env: hermeticEnv() });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('memory_propose'), `expected memory_propose in ${names}`);
  const t = tools.find((x) => x.name === 'memory_propose');
  assert.equal(t.annotations.readOnlyHint, false, 'honest: it DOES write (to quarantine)');
  assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.annotations.idempotentHint, false);
  assert.equal(t.annotations.openWorldHint, true);
  assert.equal(t.approval, true, 'approval comes from policy.requiresApproval — explicit true');
});

test('mount: WITHOUT the enable flag the tool does not exist (ships dark)', () => {
  const tools = mountEnvTools({ env: hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '' }) });
  assert.ok(!tools.map((t) => t.name).includes('memory_propose'));
  const tools2 = mountEnvTools({ env: { TERMDECK_BRIDGE_REDACT_FILE: '/nonexistent/r.json', TERMDECK_BRIDGE_PROPOSE_FILE: '/nonexistent/p.json' } });
  assert.ok(!tools2.map((t) => t.name).includes('memory_propose'), 'absent flag = dark');
});

test('mount: WITHOUT an identity source the tool does not exist (fail-closed), flag notwithstanding', () => {
  const tools = mountEnvTools({ env: hermeticEnv(), identity: null });
  assert.ok(!tools.map((t) => t.name).includes('memory_propose'));
});

test('mount: existing six read tools are untouched in both modes', () => {
  const SIX = ['list_panels', 'memory_recall', 'memory_search', 'panel_status', 'read_panel', 'recent_activity'];
  const dark = mountEnvTools({ env: hermeticEnv({ TERMDECK_BRIDGE_ENABLE_PROPOSE: '' }) });
  assert.deepEqual(dark.map((t) => t.name).sort(), SIX);
  const lit = mountEnvTools({ env: hermeticEnv() });
  assert.deepEqual(lit.map((t) => t.name).sort(), ['memory_propose', ...SIX].sort());
  for (const t of lit) {
    if (t.name !== 'memory_propose') {
      assert.equal(t.annotations.readOnlyHint, true, `${t.name} stays read-only`);
    }
  }
});

// ── handler pipeline ─────────────────────────────────────────────────────────

test('handler: heuristic identity (client_name) resolves and is stamped into the forwarded payload', async () => {
  const { handler, calls } = buildHandler({});
  const r = await handler({ text: 'a durable kitchen-level fact' }, extraFor('mcp_claude'));
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceAgent, 'claude-web');
  assert.equal(calls[0].metadata.bridge.client_id, 'mcp_claude');
  assert.equal(calls[0].metadata.bridge.client_name, 'Claude');
  assert.equal(calls[0].metadata.bridge.source_agent, 'claude-web');
  assert.match(r.content[0].text, /QUARANTINED PENDING REVIEW/);
  assert.match(r.content[0].text, /inbox-uuid-1/);
  assert.match(r.content[0].text, /not .*saved to memory/i);
  assert.deepEqual(r.structuredContent, { id: 'inbox-uuid-1', status: 'pending', source_agent: 'claude-web' });
});

test('handler: explicit operator map WINS over the client_name heuristic', async () => {
  const { handler, calls } = buildHandler({
    env: hermeticEnv({ TERMDECK_BRIDGE_PROPOSE_MAP: 'mcp_claude=grok-web' }),
  });
  await handler({ text: 'fact' }, extraFor('mcp_claude'));
  assert.equal(calls[0].sourceAgent, 'grok-web');
});

test('handler: caller-supplied source_agent in args is IGNORED — identity is server-derived', async () => {
  const { handler, calls } = buildHandler({});
  const r = await handler(
    { text: 'fact', source_agent: 'grok', metadata: { bridge: { client_id: 'SPOOF', source_agent: 'orchestrator' } } },
    extraFor('mcp_claude'),
  );
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].sourceAgent, 'claude-web', 'smuggled args.source_agent must not reach the wire');
  assert.equal(calls[0].metadata.bridge.client_id, 'mcp_claude', 'caller metadata.bridge is overwritten (spoof-proof)');
  assert.equal(calls[0].metadata.bridge.source_agent, 'claude-web');
});

test('handler: unmappable connector is REFUSED with operator guidance; nothing forwarded', async () => {
  const { handler, calls } = buildHandler({ records: { mcp_mystery: { client_id: 'mcp_mystery', client_name: 'SomeRandomClient' } } });
  const r = await handler({ text: 'fact' }, extraFor('mcp_mystery'));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not mapped to a web source agent/);
  assert.match(r.content[0].text, /mcp_mystery/, 'operator needs the client_id to map it');
  assert.match(r.content[0].text, /bridge-propose\.json/);
  assert.equal(calls.length, 0);
});

test('handler: missing/unknown client record (e.g. static-dev-bearer) is refused unless explicitly mapped', async () => {
  const { handler, calls } = buildHandler({ records: {} });
  const r = await handler({ text: 'fact' }, extraFor('static-dev-bearer'));
  assert.equal(r.isError, true);
  assert.equal(calls.length, 0);
  const mapped = buildHandler({ records: {}, env: hermeticEnv({ TERMDECK_BRIDGE_PROPOSE_MAP: 'static-dev-bearer=claude-web' }) });
  const r2 = await mapped.handler({ text: 'fact' }, extraFor('static-dev-bearer'));
  assert.equal(r2.isError, undefined);
  assert.equal(mapped.calls[0].sourceAgent, 'claude-web');
});

test('handler: no authInfo at all is refused (fail-closed)', async () => {
  const { handler, calls } = buildHandler({});
  for (const extra of [undefined, {}, { authInfo: {} }]) {
    const r = await handler({ text: 'fact' }, extra);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /identity/);
  }
  assert.equal(calls.length, 0);
});

test('handler: caps enforced before any forward (4001 chars rejected; ditto oversized merged metadata)', async () => {
  const { handler, calls } = buildHandler({});
  const r = await handler({ text: 'A'.repeat(4001) }, extraFor('mcp_claude'));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /4000/);
  // merged-metadata cap includes the bridge stamp
  const r2 = await handler({ text: 'ok', metadata: { pad: 'x'.repeat(8190) } }, extraFor('mcp_claude'));
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /8192/);
  assert.equal(calls.length, 0);
});

test('handler: per-connector rate limit — burst then 429-style error naming the retry window; isolation per client', async () => {
  let t = 0;
  const records = {
    mcp_claude: { client_id: 'mcp_claude', client_name: 'Claude' },
    mcp_grok: { client_id: 'mcp_grok', client_name: 'xAI Grok' },
  };
  const { handler, calls } = buildHandler({ records, now: () => t });
  for (let i = 0; i < 3; i++) {
    const r = await handler({ text: `fact ${i}` }, extraFor('mcp_claude'));
    assert.equal(r.isError, undefined, `burst call ${i} should pass`);
  }
  const denied = await handler({ text: 'fact 4' }, extraFor('mcp_claude'));
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /rate limit/);
  assert.match(denied.content[0].text, /retry in ~6 minutes/);
  const other = await handler({ text: 'other lane' }, extraFor('mcp_grok'));
  assert.equal(other.isError, undefined, 'another connector is unaffected');
  t += 360_000;
  const refilled = await handler({ text: 'after refill' }, extraFor('mcp_claude'));
  assert.equal(refilled.isError, undefined);
  assert.equal(calls.length, 5);
});

test('handler: ingress scan REJECTS a builtin-pattern secret — reason names the rule class, never the text', async () => {
  const { handler, calls } = buildHandler({});
  const secret = mkAnthropic();
  const r = await handler({ text: `the key is ${secret}` }, extraFor('mcp_claude'));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /anthropic-key/);
  assert.match(r.content[0].text, /never stored, never scrubbed/);
  assert.ok(!r.content[0].text.includes(secret), 'the matched secret must NOT echo back');
  assert.equal(calls.length, 0, 'reject means reject — nothing forwarded');
});

test('handler: ingress scan rejects an operator-denylisted literal anywhere in the payload (incl. metadata values)', async () => {
  const env = hermeticEnv({ TERMDECK_BRIDGE_REDACT_LITERALS: FIXTURE_LITERAL });
  const { handler, calls } = buildHandler({ env });
  const inText = await handler({ text: `see ${FIXTURE_LITERAL} runbook` }, extraFor('mcp_claude'));
  assert.equal(inText.isError, true);
  assert.match(inText.content[0].text, /denylist-0/);
  assert.ok(!inText.content[0].text.includes(FIXTURE_LITERAL));
  const inMeta = await handler({ text: 'clean', metadata: { note: `ref ${FIXTURE_LITERAL}` } }, extraFor('mcp_claude'));
  assert.equal(inMeta.isError, true);
  const inProject = await handler({ text: 'clean', project: FIXTURE_LITERAL }, extraFor('mcp_claude'));
  assert.equal(inProject.isError, true);
  assert.equal(calls.length, 0);
});

test('handler: clean proposals pass the scan and forward trimmed text + project_hint', async () => {
  const { handler, calls } = buildHandler({});
  const r = await handler({ text: '  a clean fact  ', project: ' termdeck ' }, extraFor('mcp_claude'));
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].text, 'a clean fact');
  assert.equal(calls[0].projectHint, 'termdeck');
});

test('handler: webhook refusal (400) surfaces the inbox reason as a tidy isError', async () => {
  const { handler } = buildHandler({
    impl: () => { throw new Error('proposal refused by the memory inbox: HTTP 400 — MEMORY_PROPOSE_REJECTED: invalid source_agent'); },
  });
  const r = await handler({ text: 'fact' }, extraFor('mcp_claude'));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /proposal refused by the memory inbox/);
  assert.match(r.content[0].text, /invalid source_agent/);
});

// ── registration honesty (server.js registerTools) ──────────────────────────

test('registerTools: preserves honest readOnlyHint:false for memory_propose; still stamps true on read tools', () => {
  const { registerTools } = require('../src/server');
  const { clients } = fakeProposeClients();
  const tools = buildTools({
    withEgressRedaction: IDENTITY_WRAP,
    policy,
    clients,
    identity: fakeIdentity({}),
    env: hermeticEnv(),
  });
  const captured = [];
  const fakeMcpServer = { registerTool: (name, config, handler) => captured.push({ name, config, handler }) };
  const n = registerTools(fakeMcpServer, { tools, policy });
  assert.equal(n, tools.length);
  const propose = captured.find((c) => c.name === 'memory_propose');
  assert.ok(propose, 'memory_propose registered');
  assert.equal(propose.config.annotations.readOnlyHint, false, 'the honest write hint must SURVIVE registration');
  assert.equal(propose.config.annotations.destructiveHint, false);
  assert.ok(propose.config._meta && propose.config._meta['termdeck/requiresApproval'] === true, 'approval _meta advisory present');
  assert.ok(propose.config.inputSchema && 'text' in propose.config.inputSchema, 'zod raw shape resolved (real zod)');
  assert.equal('source_agent' in propose.config.inputSchema, false, 'source_agent is NOT in the input schema');
  for (const c of captured) {
    if (c.name !== 'memory_propose') {
      assert.equal(c.config.annotations.readOnlyHint, true, `${c.name} must still be stamped read-only`);
    }
  }
});

test('registerTools: a lying memory_propose impostor cannot reach registration (assertReadOnly throws at mount)', () => {
  const { registerTools } = require('../src/server');
  const impostor = [{
    name: 'memory_propose',
    description: 'impostor',
    annotations: { readOnlyHint: true }, // lies
    handler: async () => ({ content: [] }),
  }];
  const fakeMcpServer = { registerTool: () => { throw new Error('must never be reached'); } };
  assert.throws(() => registerTools(fakeMcpServer, { tools: impostor, policy }), /honest/i);
});

// ── egress invariant on the RESULT path (leak-gate idiom) ────────────────────

test('EGRESS: a hostile webhook response cannot leak through the propose result (redactDeep + scan clean)', async () => {
  // The inbox id comes back from the webhook — if that backend were ever
  // compromised/misbehaving and echoed secret-shaped content, the egress wrap
  // must scrub it before it reaches the provider cloud.
  const FAKE_JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', 'F'.repeat(24)].join('.');
  const { clients } = fakeProposeClients(() => ({ id: `uuid-${FAKE_JWT}`, status: 'pending' }));
  const wrap = (h) => async (a, e) => redact.redactDeep(await h(a, e));
  const tools = buildTools({
    withEgressRedaction: wrap,
    policy,
    clients,
    identity: fakeIdentity({ mcp_claude: { client_id: 'mcp_claude', client_name: 'Claude' } }),
    env: hermeticEnv(),
  });
  const handler = tools.find((t) => t.name === 'memory_propose').handler;
  const r = await handler({ text: 'clean fact' }, extraFor('mcp_claude'));
  assert.equal(r.isError, undefined);
  const flat = JSON.stringify(r);
  assert.ok(!flat.includes(FAKE_JWT), 'JWT-shaped backend content must not egress');
  assert.equal(redact.scan(flat).clean, true, 'scan finds no residual secret in the tool result');
});

'use strict';

// termdeck-base.test.js — live-deck API base resolution.
//
// Pins the fix for the hardcoded-:3000 bug (claude.ai feedback + 2026-06-13
// bug_fix memory): with the deck on :3001/:3002/:3099 the panel tools reported
// "no visible panels". Covers the full resolution-order contract of
// src/clients/termdeck-base.js: env override wins → ports.json state file
// (stale-pid pruning, freshest-first, probe-verified) → fixed port probe →
// TTL cache + reportFailure() re-resolution — plus the client-level
// heal-across-restart retry in src/clients/termdeck.js.
//
// Run: node --test packages/mcp-bridge/test/termdeck-base.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createBaseResolver, DEFAULT_BASE, PROBE_PORTS, _defaultIsPidAlive } = require('../src/clients/termdeck-base');
const { createTermdeckClient } = require('../src/clients/termdeck');

// A recording fake fetch keyed by port. `livePorts` maps port → body handler
// (or a literal body). Ports absent from the map REFUSE (throw, like
// ECONNREFUSED). Mutate `livePorts` mid-test to simulate a deck restart.
function makePortFetch(livePorts) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push({ port: Number(u.port), path: u.pathname + u.search });
    const entry = livePorts[u.port];
    if (entry === undefined) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const body = typeof entry === 'function' ? entry(u) : entry;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}

// A fake fs exposing just readFileSync, recording reads.
function makeFsWithPortsFile(contents) {
  const reads = [];
  return {
    reads,
    fsImpl: {
      readFileSync(p) {
        reads.push(String(p));
        if (contents === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return typeof contents === 'string' ? contents : JSON.stringify(contents);
      },
    },
  };
}

const NO_STATE = () => makeFsWithPortsFile(undefined);

// ── (2a) env override ────────────────────────────────────────────────────────

test('resolver: TERMDECK_API_BASE env wins — no state read, no probe', async () => {
  const { fetchImpl, calls } = makePortFetch({});
  const { fsImpl, reads } = NO_STATE();
  const r = createBaseResolver({ env: { TERMDECK_API_BASE: 'http://127.0.0.1:3001/' }, fetchImpl, fsImpl });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3001'); // trailing slash stripped
  assert.equal(calls.length, 0, 'must not probe when env-pinned');
  assert.equal(reads.length, 0, 'must not read state when env-pinned');
});

test('resolver: TERMDECK_BASE_URL is honored as the env alias', async () => {
  const { fetchImpl, calls } = makePortFetch({});
  const r = createBaseResolver({ env: { TERMDECK_BASE_URL: 'http://x:3099' }, fetchImpl, fsImpl: NO_STATE().fsImpl });
  assert.equal(await r.resolve(), 'http://x:3099');
  assert.equal(calls.length, 0);
});

test('resolver: env override survives reportFailure (never invalidated)', async () => {
  const { fetchImpl, calls } = makePortFetch({});
  const r = createBaseResolver({ env: { TERMDECK_API_BASE: 'http://x:3001' }, fetchImpl, fsImpl: NO_STATE().fsImpl });
  await r.resolve();
  r.reportFailure();
  assert.equal(await r.resolve(), 'http://x:3001');
  assert.equal(calls.length, 0);
});

// ── (2b) ports.json state file ───────────────────────────────────────────────

test('resolver: state file wins — freshest startedAt entry, probe-verified', async () => {
  const { fetchImpl, calls } = makePortFetch({ 3005: [], 3007: [] });
  const { fsImpl } = makeFsWithPortsFile({ version: 1, decks: [
    { port: 3005, pid: 111, startedAt: '2026-07-30T10:00:00Z' },
    { port: 3007, pid: 222, startedAt: '2026-07-31T10:00:00Z' }, // freshest
  ] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl, isPidAlive: () => true });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3007');
  assert.deepEqual(calls.map((c) => c.port), [3007], 'freshest first; older entry never probed');
});

test('resolver: dead-pid state entries are pruned on read', async () => {
  const { fetchImpl, calls } = makePortFetch({ 3005: [], 3007: [] });
  const { fsImpl } = makeFsWithPortsFile({ version: 1, decks: [
    { port: 3005, pid: 111, startedAt: '2026-07-30T10:00:00Z' }, // alive
    { port: 3007, pid: 222, startedAt: '2026-07-31T10:00:00Z' }, // dead (fresher!)
  ] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl, isPidAlive: (pid) => pid === 111 });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3005');
  assert.ok(!calls.some((c) => c.port === 3007), 'dead-pid entry must never be probed');
});

test('resolver: state entry that does not answer falls through to the probe list', async () => {
  // ports.json says 3005 (pid alive — e.g. pid reuse), but nothing serves it;
  // the live deck is on 3001. The stale entry must not capture the bridge.
  const { fetchImpl, calls } = makePortFetch({ 3001: [] });
  const { fsImpl } = makeFsWithPortsFile({ version: 1, decks: [
    { port: 3005, pid: 111, startedAt: '2026-07-31T10:00:00Z' },
  ] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl, isPidAlive: () => true });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3001');
  assert.deepEqual(calls.map((c) => c.port), [3005, 3000, 3001]);
});

test('resolver: corrupt ports.json is tolerated (falls through to probe)', async () => {
  const { fetchImpl } = makePortFetch({ 3002: [] });
  const { fsImpl } = makeFsWithPortsFile('{not json!!');
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3002');
});

// ── (2c) fixed port probe ────────────────────────────────────────────────────

test('resolver: probe picks the first responder in 3000→3001→3002→3099 order, skipping dead ports', async () => {
  assert.deepEqual(PROBE_PORTS, [3000, 3001, 3002, 3099], 'probe list contract (NOTE: :3100 excluded — non-TermDeck app)');
  const { fetchImpl, calls } = makePortFetch({ 3002: [{ id: 'a', pid: 1, meta: {} }], 3099: [] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3002');
  assert.deepEqual(calls.map((c) => c.port), [3000, 3001, 3002], 'stops at first responder; 3099 never probed');
});

test('resolver: a 200 that is NOT a JSON array (non-TermDeck shape) is skipped', async () => {
  // Some other app squatting a probe port must not be mistaken for a deck.
  const { fetchImpl } = makePortFetch({ 3000: { ok: true, app: 'not-termdeck' }, 3001: [] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3001');
});

test('resolver: nothing answers → returns the historical default, UNCACHED', async () => {
  const { fetchImpl, calls } = makePortFetch({});
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  assert.equal(await r.resolve(), DEFAULT_BASE);
  const afterFirst = calls.length;
  assert.equal(await r.resolve(), DEFAULT_BASE);
  assert.ok(calls.length > afterFirst, 'a no-deck answer must not be cached — next call re-probes');
});

// ── TTL cache + reportFailure ────────────────────────────────────────────────

test('resolver: TTL cache — within TTL no re-probe; after expiry re-probes', async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = makePortFetch({ 3001: [] });
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl, ttlMs: 60_000, now: () => clock });
  await r.resolve();
  const afterFirst = calls.length;
  clock += 30_000; // inside TTL
  assert.equal(await r.resolve(), 'http://127.0.0.1:3001');
  assert.equal(calls.length, afterFirst, 'cached — no network inside TTL');
  clock += 31_000; // past TTL
  await r.resolve();
  assert.ok(calls.length > afterFirst, 'TTL expiry re-probes');
});

test('resolver: reportFailure drops the cache so a deck restart on a new port heals', async () => {
  const live = { 3000: [] };
  const { fetchImpl } = makePortFetch(live);
  const r = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  assert.equal(await r.resolve(), 'http://127.0.0.1:3000');
  delete live[3000]; // deck dies…
  live[3001] = [];   // …and comes back on :3001
  assert.equal(await r.resolve(), 'http://127.0.0.1:3000', 'still cached until a failure is reported');
  r.reportFailure();
  assert.equal(await r.resolve(), 'http://127.0.0.1:3001');
});

// ── client integration (src/clients/termdeck.js) ─────────────────────────────

test('client: no explicit base → auto-resolves and lists sessions off the live port', async () => {
  const { fetchImpl, calls } = makePortFetch({ 3001: [{ id: 'a', pid: 1, meta: { label: 'A' } }] });
  const resolver = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  const td = createTermdeckClient({ env: {}, fetchImpl, baseResolver: resolver });
  assert.equal(td.baseUrl, null, 'dynamic mode exposes no static baseUrl');
  const out = await td.listSessions();
  assert.equal(out[0].id, 'a');
  assert.equal(calls[calls.length - 1].port, 3001);
  assert.equal(calls[calls.length - 1].path, '/api/sessions');
});

test('client: heals across a deck restart onto a new port WITHIN one call (re-resolve + retry)', async () => {
  const live = { 3000: [{ id: 'old', pid: 1, meta: {} }] };
  const { fetchImpl, calls } = makePortFetch(live);
  const resolver = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  const td = createTermdeckClient({ env: {}, fetchImpl, baseResolver: resolver });
  assert.equal((await td.listSessions())[0].id, 'old'); // resolves + caches :3000
  delete live[3000];
  live[3001] = [{ id: 'new', pid: 2, meta: {} }];       // restart on :3001
  const out = await td.listSessions();                  // one call: fail → re-resolve → retry
  assert.equal(out[0].id, 'new');
  assert.equal(calls[calls.length - 1].port, 3001);
});

test('client: HTTP-level errors pass through — no cache invalidation, no retry', async () => {
  let sessionsHits = 0;
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/api/sessions') { sessionsHits++; return { ok: true, status: 200, text: async () => '[]' }; }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no such session' }) };
  };
  const resolver = createBaseResolver({ env: {}, fetchImpl, fsImpl: NO_STATE().fsImpl });
  const td = createTermdeckClient({ env: {}, fetchImpl, baseResolver: resolver });
  await td.listSessions();
  const probesBefore = sessionsHits;
  await assert.rejects(() => td.getSession('nope'), (e) => e.status === 404);
  assert.equal(sessionsHits, probesBefore, '404 is the deck answering — must not trigger a re-probe');
});

test('client: explicit baseUrl keeps legacy static behavior (no resolver involved)', async () => {
  const { fetchImpl, calls } = makePortFetch({ 3000: [] });
  const td = createTermdeckClient({
    env: {},
    fetchImpl,
    baseUrl: 'http://127.0.0.1:3000',
    baseResolver: { resolve: () => { throw new Error('must not be called'); }, reportFailure() {} },
  });
  assert.equal(td.baseUrl, 'http://127.0.0.1:3000');
  await td.listSessions();
  assert.deepEqual(calls.map((c) => c.port), [3000]);
});

test('client: TERMDECK_API_BASE env pins the client (bootstrap parity)', async () => {
  const { fetchImpl, calls } = makePortFetch({ 3099: [] });
  const td = createTermdeckClient({ env: { TERMDECK_API_BASE: 'http://127.0.0.1:3099' }, fetchImpl });
  assert.equal(td.baseUrl, 'http://127.0.0.1:3099');
  await td.listSessions();
  assert.deepEqual(calls.map((c) => c.port), [3099]);
});

// ── pid-liveness helper ──────────────────────────────────────────────────────

test('_defaultIsPidAlive: own pid alive; junk pids dead', () => {
  assert.equal(_defaultIsPidAlive(process.pid), true);
  assert.equal(_defaultIsPidAlive(0), false);
  assert.equal(_defaultIsPidAlive(-5), false);
  assert.equal(_defaultIsPidAlive('12'), false);
});

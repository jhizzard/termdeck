// Sprint 71 B-T2 — tier-0 objectives: normalization, ordering, render, fetch.
//
// The feature's whole value is an ordering guarantee ("pinned above recall,
// never buried"), so most of what is worth testing here IS the ordering — and
// the degradation, because this ships before engram migration 038 is live and
// "no objectives yet" must be indistinguishable from correct behavior rather
// than from a broken feature.
//
// Run: node --test packages/server/tests/tier0.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tier0 = require('../src/tier0');

// ── normalization ───────────────────────────────────────────────────────────

test('normalizeObjective — accepts the canonical shape', () => {
  const o = tier0.normalizeObjective({
    id: 'obj-1', project: 'termdeck', rank: 1, text: 'No TypeScript.',
    status: 'active', ratified_by: 'joshua', ratified_at: '2026-08-01T00:00:00Z',
    supersedes: null,
  });
  assert.deepEqual(o, {
    id: 'obj-1', project: 'termdeck', rank: 1, text: 'No TypeScript.',
    status: 'active', ratified_by: 'joshua', ratified_at: '2026-08-01T00:00:00Z',
    supersedes: null,
  });
});

test('normalizeObjective — tolerates column-name variants for text/rank/status', () => {
  // B-T1's marker was not frozen when this shipped. Guessing the column name
  // wrong yields an EMPTY block, which is indistinguishable from "this store
  // has no objectives" — the worst possible failure for this feature, since
  // it looks exactly like correct degradation.
  for (const key of ['text', 'objective', 'content', 'body', 'statement']) {
    const o = tier0.normalizeObjective({ id: 'x', [key]: 'Ship it' });
    assert.equal(o && o.text, 'Ship it', `text key "${key}" must be understood`);
  }
  for (const key of ['rank', 'ordinal', 'position', 'sort_order', 'priority']) {
    const o = tier0.normalizeObjective({ text: 't', [key]: 3 });
    assert.equal(o.rank, 3, `rank key "${key}" must be understood`);
  }
  for (const key of ['status', 'state']) {
    const o = tier0.normalizeObjective({ text: 't', [key]: 'active' });
    assert.equal(o.status, 'active', `status key "${key}" must be understood`);
  }
});

test('normalizeObjective — drops rows with no usable text', () => {
  assert.equal(tier0.normalizeObjective({ id: 'x', rank: 1 }), null);
  assert.equal(tier0.normalizeObjective({ id: 'x', text: '   ' }), null);
  assert.equal(tier0.normalizeObjective(null), null);
  assert.equal(tier0.normalizeObjective('a string'), null);
});

test('normalizeObjective — clamps a pathologically long objective', () => {
  const o = tier0.normalizeObjective({ text: 'x'.repeat(5000) });
  assert.equal(o.text.length, tier0.TIER0_MAX_TEXT_CHARS);
  assert.ok(o.text.endsWith('…'), 'truncation is visible, not silent');
});

// ── ordering: the actual feature ────────────────────────────────────────────

test('ordering — rank ascending is the pin order', () => {
  const out = tier0.normalizeObjectives([
    { id: 'c', text: 'third', rank: 3 },
    { id: 'a', text: 'first', rank: 1 },
    { id: 'b', text: 'second', rank: 2 },
  ]);
  assert.deepEqual(out.map((o) => o.text), ['first', 'second', 'third']);
});

test('ordering — REGRESSION: an unranked objective sorts LAST, not first', () => {
  // The bug this pins: Number(null) === 0 and Number.isFinite(0) === true, so
  // coercing before null-checking promotes every unranked row to rank 0 — i.e.
  // above the operator's actual rank-1 objective. Caught by a smoke test, not
  // by review.
  const out = tier0.normalizeObjectives([
    { id: 'u', text: 'unranked' },
    { id: 'a', text: 'ranked one', rank: 1 },
  ]);
  assert.deepEqual(out.map((o) => o.text), ['ranked one', 'unranked']);
  assert.equal(out[1].rank, null, 'unranked stays null, it is not invented as 0');
});

test('ordering — a genuine rank 0 is preserved and sorts first', () => {
  const out = tier0.normalizeObjectives([
    { id: 'a', text: 'one', rank: 1 },
    { id: 'z', text: 'zero', rank: 0 },
  ]);
  assert.deepEqual(out.map((o) => o.text), ['zero', 'one']);
});

test('ordering — is total and stable (ties broken by ratified_at then id)', () => {
  const rows = [
    { id: 'b', text: 'B', rank: 1, ratified_at: '2026-01-02' },
    { id: 'a', text: 'A', rank: 1, ratified_at: '2026-01-01' },
    { id: 'c', text: 'C', rank: 1, ratified_at: '2026-01-02' },
  ];
  const once = tier0.normalizeObjectives(rows).map((o) => o.id);
  const twice = tier0.normalizeObjectives(rows.slice().reverse()).map((o) => o.id);
  assert.deepEqual(once, ['a', 'b', 'c']);
  assert.deepEqual(once, twice,
    'input order must not affect output order — a block that reshuffles between '
    + 'compactions reads to the agent as drift');
});

test('ordering — cap is enforced and reported, never silent', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, text: `objective ${i}`, rank: i }));
  let reported = null;
  const out = tier0.normalizeObjectives(many, { onTruncate: (total, cap) => { reported = [total, cap]; } });
  assert.equal(out.length, tier0.TIER0_MAX_ROWS);
  assert.deepEqual(reported, [40, tier0.TIER0_MAX_ROWS],
    'a silently-capped list reads as "these are all the objectives" when it is not');
});

// ── render ──────────────────────────────────────────────────────────────────

test('renderTier0Block — empty list renders the empty string, not a bare heading', () => {
  assert.equal(tier0.renderTier0Block([]), '');
  assert.equal(tier0.renderTier0Block(null), '');
  // A heading over nothing reads as a broken feature; absence reads as absence.
});

test('renderTier0Block — numbers the objectives in pin order and states the contract', () => {
  const rows = tier0.normalizeObjectives([
    { id: 'a', text: 'No TypeScript.', rank: 1 },
    { id: 'b', text: 'Never leak the internal project name.', rank: 2 },
  ]);
  const block = tier0.renderTier0Block(rows);
  assert.match(block, /^## Objectives \(tier 0\)$/m);
  assert.match(block, /^1\. No TypeScript\.$/m);
  assert.match(block, /^2\. Never leak the internal project name\.$/m);
  assert.match(block, /binding/i, 'the block must say these are binding, not advisory');
  assert.match(block, /ratification/i, 'and that they change only by ratification');
  assert.ok(block.indexOf('1. No TypeScript.') < block.indexOf('2. Never leak'),
    'render order follows pin order');
});

test('renderTier0Block — reports the ratification count only when there is one', () => {
  const withStamp = tier0.renderTier0Block(tier0.normalizeObjectives([
    { id: 'a', text: 'x', rank: 1, ratified_at: '2026-08-01' },
  ]));
  assert.match(withStamp, /1 objective, 1 carrying a ratification stamp/);
  const without = tier0.renderTier0Block(tier0.normalizeObjectives([
    { id: 'a', text: 'x', rank: 1 },
  ]));
  assert.match(without, /1 objective\./);
  assert.doesNotMatch(without, /ratification stamp/);
});

// ── fetch + degradation ─────────────────────────────────────────────────────

const CREDS = { rag: { supabaseUrl: 'https://fixture.invalid', supabaseKey: 'k' } };

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return {
    ok, status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

test('fetch — RPC hit returns normalized objectives with source "rpc"', async () => {
  const calls = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonRes([{ id: 'a', text: 'Objective A', rank: 1 }]);
    },
  });
  const out = await p.fetch({ project: 'termdeck' });
  assert.equal(out.tier0_source, 'rpc');
  assert.equal(out.tier0.length, 1);
  assert.equal(out.tier0[0].text, 'Objective A');
  assert.equal(out.tier0_version, tier0.TIER0_PAYLOAD_VERSION);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/objective_list$/);
  assert.deepEqual(calls[0].body, { p_project: 'termdeck' });
});

test('fetch — probes the second arg shape on a PostgREST overload miss, then latches', async () => {
  // This is not hypothetical defensiveness: an unresolvable RPC overload 404
  // silently killed every Flashback query in this repo for fifteen sprints.
  const bodies = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    ttlMs: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('p_project' in body) {
        return jsonRes('Could not find the function public.objective_list(p_project)', { ok: false, status: 404 });
      }
      return jsonRes([{ id: 'a', text: 'A', rank: 1 }]);
    },
  });
  const first = await p.fetch({ project: 'termdeck' });
  assert.equal(first.tier0_source, 'rpc');
  assert.equal(first.tier0.length, 1);
  assert.deepEqual(bodies.map((b) => Object.keys(b)[0]), ['p_project', 'project']);

  await p.fetch({ project: 'termdeck' });
  assert.deepEqual(bodies.slice(2).map((b) => Object.keys(b)[0]), ['project'],
    'the accepted arg shape is latched — the failed shape is not retried forever');
});

test('fetch — falls back to a table read when the RPC is not deployed', async () => {
  const urls = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/rpc/')) return jsonRes('no function', { ok: false, status: 404 });
      return jsonRes([{ id: 'a', text: 'From table', rank: 1 }]);
    },
  });
  const out = await p.fetch({ project: 'termdeck' });
  assert.equal(out.tier0_source, 'table');
  assert.equal(out.tier0[0].text, 'From table');
  assert.ok(urls.some((u) => u.includes('memory_objectives')));
  assert.ok(urls.some((u) => u.includes('project=eq.termdeck')));
});

test('fetch — the table read constrains to the ACTIVE set, like the RPC does', async () => {
  const urls = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/rpc/')) return jsonRes('no function', { ok: false, status: 404 });
      return jsonRes([]);
    },
  });
  await p.fetch({ project: 'termdeck' });
  const tableUrl = urls.find((u) => u.includes('memory_objectives'));
  assert.match(tableUrl, /status=eq\.active/,
    'a superseded objective must not even be transferred, let alone injected');
});

test('REGRESSION — no project means NO objectives on the table path, matching the RPC', async () => {
  // The bug: the RPC sent `p_project: null` and got zero rows by design, while
  // the table path omitted the filter and returned EVERY project's objectives —
  // flat-sorted by rank so every project's rank-1 clustered at the top, then
  // wrapped in "these are binding constraints on this session". An agent in an
  // unresolved-project panel would have been handed three dozen projects'
  // constraints and told to defend them. Found by B-T1 reading the two paths
  // against each other; each path's own tests were green.
  const urls = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('/rpc/')) return jsonRes('no function', { ok: false, status: 404 });
      return jsonRes([
        { id: 'a', text: 'project one rank one', rank: 1, project: 'alpha' },
        { id: 'b', text: 'project two rank one', rank: 1, project: 'beta' },
      ]);
    },
  });
  const out = await p.fetch({ project: null });
  assert.deepEqual(out.tier0, [], 'cross-project tier 0 is not a mode');
  assert.ok(!urls.some((u) => u.includes('memory_objectives')),
    'the unfiltered table read must not even be issued');
});

test('BOUNDED — a hanging store times out and degrades to empty, it does not stall the caller', async () => {
  // Tier-0 reads sit on the critical path of `/api/ai/query` and of a
  // compaction. "No objectives" is a fine outcome; "the recall endpoint hangs"
  // is not.
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    timeoutMs: 50,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      // Never resolves on its own — only the abort signal ends it, which is
      // exactly what a wedged store looks like.
      init.signal.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  });
  const started = Date.now();
  const out = await p.fetch({ project: 'termdeck' });
  assert.deepEqual(out.tier0, []);
  assert.equal(out.tier0_source, 'unavailable');
  assert.ok(Date.now() - started < 3000, 'must not wait on a store that never answers');
});

test('BOUNDED — every request carries an abort signal', async () => {
  const seen = [];
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async (url, init) => {
      seen.push(!!(init && init.signal));
      if (url.includes('/rpc/')) return jsonRes('no function', { ok: false, status: 404 });
      return jsonRes([]);
    },
  });
  await p.fetch({ project: 'termdeck' });
  assert.ok(seen.length > 0);
  assert.ok(seen.every(Boolean), 'an unbounded request would be invisible until it hung');
});

test('DEGRADATION — no RAG config yields an empty payload, never a throw', async () => {
  const p = tier0.createTier0Provider({ config: {}, log: () => {} });
  const out = await p.fetch({ project: 'termdeck' });
  assert.deepEqual(out.tier0, []);
  assert.equal(out.tier0_source, 'unavailable');
});

test('DEGRADATION — pre-038 store (RPC 404 + table 404) yields an empty payload', async () => {
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async () => jsonRes('missing', { ok: false, status: 404 }),
  });
  const out = await p.fetch({ project: 'termdeck' });
  assert.deepEqual(out.tier0, []);
  assert.equal(out.tier0_source, 'unavailable');
});

test('DEGRADATION — a network throw yields an empty payload, never a rejection', async () => {
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  const out = await p.fetch({ project: 'termdeck' });
  assert.deepEqual(out.tier0, []);
  assert.equal(out.tier0_source, 'unavailable');
});

test('DEGRADATION — a malformed body yields an empty payload', async () => {
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new Error('not json'); }, async text() { return ''; } }),
  });
  const out = await p.fetch({ project: 'termdeck' });
  assert.deepEqual(out.tier0, []);
});

test('cache — a second call inside the TTL does not re-hit the store', async () => {
  let hits = 0;
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    ttlMs: 60_000,
    now: () => 1_000,
    fetchImpl: async () => { hits += 1; return jsonRes([{ id: 'a', text: 'A', rank: 1 }]); },
  });
  await p.fetch({ project: 'termdeck' });
  await p.fetch({ project: 'termdeck' });
  assert.equal(hits, 1);
  await p.fetch({ project: 'other' });
  assert.equal(hits, 2, 'the cache is per-project, not global');
});

test('cache — invalidate() clears both the rows and the capability latch', async () => {
  let hits = 0;
  const p = tier0.createTier0Provider({
    config: CREDS,
    log: () => {},
    now: () => 1_000,
    fetchImpl: async () => { hits += 1; return jsonRes([{ id: 'a', text: 'A', rank: 1 }]); },
  });
  await p.fetch({ project: 'termdeck' });
  p.invalidate();
  await p.fetch({ project: 'termdeck' });
  assert.equal(hits, 2);
  // A ratification that needs a server restart to become visible is not a
  // ratification mechanism.
  assert.equal(p._peek().rpcArgShape, 'p_project');
});

test('emptyTier0Payload — tier0 is always an array, never null or absent', () => {
  const e = tier0.emptyTier0Payload();
  assert.ok(Array.isArray(e.tier0));
  assert.equal(e.tier0.length, 0);
  assert.equal(e.tier0_source, 'unavailable');
  assert.equal(e.tier0_version, tier0.TIER0_PAYLOAD_VERSION);
});

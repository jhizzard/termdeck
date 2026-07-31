// Sprint 83 T3 — graph-expansion tests.
//
// The three invariants the module claims, each proven rather than asserted in
// a comment:
//
//   1. READ-ONLY BY CONSTRUCTION — no write ever leaves this module. Proven
//      three ways: source inspection for write SQL, an RPC-name pin on the
//      single outbound request, and a fetch stub that fails the test if any
//      request other than the one read RPC is issued.
//   2. ADDITIVE ONLY — expansion never mutates the inputs it is handed, so it
//      cannot perturb the ranking or the selected hit.
//   3. FEATURE-DETECTED + BOUNDED — a pre-034 store (404 "could not find the
//      function") latches the capability off and returns current behavior;
//      every failure mode fails open to `related: []`.
//
// Everything here is off-network and off-database: `fetchImpl` is injected, so
// the real request-building and error-latching paths run without either.
//
// Run: node --test packages/server/tests/graph-expansion.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gx = require('../src/graph-expansion');

const MODULE_PATH = path.join(__dirname, '..', 'src', 'graph-expansion.js');
const CONFIG = { rag: { supabaseUrl: 'https://example.test', supabaseKey: 'test-key' } };

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

// A seed set that always classifies as solved-problem, so tests exercise the
// RPC path rather than short-circuiting at seed selection.
const HIT = { id: 'aaaaaaaa-0000-0000-0000-000000000001', source_type: 'bug_fix', content: 'the hit' };

function edgeRow(overrides = {}) {
  return {
    memory_id: 'bbbbbbbb-0000-0000-0000-000000000002',
    seed_id: HIT.id,
    content: 'the fix',
    source_type: 'bug_fix',
    project: 'termdeck',
    metadata: {},
    privacy_tags: [],
    created_at: '2026-07-01T00:00:00.000Z',
    depth: 1,
    edge_type: 'fixed_by',
    edge_path: ['fixed_by'],
    direction: 'outbound',
    edge_weight: 0.9,
    ...overrides,
  };
}

// ── invariant 1: read-only ─────────────────────────────────────────────────

test('read-only: module source contains no write SQL and no database handle', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  // Strip comments first — the header explains at length what this module does
  // NOT do, and those words must not trip the scan.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [/\binsert\s+into\b/i, /\bupdate\s+\w+\s+set\b/i, /\bdelete\s+from\b/i, /\bdrop\s+table\b/i]) {
    assert.ok(!forbidden.test(code), `write SQL found in graph-expansion.js: ${forbidden}`);
  }
  // No SQLite handle reaches this module — it is not a parameter, and nothing
  // here prepares a statement.
  assert.ok(!/db\.prepare\(/.test(code), 'graph-expansion must not touch the SQLite handle');
});

test('read-only: exactly one outbound request, pinned to the read RPC', async () => {
  const calls = [];
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return jsonResponse([edgeRow()]); },
    env: {},
  });

  await expander.expand({ hit: HIT, memories: [HIT], project: 'termdeck' });

  assert.equal(calls.length, 1, 'expansion must issue exactly one request');
  assert.ok(calls[0].url.endsWith(`/rest/v1/rpc/${gx.CONTRACT.rpc}`), `unexpected endpoint: ${calls[0].url}`);
  // PostgREST distinguishes read RPCs from writes only by what the function
  // does, so the caller-side guarantee is that we call THIS function and no
  // other. Any second endpoint would be a new, unreviewed capability.
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(Object.keys(body).sort(), [
    gx.CONTRACT.params.maxDepth, gx.CONTRACT.params.maxRows,
    gx.CONTRACT.params.predicates, gx.CONTRACT.params.project, gx.CONTRACT.params.seedIds,
  ].sort(), 'RPC body keys are the PostgREST contract — a change here is a wire-format change');
});

test('read-only: expansion does not mutate the hit or the candidate list', async () => {
  const memories = [
    { id: 'a', source_type: 'bug_fix', content: 'x' },
    { id: 'b', source_type: 'fact', content: 'y' },
  ];
  const before = JSON.parse(JSON.stringify({ hit: memories[0], memories }));
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => jsonResponse([edgeRow({ seed_id: 'a' })]),
    env: {},
  });

  await expander.expand({ hit: memories[0], memories, project: null });

  assert.deepEqual({ hit: memories[0], memories }, before,
    'expansion must not touch the ranked inputs — that is what keeps it additive');
});

// ── invariant 3: feature detection + bounded failure ───────────────────────

test('pre-034 store: a 404 "could not find the function" latches expansion off permanently', async () => {
  let calls = 0;
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => { calls++; return errorResponse(404, 'Could not find the function public.memory_expand_typed'); },
    env: {},
  });

  const first = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.deepEqual(first.related, []);
  assert.equal(first.reason, 'unsupported');
  assert.equal(calls, 1);

  // The whole point of the latch: a pre-034 store pays ONE wasted round-trip,
  // ever — not one per error, forever.
  const second = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.equal(calls, 1, 'no second probe after the capability latched off');
  assert.equal(second.reason, 'unsupported');
  assert.equal(expander.available(), false);
});

test('transient failures fail open WITHOUT latching — one bad night must not disable the feature', async () => {
  let mode = 'boom';
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => {
      if (mode === 'boom') throw new Error('ECONNRESET');
      if (mode === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (mode === '500') return errorResponse(500, 'internal error');
      return jsonResponse([edgeRow()]);
    },
    env: {},
  });

  for (const m of ['boom', 'abort', '500']) {
    mode = m;
    const res = await expander.expand({ hit: HIT, memories: [HIT] });
    assert.deepEqual(res.related, [], `${m}: must fail open to an empty payload`);
    assert.equal(res.reason, 'error');
    assert.equal(expander.available(), true, `${m}: a transient failure must NOT latch the capability off`);
  }

  mode = 'ok';
  const recovered = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.equal(recovered.related.length, 1, 'must recover once the transient condition clears');
});

test('an unparseable body fails open rather than throwing into the toast path', async () => {
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); }, text: async () => '' }),
    env: {},
  });
  const res = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.deepEqual(res.related, []);
  assert.equal(res.reason, 'error');
});

test('no Supabase credentials: expansion is unavailable and never calls out', async () => {
  let called = false;
  const expander = gx.createExpander({ rag: { mnestraWebhookUrl: 'http://localhost:37778' } }, {
    fetchImpl: async () => { called = true; return jsonResponse([]); },
    env: {},
  });
  const res = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.equal(res.reason, 'not_configured');
  assert.equal(called, false);
  assert.equal(expander.available(), false);
});

test('TERMDECK_GRAPH_EXPANSION=0 hard-disables without a request', async () => {
  let called = false;
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => { called = true; return jsonResponse([]); },
    env: { TERMDECK_GRAPH_EXPANSION: '0' },
  });
  const res = await expander.expand({ hit: HIT, memories: [HIT] });
  assert.equal(res.reason, 'disabled');
  assert.equal(called, false);
});

// ── bounds ─────────────────────────────────────────────────────────────────

test('settings are clamped — env cannot turn a toast rider into a graph crawl', () => {
  const wild = gx.resolveExpansionSettings({
    TERMDECK_GRAPH_EXPANSION_MAX_DEPTH: '99',
    TERMDECK_GRAPH_EXPANSION_MAX_ROWS: '100000',
    TERMDECK_GRAPH_EXPANSION_MAX_SEEDS: '5000',
    TERMDECK_GRAPH_EXPANSION_TIMEOUT_MS: '999999',
  });
  assert.equal(wild.maxDepth, gx.LIMITS.maxDepth);
  assert.equal(wild.maxRows, gx.LIMITS.maxRows);
  assert.equal(wild.maxSeeds, gx.LIMITS.maxSeeds);
  assert.equal(wild.timeoutMs, gx.LIMITS.timeoutMs);

  const junk = gx.resolveExpansionSettings({ TERMDECK_GRAPH_EXPANSION_MAX_DEPTH: 'banana' });
  assert.equal(junk.maxDepth, gx.DEFAULTS.maxDepth, 'unparseable env falls back to the default, never to unbounded');
});

test('depth never exceeds 2 on the wire regardless of what the caller wants', async () => {
  let sent = null;
  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async (_u, o) => { sent = JSON.parse(o.body); return jsonResponse([]); },
    env: { TERMDECK_GRAPH_EXPANSION_MAX_DEPTH: '7' },
  });
  await expander.expand({ hit: HIT, memories: [HIT] });
  assert.equal(sent[gx.CONTRACT.params.maxDepth], 2);
});

// ── seed selection (I3) ────────────────────────────────────────────────────

test('seed selection requires at least one solved-problem-class candidate', () => {
  assert.deepEqual(
    gx.selectSeeds({ hit: { id: 'a', source_type: 'fact' }, memories: [{ id: 'a', source_type: 'fact' }] }),
    [],
    'a non-debugging error must not trigger a round-trip at all',
  );
});

test('seed selection uses category, not just source_type (the case that silently failed)', () => {
  // `debugging` is a CATEGORY value; migration 028's CHECK forbids it as a
  // source_type. A classifier keyed only on source_type reaches ~40% of the
  // solved-problem corpus and looks like it works.
  assert.equal(gx.isSolvedProblemClass({ source_type: 'decision', category: 'debugging' }), true);
  assert.equal(gx.isSolvedProblemClass({ source_type: 'bug_fix' }), true);
  assert.equal(gx.isSolvedProblemClass({ source_type: 'decision', category: 'workflow' }), false);
  assert.equal(gx.SOLVED_PROBLEM_SOURCE_TYPES.has('debugging'), false,
    'debugging must not be listed as a source_type — that would look like coverage while providing none');
});

test('a present problem_signature classifies regardless of type or category', () => {
  const m = { source_type: 'fact', metadata: { problem_signature: { v: 1, class: 'err-port-in-use' } } };
  assert.equal(gx.isSolvedProblemClass(m), true);
  assert.equal(gx.problemClassOf(m), 'err-port-in-use');
});

test('problem_signature reading tolerates malformed metadata without throwing', () => {
  for (const bad of [null, undefined, 'string', 42, [], { problem_signature: 'not-an-object' }, { problem_signature: [] }]) {
    assert.doesNotThrow(() => gx.problemSignatureOf({ metadata: bad }));
    assert.equal(gx.problemSignatureOf({ metadata: bad }), null);
  }
});

test('the hit always seeds; other candidates must earn their slot', () => {
  const hit = { id: 'a', source_type: 'fact' };            // not solved-problem
  const seeds = gx.selectSeeds({
    hit,
    memories: [hit, { id: 'b', source_type: 'bug_fix' }, { id: 'c', source_type: 'preference' }],
    maxSeeds: 5,
  });
  assert.deepEqual(seeds.map((s) => s.id), ['a', 'b'],
    'the hit leads (it is what the user sees); non-solved-problem candidates are excluded');
});

test('seed cap is honored', () => {
  const memories = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, source_type: 'bug_fix' }));
  assert.equal(gx.selectSeeds({ hit: memories[0], memories, maxSeeds: 3 }).length, 3);
});

// ── result shaping ─────────────────────────────────────────────────────────

test('privacy-tagged neighbors are dropped — a graph hop must not become a privacy bypass', () => {
  const shaped = gx.shapeExpansion([
    edgeRow({ memory_id: 'private-1', privacy_tags: ['medical'] }),
    edgeRow({ memory_id: 'public-1' }),
  ], { seedIds: [HIT.id] });
  assert.deepEqual(shaped.map((r) => r.id), ['public-1']);
});

test('seeds are never echoed back as their own neighbors', () => {
  const shaped = gx.shapeExpansion([edgeRow({ memory_id: HIT.id })], { seedIds: [HIT.id] });
  assert.deepEqual(shaped, [], 'echoing a seed would double-count it in a ranking we may not touch');
});

test('untyped predicates are refused even if the RPC returns them', () => {
  // Defense in depth: `relates_to` is 79% of the graph and means "these are
  // similar", which the vector search already established. If the SQL half
  // regressed, this is the caller-side stop.
  const shaped = gx.shapeExpansion([edgeRow({ edge_type: 'relates_to' })], { seedIds: [] });
  assert.deepEqual(shaped, []);
});

test('graph-derived rows carry provenance and NO similarity score', () => {
  const [row] = gx.shapeExpansion([edgeRow()], { seedIds: [] });
  assert.equal(row.graph_derived, true);
  assert.equal(row.hops, 1);
  assert.equal(row.edge_type, 'fixed_by');
  assert.ok(!('similarity' in row) && !('semantic_similarity' in row),
    'a graph neighbor was never scored against the query; inventing a score would make it look ranked');
});

test('direction decides the phrasing for asymmetric predicates', () => {
  assert.equal(gx.relationLabel('fixed_by', 'outbound'), 'You fixed this before');
  assert.notEqual(gx.relationLabel('fixed_by', 'inbound'), gx.relationLabel('fixed_by', 'outbound'));
  assert.notEqual(gx.relationLabel('supersedes', 'inbound'), gx.relationLabel('supersedes', 'outbound'));
  // Symmetric predicate reads the same from both ends.
  assert.equal(gx.relationLabel('same_pattern_as', 'inbound'), gx.relationLabel('same_pattern_as', 'outbound'));
});

test('ordering: a same-symptom match outranks a better edge type', () => {
  const seedHash = 'deadbeef';
  const shaped = gx.shapeExpansion([
    edgeRow({ memory_id: 'plain-fix', edge_type: 'fixed_by' }),
    edgeRow({
      memory_id: 'same-symptom',
      edge_type: 'supersedes',
      metadata: { problem_signature: { v: 1, class: 'err-x', symptom_hash: seedHash } },
    }),
  ], { seedIds: [], lookupKey: { class: 'err-x', symptom_hash: seedHash } });

  assert.equal(shaped[0].id, 'same-symptom');
  assert.equal(shaped[0].signature_match, 'symptom');
  assert.equal(shaped[1].signature_match, null);
});

test('the live error line feeds the match set, not just stored seed signatures', async () => {
  // This is what makes the feature work on day one: no stored row carries a
  // signature until T2's extractor has run the back-catalogue, but the live
  // error always hashes.
  const hash = require('../src/vendor/problem_signature_core.cjs')
    .problemLookupKey('ERROR: permission denied for table memory_items').symptom_hash;

  const expander = gx.createExpander(CONFIG, {
    fetchImpl: async () => jsonResponse([
      edgeRow({ memory_id: 'unmatched' }),
      edgeRow({
        memory_id: 'matched',
        edge_type: 'supersedes',
        metadata: { problem_signature: { v: 1, class: 'err-pg-permission-denied', symptom_hash: hash } },
      }),
    ]),
    env: {},
  });

  const res = await expander.expand({
    hit: HIT, memories: [HIT], errorText: 'ERROR: permission denied for table memory_items',
  });
  assert.equal(res.related[0].id, 'matched');
  assert.equal(res.related[0].signature_match, 'symptom');
});

test('row cap is applied after ordering, so the cap keeps the best rows', () => {
  const rows = Array.from({ length: 10 }, (_, i) => edgeRow({
    memory_id: `m-${i}`,
    edge_type: i === 9 ? 'fixed_by' : 'supersedes',
  }));
  const shaped = gx.shapeExpansion(rows, { seedIds: [], maxRows: 2 });
  assert.equal(shaped.length, 2);
  assert.equal(shaped[0].edge_type, 'fixed_by', 'the highest-priority edge survives the cap');
});

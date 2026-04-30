// Sprint 43 T1 — pure-function tests for graph-controls.js.
//
// Covers:
//   - computeDegrees handles raw-id endpoints AND d3-mutated object endpoints
//   - windowMinTime maps {7d|30d|90d} to ms timestamps; 'all' returns null
//   - applyControls: hide-isolated, min-degree, time-window, combined
//   - applyControls drops orphaned edges when their endpoints drop
//   - applyControls precedence: time-window first (older nodes drop first,
//     which can drop edges, which then changes degree calculations)
//   - encodeControls / decodeControls round-trip through URLSearchParams
//   - normalizeControls clamps invalid values to defaults
//   - computeHierarchyLevels assigns levels via BFS over directional edges
//   - radialRadiusFn returns a function with sane min/max behavior
//
// Acceptance criterion realism check: the lane brief promises that a 1042-node
// /392-edge graph with 719 isolated nodes (the real termdeck shape) drops to
// ~323 nodes when hide-isolated toggles on. Test 'realistic-density' below
// stubs that exact shape and asserts the math.
//
// Run: node --test tests/graph-controls.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GC = require(path.resolve(__dirname, '..', 'packages', 'client', 'public', 'graph-controls.js'));

// ----- fixtures -----------------------------------------------------------

function makeNodes(n, opts = {}) {
  const out = [];
  const baseTime = opts.baseTime || Date.parse('2026-04-30T12:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push({
      id: `n${i}`,
      label: `node ${i}`,
      project: opts.project || 'termdeck',
      createdAt: new Date(baseTime - i * 86_400_000).toISOString(),
    });
  }
  return out;
}

function edge(s, t, kind = 'relates_to') {
  return { id: `${s}-${t}`, source: s, target: t, kind, weight: 0.5 };
}

// ----- computeDegrees -----------------------------------------------------

test('computeDegrees with raw-id endpoints', () => {
  const nodes = makeNodes(4);
  const edges = [edge('n0', 'n1'), edge('n1', 'n2'), edge('n2', 'n3'), edge('n0', 'n2')];
  const deg = GC.computeDegrees(nodes, edges);
  assert.equal(deg.get('n0'), 2);
  assert.equal(deg.get('n1'), 2);
  assert.equal(deg.get('n2'), 3);
  assert.equal(deg.get('n3'), 1);
});

test('computeDegrees with d3-mutated object endpoints', () => {
  const nodes = makeNodes(3);
  const edges = [
    { id: 'a', source: { id: 'n0' }, target: { id: 'n1' }, kind: 'relates_to' },
    { id: 'b', source: { id: 'n1' }, target: { id: 'n2' }, kind: 'relates_to' },
  ];
  const deg = GC.computeDegrees(nodes, edges);
  assert.equal(deg.get('n0'), 1);
  assert.equal(deg.get('n1'), 2);
  assert.equal(deg.get('n2'), 1);
});

test('computeDegrees ignores edges to unknown ids', () => {
  const nodes = makeNodes(2);
  const edges = [edge('n0', 'n1'), edge('n1', 'phantom'), edge('ghost', 'n0')];
  const deg = GC.computeDegrees(nodes, edges);
  assert.equal(deg.get('n0'), 1);
  assert.equal(deg.get('n1'), 1);
  assert.equal(deg.has('phantom'), false);
  assert.equal(deg.has('ghost'), false);
});

// ----- windowMinTime ------------------------------------------------------

test('windowMinTime maps known windows to ms', () => {
  const now = 1_000_000_000_000;
  assert.equal(GC.windowMinTime('7d', now), now - 7 * 86_400_000);
  assert.equal(GC.windowMinTime('30d', now), now - 30 * 86_400_000);
  assert.equal(GC.windowMinTime('90d', now), now - 90 * 86_400_000);
});

test('windowMinTime returns null for "all" or unknown', () => {
  assert.equal(GC.windowMinTime('all', 1000), null);
  assert.equal(GC.windowMinTime('forever', 1000), null);
  assert.equal(GC.windowMinTime(undefined, 1000), null);
});

// ----- applyControls: hide-isolated --------------------------------------

test('hide-isolated drops zero-degree nodes only', () => {
  const nodes = makeNodes(5);
  const edges = [edge('n0', 'n1'), edge('n1', 'n2')];
  // n3 and n4 are isolated.
  const out = GC.applyControls(nodes, edges, { hideIsolated: true });
  const ids = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['n0', 'n1', 'n2']);
  assert.equal(out.edges.length, 2);
});

test('hide-isolated off keeps all nodes', () => {
  const nodes = makeNodes(5);
  const edges = [edge('n0', 'n1')];
  const out = GC.applyControls(nodes, edges, { hideIsolated: false });
  assert.equal(out.nodes.length, 5);
  assert.equal(out.edges.length, 1);
});

// ----- applyControls: min-degree -----------------------------------------

test('min-degree=2 keeps only nodes with >= 2 edges', () => {
  const nodes = makeNodes(4);
  const edges = [
    edge('n0', 'n1'), // n0=1, n1=1
    edge('n1', 'n2'), // n1=2, n2=1
    edge('n1', 'n3'), // n1=3, n3=1
  ];
  const out = GC.applyControls(nodes, edges, { minDegree: 2 });
  const ids = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['n1']);
  // Edges to dropped endpoints get cascaded out.
  assert.equal(out.edges.length, 0);
});

test('min-degree=3 with hub+leaves keeps the hub', () => {
  const nodes = makeNodes(5);
  const edges = [
    edge('n0', 'n1'),
    edge('n0', 'n2'),
    edge('n0', 'n3'),
    edge('n0', 'n4'),
  ];
  // n0 has degree 4; n1..n4 each have degree 1.
  const out = GC.applyControls(nodes, edges, { minDegree: 3 });
  assert.deepEqual(out.nodes.map((n) => n.id), ['n0']);
});

// ----- applyControls: time-window ----------------------------------------

test('time-window 7d drops nodes older than 7 days', () => {
  // makeNodes spaces createdAt one day apart, n0 newest.
  const nodes = makeNodes(20);
  const edges = [];
  const now = Date.parse(nodes[0].createdAt) + 1; // just after newest
  const out = GC.applyControls(nodes, edges, { window: '7d' }, now);
  // 7-day window keeps nodes whose createdAt is within 7 * 86_400_000ms of now.
  // n0..n6 fit (0..6 days old); n7 onward are too old.
  assert.equal(out.nodes.length, 7);
  assert.deepEqual(
    out.nodes.map((n) => n.id),
    ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
  );
});

test('time-window cascades through edges', () => {
  const nodes = makeNodes(5);
  const edges = [edge('n0', 'n4'), edge('n0', 'n1')];
  const now = Date.parse(nodes[0].createdAt) + 1;
  const out = GC.applyControls(nodes, edges, { window: '7d' }, now);
  // n4 is 4 days old → in. n0..n4 all within 7 days here; both edges stay.
  assert.equal(out.nodes.length, 5);
  assert.equal(out.edges.length, 2);

  const out2 = GC.applyControls(nodes, edges, { window: '7d' }, now + 5 * 86_400_000);
  // Now n0..n4 ages are 5..9 days; n5..n4 (id 4 → 9 days) drops.
  // The edge n0-n4 references n4 which is now > 7 days; edge drops.
  const keptIds = new Set(out2.nodes.map((n) => n.id));
  for (const e of out2.edges) {
    assert.ok(keptIds.has(e.source) && keptIds.has(e.target),
      `edge ${e.id} references dropped node`);
  }
});

// ----- applyControls: combined -------------------------------------------

test('combined hideIsolated + minDegree=2 + window=30d', () => {
  const nodes = makeNodes(20);
  const edges = [
    edge('n0', 'n1'),  // both within 7d
    edge('n0', 'n2'),  // both within 7d
    edge('n5', 'n6'),  // both within 30d
    edge('n10', 'n11'),  // both within 30d
    edge('n15', 'n16'),  // both > 30d
  ];
  const now = Date.parse(nodes[0].createdAt) + 1;
  // 30d window keeps n0..n29 (only n0..n19 exist) — all 20 nodes survive that.
  // Then min-degree=2 keeps only n0 (degree 2 from edges 0+1).
  const out = GC.applyControls(
    nodes, edges,
    { hideIsolated: true, minDegree: 2, window: '30d' },
    now,
  );
  assert.deepEqual(out.nodes.map((n) => n.id), ['n0']);
  assert.equal(out.edges.length, 0);
});

// ----- applyControls: realistic density ---------------------------------

test('realistic termdeck density: 1042 nodes / 392 edges / 719 isolated → ~323 visible', () => {
  // Build a stub that mirrors the shape from PLANNING.md: 1042 nodes total,
  // 392 edges spanning 323 connected nodes (so 719 are isolated).
  const total = 1042;
  const connectedCount = 323;
  const edgeCount = 392;
  const nodes = makeNodes(total);
  const edges = [];
  // Lay edges among the first 323 nodes — random but deterministic via i*p.
  for (let i = 0; i < edgeCount; i++) {
    const s = (i * 7) % connectedCount;
    let t = (i * 13 + 1) % connectedCount;
    if (t === s) t = (t + 1) % connectedCount;
    edges.push(edge(`n${s}`, `n${t}`));
  }
  const out = GC.applyControls(nodes, edges, { hideIsolated: true });
  // Some of the 323 connected nodes might end up with degree 0 if the
  // randomized assignment never picked them; the test's contract is that
  // visible count is ≤ connectedCount and ≥ ~280 (well below total).
  assert.ok(out.nodes.length <= connectedCount,
    `expected ≤ ${connectedCount} visible, got ${out.nodes.length}`);
  assert.ok(out.nodes.length >= 280,
    `expected ≥ 280 visible nodes (lane brief promises ~323), got ${out.nodes.length}`);
  assert.ok(out.nodes.length < total,
    `hide-isolated must reduce visible count below ${total}`);
  // Crucially: every remaining node has at least one edge in the visible set.
  const deg = GC.computeDegrees(out.nodes, out.edges);
  for (const [, d] of deg) {
    assert.ok(d >= 1, 'every visible node has degree ≥ 1 after hide-isolated');
  }
});

// ----- URL state codec ---------------------------------------------------

test('encode/decode round-trips defaults to no params', () => {
  const qs = new URLSearchParams();
  GC.encodeControls(qs, GC.defaultControls());
  assert.equal(qs.toString(), '');
  const back = GC.decodeControls(qs);
  assert.deepEqual(back, GC.defaultControls());
});

test('encode/decode round-trips full state', () => {
  const qs = new URLSearchParams();
  const c = { hideIsolated: true, minDegree: 3, window: '30d', layout: 'hierarchical' };
  GC.encodeControls(qs, c);
  assert.equal(qs.get('hideIsolated'), '1');
  assert.equal(qs.get('minDegree'), '3');
  assert.equal(qs.get('window'), '30d');
  assert.equal(qs.get('layout'), 'hierarchical');
  const back = GC.decodeControls(qs);
  assert.deepEqual(back, c);
});

test('encode strips defaults so URL stays clean', () => {
  const qs = new URLSearchParams('?project=termdeck&hideIsolated=1&window=7d');
  GC.encodeControls(qs, { hideIsolated: false, minDegree: 0, window: 'all', layout: 'force' });
  assert.equal(qs.has('hideIsolated'), false);
  assert.equal(qs.has('window'), false);
  assert.equal(qs.has('minDegree'), false);
  assert.equal(qs.has('layout'), false);
  // Other keys (project) untouched.
  assert.equal(qs.get('project'), 'termdeck');
});

test('decode rejects invalid window/layout values', () => {
  const qs = new URLSearchParams('?window=forever&layout=cubist&minDegree=-3&hideIsolated=lol');
  const c = GC.decodeControls(qs);
  assert.equal(c.window, 'all');
  assert.equal(c.layout, 'force');
  assert.equal(c.minDegree, 0);
  assert.equal(c.hideIsolated, false);
});

// ----- normalizeControls -------------------------------------------------

test('normalizeControls clamps and falls back', () => {
  assert.deepEqual(
    GC.normalizeControls({ minDegree: -5, layout: 'wat', window: 'all-time' }),
    GC.defaultControls(),
  );
  assert.deepEqual(
    GC.normalizeControls({ hideIsolated: 'truthy', minDegree: '4', window: '30d', layout: 'radial' }),
    { hideIsolated: true, minDegree: 4, window: '30d', layout: 'radial' },
  );
});

// ----- computeHierarchyLevels --------------------------------------------

test('computeHierarchyLevels assigns BFS levels for supersedes chain', () => {
  // n0 → n1 → n2 → n3 supersedes-chain
  const nodes = makeNodes(4);
  const edges = [
    { id: 'a', source: 'n0', target: 'n1', kind: 'supersedes' },
    { id: 'b', source: 'n1', target: 'n2', kind: 'supersedes' },
    { id: 'c', source: 'n2', target: 'n3', kind: 'supersedes' },
  ];
  const levels = GC.computeHierarchyLevels(nodes, edges);
  assert.equal(levels.get('n0'), 0);
  assert.equal(levels.get('n1'), 1);
  assert.equal(levels.get('n2'), 2);
  assert.equal(levels.get('n3'), 3);
});

test('computeHierarchyLevels falls back to single level when no directional edges', () => {
  const nodes = makeNodes(3);
  const edges = [edge('n0', 'n1', 'relates_to'), edge('n1', 'n2', 'relates_to')];
  const levels = GC.computeHierarchyLevels(nodes, edges);
  for (const n of nodes) {
    assert.equal(levels.get(n.id), 0);
  }
});

// ----- radialRadiusFn ----------------------------------------------------

test('radialRadiusFn places hub at smaller radius than leaf', () => {
  const nodes = makeNodes(4);
  const deg = new Map([
    ['n0', 5],   // hub
    ['n1', 1],   // leaf
    ['n2', 1],
    ['n3', 1],
  ]);
  const fn = GC.radialRadiusFn(deg, 100);
  const hubR = fn({ id: 'n0' });
  const leafR = fn({ id: 'n1' });
  assert.ok(hubR < leafR, `hub r=${hubR} should be < leaf r=${leafR}`);
  assert.ok(hubR > 0 && hubR <= 100);
  assert.ok(leafR > 0 && leafR <= 100);
});

test('radialRadiusFn handles zero-degree fallback', () => {
  const fn = GC.radialRadiusFn(new Map(), 100);
  assert.equal(fn({ id: 'whatever' }), 50);
});

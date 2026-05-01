// Sprint 46 T1 — graph-viewer end-to-end contract tests.
//
// These tests close gaps the existing graph suite doesn't cover:
//   1. HTML↔JS DOM-id wiring: every getElementById/`$('foo')` in graph.js
//      points at an element that exists in graph.html (so a future rename of
//      a control element fails fast under `node --test` instead of silently
//      breaking the page).
//   2. Edge vocabulary parity: graph.js's EDGE_COLORS / EDGE_LABELS keys
//      match migration-009's 8-type vocabulary, so a future schema-vocabulary
//      bump requires touching all three files together.
//   3. Live-shape integration: feeding API-shaped fixtures (mirroring the
//      response schema of /api/graph/all) through GraphControls.applyControls
//      preserves all the fields graph.js destructures downstream
//      (n.project, n.label, n.snippet, n.createdAt, n.degree, n.ageDays;
//      e.source, e.target, e.kind, e.weight, e.inferredBy).
//   4. URL state codec ↔ applyControls integration: a hand-encoded URL
//      decodes into a controls object that applyControls can consume
//      without throwing on unexpected types.
//
// Hermetic — no live server, no network. Reads the on-disk graph.html /
// graph.js / graph-controls.js and migration-009 SQL.
//
// Run: node --test tests/graph-viewer-e2e.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GRAPH_HTML = path.join(ROOT, 'packages', 'client', 'public', 'graph.html');
const GRAPH_JS = path.join(ROOT, 'packages', 'client', 'public', 'graph.js');
const GRAPH_CONTROLS_JS = path.join(ROOT, 'packages', 'client', 'public', 'graph-controls.js');
const MIGRATION_009 = path.join(
  ROOT, 'packages', 'server', 'src', 'setup', 'mnestra-migrations',
  '009_memory_relationship_metadata.sql',
);

const GC = require(GRAPH_CONTROLS_JS);

// IDs that graph.js creates dynamically at runtime (not declared in HTML).
const RUNTIME_CREATED_IDS = new Set(['graphToast']);

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function extractDomIdsFromJs(src) {
  // Capture both `$('id')` (the helper) and `getElementById('id')` calls.
  const out = new Set();
  const re = /(?:\$|getElementById)\(\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

function extractIdsFromHtml(src) {
  const out = new Set();
  const re = /\bid="([a-zA-Z][a-zA-Z0-9_-]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

function extractObjectKeys(src, varName) {
  // Find `const VAR = { ... };` and pull keys. Naive but adequate for the
  // EDGE_COLORS / EDGE_LABELS literals in graph.js.
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const match = re.exec(src);
  if (!match) return null;
  const body = match[1];
  const keys = new Set();
  const keyRe = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) keys.add(m[1]);
  return keys;
}

// ----- 1. DOM-id wiring contract -----------------------------------------

test('every getElementById in graph.js points at an element in graph.html', () => {
  const jsIds = extractDomIdsFromJs(readFile(GRAPH_JS));
  const htmlIds = extractIdsFromHtml(readFile(GRAPH_HTML));
  const missing = [];
  for (const id of jsIds) {
    if (RUNTIME_CREATED_IDS.has(id)) continue;
    if (!htmlIds.has(id)) missing.push(id);
  }
  assert.deepEqual(
    missing,
    [],
    `graph.js queries DOM ids that don't exist in graph.html: ${missing.join(', ')}`,
  );
});

test('the four Sprint 43 T1 control element ids exist in graph.html', () => {
  const htmlIds = extractIdsFromHtml(readFile(GRAPH_HTML));
  for (const id of ['ctlHideIsolated', 'ctlMinDegree', 'ctlWindow', 'ctlLayout', 'ctlVisibleStat']) {
    assert.ok(htmlIds.has(id), `expected control id #${id} in graph.html`);
  }
});

test('graph-controls.js loads BEFORE graph.js in graph.html', () => {
  const html = readFile(GRAPH_HTML);
  const ctlIdx = html.indexOf('graph-controls.js');
  const mainIdx = html.indexOf('graph.js"');
  assert.ok(ctlIdx > 0, 'graph-controls.js script tag not found');
  assert.ok(mainIdx > 0, 'graph.js script tag not found');
  assert.ok(
    ctlIdx < mainIdx,
    `graph-controls.js (idx ${ctlIdx}) must load before graph.js (idx ${mainIdx}) so window.GraphControls is set in time`,
  );
});

// ----- 2. Edge vocabulary parity -----------------------------------------

test('graph.js EDGE_COLORS keys match migration-009 8-type vocabulary', () => {
  const colors = extractObjectKeys(readFile(GRAPH_JS), 'EDGE_COLORS');
  assert.ok(colors, 'failed to parse EDGE_COLORS literal');
  const sql = readFile(MIGRATION_009);
  // migration-009 lists the 8 types in a CHECK clause; pull them as a flat set.
  const expected = new Set([
    'supersedes', 'contradicts', 'relates_to', 'elaborates',
    'caused_by', 'blocks', 'inspired_by', 'cross_project_link',
  ]);
  for (const k of expected) {
    assert.ok(colors.has(k), `EDGE_COLORS missing migration-009 type "${k}"`);
    assert.ok(sql.includes(`'${k}'`), `migration-009 SQL missing "${k}"`);
  }
});

test('graph.js EDGE_LABELS keys mirror EDGE_COLORS keys', () => {
  const src = readFile(GRAPH_JS);
  const colors = extractObjectKeys(src, 'EDGE_COLORS');
  const labels = extractObjectKeys(src, 'EDGE_LABELS');
  assert.ok(colors && labels, 'failed to parse EDGE_COLORS / EDGE_LABELS');
  assert.deepEqual(
    [...labels].sort(),
    [...colors].sort(),
    'EDGE_LABELS and EDGE_COLORS must keep their key sets in lockstep',
  );
});

// ----- 3. Live-shape integration -----------------------------------------

// Fixture mirrors the schema documented in graph-routes.js rowToNode + rowToEdge.
function liveShapeFixture() {
  const now = Date.now();
  const day = 86_400_000;
  const nodes = [
    {
      id: 'n0', label: 'root memory', snippet: 'root memory full snippet',
      source_type: 'fact', category: 'project', project: 'termdeck',
      createdAt: new Date(now - 0).toISOString(),
      updatedAt: new Date(now - 0).toISOString(),
      ageDays: 0, degree: 3, superseded: false,
    },
    {
      id: 'n1', label: 'related memory', snippet: 'related memory snippet',
      source_type: 'decision', category: 'workflow', project: 'termdeck',
      createdAt: new Date(now - 5 * day).toISOString(),
      updatedAt: new Date(now - 5 * day).toISOString(),
      ageDays: 5, degree: 2, superseded: false,
    },
    {
      id: 'n2', label: 'cross-project memory', snippet: 'cross-project content',
      source_type: 'bug_fix', category: 'debugging', project: 'pvb',
      createdAt: new Date(now - 40 * day).toISOString(),
      updatedAt: new Date(now - 40 * day).toISOString(),
      ageDays: 40, degree: 1, superseded: false,
    },
    {
      id: 'n3', label: 'isolated', snippet: 'isolated content',
      source_type: 'fact', category: null, project: 'global',
      createdAt: new Date(now - 100 * day).toISOString(),
      updatedAt: new Date(now - 100 * day).toISOString(),
      ageDays: 100, degree: 0, superseded: false,
    },
  ];
  const edges = [
    {
      id: 'e1', source: 'n0', target: 'n1', kind: 'relates_to',
      createdAt: new Date(now - 1 * day).toISOString(),
      weight: 0.85, inferredAt: new Date(now - 1 * day).toISOString(),
      inferredBy: 'cron-2026-04-30',
    },
    {
      id: 'e2', source: 'n0', target: 'n2', kind: 'elaborates',
      createdAt: new Date(now - 2 * day).toISOString(),
      weight: 0.71, inferredAt: new Date(now - 2 * day).toISOString(),
      inferredBy: 'cron-2026-04-29',
    },
    {
      id: 'e3', source: 'n1', target: 'n2', kind: 'supersedes',
      createdAt: new Date(now - 3 * day).toISOString(),
      weight: 0.63, inferredAt: null, inferredBy: null,
    },
  ];
  return { nodes, edges };
}

test('applyControls preserves the fields graph.js downstream renderers consume', () => {
  const { nodes, edges } = liveShapeFixture();
  const out = GC.applyControls(nodes, edges, GC.defaultControls());
  // All four nodes survive defaults; all three edges survive.
  assert.equal(out.nodes.length, 4);
  assert.equal(out.edges.length, 3);
  // Spot-check that the renderer-relevant fields are untouched (applyControls
  // returns shallow refs into the original arrays — graph.js expects to read
  // n.degree for nodeRadius, n.ageDays for recencyFactor, n.project for
  // hashHue, n.label for the SVG text node, n.snippet for the drawer body).
  const root = out.nodes.find((n) => n.id === 'n0');
  for (const k of ['project', 'label', 'snippet', 'createdAt', 'degree', 'ageDays', 'source_type']) {
    assert.ok(k in root, `node missing field "${k}" required by graph.js renderers`);
  }
  const edge = out.edges[0];
  for (const k of ['source', 'target', 'kind', 'weight', 'inferredBy']) {
    assert.ok(k in edge, `edge missing field "${k}" required by graph.js renderers`);
  }
});

test('hide-isolated drops the zero-degree node from the live-shape fixture', () => {
  const { nodes, edges } = liveShapeFixture();
  const out = GC.applyControls(nodes, edges, { hideIsolated: true });
  const ids = out.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['n0', 'n1', 'n2'], 'isolated node n3 must be dropped');
});

test('time-window=7d retains recent nodes and cascades old edges out', () => {
  const { nodes, edges } = liveShapeFixture();
  const out = GC.applyControls(nodes, edges, { window: '7d' });
  const ids = out.nodes.map((n) => n.id).sort();
  // n0 (today) and n1 (5d) survive; n2 (40d) and n3 (100d) drop.
  assert.deepEqual(ids, ['n0', 'n1']);
  // Only the n0↔n1 edge can survive — others reference dropped endpoints.
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].id, 'e1');
});

// ----- 4. URL state codec ↔ applyControls integration --------------------

test('decodeControls → applyControls accepts hand-encoded URLs cleanly', () => {
  const qs = new URLSearchParams('?project=termdeck&hideIsolated=1&minDegree=2&window=30d&layout=radial');
  const controls = GC.decodeControls(qs);
  assert.equal(controls.hideIsolated, true);
  assert.equal(controls.minDegree, 2);
  assert.equal(controls.window, '30d');
  assert.equal(controls.layout, 'radial');
  // Pipe through applyControls — it must not throw on this shape and must
  // honor the threshold (minDegree=2 with a hub graph keeps only the hub).
  const { nodes, edges } = liveShapeFixture();
  const out = GC.applyControls(nodes, edges, controls);
  // 30d window keeps n0/n1 (0d/5d) — n2/n3 drop. Then minDegree=2 against the
  // surviving edges (only e1 remains) means each surviving node has degree 1,
  // so all drop. Result: empty visible set — and that's the correct cascade.
  assert.equal(out.nodes.length, 0);
  assert.equal(out.edges.length, 0);
});

test('hostile URL params (window=forever, layout=cubist, minDegree=-3) sanitize to defaults', () => {
  const qs = new URLSearchParams('?window=forever&layout=cubist&minDegree=-3&hideIsolated=lol');
  const c = GC.decodeControls(qs);
  // Sanitized to defaults rather than thrown — graph.js can hand it straight
  // to applyControls without a try/catch.
  assert.equal(c.window, 'all');
  assert.equal(c.layout, 'force');
  assert.equal(c.minDegree, 0);
  assert.equal(c.hideIsolated, false);
  const { nodes, edges } = liveShapeFixture();
  const out = GC.applyControls(nodes, edges, c);
  assert.equal(out.nodes.length, 4, 'sanitized defaults pass-through');
});

test('encode round-trips through applyControls without losing information', () => {
  const c = { hideIsolated: true, minDegree: 1, window: '90d', layout: 'hierarchical' };
  const qs = new URLSearchParams();
  GC.encodeControls(qs, c);
  const back = GC.decodeControls(qs);
  assert.deepEqual(back, c);
  const { nodes, edges } = liveShapeFixture();
  const out1 = GC.applyControls(nodes, edges, c);
  const out2 = GC.applyControls(nodes, edges, back);
  assert.deepEqual(
    out1.nodes.map((n) => n.id).sort(),
    out2.nodes.map((n) => n.id).sort(),
  );
});

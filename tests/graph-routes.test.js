// Tests for graph-routes.js — Sprint 38 T4 server endpoints powering the
// D3 force-directed knowledge graph view.
//
// Covers:
//   - createGraphRoutes registers GET /api/graph/project/:name,
//     /api/graph/memory/:id, /api/graph/stats
//   - Graceful-degrade: when getPool() returns null, endpoints return
//     { enabled: false } rather than 500
//   - Project endpoint shape: nodes carry degree + snippet, edges scoped to
//     the project's node set, byType count derived
//   - Project endpoint validates project name
//   - Memory endpoint validates uuid, fetches root + neighborhood, surfaces
//     depth in nodes
//   - Stats endpoint returns {memories, edges, byProject} and tolerates
//     pre-T2 schemas (where to_jsonb-only column reads are missing)
//
// Run: node --test tests/graph-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const {
  createGraphRoutes,
  rowToNode,
  rowToEdge,
  rowToFullMemory,
  snippet,
  fetchProjectGraph,
  fetchAllGraph,
  fetchNeighborhood,
  fetchStats,
  encodeCursor,
  decodeCursor,
  UUID_RE,
  PROJECT_RE,
  MAX_NODES_GLOBAL,
} = require('../packages/server/src/graph-routes');

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';
const UUID_C = '33333333-4444-5555-6666-777777777777';

// Build an Express app with a stub pool.
function buildApp(getPool) {
  const app = express();
  app.use(express.json());
  createGraphRoutes({ app, getPool });
  return app;
}

// Minimal in-process HTTP request helper. Avoids supertest as a dep.
function request(app, method, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
            } catch (err) {
              resolve({ status: res.statusCode, body });
            }
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

// Stub pg pool. queries[] is an ordered list of {match, rows} entries; each
// pool.query() call walks the list and returns rows for the first matching
// SQL pattern (substring match). Mirrors the test pattern used elsewhere in
// this repo.
function makeStubPool(handlers) {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const h of handlers) {
        if (typeof h.match === 'function' ? h.match(sql, params) : sql.includes(h.match)) {
          if (h.throws) throw h.throws;
          return { rows: typeof h.rows === 'function' ? h.rows(sql, params) : h.rows };
        }
      }
      throw new Error(`stub pool: no handler matched SQL: ${sql.slice(0, 80)}…`);
    },
  };
  return { pool, calls };
}

// -------- pure helpers ----------------------------------------------------

test('UUID_RE accepts canonical UUIDs and rejects junk', () => {
  assert.equal(UUID_RE.test(UUID_A), true);
  assert.equal(UUID_RE.test('not-a-uuid'), false);
  assert.equal(UUID_RE.test(''), false);
  assert.equal(UUID_RE.test(`${UUID_A}-extra`), false);
});

test('PROJECT_RE rejects spaces and shell metacharacters', () => {
  assert.equal(PROJECT_RE.test('termdeck'), true);
  assert.equal(PROJECT_RE.test('chopin-nashville'), true);
  assert.equal(PROJECT_RE.test('a.b_c-d'), true);
  assert.equal(PROJECT_RE.test('with space'), false);
  assert.equal(PROJECT_RE.test('semi;colon'), false);
  assert.equal(PROJECT_RE.test(''), false);
});

test('snippet collapses whitespace and truncates', () => {
  assert.equal(snippet('hello   world\n\nthere'), 'hello world there');
  const long = 'x'.repeat(500);
  const out = snippet(long, 100);
  assert.equal(out.length, 100);
  assert.ok(out.endsWith('…'));
  assert.equal(snippet(null), '');
  assert.equal(snippet(''), '');
});

test('rowToNode maps schema columns + computes ageDays', () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const node = rowToNode({
    id: UUID_A,
    content: 'hello world',
    source_type: 'fact',
    category: null,
    project: 'termdeck',
    created_at: fiveDaysAgo,
    updated_at: fiveDaysAgo,
    is_active: true,
    archived: false,
    superseded_by: null,
    degree: 4,
  });
  assert.equal(node.id, UUID_A);
  assert.equal(node.label, 'hello world');
  assert.equal(node.snippet, 'hello world');
  assert.equal(node.project, 'termdeck');
  assert.equal(node.degree, 4);
  assert.equal(node.superseded, false);
  assert.ok(node.ageDays >= 4.9 && node.ageDays <= 5.1, `ageDays=${node.ageDays}`);
});

test('rowToEdge reads weight/inferredAt from to_jsonb _row', () => {
  const edge = rowToEdge({
    id: 'edge-1',
    source_id: UUID_A,
    target_id: UUID_B,
    relationship_type: 'supersedes',
    created_at: '2026-04-27T12:00:00Z',
    _row: {
      weight: 0.87,
      inferred_at: '2026-04-27T12:00:00Z',
      inferred_by: 'cron-2026-04-27',
    },
  });
  assert.equal(edge.source, UUID_A);
  assert.equal(edge.target, UUID_B);
  assert.equal(edge.kind, 'supersedes');
  assert.equal(edge.weight, 0.87);
  assert.equal(edge.inferredBy, 'cron-2026-04-27');
});

test('rowToEdge tolerates pre-T2 rows with no _row weight column', () => {
  const edge = rowToEdge({
    id: 'edge-2',
    source_id: UUID_A,
    target_id: UUID_B,
    relationship_type: 'relates_to',
    created_at: '2026-04-26T10:00:00Z',
    _row: {
      // no weight, no inferred_at — pre-T2 box
      id: 'edge-2',
    },
  });
  assert.equal(edge.weight, null);
  assert.equal(edge.inferredAt, null);
  assert.equal(edge.inferredBy, null);
});

test('rowToFullMemory preserves content + booleans', () => {
  const m = rowToFullMemory({
    id: UUID_A,
    content: 'full body of the memory',
    source_type: 'fact',
    category: 'architecture',
    project: 'termdeck',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    is_active: true,
    archived: false,
    superseded_by: null,
  });
  assert.equal(m.content, 'full body of the memory');
  assert.equal(m.isActive, true);
  assert.equal(m.archived, false);
  assert.equal(m.supersededBy, null);
});

// -------- fetchProjectGraph ------------------------------------------------

test('fetchProjectGraph returns nodes, scopes edges to project node set', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('FROM proj_nodes n'),
      rows: [
        { id: UUID_A, content: 'first', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 2 },
        { id: UUID_B, content: 'second', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [
        { id: 'e1', source_id: UUID_A, target_id: UUID_B, relationship_type: 'supersedes', created_at: new Date().toISOString(), _row: { weight: 0.9 } },
      ],
    },
  ]);

  const out = await fetchProjectGraph(pool, 'termdeck');
  assert.equal(out.nodes.length, 2);
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].kind, 'supersedes');
  assert.equal(out.edges[0].weight, 0.9);
});

test('fetchProjectGraph short-circuits when project has no nodes', async () => {
  const { pool, calls } = makeStubPool([
    { match: 'FROM proj_nodes n', rows: [] },
    { match: 'FROM memory_relationships', rows: [] },
  ]);
  const out = await fetchProjectGraph(pool, 'empty-project');
  assert.deepEqual(out, { nodes: [], edges: [] });
  // We should NOT have run the edges query on an empty node set.
  assert.equal(calls.length, 1);
});

// -------- fetchNeighborhood -----------------------------------------------

test('fetchNeighborhood walks recursive CTE + fetches nodes + edges', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('WITH RECURSIVE walk'),
      rows: [
        { memory_id: UUID_A, depth: '0' },
        { memory_id: UUID_B, depth: '1' },
        { memory_id: UUID_C, depth: '2' },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_items m') && sql.includes('m.id = ANY'),
      rows: [
        { id: UUID_A, content: 'root', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 5 },
        { id: UUID_B, content: 'neighbor 1', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 2 },
        { id: UUID_C, content: 'neighbor 2', source_type: 'fact', category: null, project: 'mnestra', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 3 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [
        { id: 'e1', source_id: UUID_A, target_id: UUID_B, relationship_type: 'elaborates', created_at: new Date().toISOString(), _row: {} },
        { id: 'e2', source_id: UUID_B, target_id: UUID_C, relationship_type: 'relates_to', created_at: new Date().toISOString(), _row: {} },
      ],
    },
  ]);

  const out = await fetchNeighborhood(pool, UUID_A, 2);
  assert.equal(out.nodes.length, 3);
  const root = out.nodes.find((n) => n.id === UUID_A);
  assert.equal(root.depth, 0);
  const far = out.nodes.find((n) => n.id === UUID_C);
  assert.equal(far.depth, 2);
  assert.equal(out.edges.length, 2);
});

test('fetchNeighborhood clamps depth into [1, MAX_DEPTH]', async () => {
  const { pool, calls } = makeStubPool([
    { match: 'WITH RECURSIVE walk', rows: [{ memory_id: UUID_A, depth: '0' }] },
    { match: 'FROM memory_items m', rows: [] },
    { match: 'FROM memory_relationships', rows: [] },
  ]);
  await fetchNeighborhood(pool, UUID_A, 99);
  // The recursive SQL embeds the safe depth literally; verify it's been
  // clamped to MAX_DEPTH (4) rather than 99.
  const recursiveCall = calls[0];
  assert.match(recursiveCall.sql, /w\.depth\s*<\s*4/);
});

// -------- fetchStats ------------------------------------------------------

test('fetchStats aggregates memories, edges by type, projects', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('FROM memory_items') && sql.includes('total'),
      rows: [{ total: 5455, active: 5400, projects: 18 }],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('GROUP BY ROLLUP'),
      rows: [
        { kind: 'supersedes', by_type: 469 },
        { kind: 'elaborates', by_type: 167 },
        { kind: 'relates_to', by_type: 91 },
        { kind: 'contradicts', by_type: 14 },
        { kind: 'caused_by', by_type: 8 },
        { kind: null, by_type: 749 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_items') && sql.includes('GROUP BY project'),
      rows: [
        { project: 'pvb', n: 1599 },
        { project: 'termdeck', n: 980 },
      ],
    },
    {
      match: 'ORDER BY id DESC',
      rows: [{ _row: { inferred_at: '2026-04-27T12:00:00Z', inferred_by: 'cron-2026-04-27' } }],
    },
  ]);

  const out = await fetchStats(pool);
  assert.equal(out.enabled, true);
  assert.equal(out.memories.total, 5455);
  assert.equal(out.memories.projects, 18);
  assert.equal(out.edges.total, 749);
  assert.equal(out.edges.byType.supersedes, 469);
  assert.equal(out.edges.byType.relates_to, 91);
  assert.equal(out.byProject.pvb, 1599);
  assert.equal(out.lastInferredBy, 'cron-2026-04-27');
});

test('fetchStats survives pre-T2 schema where last-inferred query throws', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('FROM memory_items') && sql.includes('total'),
      rows: [{ total: 100, active: 100, projects: 2 }],
    },
    {
      match: (sql) => sql.includes('GROUP BY ROLLUP'),
      rows: [{ kind: null, by_type: 0 }],
    },
    {
      match: (sql) => sql.includes('GROUP BY project'),
      rows: [],
    },
    {
      match: 'ORDER BY id DESC',
      throws: new Error('column "inferred_at" does not exist'),
    },
  ]);
  const out = await fetchStats(pool);
  assert.equal(out.enabled, true);
  assert.equal(out.lastInferredAt, null);
  assert.equal(out.lastInferredBy, null);
});

// -------- HTTP integration ------------------------------------------------

test('GET /api/graph/project/:name returns nodes+edges+stats', async () => {
  const { pool } = makeStubPool([
    {
      match: 'FROM proj_nodes n',
      rows: [
        { id: UUID_A, content: 'a', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [],
    },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/project/termdeck');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.project, 'termdeck');
  assert.equal(r.body.nodes.length, 1);
  assert.equal(r.body.stats.nodes, 1);
  assert.equal(r.body.stats.edges, 0);
});

test('GET /api/graph/project/:name rejects invalid project names', async () => {
  const app = buildApp(() => null);
  const r = await request(app, 'GET', '/api/graph/project/has%20space');
  assert.equal(r.status, 400);
});

test('GET /api/graph/project/:name returns enabled=false when pool absent', async () => {
  const app = buildApp(() => null);
  const r = await request(app, 'GET', '/api/graph/project/termdeck');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.deepEqual(r.body.nodes, []);
  assert.deepEqual(r.body.edges, []);
});

test('GET /api/graph/memory/:id rejects non-uuid id', async () => {
  const app = buildApp(() => null);
  const r = await request(app, 'GET', '/api/graph/memory/not-a-uuid');
  assert.equal(r.status, 400);
});

test('GET /api/graph/memory/:id returns 404 when root memory missing', async () => {
  const { pool } = makeStubPool([
    { match: 'FROM memory_items WHERE id = $1', rows: [] },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', `/api/graph/memory/${UUID_A}`);
  assert.equal(r.status, 404);
});

test('GET /api/graph/memory/:id returns root + neighborhood', async () => {
  const { pool } = makeStubPool([
    {
      match: 'FROM memory_items WHERE id = $1',
      rows: [{ id: UUID_A, content: 'root content', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null }],
    },
    {
      match: 'WITH RECURSIVE walk',
      rows: [
        { memory_id: UUID_A, depth: '0' },
        { memory_id: UUID_B, depth: '1' },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_items m') && sql.includes('m.id = ANY'),
      rows: [
        { id: UUID_A, content: 'root', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
        { id: UUID_B, content: 'neighbor', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [
        { id: 'e1', source_id: UUID_A, target_id: UUID_B, relationship_type: 'elaborates', created_at: new Date().toISOString(), _row: {} },
      ],
    },
  ]);

  const app = buildApp(() => pool);
  const r = await request(app, 'GET', `/api/graph/memory/${UUID_A}?depth=2`);
  assert.equal(r.status, 200);
  assert.equal(r.body.root.id, UUID_A);
  assert.equal(r.body.root.content, 'root content');
  assert.equal(r.body.nodes.length, 2);
  assert.equal(r.body.edges.length, 1);
  assert.equal(r.body.depth, 2);
});

test('GET /api/graph/stats returns memories + edge totals', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('FROM memory_items') && sql.includes('total'),
      rows: [{ total: 200, active: 195, projects: 5 }],
    },
    {
      match: 'GROUP BY ROLLUP',
      rows: [
        { kind: 'supersedes', by_type: 100 },
        { kind: null, by_type: 100 },
      ],
    },
    {
      match: 'GROUP BY project',
      rows: [{ project: 'termdeck', n: 100 }],
    },
    {
      match: 'ORDER BY id DESC',
      rows: [{ _row: {} }],
    },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.memories.total, 200);
  assert.equal(r.body.edges.total, 100);
});

test('GET /api/graph/stats returns enabled=false when pool absent', async () => {
  const app = buildApp(() => null);
  const r = await request(app, 'GET', '/api/graph/stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
});

// -------- Sprint 41 T3 — fetchAllGraph + GET /api/graph/all --------------

test('MAX_NODES_GLOBAL is exported and equals 2000 (Sprint 41 T3 contract)', () => {
  assert.equal(MAX_NODES_GLOBAL, 2000);
});

test('fetchAllGraph returns truncated:false when total <= MAX_NODES_GLOBAL', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c') && sql.includes('memory_items'),
      rows: [{ c: 12 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS') && sql.includes('FROM all_nodes n'),
      rows: [
        { id: UUID_A, content: 'a', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
        { id: UUID_B, content: 'b', source_type: 'fact', category: null, project: 'pvb', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [
        { id: 'e1', source_id: UUID_A, target_id: UUID_B, relationship_type: 'cross_project_link', created_at: new Date().toISOString(), _row: { weight: 0.6 } },
      ],
    },
  ]);

  const out = await fetchAllGraph(pool);
  assert.equal(out.totalAvailable, 12);
  assert.equal(out.truncated, false);
  assert.equal(out.nodes.length, 2);
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].kind, 'cross_project_link');
  assert.equal(out.edges[0].weight, 0.6);
});

test('fetchAllGraph returns truncated:true when total > MAX_NODES_GLOBAL', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c') && sql.includes('memory_items'),
      rows: [{ c: 5891 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS') && sql.includes('FROM all_nodes n'),
      rows: [
        { id: UUID_A, content: 'most recent', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 0 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships'),
      rows: [],
    },
  ]);

  const out = await fetchAllGraph(pool);
  assert.equal(out.totalAvailable, 5891);
  assert.equal(out.truncated, true);
  assert.equal(out.nodes.length, 1);
  assert.deepEqual(out.edges, []);
});

test('fetchAllGraph short-circuits when no nodes are returned', async () => {
  const { pool, calls } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c'),
      rows: [{ c: 0 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS'),
      rows: [],
    },
  ]);
  const out = await fetchAllGraph(pool);
  assert.deepEqual(out, { nodes: [], edges: [], totalAvailable: 0, truncated: false, nextCursor: null });
  // Total + nodes queries ran; the edges query MUST NOT have run on an empty
  // node set (parity with fetchProjectGraph's short-circuit).
  assert.equal(calls.length, 2);
});

test('GET /api/graph/all returns enabled=false when pool absent', async () => {
  const app = buildApp(() => null);
  const r = await request(app, 'GET', '/api/graph/all');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, false);
  assert.deepEqual(r.body.nodes, []);
  assert.deepEqual(r.body.edges, []);
  assert.equal(r.body.totalAvailable, 0);
  assert.equal(r.body.truncated, false);
});

test('GET /api/graph/all returns nodes+edges+stats with truncated/totalAvailable', async () => {
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c'),
      rows: [{ c: 3 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS'),
      rows: [
        { id: UUID_A, content: 'first', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
        { id: UUID_B, content: 'second', source_type: 'fact', category: null, project: 'pvb', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 1 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
      rows: [
        { id: 'e1', source_id: UUID_A, target_id: UUID_B, relationship_type: 'relates_to', created_at: new Date().toISOString(), _row: {} },
      ],
    },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/all');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.nodes.length, 2);
  assert.equal(r.body.edges.length, 1);
  assert.equal(r.body.totalAvailable, 3);
  assert.equal(r.body.truncated, false);
  assert.equal(r.body.stats.nodes, 2);
  assert.equal(r.body.stats.edges, 1);
  assert.equal(r.body.stats.byType.relates_to, 1);
  assert.equal(r.body.stats.totalAvailable, 3);
  // Sprint 57 T2 — backward-compat: no-cursor request returns nextCursor:null
  // (or explicitly null) when fewer rows than the historical ceiling.
  assert.equal(r.body.nextCursor, null);
});

// -------- Sprint 57 T2 — /api/graph/all cursor pagination (F-T2-4) --------

test('encodeCursor + decodeCursor round-trip preserves (createdAt, id)', () => {
  const iso = '2026-05-05T12:34:56.789Z';
  const token = encodeCursor(iso, UUID_A);
  assert.ok(typeof token === 'string' && token.length > 0);
  const out = decodeCursor(token);
  assert.deepEqual(out, { createdAt: iso, id: UUID_A });
});

test('decodeCursor rejects malformed tokens', () => {
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('not-base64-!@#$%'), null);
  // Valid base64 but not JSON
  assert.equal(decodeCursor(Buffer.from('not json').toString('base64')), null);
  // Valid JSON but missing fields
  assert.equal(decodeCursor(Buffer.from('{}').toString('base64')), null);
  // Valid JSON, bad uuid
  assert.equal(
    decodeCursor(Buffer.from(JSON.stringify({ createdAt: '2026-05-05T12:00:00Z', id: 'not-a-uuid' })).toString('base64')),
    null,
  );
  // Valid JSON, valid uuid, bad date
  assert.equal(
    decodeCursor(Buffer.from(JSON.stringify({ createdAt: 'tomorrow', id: UUID_A })).toString('base64')),
    null,
  );
});

test('fetchAllGraph paginates through 5 nodes in 3 pages of 2 (covers same set as single-shot)', async () => {
  // Five nodes with descending created_at + descending uuid tie-break.
  // Page 1: limit=2 returns nodes 1,2 (most recent) + nextCursor pointing at node 2.
  // Page 2: cursor → node 3, 4 + nextCursor pointing at node 4.
  // Page 3: cursor → node 5 + nextCursor:null (last page).
  const NODE = (id, t, project = 'termdeck') => ({
    id,
    content: `n-${id.slice(0, 4)}`,
    source_type: 'fact',
    category: null,
    project,
    created_at: t,
    updated_at: null,
    is_active: true,
    archived: false,
    superseded_by: null,
    degree: 0,
  });
  const T = (n) => `2026-05-05T12:00:0${n}.000Z`; // T(0) oldest, T(4) newest
  const rows = [
    NODE('aaaaaaaa-1111-1111-1111-111111111111', T(4)), // newest first
    NODE('bbbbbbbb-2222-2222-2222-222222222222', T(3)),
    NODE('cccccccc-3333-3333-3333-333333333333', T(2)),
    NODE('dddddddd-4444-4444-4444-444444444444', T(1)),
    NODE('eeeeeeee-5555-5555-5555-555555555555', T(0)),
  ];
  // Stub pool: count + nodes (page-aware via cursor) + edges (empty).
  function stubForPaging(remainingRows) {
    return makeStubPool([
      {
        match: (sql) => sql.includes('SELECT COUNT(*)::int AS c'),
        rows: [{ c: rows.length }],
      },
      {
        match: (sql) => sql.includes('WITH all_nodes AS'),
        rows: (sql, params) => {
          // Mimic LIMIT k+1 + cursor predicate. The handler asks for limit+1=3
          // rows. If a cursor is present, we slice from there.
          if (params && params.length === 2) {
            const [createdAt, id] = params;
            // Strict-less-than (created_at, id) row-key.
            const idx = remainingRows.findIndex(
              (r) => r.created_at < createdAt || (r.created_at === createdAt && r.id < id),
            );
            return idx === -1 ? [] : remainingRows.slice(idx, idx + 3);
          }
          return remainingRows.slice(0, 3);
        },
      },
      {
        match: (sql) => sql.includes('FROM memory_relationships') && sql.includes('source_id = ANY'),
        rows: [],
      },
    ]);
  }

  const collected = [];
  // Page 1 — no cursor.
  let { pool: p1 } = stubForPaging(rows);
  let page = await fetchAllGraph(p1, { limit: 2 });
  assert.equal(page.totalAvailable, 5);
  assert.equal(page.nodes.length, 2);
  assert.ok(page.nextCursor, 'page 1 must carry a nextCursor');
  collected.push(...page.nodes.map((n) => n.id));

  // Page 2 — cursor from page 1.
  let { pool: p2 } = stubForPaging(rows);
  let cursor2 = decodeCursor(page.nextCursor);
  page = await fetchAllGraph(p2, { cursor: cursor2, limit: 2 });
  assert.equal(page.nodes.length, 2);
  assert.ok(page.nextCursor, 'page 2 must carry a nextCursor');
  collected.push(...page.nodes.map((n) => n.id));

  // Page 3 — cursor from page 2.
  let { pool: p3 } = stubForPaging(rows);
  let cursor3 = decodeCursor(page.nextCursor);
  page = await fetchAllGraph(p3, { cursor: cursor3, limit: 2 });
  assert.equal(page.nodes.length, 1);
  assert.equal(page.nextCursor, null, 'last page must have nextCursor:null');
  collected.push(...page.nodes.map((n) => n.id));

  // All 5 nodes covered, no duplicates, in descending (created_at, id) order.
  assert.equal(collected.length, 5);
  assert.deepEqual(
    collected,
    rows.map((r) => r.id),
    'paginated chunks cover the same set as the single-shot response, in order',
  );
});

test('GET /api/graph/all rejects malformed cursor with 400', async () => {
  const { pool } = makeStubPool([]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/all?cursor=garbage!@#');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid cursor');
});

test('GET /api/graph/all default page returns at most 200 rows + nextCursor when more exist (ORCH 14:21 clarification)', async () => {
  // Sprint 57 T2 — pagination is the default. With a corpus of 250 rows and
  // no cursor / no limit specified, the route fetches LIMIT 201 internally,
  // returns 200 nodes, and emits a non-null nextCursor pointing at the 200th
  // row's (created_at, id) so the next call resumes correctly.
  const baseTime = new Date('2026-05-05T12:00:00.000Z').getTime();
  const allRows = [];
  for (let i = 0; i < 250; i++) {
    allRows.push({
      id: `${(0xa0 + Math.floor(i / 16)).toString(16).padStart(2, '0')}${(i % 16).toString(16)}aaaaa-1111-1111-1111-${i.toString().padStart(12, '0')}`,
      content: `n-${i}`,
      source_type: 'fact',
      category: null,
      project: 'termdeck',
      // Descending wall-clock so ORDER BY created_at DESC returns oldest-id-first
      created_at: new Date(baseTime - i * 1000).toISOString(),
      updated_at: null,
      is_active: true,
      archived: false,
      superseded_by: null,
      degree: 0,
    });
  }
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c'),
      rows: [{ c: 250 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS'),
      // Server requests LIMIT 201; mimic by returning the first 201 rows
      // ordered by (created_at DESC, id DESC).
      rows: allRows.slice(0, 201),
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships'),
      rows: [],
    },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/all');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.nodes.length, 200);
  assert.equal(r.body.totalAvailable, 250);
  // truncated stays false because totalAvailable (250) is below the
  // historical MAX_NODES_GLOBAL=2000 cap; nextCursor is the more-pages
  // signal for paginated callers.
  assert.equal(r.body.truncated, false);
  assert.ok(typeof r.body.nextCursor === 'string' && r.body.nextCursor.length > 0,
    'first-page nextCursor must be non-null when total > default page size');
  // Decoding the cursor must round-trip the 200th row's (created_at, id).
  const decoded = decodeCursor(r.body.nextCursor);
  assert.deepEqual(decoded, { createdAt: allRows[199].created_at, id: allRows[199].id });
});

test('GET /api/graph/all default page returns nextCursor:null when total <= page size', async () => {
  // 1 row total, default page=200 — nextCursor must be null on the only page.
  const { pool } = makeStubPool([
    {
      match: (sql) => sql.includes('SELECT COUNT(*)::int AS c'),
      rows: [{ c: 1 }],
    },
    {
      match: (sql) => sql.includes('WITH all_nodes AS'),
      rows: [
        { id: UUID_A, content: 'only', source_type: 'fact', category: null, project: 'termdeck', created_at: new Date().toISOString(), updated_at: null, is_active: true, archived: false, superseded_by: null, degree: 0 },
      ],
    },
    {
      match: (sql) => sql.includes('FROM memory_relationships'),
      rows: [],
    },
  ]);
  const app = buildApp(() => pool);
  const r = await request(app, 'GET', '/api/graph/all');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.nodes.length, 1);
  assert.equal(r.body.totalAvailable, 1);
  assert.equal(r.body.truncated, false);
  assert.equal(r.body.nextCursor, null);
});

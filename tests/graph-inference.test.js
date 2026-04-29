// Tests for Sprint 38 T2 — graph-inference cron pipeline.
//
// Two surfaces under test:
//   1. The Deno Edge Function source at
//      ~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts.
//      We can't actually run Deno from node:test, but we can read the source
//      and assert structural invariants (SQL shape, conflict policy, env-var
//      gates, model id, cost cap, inferred_by tag format).
//   2. The /api/graph/stats/inference HTTP endpoint in graph-routes.js, which
//      we run in-process against an Express app with a stubbed pg pool —
//      same pattern as tests/graph-routes.test.js.
//
// Run: node --test tests/graph-inference.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const {
  createGraphRoutes,
  fetchInferenceStats,
} = require('../packages/server/src/graph-routes');

const EDGE_FN_PATH = path.join(
  os.homedir(),
  'Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts',
);
const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'packages/server/src/setup/rumen/migrations/003_graph_inference_schedule.sql',
);

// ---- Edge Function: structural invariants -------------------------------

test('Edge Function source is present at the expected path', () => {
  assert.ok(fs.existsSync(EDGE_FN_PATH), `missing: ${EDGE_FN_PATH}`);
});

test('Edge Function uses Haiku 4.5 model id', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(src, /claude-haiku-4-5-20251001/);
});

test('Edge Function declares the 8-type vocabulary including T1 additions', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  for (const t of [
    'supersedes',
    'relates_to',
    'contradicts',
    'elaborates',
    'caused_by',
    'blocks',
    'inspired_by',
    'cross_project_link',
  ]) {
    assert.match(src, new RegExp(`['"\`]${t}['"\`]`), `missing type token: ${t}`);
  }
});

test('Edge Function ON CONFLICT policy targets the unique tuple', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(
    src,
    /ON CONFLICT\s*\(\s*source_id\s*,\s*target_id\s*,\s*relationship_type\s*\)/i,
  );
});

test('Edge Function refresh policy guards on null weight or 7-day staleness', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(src, /weight\s+IS\s+NULL/i);
  assert.match(src, /interval\s+'7 days'/i);
});

test('Edge Function writes weight = 1 - cosine_distance (similarity, not distance)', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // The candidate-pair query computes similarity from the cosine-distance
  // op. Sprint 42 T1 rewrote the join target alias from `m2` to `nbr` (the
  // LATERAL output), so allow either side of the swap.
  assert.match(
    src,
    /1\s*-\s*\(\s*m1\.embedding\s*<=>\s*(?:m2|nbr)\.embedding\s*\)/,
  );
});

// ---- Sprint 42 T1: LATERAL + HNSW structural invariants ------------------

test('Edge Function uses CROSS JOIN LATERAL for HNSW-accelerated top-K (Sprint 42)', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // The pre-Sprint-42 naive `JOIN m2 ON m1.id < m2.id AND (... <=> ...) <= cutoff`
  // shape times out at the 150s Edge Function wall-clock on >5K rows because
  // HNSW can't accelerate a join-clause cosine constraint. The fix is a
  // CROSS JOIN LATERAL feeding a per-row top-K subquery — HNSW serves that.
  assert.match(src, /CROSS\s+JOIN\s+LATERAL/i);
});

test('Edge Function lateral subquery uses ORDER BY <=> ... LIMIT for HNSW', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // The inner LATERAL must `ORDER BY m2.embedding <=> m1.embedding LIMIT K`
  // — that exact shape is what engages the HNSW index. Without the ORDER BY
  // <=> + LIMIT pair, the planner falls back to seq-scan + post-filter, the
  // very pattern Sprint 42 was rewriting away from.
  assert.match(
    src,
    /ORDER\s+BY\s+m2\.embedding\s*<=>\s*m1\.embedding\s+LIMIT/i,
  );
});

test('Edge Function canonicalizes pair orientation via LEAST/GREATEST + DISTINCT ON', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // Each pair (A, B) may be emitted twice from the LATERAL (once seeded by
  // A, once by B). LEAST/GREATEST canonicalizes to one orientation and
  // DISTINCT ON dedupes — preserving the pre-Sprint-42 unique
  // (source_id, target_id) invariant feeding ON CONFLICT.
  assert.match(src, /DISTINCT\s+ON\s*\(\s*LEAST\s*\(\s*m1\.id\s*,\s*nbr\.id\s*\)/i);
  assert.match(src, /GREATEST\s*\(\s*m1\.id\s*,\s*nbr\.id\s*\)/i);
});

test('Edge Function reads GRAPH_INFERENCE_PER_ROW_K with default 8', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // Sprint 42 T1 added the per-row K env knob. 8 is the default; 12 if
  // recall drops at threshold 0.85.
  assert.match(src, /GRAPH_INFERENCE_PER_ROW_K/);
  assert.match(src, /parseIntEnv\(['"]GRAPH_INFERENCE_PER_ROW_K['"],\s*8\)/);
});

test('Edge Function uses inferred_by = cron-YYYY-MM-DD tag format', () => {
  // Load the inferredByTag helper by extracting + eval'ing it. The Edge
  // Function source is Deno-flavored so we can't `require` it directly; we
  // pull the function body out of the source string and run it in isolation.
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  const match = src.match(/function inferredByTag\(now: Date\): string \{([\s\S]*?)\n\}/);
  assert.ok(match, 'inferredByTag helper not found in Edge Function source');
  // Strip the TS return-type annotations from the body for eval.
  const body = match[1];
  // eslint-disable-next-line no-new-func
  const fn = new Function('now', body);
  const out = fn(new Date(Date.UTC(2026, 3, 27, 3, 5, 0)));
  assert.equal(out, 'cron-2026-04-27');
});

test('Edge Function reads the cost-cap env vars with sane defaults', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(src, /GRAPH_INFERENCE_THRESHOLD/);
  assert.match(src, /GRAPH_INFERENCE_MAX_LLM_CALLS/);
  assert.match(src, /GRAPH_INFERENCE_MAX_PAIRS/);
  // Default similarity threshold per FIX-PROPOSED.
  assert.match(src, /parseFloatEnv\(['"]GRAPH_INFERENCE_THRESHOLD['"],\s*0\.85\)/);
  // Default max LLM calls per tick.
  assert.match(src, /parseIntEnv\(['"]GRAPH_INFERENCE_MAX_LLM_CALLS['"],\s*200\)/);
});

test('Edge Function gates LLM classification on GRAPH_LLM_CLASSIFY=1', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(src, /GRAPH_LLM_CLASSIFY['"]?\s*\)\s*===\s*['"]1['"]/);
});

test('Edge Function caps LLM calls per tick at maxLlmCalls', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // The check increments classifications + failures, then compares to maxLlmCalls.
  assert.match(src, /llm_classifications\s*\+\s*summary\.llm_failures\s*<\s*maxLlmCalls/);
});

test('Edge Function distinguishes new-edge vs refresh paths', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  // Only NEW edges trigger LLM classification (per FIX-PROPOSED).
  assert.match(src, /isNewEdge/);
  assert.match(src, /outcome === 'inserted'/);
});

test('Edge Function provides an awaiting-migration runtime guard', () => {
  const src = fs.readFileSync(EDGE_FN_PATH, 'utf8');
  assert.match(src, /awaiting migration 009/);
  assert.match(src, /isMissingColumnError/);
});

// ---- Migration 003: cron schedule ---------------------------------------

test('Migration 003 schedules graph-inference-tick daily at 03:00 UTC', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /cron\.unschedule\('graph-inference-tick'\)/);
  assert.match(sql, /cron\.schedule\(\s*'graph-inference-tick',\s*'0 3 \* \* \*'/);
});

test('Migration 003 reads vault key graph_inference_service_role_key', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /graph_inference_service_role_key/);
  // The cron body itself must NOT reference rumen's vault key — comments
  // referencing it for documentation purposes are fine.
  const cronBody = sql.match(/SELECT cron\.schedule\([\s\S]*?\);/)[0];
  assert.doesNotMatch(cronBody, /rumen_service_role_key/);
});

test('Migration 003 POSTs to the graph-inference Edge Function URL', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /functions\/v1\/graph-inference/);
});

// ---- /api/graph/stats/inference endpoint --------------------------------

const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '22222222-3333-4444-5555-666666666666';

function buildApp(getPool) {
  const app = express();
  app.use(express.json());
  createGraphRoutes({ app, getPool });
  return app;
}

function request(app, method, urlPath) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
            } catch (_e) {
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

function makeStubPool(handlers) {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const h of handlers) {
        const matches = typeof h.match === 'function'
          ? h.match(sql, params)
          : sql.includes(h.match);
        if (matches) {
          if (h.throws) throw h.throws;
          return { rows: typeof h.rows === 'function' ? h.rows(sql, params) : h.rows };
        }
      }
      throw new Error(`stub pool: no handler matched SQL: ${sql.slice(0, 80)}…`);
    },
  };
  return { pool, calls };
}

test('GET /api/graph/stats/inference graceful-degrades when pool absent', async () => {
  const app = buildApp(() => null);
  const res = await request(app, 'GET', '/api/graph/stats/inference');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
});

test('GET /api/graph/stats/inference returns the projected shape', async () => {
  const inferredAt = new Date(Date.UTC(2026, 3, 27, 3, 0, 0)).toISOString();
  const { pool } = makeStubPool([
    {
      match: (sql) => /COUNT\(\*\)::int AS total/.test(sql) && /orphan_memories/.test(sql),
      rows: [{ total: 10, orphan_memories: 2 }],
    },
    {
      match: (sql) => /to_jsonb\(memory_relationships\) AS _row/.test(sql) && /LIMIT 200/.test(sql),
      rows: [
        { _row: { id: UUID_A, inferred_by: 'cron-2026-04-27', inferred_at: inferredAt } },
        { _row: { id: UUID_B, inferred_by: null, inferred_at: null } },
      ],
    },
    {
      match: (sql) => /ILIKE 'cron-%'/.test(sql) && /COUNT\(\*\)/.test(sql),
      rows: [{ n: 5, last_at: inferredAt }],
    },
    {
      match: (sql) => /cron\.job_run_details/.test(sql),
      rows: [
        {
          start_time: new Date(Date.UTC(2026, 3, 27, 3, 0, 0)),
          end_time: new Date(Date.UTC(2026, 3, 27, 3, 0, 12)),
          status: 'succeeded',
          return_message: null,
          duration_ms: 12_000,
        },
      ],
    },
  ]);
  const app = buildApp(() => pool);
  const res = await request(app, 'GET', '/api/graph/stats/inference');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.totalEdges, 10);
  assert.equal(res.body.cronInferredEdges, 5);
  assert.equal(res.body.orphanMemories, 2);
  assert.equal(res.body.lastInferenceAt, inferredAt);
  assert.equal(res.body.lastRunDurationMs, 12_000);
  assert.equal(res.body.recentRuns.length, 1);
  assert.equal(res.body.recentRuns[0].status, 'succeeded');
});

test('GET /api/graph/stats/inference tolerates pre-T1 schema (no inferred_by column)', async () => {
  // Two failure modes a pre-T1 box would hit:
  //   1. The exact cron count query references inferred_by — should fall back
  //      to the sample probe (which already uses to_jsonb).
  //   2. cron.job_run_details may be unavailable on some Supabase plans.
  const { pool } = makeStubPool([
    {
      match: (sql) => /COUNT\(\*\)::int AS total/.test(sql) && /orphan_memories/.test(sql),
      rows: [{ total: 749, orphan_memories: 0 }],
    },
    {
      match: (sql) => /to_jsonb\(memory_relationships\) AS _row/.test(sql),
      rows: [
        { _row: { id: UUID_A } },
        { _row: { id: UUID_B } },
      ],
    },
    {
      match: (sql) => /ILIKE 'cron-%'/.test(sql),
      throws: new Error('column "inferred_by" does not exist'),
    },
    {
      match: (sql) => /cron\.job_run_details/.test(sql),
      throws: new Error('relation "cron.job_run_details" does not exist'),
    },
  ]);
  const app = buildApp(() => pool);
  const res = await request(app, 'GET', '/api/graph/stats/inference');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.totalEdges, 749);
  assert.equal(res.body.cronInferredEdges, 0);
  assert.equal(res.body.lastInferenceAt, null);
  assert.equal(res.body.lastRunDurationMs, null);
  assert.deepEqual(res.body.recentRuns, []);
});

test('GET /api/graph/stats/inference does not shadow GET /api/graph/stats', async () => {
  // Express matches by exact path; both routes must remain reachable.
  const { pool } = makeStubPool([
    { match: 'COUNT(*)::int AS total', rows: [{ total: 10, active: 10, projects: 1 }] },
    { match: 'GROUP BY ROLLUP(relationship_type)', rows: [{ kind: null, by_type: 5 }] },
    { match: 'GROUP BY project', rows: [{ project: 'termdeck', n: 10 }] },
    { match: 'ORDER BY id DESC', rows: [{ _row: {} }] },
  ]);
  const app = buildApp(() => pool);
  const res = await request(app, 'GET', '/api/graph/stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, true);
  assert.ok(res.body.memories);
});

test('fetchInferenceStats is exported for reuse', () => {
  assert.equal(typeof fetchInferenceStats, 'function');
});

// Tests for Sprint 38 / T3 — graph-aware recall.
//
// Coverage map:
//   1. Constructor reads graphRecall/graphRecallDepth/graphRecallK config
//      with sensible defaults + clamping.
//   2. recall() with graphRecall=false delegates to bridge.queryMnestra
//      and forwards options.
//   3. recall() with graphRecall=true calls _recallViaGraph (no bridge dep).
//   4. _recallViaGraph posts the right embedding + RPC bodies.
//   5. _recallViaGraph maps RPC rows → bridge-shaped { memories, total }
//      with final_score → similarity, depth/path/scores preserved.
//   6. _recallViaGraph throws helpfully when keys are missing.
//   7. searchAll forces project_filter=null in the RPC body.
//   8. preflight checkGraphHealth returns pass/warn/fail per substrate.
//   9. Migration 010 SQL has the expected RPC signature, coalesce, and
//      recency formula tokens (catches future drift in the SQL contract).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const RAG_PATH = path.resolve(__dirname, '..', 'packages', 'server', 'src', 'rag.js');
const PREFLIGHT_PATH = path.resolve(__dirname, '..', 'packages', 'server', 'src', 'preflight.js');
const MIGRATION_PATH = path.resolve(
  __dirname, '..', 'packages', 'server', 'src', 'setup',
  'mnestra-migrations', '010_memory_recall_graph.sql'
);

function loadFreshRag() {
  delete require.cache[RAG_PATH];
  delete require.cache[require.resolve(
    path.resolve(__dirname, '..', 'packages', 'server', 'src', 'database')
  )];
  return require(RAG_PATH);
}

// Stub the database module so the require chain doesn't trip on it. The
// recall() code path doesn't touch the db, but the constructor imports it.
function stubDatabase() {
  const dbPath = path.resolve(
    __dirname, '..', 'packages', 'server', 'src', 'database.js'
  );
  if (!require.cache[dbPath]) {
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        logRagEvent: () => {},
        getUnsyncedRagEvents: () => [],
        markRagEventsSynced: () => {},
      },
    };
  }
}

function makeConfig(extra) {
  return {
    rag: {
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      openaiApiKey: 'sk-test',
      ...extra,
    },
    projects: {},
  };
}

// ── 1. Constructor flag readout + clamping ─────────────────────────────────

test('constructor: graphRecall defaults off, depth/k clamped to safe ranges', () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();

  const r1 = new RAGIntegration(makeConfig(), null);
  assert.equal(r1.graphRecall, false, 'graphRecall defaults to false');
  assert.equal(r1.graphRecallDepth, 2, 'depth defaults to 2');
  assert.equal(r1.graphRecallK, 10, 'k defaults to 10');
  assert.equal(r1.graphRecallRecencyHalflifeDays, 30, 'half-life defaults to 30 days');

  const r2 = new RAGIntegration(makeConfig({
    graphRecall: true, graphRecallDepth: 99, graphRecallK: 999,
    graphRecallRecencyHalflifeDays: 7,
  }), null);
  assert.equal(r2.graphRecall, true);
  assert.equal(r2.graphRecallDepth, 5, 'depth clamped to 5 (upper bound)');
  assert.equal(r2.graphRecallK, 50, 'k clamped to 50 (upper bound)');
  assert.equal(r2.graphRecallRecencyHalflifeDays, 7, 'half-life passes through');

  const r3 = new RAGIntegration(makeConfig({
    graphRecall: true, graphRecallDepth: 0, graphRecallK: 0,
  }), null);
  assert.equal(r3.graphRecallDepth, 1, 'depth clamped to 1 (lower bound)');
  assert.equal(r3.graphRecallK, 1, 'k clamped to 1 (lower bound)');
});

// ── 2. recall() vector-only path delegates to the bridge ───────────────────

test('recall() with graphRecall=false delegates to bridge.queryMnestra', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: false }), null);

  const calls = [];
  rag.setBridge({
    async queryMnestra(args) {
      calls.push(args);
      return { memories: [{ content: 'vec hit' }], total: 1 };
    },
  });

  const out = await rag.recall('what is termdeck', {
    project: 'termdeck', searchAll: false, sessionContext: { cwd: '/tmp/x' },
  });

  assert.equal(out.total, 1);
  assert.equal(out.memories[0].content, 'vec hit');
  assert.equal(calls.length, 1, 'bridge called exactly once');
  assert.equal(calls[0].question, 'what is termdeck');
  assert.equal(calls[0].project, 'termdeck');
  assert.equal(calls[0].searchAll, false);
  assert.deepEqual(calls[0].sessionContext, { cwd: '/tmp/x' });
});

test('recall() with no bridge wired throws a helpful error', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: false }), null);

  await assert.rejects(
    () => rag.recall('q'),
    /no bridge wired/
  );
});

// ── 3. recall() graph path bypasses the bridge entirely ────────────────────

test('recall() with graphRecall=true calls graph RPC, never touches bridge', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: true }), null);

  let bridgeCalled = false;
  rag.setBridge({
    async queryMnestra() { bridgeCalled = true; return { memories: [], total: 0 }; },
  });

  const fetches = [];
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url, opts });
    if (url.includes('openai.com')) {
      return {
        ok: true,
        async json() { return { data: [{ embedding: new Array(1536).fill(0) }] }; },
      };
    }
    return {
      ok: true,
      async json() {
        return [
          {
            memory_id: 'mem-1', content: 'graph hit', project: 'termdeck',
            depth: 0, vector_score: 0.9, edge_weight: 1.0,
            recency_score: 0.5, final_score: 0.45, path: ['mem-1'],
            created_at: '2026-04-27T00:00:00Z',
          },
        ];
      },
    };
  };

  try {
    const out = await rag.recall('graph query', { project: 'termdeck' });
    assert.equal(bridgeCalled, false, 'bridge must not be called on graph path');
    assert.equal(out.total, 1);
    assert.equal(out.memories[0].content, 'graph hit');
    assert.equal(out.memories[0].similarity, 0.45, 'final_score → similarity');
    assert.equal(out.memories[0].depth, 0);
    assert.deepEqual(out.memories[0].path, ['mem-1']);
    assert.equal(fetches.length, 2, 'one OpenAI + one Supabase RPC');
  } finally {
    delete globalThis.fetch;
  }
});

// ── 4. RPC body shape ──────────────────────────────────────────────────────

test('_recallViaGraph posts correct embedding + RPC payloads', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({
    graphRecall: true, graphRecallDepth: 3, graphRecallK: 7,
  }), null);

  const fetches = [];
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url, body: JSON.parse(opts.body) });
    if (url.includes('openai.com')) {
      return {
        ok: true,
        async json() { return { data: [{ embedding: [0.1, 0.2, 0.3] }] }; },
      };
    }
    return { ok: true, async json() { return []; } };
  };

  try {
    await rag.recall('hello', { project: 'mnestra' });

    assert.equal(fetches[0].url, 'https://api.openai.com/v1/embeddings');
    assert.equal(fetches[0].body.model, 'text-embedding-3-large');
    assert.equal(fetches[0].body.input, 'hello');
    assert.equal(fetches[0].body.dimensions, 1536);

    assert.match(fetches[1].url, /\/rpc\/memory_recall_graph$/);
    assert.equal(fetches[1].body.project_filter, 'mnestra');
    assert.equal(fetches[1].body.max_depth, 3);
    assert.equal(fetches[1].body.k, 7);
    assert.equal(fetches[1].body.query_embedding, '[0.1,0.2,0.3]');
  } finally {
    delete globalThis.fetch;
  }
});

// ── 5. Result mapping preserves graph-specific fields ──────────────────────

test('_recallViaGraph preserves depth, path, vector/edge/recency scores', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: true }), null);

  globalThis.fetch = async (url) => {
    if (url.includes('openai.com')) {
      return {
        ok: true,
        async json() { return { data: [{ embedding: new Array(1536).fill(0) }] }; },
      };
    }
    return {
      ok: true,
      async json() {
        return [
          { memory_id: 'a', content: 'A', project: 'p', depth: 0,
            vector_score: 0.9, edge_weight: 1.0, recency_score: 0.8,
            final_score: 0.72, path: ['a'] },
          { memory_id: 'b', content: 'B', project: 'p', depth: 1,
            vector_score: 0.9, edge_weight: 0.5, recency_score: 0.6,
            final_score: 0.27, path: ['a', 'b'] },
        ];
      },
    };
  };

  try {
    const out = await rag.recall('q', { project: 'p' });
    assert.equal(out.total, 2);
    assert.equal(out.memories[0].depth, 0);
    assert.equal(out.memories[1].depth, 1);
    assert.equal(out.memories[0].similarity, 0.72);
    assert.equal(out.memories[1].similarity, 0.27);
    assert.deepEqual(out.memories[1].path, ['a', 'b']);
    assert.equal(out.memories[1].edge_weight, 0.5);
    assert.equal(out.memories[1].vector_score, 0.9);
    assert.equal(out.memories[1].recency_score, 0.6);
  } finally {
    delete globalThis.fetch;
  }
});

// ── 6. Error handling ──────────────────────────────────────────────────────

test('_recallViaGraph throws when supabaseUrl is missing', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const cfg = makeConfig({ graphRecall: true });
  cfg.rag.supabaseUrl = null;
  const rag = new RAGIntegration(cfg, null);

  await assert.rejects(() => rag.recall('q'), /supabaseUrl\/supabaseKey not configured/);
});

test('_recallViaGraph throws when OPENAI_API_KEY is missing', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const cfg = makeConfig({ graphRecall: true });
  cfg.rag.openaiApiKey = null;
  const prevEnvKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const rag = new RAGIntegration(cfg, null);
    await assert.rejects(() => rag.recall('q'), /OPENAI_API_KEY not configured/);
  } finally {
    if (prevEnvKey) process.env.OPENAI_API_KEY = prevEnvKey;
  }
});

test('_recallViaGraph surfaces RPC failures with the HTTP status', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: true }), null);

  globalThis.fetch = async (url) => {
    if (url.includes('openai.com')) {
      return {
        ok: true,
        async json() { return { data: [{ embedding: new Array(1536).fill(0) }] }; },
      };
    }
    return { ok: false, status: 404, async text() { return 'Could not find function'; } };
  };

  try {
    await assert.rejects(() => rag.recall('q'), /memory_recall_graph RPC failed \(404\)/);
  } finally {
    delete globalThis.fetch;
  }
});

// ── 7. searchAll forces project=null ───────────────────────────────────────

test('searchAll=true overrides project to null in the RPC body', async () => {
  stubDatabase();
  const { RAGIntegration } = loadFreshRag();
  const rag = new RAGIntegration(makeConfig({ graphRecall: true }), null);

  let rpcBody = null;
  globalThis.fetch = async (url, opts) => {
    if (url.includes('openai.com')) {
      return {
        ok: true,
        async json() { return { data: [{ embedding: new Array(1536).fill(0) }] }; },
      };
    }
    rpcBody = JSON.parse(opts.body);
    return { ok: true, async json() { return []; } };
  };

  try {
    await rag.recall('q', { project: 'termdeck', searchAll: true });
    assert.equal(rpcBody.project_filter, null, 'searchAll forces null project');
  } finally {
    delete globalThis.fetch;
  }
});

// ── 8. Preflight checkGraphHealth ──────────────────────────────────────────

test('checkGraphHealth: disabled → pass with descriptive detail', async () => {
  delete require.cache[PREFLIGHT_PATH];
  const { runPreflight } = require(PREFLIGHT_PATH);
  // When graphRecall is off, the check passes with a "disabled" detail
  // regardless of pg state — verify by running with no DATABASE_URL.
  const prevDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const result = await runPreflight({ rag: { graphRecall: false } });
    const graph = result.checks.find((c) => c.name === 'graph_health');
    assert.ok(graph, 'graph_health check is registered');
    assert.equal(graph.passed, true);
    assert.match(graph.detail, /disabled/);
  } finally {
    if (prevDb) process.env.DATABASE_URL = prevDb;
  }
});

test('checkGraphHealth: enabled but DATABASE_URL missing → fail', async () => {
  delete require.cache[PREFLIGHT_PATH];
  const { runPreflight } = require(PREFLIGHT_PATH);
  const prevDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const result = await runPreflight({ rag: { graphRecall: true } });
    const graph = result.checks.find((c) => c.name === 'graph_health');
    assert.equal(graph.passed, false);
    assert.match(graph.detail, /DATABASE_URL/);
  } finally {
    if (prevDb) process.env.DATABASE_URL = prevDb;
  }
});

// ── 9. Migration SQL contract ──────────────────────────────────────────────

test('migration 010 SQL exists and contains the expected contract tokens', () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), `migration not found at ${MIGRATION_PATH}`);
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  // Function signature
  assert.match(sql, /create or replace function memory_recall_graph/i);
  assert.match(sql, /query_embedding\s+vector\(1536\)/i);
  assert.match(sql, /project_filter\s+text\s+default\s+null/i);
  assert.match(sql, /max_depth\s+int\s+default\s+2/i);
  assert.match(sql, /k\s+int\s+default\s+10/i);

  // Stage 1 reuses match_memories (T3 brief: don't reimplement vector recall)
  assert.match(sql, /from match_memories\(/i);

  // Stage 2 uses T1's expand_memory_neighborhood
  assert.match(sql, /expand_memory_neighborhood\(/i);

  // Re-rank formula: vector × edge × recency
  assert.match(sql, /vector_score\s*\*\s*edge_weight/i);
  assert.match(sql, /exp\(-extract\(epoch from/i);
  assert.match(sql, /30\.0\s*\*\s*86400/i, '30-day half-life recency');

  // coalesce(weight, 0.5) — T2 hasn't classified the 749 pre-T2 edges
  assert.match(sql, /coalesce\(r\.weight,\s*0\.5\)/i);

  // Final ranking + cap
  assert.match(sql, /order by final_score desc/i);
  assert.match(sql, /limit 50/i);

  // Grant for PostgREST visibility
  assert.match(sql, /grant execute on function memory_recall_graph/i);
});

test('migration 010 mirror exists in engram/migrations and is byte-identical', () => {
  const mirror = '/Users/joshuaizzard/Documents/Graciella/engram/migrations/010_memory_recall_graph.sql';
  if (!fs.existsSync(mirror)) {
    // Engram repo may not exist on every dev box; skip rather than fail.
    return;
  }
  const a = fs.readFileSync(MIGRATION_PATH);
  const b = fs.readFileSync(mirror);
  assert.ok(a.equals(b), 'TermDeck-bundled and engram-canonical migrations must be byte-identical');
});

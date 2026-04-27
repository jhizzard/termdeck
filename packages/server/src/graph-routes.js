'use strict';

// Graph routes — Sprint 38 T4. Powers the D3 force-directed knowledge-graph
// view in the dashboard.
//
// Endpoints:
//   GET /api/graph/project/:name          per-project node + edge set
//   GET /api/graph/memory/:id?depth=2     per-memory N-hop neighborhood
//   GET /api/graph/stats                  global topology counts
//
// All three accept the same { app, getPool } injection so tests can stub the
// pg pool. getPool() returns null when DATABASE_URL is absent or the pool
// failed to initialize — endpoints respond `{ enabled: false }` in that case
// (mirrors the rumen endpoints' graceful-degrade pattern).
//
// Schema notes:
//   - memory_items.project is a single text column (not array).
//   - memory_relationships.relationship_type is the edge type (CHECK enforces
//     a vocabulary; T1's migration 009 expands to 8 values).
//   - T2 may add weight + inferred_at + inferred_by mid-sprint. We SELECT them
//     conditionally via to_jsonb so missing columns don't break the query.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const NODE_LABEL_LEN = 200;
const MAX_DEPTH = 4;
const DEFAULT_DEPTH = 2;
const MAX_NODES_PER_PROJECT = 2000;

function snippet(content, len = NODE_LABEL_LEN) {
  if (!content) return '';
  const s = String(content).replace(/\s+/g, ' ').trim();
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

function asIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

// SELECT shape — keep column list explicit so additions to memory_items
// (Sprint 39+) don't accidentally leak into the API.
const NODE_COLUMNS = [
  'id', 'content', 'source_type', 'category', 'project',
  'created_at', 'updated_at', 'is_active', 'archived', 'superseded_by',
];
const NODE_COLUMNS_SQL = NODE_COLUMNS.join(', ');
const NODE_COLUMNS_PREFIXED = (alias) => NODE_COLUMNS.map((c) => `${alias}.${c}`).join(', ');

const EDGE_COLUMNS_BASE = ['id', 'source_id', 'target_id', 'relationship_type', 'created_at'];
const EDGE_COLUMNS_BASE_SQL = EDGE_COLUMNS_BASE.join(', ');

// T2 will add weight/inferred_at/inferred_by mid-sprint. Use to_jsonb so a
// SELECT on a fresh pre-T2 box doesn't error on missing columns. The to_jsonb
// row carries whichever columns exist; we read weight/inferred_at/inferred_by
// off the resulting JSON.
const EDGE_COLUMNS_T2_SQL = `to_jsonb(memory_relationships) AS _row`;

function rowToNode(row) {
  const createdAt = asIso(row.created_at);
  const updatedAt = asIso(row.updated_at);
  const ageMs = createdAt ? Date.now() - new Date(createdAt).getTime() : null;
  const ageDays = ageMs == null ? null : ageMs / 86_400_000;
  return {
    id: row.id,
    label: snippet(row.content, 80),
    snippet: snippet(row.content, NODE_LABEL_LEN),
    source_type: row.source_type || null,
    category: row.category || null,
    project: row.project || 'global',
    createdAt,
    updatedAt,
    ageDays: ageDays == null ? null : Number(ageDays.toFixed(2)),
    degree: typeof row.degree === 'number' ? row.degree : Number(row.degree || 0),
    superseded: !!row.superseded_by,
  };
}

function rowToEdge(row) {
  const meta = row._row && typeof row._row === 'object' ? row._row : {};
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    kind: row.relationship_type,
    createdAt: asIso(row.created_at),
    weight: typeof meta.weight === 'number' ? meta.weight : null,
    inferredAt: asIso(meta.inferred_at),
    inferredBy: meta.inferred_by || null,
  };
}

function rowToFullMemory(row) {
  return {
    id: row.id,
    content: row.content || '',
    source_type: row.source_type || null,
    category: row.category || null,
    project: row.project || 'global',
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
    isActive: row.is_active !== false,
    archived: !!row.archived,
    supersededBy: row.superseded_by || null,
  };
}

function disabledPayload(extra = {}) {
  return Object.assign({ enabled: false, reason: 'DATABASE_URL not configured' }, extra);
}

async function fetchProjectGraph(pool, projectName) {
  // One round-trip:
  //   1. nodes for the project (with degree computed via subquery so we don't
  //      pull edges into JS just to count).
  //   2. edges where BOTH endpoints belong to the project's node set.
  //
  // We deliberately scope to is_active=true and archived=false (matches the
  // mnestra recall convention) so superseded/archived noise stays out of the
  // visualization.
  const nodesSql = `
    WITH proj_nodes AS (
      SELECT ${NODE_COLUMNS_SQL}
        FROM memory_items
       WHERE project = $1
         AND is_active = TRUE
         AND archived = FALSE
       ORDER BY created_at DESC
       LIMIT ${MAX_NODES_PER_PROJECT}
    )
    SELECT
      n.*,
      COALESCE((
        SELECT COUNT(*)::int
          FROM memory_relationships r
         WHERE r.source_id = n.id OR r.target_id = n.id
      ), 0) AS degree
      FROM proj_nodes n
  `;
  const nodesRes = await pool.query(nodesSql, [projectName]);
  const nodes = nodesRes.rows.map(rowToNode);
  const idSet = new Set(nodes.map((n) => n.id));
  if (idSet.size === 0) {
    return { nodes: [], edges: [] };
  }
  const ids = Array.from(idSet);

  // ANY($1::uuid[]) is the safe way to pass a uuid array param.
  const edgesSql = `
    SELECT ${EDGE_COLUMNS_BASE_SQL}, ${EDGE_COLUMNS_T2_SQL}
      FROM memory_relationships
     WHERE source_id = ANY($1::uuid[])
       AND target_id = ANY($1::uuid[])
  `;
  const edgesRes = await pool.query(edgesSql, [ids]);
  const edges = edgesRes.rows.map(rowToEdge);
  return { nodes, edges };
}

async function fetchNeighborhood(pool, rootId, depth) {
  // Inline recursive CTE so T4 ships independently of T1's
  // expand_memory_neighborhood RPC. When that RPC lands, the CTE here can be
  // replaced with `SELECT * FROM expand_memory_neighborhood($1, $2)` without
  // changing the return shape (memory_id, depth).
  //
  // Cycle-safety: the path[] column accumulates visited ids; we only descend
  // into ids not already in the path. Caps at depth so a runaway loop can't
  // OOM the server.
  const safeDepth = Math.max(1, Math.min(MAX_DEPTH, depth));
  const sql = `
    WITH RECURSIVE walk AS (
      SELECT $1::uuid AS memory_id, 0 AS depth, ARRAY[$1::uuid] AS path
      UNION ALL
      SELECT
        CASE WHEN r.source_id = w.memory_id THEN r.target_id ELSE r.source_id END AS memory_id,
        w.depth + 1 AS depth,
        w.path || (CASE WHEN r.source_id = w.memory_id THEN r.target_id ELSE r.source_id END)
        FROM walk w
        JOIN memory_relationships r
          ON (r.source_id = w.memory_id OR r.target_id = w.memory_id)
       WHERE w.depth < ${safeDepth}
         AND NOT (
           (CASE WHEN r.source_id = w.memory_id THEN r.target_id ELSE r.source_id END)
             = ANY (w.path)
         )
    )
    SELECT DISTINCT memory_id, MIN(depth) AS depth
      FROM walk
     GROUP BY memory_id
  `;
  const walkRes = await pool.query(sql, [rootId]);
  const memoryIds = walkRes.rows.map((r) => r.memory_id);
  const depthByMemoryId = new Map(walkRes.rows.map((r) => [r.memory_id, Number(r.depth)]));
  if (memoryIds.length === 0) {
    return { nodes: [], edges: [], depthByMemoryId };
  }

  // Fetch full memory rows for each id in the walk + their degree.
  const nodesSql = `
    SELECT
      ${NODE_COLUMNS_PREFIXED('m')},
      COALESCE((
        SELECT COUNT(*)::int
          FROM memory_relationships r
         WHERE r.source_id = m.id OR r.target_id = m.id
      ), 0) AS degree
      FROM memory_items m
     WHERE m.id = ANY($1::uuid[])
       AND m.is_active = TRUE
       AND m.archived = FALSE
  `;
  const nodesRes = await pool.query(nodesSql, [memoryIds]);
  const nodes = nodesRes.rows.map((row) => {
    const node = rowToNode(row);
    node.depth = depthByMemoryId.get(row.id) ?? 0;
    return node;
  });

  // Edges where BOTH endpoints are in the walk.
  const edgesSql = `
    SELECT ${EDGE_COLUMNS_BASE_SQL}, ${EDGE_COLUMNS_T2_SQL}
      FROM memory_relationships
     WHERE source_id = ANY($1::uuid[])
       AND target_id = ANY($1::uuid[])
  `;
  const edgesRes = await pool.query(edgesSql, [memoryIds]);
  const edges = edgesRes.rows.map(rowToEdge);
  return { nodes, edges, depthByMemoryId };
}

async function fetchStats(pool) {
  const memoriesSql = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_active = TRUE AND archived = FALSE)::int AS active,
      COUNT(DISTINCT project)::int AS projects
      FROM memory_items
  `;
  const edgesSql = `
    SELECT
      COUNT(*)::int AS total,
      relationship_type AS kind,
      COUNT(*)::int AS by_type
      FROM memory_relationships
     GROUP BY ROLLUP(relationship_type)
  `;
  const projectSql = `
    SELECT project, COUNT(*)::int AS n
      FROM memory_items
     WHERE is_active = TRUE AND archived = FALSE
     GROUP BY project
     ORDER BY n DESC
     LIMIT 30
  `;
  // T2's inferred_at column may not exist yet — guard with a try/catch and
  // fall back to a null lastInferredAt so the endpoint stays alive on a
  // pre-T2 box.
  const lastInferredSqlRaw = `
    SELECT to_jsonb(memory_relationships) - 'embedding' AS _row
      FROM memory_relationships
     ORDER BY id DESC
     LIMIT 1
  `;

  const [memoriesRes, edgesRes, projectsRes] = await Promise.all([
    pool.query(memoriesSql),
    pool.query(edgesSql),
    pool.query(projectSql),
  ]);

  const memoriesRow = memoriesRes.rows[0] || { total: 0, active: 0, projects: 0 };

  let totalEdges = 0;
  const byType = {};
  for (const row of edgesRes.rows) {
    if (row.kind === null) {
      // ROLLUP NULL row carries the grand total.
      totalEdges = Number(row.by_type || 0);
    } else {
      byType[row.kind] = Number(row.by_type || 0);
    }
  }

  const byProject = {};
  for (const row of projectsRes.rows) {
    byProject[row.project] = Number(row.n || 0);
  }

  let lastInferredAt = null;
  let lastInferredBy = null;
  try {
    const r = await pool.query(lastInferredSqlRaw);
    const meta = r.rows[0] && r.rows[0]._row ? r.rows[0]._row : null;
    if (meta) {
      lastInferredAt = asIso(meta.inferred_at) || null;
      lastInferredBy = meta.inferred_by || null;
    }
  } catch (_e) {
    // pre-T2: column or extension missing — leave nulls.
  }

  return {
    enabled: true,
    memories: {
      total: Number(memoriesRow.total || 0),
      active: Number(memoriesRow.active || 0),
      projects: Number(memoriesRow.projects || 0),
    },
    edges: {
      total: totalEdges,
      byType,
    },
    byProject,
    lastInferredAt,
    lastInferredBy,
    generatedAt: new Date().toISOString(),
  };
}

// Sprint 38 T2 — inference-pipeline stats. Distinct from the topology-focused
// /api/graph/stats above: this answers "is the graph-inference cron healthy?"
// using memory_relationships' inferred_* columns plus pg_cron's job_run_details.
//
// All optional columns are read via to_jsonb so a pre-T1 box (no inferred_at /
// inferred_by / weight columns) still gets a usable response with nulls.
async function fetchInferenceStats(pool) {
  const totalsSql = `
    SELECT
      COUNT(*)::int AS total,
      (
        SELECT COUNT(*)::int FROM memory_items
         WHERE is_active = TRUE AND archived = FALSE
           AND id NOT IN (
             SELECT source_id FROM memory_relationships
             UNION
             SELECT target_id FROM memory_relationships
           )
      ) AS orphan_memories
      FROM memory_relationships
  `;

  // cron-tagged rows + last cron-inferred timestamp. Anonymous to_jsonb dance
  // so a missing column on a pre-T1 box returns nulls rather than errors.
  const cronSummarySql = `
    SELECT to_jsonb(memory_relationships) AS _row
      FROM memory_relationships
     ORDER BY id DESC
     LIMIT 200
  `;

  const [totalsRes, sampleRes] = await Promise.all([
    pool.query(totalsSql),
    pool.query(cronSummarySql).catch(() => ({ rows: [] })),
  ]);

  const totalsRow = totalsRes.rows[0] || { total: 0, orphan_memories: 0 };

  let cronInferredEdges = 0;
  let lastInferenceAt = null;
  for (const row of sampleRes.rows) {
    const meta = row._row && typeof row._row === 'object' ? row._row : null;
    if (!meta) continue;
    const inferredBy = typeof meta.inferred_by === 'string' ? meta.inferred_by : null;
    if (inferredBy && inferredBy.startsWith('cron-')) {
      cronInferredEdges++;
      const at = asIso(meta.inferred_at);
      if (at && (!lastInferenceAt || at > lastInferenceAt)) {
        lastInferenceAt = at;
      }
    }
  }

  // Authoritative count for cron-inferred edges (separate query so the sample
  // above stays a fast probe; this one only runs after the totals land).
  let cronInferredTotal = cronInferredEdges;
  let lastCronInferredAt = lastInferenceAt;
  try {
    const exactRes = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(inferred_at) AS last_at
         FROM memory_relationships
        WHERE inferred_by ILIKE 'cron-%'`,
    );
    const exactRow = exactRes.rows[0];
    if (exactRow) {
      cronInferredTotal = Number(exactRow.n || 0);
      lastCronInferredAt = asIso(exactRow.last_at) || lastInferenceAt;
    }
  } catch (_e) {
    // Pre-T1: inferred_by column missing — fall back to the sample probe.
  }

  // Last 5 graph-inference-tick runs from pg_cron's job_run_details.
  // Wrapped in try/catch because some Supabase plans gate access to cron.*
  // tables and we'd rather return nulls than 500.
  let recentRuns = [];
  let lastRunDurationMs = null;
  try {
    const cronRes = await pool.query(
      `SELECT
         start_time, end_time, status, return_message,
         EXTRACT(EPOCH FROM (end_time - start_time)) * 1000 AS duration_ms
         FROM cron.job_run_details
        WHERE jobname = 'graph-inference-tick'
        ORDER BY start_time DESC
        LIMIT 5`,
    );
    recentRuns = cronRes.rows.map((row) => ({
      startedAt: asIso(row.start_time),
      endedAt: asIso(row.end_time),
      status: row.status || null,
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      message: row.return_message || null,
    }));
    if (recentRuns.length > 0 && recentRuns[0].durationMs != null) {
      lastRunDurationMs = recentRuns[0].durationMs;
    }
  } catch (_e) {
    // pg_cron not enabled or cron schema not readable — recentRuns stays [].
  }

  return {
    enabled: true,
    totalEdges: Number(totalsRow.total || 0),
    cronInferredEdges: cronInferredTotal,
    orphanMemories: Number(totalsRow.orphan_memories || 0),
    lastInferenceAt: lastCronInferredAt,
    lastRunDurationMs,
    recentRuns,
    generatedAt: new Date().toISOString(),
  };
}

function createGraphRoutes({ app, getPool }) {
  if (!app) throw new Error('app required');
  if (typeof getPool !== 'function') throw new Error('getPool callback required');

  app.get('/api/graph/project/:name', async (req, res) => {
    const project = req.params.name;
    if (!project || !PROJECT_RE.test(project)) {
      return res.status(400).json({ error: 'invalid project name' });
    }
    const pool = getPool();
    if (!pool) return res.json(disabledPayload({ project, nodes: [], edges: [] }));

    try {
      const { nodes, edges } = await fetchProjectGraph(pool, project);
      const byType = {};
      for (const e of edges) {
        byType[e.kind] = (byType[e.kind] || 0) + 1;
      }
      res.json({
        enabled: true,
        project,
        stats: {
          nodes: nodes.length,
          edges: edges.length,
          byType,
          truncated: nodes.length >= MAX_NODES_PER_PROJECT,
        },
        nodes,
        edges,
      });
    } catch (err) {
      console.warn('[graph] /api/graph/project failed:', err.message);
      res.status(500).json({ error: 'graph query failed', detail: err.message });
    }
  });

  app.get('/api/graph/memory/:id', async (req, res) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid memory id' });
    }
    const depthRaw = parseInt(req.query.depth, 10);
    const depth = Number.isFinite(depthRaw) ? depthRaw : DEFAULT_DEPTH;

    const pool = getPool();
    if (!pool) return res.json(disabledPayload({ root: null, nodes: [], edges: [] }));

    try {
      // Fetch the root memory in full first so we can return content even when
      // it has no edges yet.
      const rootRes = await pool.query(
        `SELECT ${NODE_COLUMNS} FROM memory_items WHERE id = $1`,
        [id],
      );
      if (rootRes.rows.length === 0) {
        return res.status(404).json({ error: 'memory not found' });
      }
      const root = rowToFullMemory(rootRes.rows[0]);

      const { nodes, edges } = await fetchNeighborhood(pool, id, depth);
      res.json({
        enabled: true,
        root,
        depth: Math.max(1, Math.min(MAX_DEPTH, depth)),
        nodes,
        edges,
        stats: {
          nodes: nodes.length,
          edges: edges.length,
        },
      });
    } catch (err) {
      console.warn('[graph] /api/graph/memory failed:', err.message);
      res.status(500).json({ error: 'graph query failed', detail: err.message });
    }
  });

  app.get('/api/graph/stats', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(disabledPayload());
    try {
      const stats = await fetchStats(pool);
      res.json(stats);
    } catch (err) {
      console.warn('[graph] /api/graph/stats failed:', err.message);
      res.status(500).json({ error: 'graph stats query failed', detail: err.message });
    }
  });

  // Sprint 38 T2 — operational view of the graph-inference cron pipeline.
  // Distinct from /api/graph/stats (T4 topology). Express routes by exact
  // path so the more-specific /stats/inference does not shadow /stats.
  app.get('/api/graph/stats/inference', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(disabledPayload());
    try {
      const stats = await fetchInferenceStats(pool);
      res.json(stats);
    } catch (err) {
      console.warn('[graph] /api/graph/stats/inference failed:', err.message);
      res.status(500).json({ error: 'graph inference stats query failed', detail: err.message });
    }
  });
}

module.exports = {
  createGraphRoutes,
  // Exported for tests + reuse:
  fetchProjectGraph,
  fetchNeighborhood,
  fetchStats,
  fetchInferenceStats,
  rowToNode,
  rowToEdge,
  rowToFullMemory,
  snippet,
  UUID_RE,
  PROJECT_RE,
  MAX_NODES_PER_PROJECT,
  MAX_DEPTH,
  DEFAULT_DEPTH,
};

# Sprint 38 — T3: Graph-aware recall

**Lane goal:** Ship `memory_recall_graph(query, project?, depth=2)` — a recall path that does vector recall first, then expands the top-K results through `memory_relationships` to N hops, then re-ranks the union by combined signal: `final_score = vector_score × edge_weight × recency_decay`. Add a `rag.graphRecall: true` config flag in `rag.js` so daily-flow recall can opt into graph expansion. Update `preflight.js` to add a graph-health check.

**Target deliverable:**
1. NEW Supabase RPC `memory_recall_graph(query text, project text DEFAULT NULL, depth int DEFAULT 2, k int DEFAULT 10) RETURNS TABLE`.
2. NEW Mnestra MCP tool `memory_recall_graph` exposing the RPC.
3. `packages/server/src/rag.js` config flag `graphRecall: bool` routing to the new path when true.
4. `packages/server/src/preflight.js` graph-health check entry.

## Pre-sprint findings (from orchestrator probe at 2026-04-27 17:25 ET)

- `memory_relationships` already has **749 edges** distributed across 5 schema-allowed kinds. T1 expands the vocabulary to 8; T2's cron will populate `weight` for new edges. Existing 749 edges have `weight = NULL` until T2's optional backfill runs — your re-rank formula must handle `weight IS NULL` gracefully.
- Existing column is `relationship_type` (not `kind`). Your RPC SQL queries the existing column name; the MCP tool's input schema can use `kind` for friendliness if it prefers.
- The Mnestra `match_memories` RPC already exists for vector recall; reuse it as the first stage rather than reimplementing.

## RPC design

```sql
CREATE OR REPLACE FUNCTION memory_recall_graph(
  query_embedding vector(1536),
  project_filter text DEFAULT NULL,
  max_depth int DEFAULT 2,
  k int DEFAULT 10
)
RETURNS TABLE (
  memory_id uuid,
  content text,
  project text,
  depth int,
  vector_score float,
  edge_weight float,
  recency_score float,
  final_score float,
  path uuid[]
)
LANGUAGE sql STABLE
AS $$
  WITH initial AS (
    -- Stage 1: vector recall, top-K
    SELECT
      id AS memory_id,
      content,
      project,
      0 AS depth,
      1 - (embedding <=> query_embedding) AS vector_score,
      created_at,
      ARRAY[id] AS path
    FROM memory_items
    WHERE (project_filter IS NULL OR project = project_filter)
    ORDER BY embedding <=> query_embedding
    LIMIT k
  ),
  expanded AS (
    -- Stage 2: graph expansion via T1's RPC
    SELECT
      n.memory_id,
      mi.content,
      mi.project,
      n.depth,
      i.vector_score AS source_vector_score,
      n.path,
      mi.created_at,
      coalesce(
        (SELECT avg(coalesce(r.weight, 0.5)) FROM memory_relationships r
          WHERE (r.source_id, r.target_id) IN (
            SELECT n.path[generate_series(1, array_length(n.path,1)-1)],
                   n.path[generate_series(2, array_length(n.path,1))]
          )),
        0.5
      ) AS edge_weight
    FROM initial i
    CROSS JOIN LATERAL expand_memory_neighborhood(i.memory_id, max_depth) n
    JOIN memory_items mi ON mi.id = n.memory_id
    WHERE n.depth > 0
  ),
  unioned AS (
    SELECT memory_id, content, project, depth, vector_score, 1.0 AS edge_weight, created_at, path FROM initial
    UNION ALL
    SELECT memory_id, content, project, depth, source_vector_score AS vector_score, edge_weight, created_at, path FROM expanded
  )
  SELECT
    memory_id,
    content,
    project,
    depth,
    vector_score,
    edge_weight,
    -- recency decay: half-life ~30 days
    exp(-extract(epoch from now() - created_at) / (30 * 86400)) AS recency_score,
    vector_score * edge_weight * exp(-extract(epoch from now() - created_at) / (30 * 86400)) AS final_score,
    path
  FROM unioned
  ORDER BY final_score DESC
  LIMIT 50;
$$;
```

**Key design decisions worth flagging in your FINDING:**

- `coalesce(weight, 0.5)` for edges T2 hasn't classified yet (the existing 749). Tunable; 0.5 is a neutral mid-prior.
- Recency decay: 30-day half-life. PLANNING.md doesn't specify; pick a default and expose via config (`rag.graphRecallRecencyHalflifeDays`).
- Final-result LIMIT 50 — large enough to be useful, small enough to not overwhelm the recall consumer. Tunable.
- Path edges aren't directly summed; the `edge_weight` is the AVERAGE of edges along the path (so longer paths get diluted, not punished outright). Alternative: multiply edge weights along the path (steeper decay). Choose AVG for first pass; revisit if recall quality is poor.

## `rag.js` config flag

```js
// packages/server/src/rag.js
class RAGIntegration {
  constructor(config, ...) {
    this.graphRecall = config?.rag?.graphRecall === true;
    this.graphRecallDepth = config?.rag?.graphRecallDepth ?? 2;
    // ...
  }

  async recall(query, project) {
    if (this.graphRecall) {
      return this._recallViaGraph(query, project, this.graphRecallDepth);
    }
    return this._recallViaVectorOnly(query, project);
  }
}
```

The `_recallViaVectorOnly` path is what `recall()` does today; rename and gate. The `_recallViaGraph` path calls the new MCP tool (or RPC directly via `pool.query`) and returns the same shape so downstream consumers don't change.

## Preflight check

```js
// packages/server/src/preflight.js — add to the existing checks array
{
  name: 'graph-health',
  status: 'pass' | 'warn' | 'fail',
  detail: '<edge_count> edges, last inference <Y> ago'
}
```

Implementation: query `SELECT count(*), max(inferred_at) FROM memory_relationships`. Pass if `count > 0`; warn if `last_inference_at > 48h ago` (cron should have run); fail if pg unreachable.

## Coordination notes

- **T1** owns `expand_memory_neighborhood`. Your `memory_recall_graph` RPC depends on it. Use the same Postgres function name + signature T1 ships.
- **T2** owns the `weight` column population. Your re-rank formula handles `weight IS NULL` via `coalesce(weight, 0.5)` — works whether T2 lands first or not.
- **T4** consumes `memory_recall_graph` output indirectly via the `/api/graph/memory/:id` endpoint (which can show "memories you'd recall if you queried this neighborhood"). T4 owns the endpoint; your RPC is a building block.

## Test plan

- New `tests/memory_recall_graph.test.js` — mock `pool.query` returning canned vector + graph results, verify the re-rank order matches the formula, verify `coalesce(weight, 0.5)` behavior, verify project filter, verify depth limit.
- Manual: against the petvetbid Supabase test schema, run `SELECT * FROM memory_recall_graph(<test embedding>, 'termdeck', 2, 5);`. Verify 50 rows max, ordered by `final_score DESC`. Spot-check that depth-1 results aren't always above depth-0 results (graph expansion adds value).
- Manual: in TermDeck, set `rag.graphRecall: true` in `~/.termdeck/config.yaml`, restart server, fire a memory_recall in Claude Code, inspect server logs for `[rag] using graph recall path` line.

## Out of scope

- MCP tools `memory_link/unlink/related` — T1 owns.
- Edge inference automation — T2 owns.
- Visualization — T4 owns.
- Bidirectional edge weighting (treating in-edges and out-edges differently) — future sprint.
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-38-knowledge-graph/STATUS.md` under `## T3`. No version bumps. No CHANGELOG. No commits. Stay in your lane.

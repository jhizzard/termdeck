# Sprint 38 — T2: Edge-inference cron job

**Lane goal:** Ship a background process that periodically computes pairwise cosine similarity in `memory_items`, inserts/updates edges in `memory_relationships` above a threshold, and optionally classifies edge types via Haiku 4.5 LLM call. Per-edge `inferred_by: 'cron-2026-MM-DD'` for auditability + replay. After this lane lands, the graph populates itself nightly with no human action.

**Target deliverable:**
1. NEW migration `003_graph_inference_schedule.sql` adding a pg_cron job that fires the inference Edge Function on schedule.
2. NEW Supabase Edge Function (Deno) that runs the inference logic.
3. NEW `GET /api/graph/stats` endpoint exposing edge counts + last inference timestamps.

## CRITICAL pre-sprint finding — `memory_relationships` is NOT empty

The petvetbid `memory_relationships` table has **749 edges already populated** at sprint start (probe: 2026-04-27 17:25 ET). Distribution: supersedes 469, elaborates 167, relates_to 91, contradicts 14, caused_by 8.

**This means something is already inserting edges.** Possible sources:
1. A prior Rumen extract phase (Rumen synthesizes insights from memory_items; some pipeline may insert relationships as a side effect).
2. A prior manual seeding job.
3. A direct MCP/SQL insertion from Joshua's daily flow.

**Your first task is identifying the source.** Query options:
- `SELECT inferred_by, count(*) FROM memory_relationships GROUP BY inferred_by;` — but `inferred_by` doesn't exist yet (T1 adds it in migration 009). Run AFTER T1's migration lands.
- Check Rumen Edge Function source at `~/Documents/Graciella/rumen/` for any `INSERT INTO memory_relationships` statements.
- Check Mnestra Supabase function definitions: `\df+ public.*memory*relationship*` and similar.
- Check pg_cron for existing inference jobs: `SELECT * FROM cron.job WHERE jobname ILIKE '%relationship%' OR command ILIKE '%memory_relationships%';`

**If a prior job exists**, decide: (a) replace it with this lane's cron, (b) coexist (mark new-cron-inferred edges with a distinct `inferred_by` prefix), or (c) refactor the existing source to use this lane's logic. Document the decision in your FIX-PROPOSED entry.

## Coverage stats endpoint

```js
// packages/server/src/index.js (T4 may add /api/graph/* routes; coordinate)
app.get('/api/graph/stats', async (req, res) => {
  const result = await pool.query(`
    SELECT
      count(*) AS total_edges,
      count(*) FILTER (WHERE inferred_at IS NOT NULL) AS inferred_edges,
      count(*) FILTER (WHERE inferred_by ILIKE 'cron-%') AS cron_inferred_edges,
      max(inferred_at) AS last_inference_at,
      (SELECT count(*) FROM memory_items) AS total_memories,
      (SELECT count(*) FROM memory_items WHERE id NOT IN (
        SELECT source_id FROM memory_relationships UNION
        SELECT target_id FROM memory_relationships
      )) AS orphan_memories
    FROM memory_relationships
  `);
  res.json(result.rows[0]);
});
```

## Inference Edge Function design

NEW Edge Function at `~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts` (Rumen repo, since Rumen already has Edge Function infra). Or NEW Mnestra-side function — coordinate with Joshua's preference at sprint kickoff. Default: Rumen-side (existing pg_cron + Edge Function infrastructure).

Logic:

1. Fetch all `memory_items` rows updated since the last inference run (`SELECT id, embedding, project, content FROM memory_items WHERE updated_at > $1`). For the first run, scan all rows.
2. For each pair (A, B) where A.id != B.id and an edge does NOT already exist OR was last inferred > 7 days ago:
   - Compute cosine similarity from `embedding` vectors. Threshold: `>= 0.85` (default; configurable via `rag.graphInferenceThreshold` in `~/.termdeck/config.yaml`).
   - If above threshold: insert into `memory_relationships` with `relationship_type = 'relates_to'`, `weight = similarity`, `inferred_at = now()`, `inferred_by = 'cron-YYYY-MM-DD'`.
   - **Optional LLM classification (gated by env var `GRAPH_LLM_CLASSIFY=1`)**: send the two memory contents to Haiku 4.5 with a classification prompt. Map response to one of the 8 schema-allowed types (T1's expanded vocabulary). On classification failure, fall back to `relates_to`.

LLM classification prompt (sketch — refine in lane):

```
You are classifying the relationship between two memories from the same developer.

Memory A: {a.content}
Memory B: {b.content}

Classify their relationship as exactly ONE of:
- supersedes — A replaces B (B is older/wrong/outdated)
- relates_to — A and B are about the same topic/system
- contradicts — A and B claim conflicting facts
- elaborates — A provides more detail about something B mentions
- caused_by — A is a consequence of something described in B
- blocks — A's resolution depends on B
- inspired_by — A's idea originated from B
- cross_project_link — A and B are in different projects but reference shared infrastructure

Return ONLY the type token, no explanation.
```

Per-call cost ~$0.0001 with Haiku 4.5; for 1000 memories, ~500K pairs above threshold * $0.0001 = $50/full-classification-pass. **Run classification only on NEW edges, not on every cron tick** — once an edge is classified, don't reclassify unless `--reclassify` flag is set on a manual run.

## Migration `003_graph_inference_schedule.sql`

```sql
-- packages/server/src/setup/rumen/migrations/003_graph_inference_schedule.sql
-- Schedules graph-inference Edge Function via pg_cron + pg_net.

SELECT cron.schedule(
  'graph-inference-tick',
  '0 3 * * *',  -- 3 AM UTC daily
  $$
    SELECT net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/graph-inference',
      headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'))
    );
  $$
);
```

Coordinate the schedule cadence with Joshua at sprint kickoff. PLANNING.md says "nightly"; 3 AM UTC = 11 PM ET, after Joshua's typical work hours. If Joshua wants more frequent inference (e.g., every 6h), update the schedule before commit.

## Coordination notes

- **T1** owns the migration that adds `inferred_at` / `inferred_by` / `weight` columns. **Your cron writes to those columns** — do not start your inference runs until T1's migration 009 has landed in your dev DB. Watch T1's STATUS.md for the migration filename + path; you can mirror your own copy if T1's lands too late.
- **T3** owns `memory_recall_graph`. Your `weight` column feeds T3's re-rank formula (`vector_score × edge_weight × recency_decay`). Use a normalized [0, 1] weight so T3's math doesn't need scaling.
- **T4** owns the dashboard graph viz. Your `inferred_at` powers the "freshness" coloring T4 may surface.

## Test plan

- New `tests/graph-inference.test.js` — mock `pool.query` + mock fetch to the Edge Function, verify the cron-tick path triggers the function, verify edge-insertion shape, verify ON CONFLICT idempotence.
- Manual: deploy the Edge Function to a Supabase test schema (NOT prod), run inference against a 100-row test set, verify edge count + weight distribution.
- Cost validation: count Haiku tokens per classification call; confirm full-pass cost is under $50 on the current memory_items count.

## Out of scope

- MCP tools (`memory_link`, `memory_unlink`, `memory_related`) — T1 owns.
- Graph-aware recall — T3 owns.
- Visualization — T4 owns.
- Cross-Mnestra-instance edge inference (PLANNING.md explicit).
- Realtime collaboration on the graph (PLANNING.md explicit).
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-38-knowledge-graph/STATUS.md` under `## T2`. No version bumps. No CHANGELOG. No commits. Stay in your lane.

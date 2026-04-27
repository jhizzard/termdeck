# Sprint 38 — T1: Mnestra graph MCP tools + traversal RPC

**Lane goal:** Bring the `memory_relationships` table to first-class status. Add three MCP tools (`memory_link`, `memory_unlink`, `memory_related`), a recursive-CTE RPC for neighborhood expansion (`expand_memory_neighborhood`), and a metadata migration that adds `weight` / `inferred_at` / `inferred_by` columns. After this lane lands, Claude Code can link two memories, ask "what's related to memory X out to depth 2," and get back a re-rankable graph slice.

**Target deliverable:**
1. NEW migration `009_memory_relationship_metadata.sql` — adds three columns, expands the relationship-type CHECK constraint vocabulary.
2. NEW SQL function `expand_memory_neighborhood(id uuid, max_depth int) RETURNS TABLE` using recursive CTE.
3. Three NEW MCP tools in the Mnestra package: `memory_link`, `memory_unlink`, `memory_related`.

## CRITICAL pre-sprint finding — read before designing the migration

**The PLANNING.md statement that `memory_relationships` "has been doing nothing" is wrong.** Direct probe of `petvetbid` Supabase at sprint kickoff (2026-04-27 17:25 ET):

```
SELECT relationship_type, count(*) FROM memory_relationships GROUP BY relationship_type;

 relationship_type | count
-------------------+-------
 supersedes        |   469
 elaborates        |   167
 relates_to        |    91
 contradicts       |    14
 caused_by         |     8
(749 edges total)
```

**Existing schema** (from `\d memory_relationships`):
- Column name is `relationship_type`, not `kind`. Plan accordingly: either alias `kind` → `relationship_type` in the MCP API surface, or rename the column. **Recommend alias** — renaming a column with 749 live rows + foreign-key cascades is high-risk for a bug-fix-class change.
- Existing CHECK: `relationship_type IN ('supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by')` — **underscore convention, not hyphen.**
- No `weight`, `inferred_at`, `inferred_by` columns yet. The migration adds them.
- Composite UNIQUE constraint: `(source_id, target_id, relationship_type)`. ON CONFLICT semantics matter for `memory_link` upserts.

**PLANNING.md proposed a different vocabulary** (`relates-to / contradicts / supersedes / blocks / inspired-by / cross-project-link`). Three of those (`blocks`, `inspired_by`, `cross_project_link`) are not in the existing CHECK; the hyphen forms (`relates-to`, `inspired-by`) collide with the underscore convention.

**Recommended vocabulary** (decided by orchestrator, T1 may push back):
- KEEP existing: `supersedes`, `relates_to`, `contradicts`, `elaborates`, `caused_by` (749 edges already use these).
- ADD: `blocks`, `inspired_by`, `cross_project_link`.
- Use **underscore convention exclusively** — match what's already there.
- Final 8-value CHECK: `('supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by', 'blocks', 'inspired_by', 'cross_project_link')`.

## Where this lane writes

This lane is **mostly outside the TermDeck repo.** The Mnestra MCP server lives at `~/Documents/Graciella/engram` (folder name retained from the pre-rename — see global CLAUDE.md). Migrations live BOTH in the Mnestra repo AND in the TermDeck installer:

- Primary migration home: Mnestra repo `migrations/009_memory_relationship_metadata.sql`.
- Mirror copy in TermDeck: `packages/server/src/setup/mnestra-migrations/009_memory_relationship_metadata.sql` (the migration runner discovers via glob, so dropping the file in is enough — no wiring change).
- MCP tool sources: `~/Documents/Graciella/engram/src/tools/memory_link.ts`, `memory_unlink.ts`, `memory_related.ts`. Mnestra is a TypeScript project (the no-TS rule in TermDeck's CLAUDE.md is **TermDeck-specific**; Mnestra is on TS by design). Build via `npm run build` in the Mnestra repo.
- Mnestra MCP server export: `~/Documents/Graciella/engram/src/mcp/index.ts` — register the three new tools alongside the existing `memory_recall`, `memory_remember`, `memory_forget`, etc.
- New version: bump Mnestra to `0.3.0` (additive feature → minor bump). Republish to npm `@jhizzard/mnestra@0.3.0` at sprint close.

## Migration `009_memory_relationship_metadata.sql`

```sql
-- 009_memory_relationship_metadata.sql
-- Adds graph metadata columns + expands relationship vocabulary.
-- Idempotent: safe to re-run.

ALTER TABLE memory_relationships
  ADD COLUMN IF NOT EXISTS weight float,
  ADD COLUMN IF NOT EXISTS inferred_at timestamptz,
  ADD COLUMN IF NOT EXISTS inferred_by text;

-- Drop the old narrow CHECK and re-add the expanded one.
ALTER TABLE memory_relationships
  DROP CONSTRAINT IF EXISTS memory_relationships_relationship_type_check;

ALTER TABLE memory_relationships
  ADD CONSTRAINT memory_relationships_relationship_type_check
  CHECK (relationship_type IN (
    'supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by',
    'blocks', 'inspired_by', 'cross_project_link'
  ));

-- Indexes for graph traversal.
CREATE INDEX IF NOT EXISTS memory_relationships_weight_idx ON memory_relationships(weight) WHERE weight IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_relationships_inferred_at_idx ON memory_relationships(inferred_at) WHERE inferred_at IS NOT NULL;
```

Backfill: leave existing 749 edges with `weight = NULL`, `inferred_at = NULL`, `inferred_by = NULL`. T2's edge-inference cron will populate `weight` + `inferred_at` + `inferred_by` for new edges; existing edges can be re-classified by a one-time backfill in T2 if the cron output's confidence is high enough — coordinate with T2.

## RPC `expand_memory_neighborhood`

```sql
CREATE OR REPLACE FUNCTION expand_memory_neighborhood(
  start_id uuid,
  max_depth int DEFAULT 2
)
RETURNS TABLE (
  memory_id uuid,
  depth int,
  path uuid[],
  edge_kinds text[]
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE neighborhood AS (
    SELECT
      start_id AS memory_id,
      0 AS depth,
      ARRAY[start_id] AS path,
      ARRAY[]::text[] AS edge_kinds
    UNION ALL
    SELECT
      CASE WHEN r.source_id = n.memory_id THEN r.target_id ELSE r.source_id END,
      n.depth + 1,
      n.path || (CASE WHEN r.source_id = n.memory_id THEN r.target_id ELSE r.source_id END),
      n.edge_kinds || r.relationship_type
    FROM neighborhood n
    JOIN memory_relationships r
      ON (r.source_id = n.memory_id OR r.target_id = n.memory_id)
    WHERE n.depth < max_depth
      AND NOT (CASE WHEN r.source_id = n.memory_id THEN r.target_id ELSE r.source_id END = ANY (n.path))
  )
  SELECT memory_id, depth, path, edge_kinds FROM neighborhood;
$$;
```

Returns a row per (memory_id, depth) reachable from `start_id` within `max_depth`. The `path` array prevents cycle traversal. Edge-kind list returned for downstream filtering.

## MCP tool surfaces

```ts
// memory_link
{
  name: 'memory_link',
  description: 'Connect two memories with a typed relationship. Idempotent on (source_id, target_id, kind).',
  inputSchema: {
    type: 'object',
    properties: {
      source_id: { type: 'string', format: 'uuid' },
      target_id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['supersedes', 'relates_to', 'contradicts', 'elaborates', 'caused_by', 'blocks', 'inspired_by', 'cross_project_link'] },
      weight: { type: 'number', minimum: 0, maximum: 1, default: null }
    },
    required: ['source_id', 'target_id', 'kind']
  }
  // Maps to:
  // INSERT INTO memory_relationships (source_id, target_id, relationship_type, weight, inferred_by)
  // VALUES ($1, $2, $3, $4, 'mcp:memory_link')
  // ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE SET weight = EXCLUDED.weight
}

// memory_unlink
{
  name: 'memory_unlink',
  inputSchema: {
    properties: {
      source_id: { type: 'string', format: 'uuid' },
      target_id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: [...same...] }  // optional — if omitted, removes ALL kinds between the two
    },
    required: ['source_id', 'target_id']
  }
}

// memory_related
{
  name: 'memory_related',
  description: 'Return the N-hop neighborhood of a memory, optionally filtered by relationship kind.',
  inputSchema: {
    properties: {
      id: { type: 'string', format: 'uuid' },
      depth: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
      kind: { type: 'string', default: null }  // null = all kinds
    },
    required: ['id']
  }
  // Calls expand_memory_neighborhood, joins memory_items for content, optionally filters by edge kind.
}
```

## Coordination notes

- **T2** owns the edge-inference cron. Coordinate on `inferred_by` field semantics — T2 writes `'cron-2026-MM-DD'`, you write `'mcp:memory_link'` for tool-driven inserts. No collision.
- **T3** consumes `expand_memory_neighborhood` for graph-aware recall. Surface the RPC by sprint mid-point so T3 isn't blocked.
- **T4** consumes `expand_memory_neighborhood` for the `/api/graph/memory/:id` endpoint. Same dependency as T3.
- **Mnestra version bump** (`0.3.0`) coordinated by orchestrator at sprint close. No version bumps in lane.

## Test plan

- New `tests/memory_relationships.test.ts` (in Mnestra repo) — covers `memory_link` happy path, ON CONFLICT upsert, validation, `memory_unlink` with and without `kind`, `memory_related` depth=1 / depth=2 / kind filter.
- Migration test in TermDeck: `tests/mnestra-migration-009.test.js` — applies the migration to a fresh Postgres test DB, verifies the new columns exist, verifies the expanded CHECK constraint accepts new types.
- Manual: against the live `petvetbid` Supabase test schema (NOT prod), run the migration, link two memory_items rows, query `expand_memory_neighborhood`, verify the path array.

## Out of scope

- Edge inference automation — T2 owns that.
- Graph-aware recall (`memory_recall_graph` RPC + `rag.js` graphRecall flag) — T3 owns that.
- D3.js visualization — T4 owns that.
- Backfilling existing 749 edges with weight/confidence — T2 may handle; if not, future sprint.
- Cross-Mnestra-instance graph federation — explicitly out (PLANNING.md).
- Don't bump versions, don't touch CHANGELOG, don't commit.

## Sprint contract

Append FINDING / FIX-PROPOSED / DONE entries to `docs/sprint-38-knowledge-graph/STATUS.md` under `## T1`. No version bumps. No CHANGELOG. No commits. Stay in your lane.

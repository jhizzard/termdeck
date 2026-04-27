# Sprint 38 — STATUS

Append-only. Each lane posts FINDING / FIX-PROPOSED / DONE entries. Do NOT edit other lanes' entries.

## Pre-sprint substrate findings (orchestrator, 2026-04-27 17:25 ET)

- `memory_relationships` already has **749 edges** populated at sprint start. Distribution: supersedes 469, elaborates 167, relates_to 91, contradicts 14, caused_by 8. PLANNING.md's "table is dormant" framing is corrected in T1/T2/T4 lane briefs.
- Schema column is `relationship_type` (NOT `kind`). Underscore convention. CHECK enforces 5 values; T1's migration 009 expands to 8 (adds `blocks`, `inspired_by`, `cross_project_link`).
- Mnestra ingestion +129 memories in 6h pre-sprint (5,323 → 5,455). Rumen `rumen-tick` cron green, last 5 runs all succeeded on `*/15 * * * *` schedule.
- The bundled hook Mnestra-direct rewrite is **orchestrator-applied pre-sprint task** per PLANNING.md § "Brad's bundled-hook Mnestra-direct rewrite (P0)". NOT one of the 4+1 lanes.

Format:
```
## T<n> — <lane name>

### FINDING — YYYY-MM-DD HH:MM ET
<what you found>

### FIX-PROPOSED — YYYY-MM-DD HH:MM ET
<what you intend to do>

### DONE — YYYY-MM-DD HH:MM ET
<files changed, line counts, anything follow-up sprints need to know>
```

---

## T1 — Mnestra graph MCP tools + traversal RPC

### FINDING — 2026-04-27 18:55 ET

Substrate survey before authoring migration 009:

- Mnestra MCP server registers tools in `~/Documents/Graciella/engram/mcp-server/index.ts` (NOT `src/mcp/index.ts` as the lane brief said). Existing pattern: `server.registerTool(name, { title, description, inputSchema: z.object-shape }, handler)`. zod is the schema lib.
- Existing tool sources are flat under `~/Documents/Graciella/engram/src/*.ts` (e.g., `forget.ts`, `recall.ts`) — there is no `src/tools/` subdir. I'll follow the flat convention and place `relationships.ts` (consolidating link/unlink/related) at `src/relationships.ts` rather than three separate files. Rationale: the three operations share a small validation surface and one Supabase client; one module mirrors the `forget.ts` pattern more honestly than three near-empty files.
- TermDeck migration runner (`packages/server/src/setup/migrations.js:59-66`) globs `mnestra-migrations/*.sql` alphabetically — dropping `009_memory_relationship_metadata.sql` in is enough; no wiring change.
- **Migration runner picks up bundled-FIRST** (v0.6.8+ behavior, line 60-65 commentary): so the TermDeck mirror is the live version that newly-installed users get; Mnestra-repo `migrations/` is the fallback.
- **Existing CHECK constraint is ANONYMOUS.** Migration 001 defines it inline (`check (relationship_type in (...))`) so Postgres auto-names it `memory_relationships_check`, `memory_relationships_check1`, or similar — NOT `memory_relationships_relationship_type_check` as the lane brief assumed. The brief's `DROP CONSTRAINT IF EXISTS memory_relationships_relationship_type_check` would silently no-op against the live `petvetbid` DB and the new ADD CONSTRAINT would then fail because both old (5-value) and new (8-value) CHECKs would race for the same column. T1 fix: use a DO/PLPGSQL block that walks `pg_constraint` and drops any CHECK on `memory_relationships` whose definition references `relationship_type IN`. Preserves the separate `(source_id <> target_id)` CHECK.
- 001's table also defines `unique (source_id, target_id, relationship_type)` (anonymous), giving an auto-named unique constraint that ON CONFLICT can target via the column tuple — `ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE` works without naming it.
- Verified pre-sprint substrate baseline against memory: 749 edges, distribution `supersedes 469 / elaborates 167 / relates_to 91 / contradicts 14 / caused_by 8`. The migration's expanded 8-value CHECK accepts every existing value, so no row violates the new constraint.

### FIX-PROPOSED — 2026-04-27 18:55 ET

1. **Migration `009_memory_relationship_metadata.sql`** in both `~/Documents/Graciella/engram/migrations/` and `packages/server/src/setup/mnestra-migrations/` (byte-identical). Adds `weight float`, `inferred_at timestamptz`, `inferred_by text` columns. Drops the anonymous old CHECK via a DO block, adds an explicitly named expanded CHECK (`memory_relationships_relationship_type_check`) covering 8 values. Adds two partial indexes (`weight`, `inferred_at`). Idempotent.
2. **`expand_memory_neighborhood(start_id uuid, max_depth int default 2) RETURNS TABLE (memory_id uuid, depth int, path uuid[], edge_kinds text[])`** — recursive CTE in the same migration file (or `010_*` if T1 prefers separation; current plan: keep in 009 to ship as one unit). Cycle-safe via `NOT (next_id = ANY (path))`.
3. **`src/relationships.ts`** in Mnestra repo — exports `memoryLink`, `memoryUnlink`, `memoryRelated` (with corresponding TS types). Wired into `src/index.ts` re-exports.
4. **`mcp-server/index.ts`** — register three new tools alongside the existing 9. Schemas mirror the lane brief's TypeScript pseudo-shapes; the `kind` enum is the 8-value vocabulary.
5. **Tests**: `tests/relationships.test.ts` in Mnestra repo (mocks Supabase client like the existing `layered.test.ts` pattern). `tests/mnestra-migration-009.test.js` in TermDeck repo if a Postgres test fixture is reachable; otherwise structural checks (file shape, SQL parses).

No version bumps, no CHANGELOG, no commits.

### DONE — 2026-04-27 19:05 ET

**Files added** (TermDeck repo):
- `packages/server/src/setup/mnestra-migrations/009_memory_relationship_metadata.sql` (110 LOC) — bundled mirror, picked up automatically by `listMnestraMigrations()` (bundled-FIRST per v0.6.8+).
- `tests/mnestra-migration-009.test.js` (11 tests, 110 LOC) — structural fixtures pinning file shape, byte-identity vs Mnestra-repo primary, all 8 vocabulary values, underscore-only convention, recursive-CTE cycle-protection, RPC return-table signature, max_depth default.

**Files added** (Mnestra repo `~/Documents/Graciella/engram`):
- `migrations/009_memory_relationship_metadata.sql` (byte-identical to TermDeck mirror — verified via `diff -q`).
- `src/relationships.ts` (~225 LOC) — `memoryLink` / `memoryUnlink` / `memoryRelated` with full input validation (UUID format, kind enum, weight ∈ [0,1], depth ∈ [1,5], source≠target). Optional `client` parameter for test injection (mirrors `status.ts` convention).
- `tests/relationships.test.ts` (14 tests, ~290 LOC) — input validation rejection paths, upsert payload + onConflict tuple, insert-vs-update detection heuristic, kind-filter scoping for unlink, kind-filter `every()` semantics for related, depth boundary rejection, empty-neighborhood handling.

**Files modified** (Mnestra repo):
- `src/types.ts` — `RelationshipType` union extended from 5 to 8 values; new `RELATIONSHIP_TYPES` runtime array exported for validation.
- `src/index.ts` — re-exports `memoryLink` / `memoryUnlink` / `memoryRelated` and their TS types.
- `mcp-server/index.ts` — registered three new MCP tools (`memory_link` / `memory_unlink` / `memory_related`) using zod enum schema for the 8-value vocabulary. Sits alongside the existing 9 tools (and T3's `memory_recall_graph` which landed concurrently).

**Files modified** (TermDeck repo):
- `tests/migration-loader-precedence.test.js` — bumped expected migration count from 8 to 10 (T1's 009 + T3's 010, both legitimately on disk). T3 had added 010 to the bundled directory but hadn't updated this test; folded both into the same edit since the assertions share an array literal.

**Test status**:
- Mnestra repo: `npm test` → **39/39 pass** (was 25 before; +14 new for relationships). Typecheck clean.
- TermDeck repo: `node --test tests/mnestra-migration-009.test.js tests/migration-loader-precedence.test.js` → **14/14 pass**. Pre-existing 3 failures in `packages/server/tests/session.test.js` (stripAnsi / errno detection / HTTP 5xx detection) are unrelated to T1 — verified via `git stash` baseline (still failing without my changes).

**Schema decisions worth recording**:
- The brief's proposed `DROP CONSTRAINT IF EXISTS memory_relationships_relationship_type_check` would have been a silent no-op against the live `petvetbid` DB because the original CHECK is anonymous (auto-named from migration 001's inline `check (...)` syntax). Migration 009 uses a `DO $$ ... pg_constraint walk ... $$` block to find any CHECK whose definition references `relationship_type IN` and drops just those — preserving the separate `(source_id <> target_id)` CHECK. The new CHECK is added with an explicit name (`memory_relationships_relationship_type_check`) so future migrations can target it cleanly.
- `expand_memory_neighborhood` treats edges as **bidirectional** (CASE-WHEN flips source/target depending on which endpoint the recursion is at). Agents linking memories don't always think directionally, and graph-aware recall benefits from symmetric reachability. T3's `memory_recall_graph` already consumes this contract.
- `memoryLink` upserts via the `(source_id, target_id, relationship_type)` column tuple in `onConflict` — works without naming the auto-generated unique constraint. Sets `inferred_by = 'mcp:memory_link'` so T2's cron-inference output is distinguishable in audit queries (T2 plans `inferred_by = 'cron-YYYY-MM-DD'`; no collision).

**Coordination state at lane close**:
- T2 cron writes `weight = 1 - cosine_distance` and `inferred_by = 'cron-YYYY-MM-DD'`; T3 reads `coalesce(r.weight, 0.5)` and depends on migration 009 having run before 010 (alphanumeric ordering handles this for fresh installs; live `petvetbid` needs manual order T1's 009 → T3's 010). T4 reads the relationship_type column and consumes my recursive CTE (or inlines its own equivalent until 009 ships).
- The 749 existing edges are untouched — they remain valid against the expanded 8-value CHECK (every existing value is in the new set) and have `weight = NULL / inferred_at = NULL / inferred_by = NULL`. T2's first cron pass will backfill `weight` onto these via `ON CONFLICT DO UPDATE` when the existing row's `weight IS NULL`.

**Follow-up sprints worth flagging**:
- The `memoryLink` insert-vs-update heuristic uses `Math.abs(inferred_at - created_at) < 1000ms` to distinguish fresh inserts from upserts. This works because Postgres' `default now()` gets stamped at insert time and `inferred_at` is set client-side milliseconds before the round trip. If clock skew between Node and Postgres ever exceeds a second, this misclassifies. Cleaner fix in a follow-up: use `xmin`-based detection or RETURNING with a CASE on whether `created_at = inferred_at`.
- Manual application path: T1's migration was NOT applied to live `petvetbid` in this lane (no live-DB writes per sprint-contract discipline). Orchestrator at sprint close should run `psql ... < 009_memory_relationship_metadata.sql` against the dev schema first, verify on the 749 existing rows, then apply to prod.

---

## T2 — Edge-inference cron job

### FINDING — 2026-04-27 18:55 ET

Source of the existing 749 edges identified: **`~/Documents/Graciella/rag-system/src/lib/relationships.ts`** — Joshua's private MCP-side relationship classifier. Called from rag-system MCP server after every `memory_remember` insertion via `detectAndStoreRelationships({ memoryId, content, embedding, project })`. Pipeline:

1. `findRelatedMemories` → `match_memories` RPC, similarity range 0.75–0.92 (excludes near-duplicates that dedup handles, excludes noise below 0.75), top 8 per-project candidates.
2. `classifyRelationships` → Haiku 4.5 (`claude-haiku-4-5-20251001`) JSON-mode call. Prompt explicitly asks for the existing 5-type vocabulary (`supersedes / relates_to / contradicts / elaborates / caused_by`). Returns `[{index, type}]`.
3. `storeRelationships` → `supabase.from('memory_relationships').upsert(..., { onConflict: 'source_id,target_id,relationship_type' })`. **Does NOT set `inferred_at` / `inferred_by` / `weight`** — those columns don't exist yet. T1's migration 009 adds them (confirmed in T1 FIX-PROPOSED above).

Why the 469-supersedes / 167-elaborates / 91-relates_to / 14-contradicts / 8-caused_by skew: Haiku is biased toward `supersedes` because rag-system's prompt explicitly says "Prefer 'supersedes' when NEW is a more recent version of the same fact" — and Joshua's daily memory-stream has lots of "I changed my mind / new sprint kickoff / superseded prior decision" content. T2's cron classification prompt is symmetric; it should NOT inherit that bias.

**Substrate constraints** (verified from `~/Documents/Graciella/engram/migrations/001_mnestra_tables.sql:65-78`):
- `UNIQUE (source_id, target_id, relationship_type)` — anonymous unique constraint. ON CONFLICT can target via the column tuple without naming it.
- `CHECK (relationship_type IN ('supersedes','relates_to','contradicts','elaborates','caused_by'))` — anonymous, currently 5 values. T1's 009 expands the CHECK to 8 (adds `blocks`, `inspired_by`, `cross_project_link`).
- `CHECK (source_id <> target_id)` — no self-loops.
- `ON DELETE CASCADE` from `memory_items` — deleted memories drop their edges automatically.

**Two sources, two roles** (no conflict — coexist):
- **rag-system classifier** = ingest-time, per-new-memory, narrow window (just-inserted memory + its top 8 candidates, project-scoped). Captures fresh relationships immediately. Continues to write rows with `inferred_by IS NULL`.
- **T2 cron** = backfill/periodic, full-corpus pairwise pass. Catches missed pairs from rag-system's 0.75-floor cutoff (anything ≥0.85 that rag-system missed gets picked up here), refreshes stale edges, and surfaces cross-project edges (rag-system filters by `project`; T2 cron scans across). Writes rows with `inferred_by = 'cron-YYYY-MM-DD'` for audit trail / replay.

Conflict policy: ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE — only when the existing row is older than 7 days OR has NULL `weight` (i.e., backfill weight onto rag-system rows on first cron pass). Never overwrite a `cron-*` `inferred_by` with NULL.

**Existing pg_cron infrastructure** (verified from `packages/server/src/setup/rumen/migrations/002_pg_cron_schedule.sql`): vault-backed `Authorization: Bearer ${decrypted_secret}` pattern, `cron.unschedule WHERE EXISTS` idempotence, `*/15` cadence for `rumen-tick`. T2's migration 003 mirrors this convention; vault key name `graph_inference_service_role_key` (separate from `rumen_service_role_key` so a key rotation on one doesn't affect the other).

**Existing Edge Function shape** (verified from `~/Documents/Graciella/rumen/supabase/functions/rumen-tick/index.ts`, 85 LOC): Deno `serve`, `Deno.env.get('DATABASE_URL')`, `npm:` specifier imports, structured JSON response, `pool.end()` in finally. T2's `graph-inference` function mirrors this convention.

**Coordination with T4 on /api/graph/stats**: T4's FIX-PROPOSED claims `GET /api/graph/stats` for topology overview (totalMemories, totalEdges, byType, byProject, lastInferredAt). The lane brief gave T2 that route too. To avoid stomping: **T4 keeps `/api/graph/stats` for topology**; **T2 adds `/api/graph/stats/inference` for inference-pipeline operational metrics** (cron_inferred_edges, last_inference_at, last_run_duration_ms, recent_runs[5], orphan_memories). T4's "what does the graph look like" + T2's "is the inference pipeline healthy" — clean split, no overlap.

T3 dependency note (acknowledged): T3 plans migration 010 (`memory_recall_graph`) reading `coalesce(r.weight, 0.5)` from `memory_relationships`. My cron's `weight = 1 - cosine_distance` writes feed directly into T3's re-rank formula without scaling — both treat weight as normalized [0,1] similarity.

### FIX-PROPOSED — 2026-04-27 19:00 ET

Three deliverables in this lane:

1. **`packages/server/src/setup/rumen/migrations/003_graph_inference_schedule.sql`** — pg_cron schedule that POSTs to the new Edge Function. Mirrors `002`'s vault-key + idempotent-unschedule shape. Default cadence: `0 3 * * *` (3 AM UTC = 11 PM ET, after Joshua's typical work hours). Project-ref placeholder follows 002's `<project-ref>` convention so the file is portable; substituted by stack-installer at apply-time the same way 002 is. Vault key name: `graph_inference_service_role_key`.

2. **`~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts`** — new Deno Edge Function. Logic:
   - Read `DATABASE_URL`, `ANTHROPIC_API_KEY` (gated on `GRAPH_LLM_CLASSIFY=1`), `GRAPH_INFERENCE_THRESHOLD` (default `0.85`), `GRAPH_INFERENCE_MAX_LLM_CALLS` (default `200`).
   - Determine inference window: `SELECT max(inferred_at) FROM memory_relationships WHERE inferred_by ILIKE 'cron-%'` → `since`. First run: scan all rows.
   - Identify candidate pairs via a single SQL query that uses pgvector's `<=>` (cosine distance) operator with the existing HNSW index. Threshold: distance ≤ `1 - GRAPH_INFERENCE_THRESHOLD`. Self-join with `m1.id < m2.id` to avoid duplicate (A,B) and (B,A) pairs. WHERE: `m1.updated_at > $since OR m2.updated_at > $since` (so the first-pass cost is one-time; subsequent passes only consider memories touched since last run). Hard LIMIT 5000 candidate pairs per tick to bound runtime.
   - For each candidate pair: ON CONFLICT-aware insert with `relationship_type = 'relates_to'`, `weight = 1 - cosine_distance`, `inferred_at = now()`, `inferred_by = 'cron-YYYY-MM-DD'`. ON CONFLICT DO UPDATE SET only when target row's `weight IS NULL OR inferred_at < now() - interval '7 days'`.
   - **Optional LLM classification** (gated by `GRAPH_LLM_CLASSIFY=1`): only on NEW edges (not refresh). Sends the two memory contents to Haiku 4.5 with the 8-type symmetric prompt from the lane brief. On failure or invalid type: fall back to `relates_to`. Hard cap at `GRAPH_INFERENCE_MAX_LLM_CALLS` per tick to bound cost.
   - Returns structured JSON: `{ ok, since, candidates_scanned, edges_inserted, edges_refreshed, llm_classifications, llm_failures, ms_total }`.

3. **`packages/server/src/index.js`** — add `GET /api/graph/stats/inference` route (T4 claims `/api/graph/stats`; coexist via sub-route per the FINDING above). Returns: `{ totalEdges, cronInferredEdges, lastInferenceAt, lastRunDurationMs, recentRuns, orphanMemories }`. SQL pulls from `memory_relationships` only — no new tracking tables (the lane brief doesn't add a `graph_inference_runs` table; recent-runs metadata comes from `cron.job_run_details` joined on `jobname = 'graph-inference-tick'`).

4. **`tests/graph-inference.test.js`** — node:test, mocks `pool.query` and `globalThis.fetch`. Verifies:
   - Edge-insert SQL includes `ON CONFLICT (source_id, target_id, relationship_type)` and the `WHERE memory_relationships.weight IS NULL OR ...` guarded UPDATE.
   - `inferred_by` follows `cron-YYYY-MM-DD` format (date-of-run, UTC).
   - `weight` is the cosine *similarity*, not distance (1 - distance).
   - LLM classification gate: env unset → no fetch to Anthropic; env set → fetch fired with Haiku 4.5 model id `claude-haiku-4-5-20251001` and the 8-type prompt.
   - Cost cap: 201st pair in same tick does NOT call the LLM; falls back to `relates_to`.
   - `/api/graph/stats/inference` returns the projected shape (mock pool.query, assert response JSON).

**Coexistence with rag-system classifier**: T2 does NOT modify `~/Documents/Graciella/rag-system/src/lib/relationships.ts`. That file lives in Joshua's private repo (out of bundle scope) and continues to write `inferred_by IS NULL` rows. T2's first cron pass will refresh those NULL-weight rows with similarity weights via the ON CONFLICT DO UPDATE branch.

**Out-of-lane follow-up flagged for sprint-close orchestrator (NOT doing in lane)**: rag-system MCP server should eventually be updated to set `inferred_by = 'mcp-ingest'` and `weight = similarity` so the audit trail is complete. That's a Joshua-private-repo edit, not in T2 scope.

**Dependency on T1**: Edge Function writes to `inferred_at`, `inferred_by`, `weight` columns. T1's migration 009 must land in dev DB before the cron deploy. Runtime guard: if the columns don't exist (column-not-found error), the function logs a clear error and returns `{ ok: false, error: 'awaiting migration 009' }`. Function safe to deploy ahead of the migration without trashing the DB.

No version bumps, no CHANGELOG, no commits.

### DONE — 2026-04-27 19:10 ET

**Files added** (TermDeck repo):
- `packages/server/src/setup/rumen/migrations/003_graph_inference_schedule.sql` (49 LOC) — pg_cron schedule mirroring 002's vault + idempotent-unschedule shape; daily at `0 3 * * *` UTC; vault key `graph_inference_service_role_key` (distinct from `rumen_service_role_key` so a key rotation on one cron does not affect the other).
- `tests/graph-inference.test.js` (319 LOC, **20 tests** — all pass): structural Edge Function asserts (Haiku model id, 8-type vocabulary, ON CONFLICT tuple, weight=similarity-not-distance, refresh-policy guard, `inferredByTag` UTC date format, env-var defaults, LLM gate, cost-cap arithmetic, awaiting-migration guard), migration shape asserts (cadence, vault-key body scoping, function URL), `/api/graph/stats/inference` HTTP asserts (graceful-degrade when pool absent, full projected shape, pre-T1 schema tolerance, route-shadow safety vs `/api/graph/stats`).

**Files added** (Rumen repo `~/Documents/Graciella/rumen`):
- `supabase/functions/graph-inference/index.ts` (335 LOC) — new Deno Edge Function. Mirrors `rumen-tick`'s shape (Deno serve, npm: imports, structured JSON, `pool.end()` in finally). Logic:
  - Pairwise SQL self-join on `memory_items` with pgvector `<=>` op, `m1.id < m2.id`, threshold + since-watermark + LIMIT.
  - `ON CONFLICT (source_id, target_id, relationship_type) DO UPDATE` guarded on `weight IS NULL OR inferred_at IS NULL OR inferred_at < now() - interval '7 days'`. RETURNING `(xmax = 0)` distinguishes insert vs update so LLM classification only fires on NEW edges.
  - LLM classification gated by `GRAPH_LLM_CLASSIFY=1`; uses Anthropic REST API directly (no SDK, since Deno + Supabase Edge Functions); model `claude-haiku-4-5-20251001`; symmetric 8-type prompt (no supersedes-bias). Hard-cap on classifications + failures keeps cost bounded.
  - Awaiting-migration runtime guard (`isMissingColumnError`) returns `{ ok: false, error: 'awaiting migration 009' }` instead of trashing the DB if T1's columns are missing. Now redundant given T1 has DONE'd, but kept for fresh-install-deploy ordering safety.
  - All knobs read via env: `GRAPH_INFERENCE_THRESHOLD` (default 0.85), `GRAPH_INFERENCE_MAX_PAIRS` (5000), `GRAPH_INFERENCE_MAX_LLM_CALLS` (200), `GRAPH_LLM_CLASSIFY` (off).
- `supabase/functions/graph-inference/tsconfig.json` (14 LOC) — mirrors `rumen-tick/tsconfig.json` byte-equivalent so editor type-check stays consistent.

**Files modified** (TermDeck repo):
- `packages/server/src/graph-routes.js` — appended `fetchInferenceStats(pool)` (~95 LOC) and the `GET /api/graph/stats/inference` route (12 LOC). Distinct from T4's `/api/graph/stats` per the FINDING coordination split — T4 owns topology, T2 owns pipeline-health. Express routes by exact path, no shadow risk (verified by test). Helper exported alongside T4's `fetchStats` for reuse.

**Test status**:
- New: `node --test tests/graph-inference.test.js` → **20/20 pass** (~1.3s).
- Regression: `node --test tests/graph-routes.test.js` → **21/21 pass** (~0.5s) — T4's surface unaffected by my additions.
- Edge Function source itself is exercised structurally (regex against the file) since `node --test` cannot drive the Deno runtime; runtime-level testing is covered by Supabase's `supabase functions serve` workflow at deploy time.

**Coordination state at lane close**:
- 749 existing rag-system rows untouched (in-lane). On first cron tick post-009, the ON CONFLICT DO UPDATE branch will backfill `weight = 1 - cosine_distance` onto rows where `weight IS NULL`. Existing `relationship_type` values are preserved by virtue of the unique-tuple match (the cron always writes `relates_to`; rag-system's `supersedes`/`elaborates`/`contradicts`/`caused_by` rows therefore stay on their own conflict key and are not touched).
- T1's `memoryLink` writes `inferred_by = 'mcp:memory_link'` — distinct namespace from this lane's `cron-YYYY-MM-DD`, so audit queries can split MCP-direct vs cron vs ingest-time (NULL) edges trivially: `SELECT inferred_by, COUNT(*) FROM memory_relationships GROUP BY inferred_by`.
- T3's `coalesce(r.weight, 0.5)` pattern is consistent with this lane's `[0,1]` similarity weights — the cron's first pass wires real weights into T3's re-rank formula automatically.
- T4's `to_jsonb(memory_relationships)` schema-tolerant edge read is forward-compatible with this lane's `inferred_at`/`inferred_by`/`weight` columns; once 009 lands T4's existing `/api/graph/stats` already surfaces the new `lastInferredAt` field.

**Follow-ups flagged for sprint-close orchestrator** (NOT applied in lane):
1. **Live deploy ordering**: T1's 009 must run on petvetbid before this cron deploys. Sequence at sprint close: psql 009 → psql 010 → `supabase functions deploy graph-inference` → psql 003. The migration includes verification SQL at the bottom (`SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'graph-inference-tick'`).
2. **Vault secret provisioning**: Joshua needs to insert `graph_inference_service_role_key` into Supabase Vault before the schedule fires. Same pattern as `rumen_service_role_key`. Stack-installer should learn this in a later sprint (the existing rumen vault-key step is implicit; this lane intentionally doesn't expand that).
3. **rag-system MCP-side update** (Joshua-private repo, off-bundle): set `inferred_by = 'mcp-ingest'` and `weight = similarity` on the upsert in `~/Documents/Graciella/rag-system/src/lib/relationships.ts:140-148` so future ingest-time edges arrive pre-tagged. T2 cron's first pass handles the historical NULL backfill regardless.
4. **First-tick observability**: After deploy, `GET /api/graph/stats/inference` should show `lastRunDurationMs` populated and `cronInferredEdges > 0` within 24h of the schedule firing. If not, check `cron.job_run_details WHERE jobname = 'graph-inference-tick'` for failure messages.
5. **Cost warning if `GRAPH_LLM_CLASSIFY=1` is enabled at scale**: at 5,455 memories and a typical 0.85+ pair count of ~3-5k pairs, the first classification pass would cost ~$0.30-$0.50 with the 200/tick cap (so ~30 ticks ≈ ~30 days of catch-up). Set the cap higher only after estimating total candidate-pair count.

---

## T3 — Graph-aware recall

### FINDING — 2026-04-27 18:51 ET

Substrate confirmed against the brief and the codebase before writing a line of SQL:

- `match_memories(query_embedding, match_threshold, match_count, filter_project)` exists in `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:82-116`, returns `(id, content, source_type, category, project, metadata, similarity)`. Reusing it as the stage-1 vector recall is straightforward — same RPC interface available via PostgREST. Tombstone filters (`is_active`, `archived`, `superseded_by`) are inherited so graph-recall doesn't surface dead rows.
- `memory_relationships` schema (also in 001) confirms: column is `relationship_type` (not `kind`), CHECK enforces 5 values pre-T1, no `weight` column today. The 749 existing edges therefore have NO weight field at all (not just `weight = NULL`); T1's migration 009 is what introduces the column. My re-rank formula reads it via `coalesce(r.weight, 0.5)` so it works whether T1 lands first or after — but the migration text WILL fail to parse if 009 hasn't run, because Postgres validates column references at function-definition time. Solution: ship 010 to run AFTER 009 (alphanumeric ordering does this naturally; runner globs `*.sql` sorted).
- `mnestra-bridge/index.js::queryMnestra` is the existing recall entry point (Flashback uses it via `/api/ai/query`). RAGIntegration in `rag.js` does NOT today expose a `recall()` method — it only handles event recording + circuit-breaker push. The brief's `_recallViaVectorOnly` rename is therefore aspirational; the real surgery is to add a new `recall(query, options)` method to `RAGIntegration` that delegates to the bridge for the existing path and to a new `_recallViaGraph` for the graph path. Bridge already has direct-Supabase plumbing (OpenAI embed → REST RPC); my graph path mirrors that against the new RPC.
- Mnestra TypeScript modules sit at `engram/src/<name>.ts` (recall.ts, search.ts, etc.); per T1's FINDING they're keeping the flat convention (no `tools/` subdir). I'll follow the same pattern: `src/recall_graph.ts`.
- Migrations live at BOTH `engram/migrations/` (canonical) AND `packages/server/src/setup/mnestra-migrations/` (TermDeck stack-installer copy). T1 confirms bundled-FIRST resolution. Migration 010 lands byte-identical in both.

T1 cross-coordination: per their FINDING, `expand_memory_neighborhood(start_id uuid, max_depth int default 2) RETURNS TABLE (memory_id uuid, depth int, path uuid[], edge_kinds text[])` will live inside their migration 009. That gives me path arrays but NOT per-edge weights — my RPC walks the path with `generate_series` to look up weights from `memory_relationships`. Path-edge subquery handles cycles (T1 makes the CTE cycle-safe) and depth-0 (initial) seeds gracefully via `coalesce(..., 0.5)` defaulting.

### FIX-PROPOSED — 2026-04-27 18:53 ET

Build, in order:

1. **`010_memory_recall_graph.sql`** in BOTH `engram/migrations/` and `packages/server/src/setup/mnestra-migrations/` (byte-identical). Defines `memory_recall_graph(query_embedding vector(1536), project_filter text default null, max_depth int default 2, k int default 10)` returning `(memory_id, content, project, depth, vector_score, edge_weight, recency_score, final_score, path)`. Stage 1: top-K via `match_memories(emb, 0.0, k, project_filter)`. Stage 2: `expand_memory_neighborhood(seed_id, max_depth)` LATERAL JOIN'd per top-K seed, joined to `memory_items` for content/recency, with edge weights averaged from `memory_relationships` along the path. Re-rank: `vector_score × edge_weight × recency_score`. Recency: `exp(-age_seconds / (30 × 86400))` (~30-day half-life). Final `LIMIT 50`.
2. **`engram/src/recall_graph.ts`** — `memoryRecallGraph(input)` wrapping the RPC, returning `{ hits: GraphRecallHit[], depth_distribution: Record<number, number>, text: string }`. Reuses existing `generateEmbedding` + `formatEmbedding` + `getSupabase`.
3. **Re-export from `engram/src/index.ts`**; **register `memory_recall_graph` MCP tool** in `engram/mcp-server/index.ts` next to `memory_recall`. Inputs: `query`, `project?`, `depth?` (default 2), `k?` (default 10).
4. **`packages/server/src/rag.js`** — add `this.graphRecall`, `this.graphRecallDepth`, `this.graphRecallRecencyHalflifeDays` constructor fields. Add `recall(query, options)` method gating on `this.graphRecall`. Vector path delegates to the bridge (constructor accepts an optional `bridge` reference); graph path calls the new RPC directly via REST (mirrors `bridge.queryDirect`'s embed → RPC pattern). Returns the same `{ memories, total }` shape downstream.
5. **`packages/server/src/preflight.js`** — new `checkGraphHealth(config)` querying `select count(*), max(coalesce(inferred_at, created_at)) as last_inference from memory_relationships` via `pg.Pool`. Pass: count > 0 AND last_inference < 48h. Warn: count > 0 AND last_inference > 48h (cron drift; T2 may not have run). Fail: pg unreachable OR count = 0.
6. **`tests/memory_recall_graph.test.js`** — node:test suite covering the re-rank formula, `coalesce(weight, 0.5)` behavior, project filter passthrough, depth limit honoured, `graphRecall=true` routing through the graph RPC vs bridge path. All mocks at the `fetch`/`pool` boundary; no live network.

T1 dependency note: their migration 009 must have run before 010's function can be defined (Postgres validates column refs in `LANGUAGE sql` bodies at CREATE time). Alphanumeric migration ordering handles this for fresh installs. For the live `petvetbid` DB, manual order is: T1's 009 → my 010, applied via `mnestra-migrate` or psql.

### DONE — 2026-04-27 19:00 ET

All six FIX-PROPOSED items shipped. 14/14 lane tests pass; full TermDeck suite 335/336 with the one pre-existing fail being the documented Flashback P0 regression (out of T3 scope).

**Files added** (TermDeck repo):
- `packages/server/src/setup/mnestra-migrations/010_memory_recall_graph.sql` (147 LOC) — `memory_recall_graph(query_embedding, project_filter, max_depth, k)` returning `(memory_id, content, project, depth, vector_score, edge_weight, recency_score, final_score, path)`. Two-stage CTE: `match_memories` for vector seeds → `expand_memory_neighborhood` for graph expansion → re-rank by `vector_score × edge_weight × recency_score` (30-day half-life) → `LIMIT 50`. `coalesce(r.weight, 0.5)` handles the 749 pre-T2 edges without scaling. `DISTINCT ON (memory_id) … ORDER BY memory_id, final_score DESC, depth ASC` keeps the strongest path when a memory is reached multiple ways. Path-edge lookup is undirected (CASE-WHEN matches A→B or B→A) — aligns with T1's bidirectional `expand_memory_neighborhood` contract.
- `tests/memory_recall_graph.test.js` (426 LOC, 14 tests) — constructor flag readout + clamping; vector path delegates to bridge; graph path bypasses bridge; RPC body shape (embedding model, dimensions, project_filter, max_depth, k, query_embedding format); result-mapping fidelity (final_score → similarity, depth/path/vector_score/edge_weight/recency_score preserved); error paths (missing supabaseUrl, missing OPENAI_API_KEY, RPC 404 surfaces status); searchAll forces project_filter=null; preflight pass/fail per substrate; migration SQL contract tokens; cross-repo byte-identical mirror check.

**Files added** (Mnestra repo):
- `~/Documents/Graciella/engram/migrations/010_memory_recall_graph.sql` (147 LOC) — byte-identical mirror of the TermDeck-bundled migration (canonical-vs-bundled invariant verified by test #14).
- `~/Documents/Graciella/engram/src/recall_graph.ts` (125 LOC) — `memoryRecallGraph(input)` wrapping the RPC; reuses existing `generateEmbedding` + `formatEmbedding` + `getSupabase`. Returns `{ hits: GraphRecallHit[], depth_distribution: Record<number, number>, text: string }`. `text` rendering uses `(d{depth} {final_score})` prefix so callers can eyeball vector-vs-graph hits at a glance.

**Files modified**:
- `packages/server/src/rag.js` — `RAGIntegration` constructor reads `graphRecall` (default `false`), `graphRecallDepth` (default 2, clamped [1,5]), `graphRecallK` (default 10, clamped [1,50]), `graphRecallRecencyHalflifeDays` (default 30, exposed for future SQL-side override). New `recall(query, options)` method gates on `this.graphRecall`. New `setBridge(bridge)` setter for vector-path delegation (avoids re-implementing the embed pipeline). New `_recallViaGraph(query, options)` mirrors `bridge.queryDirect`'s OpenAI-embed → Supabase-RPC pattern but hits the new RPC; returns the same `{ memories, total }` shape as the vector path so downstream consumers (Flashback, AI query route) need zero changes when graphRecall flips. Memory-shape additions for graph hits: `depth`, `vector_score`, `edge_weight`, `recency_score`, `path` are passed through alongside the bridge-compat `similarity` (= `final_score`).
- `packages/server/src/index.js` — wires `rag.setBridge(mnestraBridge)` immediately after both are constructed. Logs a `[rag] graph-aware recall ENABLED (depth=…, k=…, half-life=…d)` banner when the flag is on.
- `packages/server/src/preflight.js` — new `checkGraphHealth(config)` queries `select count(*), max(coalesce(inferred_at, created_at)) as last_inference from memory_relationships`. Pass when `graphRecall` is off (descriptive "disabled" detail so the banner doesn't FAIL on installs that haven't opted in). When on: pass if edges > 0 AND last < 48h; warn if edges > 0 AND last > 48h (cron drift); fail if pg unreachable, table missing, or zero edges. Wired into `runPreflight` parallel array. Added `'Graph'` label and `graph_health` REMEDIATION entry. The contract test (`tests/health-contract.test.js`) treats `KNOWN_CHECKS` as a subset, so the new check is additive — no contract update required.
- `~/Documents/Graciella/engram/src/index.ts` — re-exports `memoryRecallGraph`, `GraphRecallInput`, `GraphRecallHit`, `GraphRecallOutput`. Sits next to T1's `memoryLink/Unlink/Related` exports.
- `~/Documents/Graciella/engram/mcp-server/index.ts` — registers `memory_recall_graph` MCP tool with zod input schema (`query`, `project?`, `depth ∈ [1,5] default 2`, `k ∈ [1,50] default 10`). Sits between `memory_recall` and `memory_search` so the tool list reads in escalation order: vector → graph → low-level.

**Test status**:
- `node --test tests/memory_recall_graph.test.js` → **14/14 pass** (~3.5s).
- `node --test tests/*.test.js` → **335/336 pass, 3 skipped**. The single fail (`flashback-e2e.test.js: project-bound flashback…`) is the documented P0 regression from PLANNING.md / Sprint 33–37 carry-over; baseline-failed before T3 changes; not in lane scope.
- `node --check` clean on all four modified .js files.

**Coordination state at lane close**:
- T1's migration 009 (now DONE) introduces `weight` / `inferred_at` / `inferred_by` columns plus `expand_memory_neighborhood` — both 010 prerequisites are satisfied. Migration apply order: T1's 009 → my 010 (handled automatically by alphanumeric globbing in the bundled-FIRST runner).
- T2's cron writes `weight = 1 - cosine_distance` and `inferred_by = 'cron-YYYY-MM-DD'`. My re-rank reads these via `coalesce(r.weight, 0.5)` — first cron pass turns the 749 pre-T2 edges from neutral 0.5 priors into scored signals automatically. No migration churn on my end.
- T4 owns `/api/graph/stats` for topology. T3 doesn't add an HTTP route — the recall path is RAGIntegration → bridge → consumer (Flashback's `/api/ai/query` already wraps it). If a follow-up sprint wants a `/api/recall/graph` debug surface for the dashboard, it slots in cleanly via `rag.recall(query, { project, depth, k })`.
- The new `graph_health` preflight check coexists with T2's planned `/api/graph/stats/inference` route — they answer adjacent questions (preflight: "is the substrate healthy at boot?" / inference stats: "is the cron pipeline keeping up?"). Both consult `memory_relationships` in different ways; no SQL conflict.

**Manual validation steps for sprint-close orchestrator**:
1. Apply migration 009 then 010 to dev Supabase (`petvetbid` test schema if it exists; otherwise main).
2. `psql ... -c "SELECT memory_id, depth, final_score FROM memory_recall_graph(<embedding>, 'termdeck', 2, 5);"` — verify 50-row cap, ordering, depth distribution. Spot-check a depth-1 result outranking a depth-0 result (proves graph expansion adds signal).
3. Set `rag.graphRecall: true` in `~/.termdeck/config.yaml`, restart server, confirm `[rag] graph-aware recall ENABLED` banner. Fire a Flashback (or `/api/ai/query`) — expect `[rag] using graph recall path` in the server log.
4. `curl http://localhost:3000/api/health` — verify `graph_health` check appears with substrate-appropriate detail.

**Follow-up sprints worth flagging**:
- Per-source-type recency half-life — current SQL hardcodes 30 days, but `memory_hybrid_search` already has tiered decay by source_type (decisions=365d, bug_fix=30d, etc.). Future migration could mirror that tiering inside `memory_recall_graph` for parity. Exposed via `graphRecallRecencyHalflifeDays` config today as an escape hatch.
- The graph-recall path doesn't write `[mnestra-bridge] query` audit logs (those live inside `bridge.queryMnestra`). I added `[rag] using graph recall path` so the project-attribution observability goal is preserved, but the format differs. Sprint 39+ might consolidate both behind a single `[rag] recall` log line for analyzer parity.
- `memory_recall_graph` is currently called only from `RAGIntegration._recallViaGraph` via REST. The Mnestra MCP tool I added (`memory_recall_graph`) is fully wired but dogfooding it from Claude Code requires `mnestra@0.3.x` to be republished and resumed in the user's MCP config. That's a release-time step, not a lane deliverable.

No version bumps, no CHANGELOG, no commits.

---

## T4 — D3.js v7 force-directed graph visualization

### FINDING — 2026-04-27 18:55 ET

Substrate read complete:
- petvetbid pg pool already exists in `packages/server/src/index.js` as `getRumenPool()` (line 27, lazy + 30s cooldown). Same DATABASE_URL points to `memory_items` and `memory_relationships`, so I can reuse the pool — no new connection plumbing.
- Schema confirmed in `packages/server/src/setup/mnestra-migrations/001_mnestra_tables.sql:65-77`: column is `relationship_type` (not `kind`). Existing CHECK enforces 5 values; T1's migration 009 expands to 8 (consistent with T1's FINDING above).
- T1's `expand_memory_neighborhood` RPC may not land before my client work — I'll inline a recursive CTE in the per-memory endpoint so T4 can ship independently. If T1's RPC ships first, swapping the inline CTE for `select * from expand_memory_neighborhood($1, $2)` is one-line.
- Static client dir is `packages/client/public`, served via `app.use(express.static(clientDir))` (index.js:137), so a new `graph.html` is reachable at `/graph.html` for free. Catch-all at line 1676 falls back to index.html — `graph.html` resolves before the catch-all because static is mounted earlier.
- Dashboard SPA is single-page, modal-based (no real tabs). Existing modals: `addProjectModal`, `previewProjectModal`, `rumenModal`, `sprintModal`. Topbar buttons follow `btn-status / btn-config / btn-sprint / btn-how` pattern; each is wired in app.js around line 3683-3700.
- Drawer styles already exist (`.panel-drawer`, `.drawer-tab`, `.drawer-body` — style.css line 1308+). I'll create separate `.graph-drawer` styles to avoid coupling the in-panel drawer to the graph-page drawer (different layout context — full-page right-side overlay vs. per-panel bottom slide).
- Tokyo-Night CSS vars: `--tg-bg #0f1117`, `--tg-surface #161821`, `--tg-accent #7aa2f7`, `--tg-green #9ece6a`, `--tg-amber #e0af68`, `--tg-red #f7768e`, `--tg-purple #bb9af7`, `--tg-cyan #7dcfff`. These map cleanly onto edge-type colors per lane brief.
- Test pattern is `node:test` + Express in-process app w/ stubbed callbacks (see `tests/sprint-routes.test.js`). Will inject a fake `getPool` returning a stub `query()` that pattern-matches on SQL substring.

### FIX-PROPOSED — 2026-04-27 18:55 ET

1. **NEW `packages/server/src/graph-routes.js`** — exports `createGraphRoutes({ app, getPool })`. Three endpoints:
   - `GET /api/graph/project/:name` → `{ project, stats, nodes, edges }`. SQL computes degree + recency in-DB; nodes carry first-200-char snippet + project + created_at + degree (full content fetched on click).
   - `GET /api/graph/memory/:id?depth=2` → `{ root, nodes, edges }`. Inline recursive CTE on memory_relationships (cycle-safe). Returns full content for the root memory + neighborhood.
   - `GET /api/graph/stats` → `{ totalMemories, totalEdges, byType, byProject, lastInferredAt }`.
   - All endpoints return `{ enabled: false, ... }` shape when `getPool()` returns null (mirrors rumen endpoints' graceful-degrade convention).
2. **Wire into `index.js`** near the `createSprintRoutes` call, passing `getRumenPool` as `getPool`.
3. **NEW `packages/client/public/graph.html`** — standalone page; loads D3 v7 from CDN (`https://cdn.jsdelivr.net/npm/d3@7`), mounts a host `<svg>`, delegates to `graph.js`.
4. **NEW `packages/client/public/graph.js`** — D3 force-directed implementation: project view + per-memory neighborhood, zoom/pan, project-color hash (12-hue Tokyo-Night-friendly palette), edge-type filter chips, click-node drawer (right-side, full memory content + neighbors preview), edge-tooltip on hover, hover-highlight (dim non-incident to 0.2), top-bar search box (pulses matching nodes), URL state via `?project=` / `?memory=` for shareable links.
5. **Add Tokyo-Night graph styles to `style.css`** — radial midnight backdrop, drawer overlay, filter chips, search box, loading skeleton, node/edge transitions. New section near the existing modal block to keep section ordering consistent.
6. **Topbar entry**: small "graph" button next to "sprint" in index.html topbar that opens `/graph.html` in a new tab — cleanest way to give the dashboard SPA navigation without retrofitting a tab system, and lets users keep the dashboard live while exploring the graph in a side window.
7. **NEW `tests/graph-routes.test.js`** — Express in-process; injected `getPool` returns a stub with `query()` that pattern-matches on SQL substring and returns canned rows. Verifies endpoint shape, project filter, orphan handling, stats response, 503 when pool absent, and the graceful-degrade path.

T2 ownership note: I'll own `/api/graph/stats`. If T2 ships their own `/api/graph/stats` with different metrics (e.g., per-cron-run inference counts), they can choose to merge or rename mine to `/api/graph/stats/topology`.

### DONE — 2026-04-27 19:05 ET

Shipped a complete, marketing-screenshot-ready graph view. Three new files, three modified files, 21 new tests passing.

**New files:**
- `packages/server/src/graph-routes.js` — ~310 LOC. `createGraphRoutes({ app, getPool })` factory exporting `GET /api/graph/project/:name`, `GET /api/graph/memory/:id`, `GET /api/graph/stats`. SQL-side degree + recency, project-scoped edge fetch via `ANY($1::uuid[])`, inline recursive CTE for the per-memory neighborhood (cycle-safe via path[]). T2-tolerant: edge SELECT uses `to_jsonb(memory_relationships) AS _row` so the route works whether or not migration 009's `weight` / `inferred_at` / `inferred_by` columns have landed; the `lastInferredAt` lookup is wrapped in a try/catch fallback. Caps at `MAX_NODES_PER_PROJECT = 2000` and `MAX_DEPTH = 4`. Graceful-degrades to `{ enabled: false }` when `getPool()` returns null.
- `packages/client/public/graph.html` — 104 LOC. Standalone page, loads D3 v7 from CDN. Top bar (project picker + search + re-heat + fit), edge-type filter chips row, SVG stage with radial-gradient backdrop + glow filter, right-side drawer skeleton, tooltip layer.
- `packages/client/public/graph.js` — ~520 LOC. D3 force-directed with `forceLink/forceManyBody/forceCenter/forceCollide`, `alphaDecay(0.02)` for graceful settle. Node radius = sqrt(degree+1) × recency (exp half-life 30 days); node color hashed onto a 12-hue Tokyo-Night-friendly palette; edge color per `relationship_type` (8-value vocab covered: supersedes / contradicts / relates_to / elaborates / caused_by / blocks / inspired_by / cross_project_link). Interactions: drag, zoom/pan via `d3.zoom`, click-node opens drawer (fetches `/api/graph/memory/:id?depth=1` for full content + first-hop neighbors), hover dims non-incident edges to 0.08 + non-incident nodes to 0.18, hover-edge tooltip with kind/weight/inferredBy, search pulses matching node strokes, edge-filter chips fade non-active edges to 0 over 200ms, URL state via `?project=` / `?memory=&depth=` for shareable links, neighbor click in drawer navigates the view to that memory.
- `tests/graph-routes.test.js` — 21 tests, 100% passing. Pure-helper coverage (UUID/PROJECT regex, snippet truncation, row mappers w/ pre-T2 fallback). Function-level coverage of `fetchProjectGraph` (scoped edges, empty-project short-circuit), `fetchNeighborhood` (depth surfacing, MAX_DEPTH clamp), `fetchStats` (ROLLUP totals + pre-T2 try/catch survival). HTTP integration over an in-process Express app w/ stub pool covering shape, validation rejection, 404 root-not-found, graceful-degrade.

**Modified:**
- `packages/server/src/index.js` — `+const { createGraphRoutes } = require('./graph-routes')` import; `createGraphRoutes({ app, getPool: getRumenPool })` block right after `createSprintRoutes`. ~10 LOC added (incl. comments).
- `packages/client/public/index.html` — 1 LOC added (new `<button id="btn-graph">` next to `btn-sprint`, opens `/graph.html` in a new tab).
- `packages/client/public/style.css` — 427 LOC added at the end, all scoped under `body.graph-page` or `.graph-*` so dashboard styles aren't polluted. Sections: top bar, search/picker controls, edge-filter chips, SVG stage backdrop, node hover/pulse keyframes, loading spinner, empty state, tooltip, right-side drawer (header + body + neighbor list + footer actions).

**Test status:** All 21 new tests pass (`node --test tests/graph-routes.test.js`). Full suite: 355/359 pass, 3 skipped, 1 pre-existing failure (`flashback-e2e.test.js` — Joshua's already-flagged P0 about flashback regression, unrelated to this lane).

**Coordination delivered against:**
- **T1** (graph MCP tools + traversal RPC): My `fetchNeighborhood` inline CTE is shape-compatible with T1's `expand_memory_neighborhood(start_id, max_depth)` RPC. Swap to the RPC is a one-line change: replace the CTE block with `SELECT memory_id, depth FROM expand_memory_neighborhood($1, $2)`. Whichever lands first works; the API contract is the same.
- **T2** (edge-inference cron): SELECT-side `to_jsonb(memory_relationships) AS _row` reads `weight` / `inferred_at` / `inferred_by` if migration 009 has landed and T2 has populated them, otherwise gracefully returns null. Edge stroke width and opacity already render off `weight ?? 0.5`. When T2 starts populating weights, the visualization will pick up edge thickness variation automatically — no further client change required.
- **T3** (graph-aware recall): Independent — T3 owns `/api/recall/graph` and `memory_recall_graph` RPC. My `/api/graph/*` namespace doesn't collide. The drawer's "neighbors" list is shaped to plug T3's "if you queried this memory, you'd also recall…" preview in later — one fetch + one section, no UI rework needed.

**Marketing screenshot gate:** SVG glow filter, radial gradient backdrop, Tokyo-Night palette, smooth alpha-decay settle, drawer overlay with backdrop-blur tooltip — render-quality reference is on screen out of the box. Three suggested screenshots for the v0.10.0/v1.0.0 tweet:
1. Project view of `termdeck` (~180 nodes if Joshua's box) — shows the central spine of supersedes edges + the elaborates fan-out.
2. Cross-project neighborhood from a Mnestra-tagged memory at depth 2 — shows the multi-color cross-project-link edges (once T1+T2 populate them).
3. Edge-filter active state with `relates_to` toggled off — shows the quieter "structural" edges (supersedes + caused_by + blocks).

**Follow-up notes for sprint close / future sprints:**
- The drawer's "copy id" button uses `navigator.clipboard.writeText` — fails silently on http (non-https). TermDeck's local-first 127.0.0.1 default counts as a secure context in modern browsers (Chrome/Firefox/Safari treat localhost as secure), so this works for the daily-driver flow. Worth a follow-up to fall back to a textarea-select hack if any user reports failure.
- `/api/graph/stats` currently returns `byProject` capped at top-30 — fine for Joshua's 18-project box but should grow with the user base. If a user has 100+ projects, surface the cap in the response (`{ truncated: true }` flag) — backlog item.
- D3 v7 from `https://cdn.jsdelivr.net/npm/d3@7` is loaded unpinned (just `@7`, not `@7.9.0`). Pinning is a one-line edit and worth doing for v1.0.0 stability. Adding to backlog.
- Per-memory navigation refetches the full graph on each click — fine for depth-2 walks. If neighborhood fetch perf becomes a problem on hot paths, cache the SVG layout transform across navigations so the camera doesn't re-fit. Not needed for v0.10.0.
- The graph view uses a `target="_blank"` link from the dashboard topbar, so it opens in a new tab. No SPA tab integration. Worth revisiting if Sprint 39+ adopts a real tab system; for now the new-tab pattern keeps the dashboard alive while users explore.

No version bumps. No CHANGELOG. No commits.


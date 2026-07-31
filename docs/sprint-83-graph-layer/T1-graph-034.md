# T1 — engram migration 034: edge temporality + predicate vocabulary + entities + citation RPC

**Working dir:** `~/Documents/Graciella/engram` (the Mnestra repo). You also touch ONE vendored path in the termdeck repo (below). Nothing else in termdeck. **You own ALL sprint SQL** — T2/T3 route schema needs to you via SCHEMA-REQUEST.

## The problem you are fixing

`memory_relationships` (~7,378 live edges) has no temporal validity — nothing distinguishes a still-true edge from one later events invalidated — and no predicate discipline beyond whatever the graph-inference Haiku emitted. There is no entity layer. And the recall-telemetry label channel has no SQL surface a client could cite through: `cited` is only reachable via `memory_get` (`src/layered.ts:266`) and webhook `op:'feedback'` (`src/webhook-server.ts:92`), while ordinary `memory_recall` returns content inline and never cites. Migration 031 already stamps `recall_group_id` per recall — the key exists; the RPC doesn't.

## Ground truth first (read-only, before freezing anything)

- Inventory the LIVE edge types: `SELECT relationship_type, count(*) FROM memory_relationships GROUP BY 1 ORDER BY 2 DESC;` read-only over `DATABASE_URL` from `~/.termdeck/secrets.env` (never print secret values). Known approximate shape: `relates_to` 5,841 · `supersedes` 927 · `cross_project_link` 32 · ~5 more thin types (Haiku's 8-type vocabulary — cross-check `rumen/supabase/functions/graph-inference/`).
- Read migrations 009/010 (`expand_memory_neighborhood`, `memory_recall_graph`) — your temporal work must not silently break them, and I4 will likely have you upgrading one of them.
- Read 031 (recall_group_id stamping) and `scripts/calibration/fit-platt.ts` — your citation RPC must write **exactly what that script reads** (positive labels on `memory_recall_log`).

## Deliverables

1. **`migrations/034_graph_layer.sql`:**
   - **Temporal validity:** `valid_at timestamptz NOT NULL DEFAULT now()` + `invalid_at timestamptz NULL` on `memory_relationships` (backfill `valid_at` from `created_at` if present). Partial index for live-edge traversal (`WHERE invalid_at IS NULL`). An invalidation function (edge id or endpoints+type) that SETS `invalid_at` — **invalidate-don't-delete; nothing in this sprint DELETEs an edge**. Wire `supersedes` semantics: when a memory supersedes another (the `memory_remember supersedes:` path), the superseded memory's outbound contradicted edges get invalidated, not removed — scope this conservatively and document what you chose.
   - **Typed-predicate vocabulary:** constrain `relationship_type` to a shipped vocabulary = union(live inventory, new predicates: `same_pattern_as`, `caused_by`, `fixed_by`, `documented_at`, `part_of` — snake_case to match existing types). Enforcement widening-safe (the Sprint 82 lesson: a parsed-allow-list or lookup-table pattern beats a hard-coded CHECK that a later migration forgets). **Every existing live edge must remain valid — prove it with a seeded-legacy-edges test.**
   - **Entity storage:** decide table (`memory_entities` + mention join) vs `metadata` JSONB and justify the choice in your SCHEMA-READY post. If a table: RLS ENABLED, service-role-only, five gates. Keep it minimal — T2's extractor is the only writer this sprint.
   - **Citation RPC:** e.g. `memory_record_citation(p_recall_group_id uuid, p_memory_id uuid, p_source_agent text DEFAULT NULL)` — marks the matching `memory_recall_log` row(s) as cited/positive, idempotent on repeat calls, returns what it updated. `REVOKE ... FROM PUBLIC` + service-role grant (match the grant set of the sibling functions). This is the label producer's entire SQL surface (I5).
   - **Typed expansion SQL (on T3's I4 request):** 1–2 hop typed expansion that traverses ONLY `invalid_at IS NULL` edges, filterable by predicate set, returning edge type + validity alongside each neighbor — either upgrade `memory_recall_graph`/`expand_memory_neighborhood` (watch overload-drop: defaulted params create NEW overloads; drop old sigs explicitly) or a new function. Read-only — it must never write.
   - **Hygiene, non-negotiable:** five gates on every function (`SET search_path = public, pg_catalog`, `REVOKE FROM PUBLIC` then targeted grants, SECURITY mode matching siblings, RLS enabled on any new table, no new PUBLIC-writable anything). DROP+recreate hands PUBLIC EXECUTE back — re-pin in-migration.
2. **Vendored copy:** byte-identical file at `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/mnestra-migrations/034_graph_layer.sql` (`diff` must be empty) + `MIGRATION_PROBES` entry (two-sided: function body AND index/column artifact) + `BUNDLE_MAX` → 34.
3. **Tests:** clean-DB acceptance 001→034 (the Sprint 82 lesson — every fixture legal under the constraints in force at its step); invalidate-don't-delete; seeded-legacy-edge survival; citation RPC idempotency + fit-platt visibility (a cited row counts as a positive); grant assertions per the `ci.yml` role-provision pattern. `npm test` green.

## Interfaces

- Post `### [T1] SCHEMA-READY 2026-MM-DD HH:MM ET — <gist>` the moment the surface is frozen: temporal DDL, shipped vocabulary list, entity shape, citation RPC exact signature, expansion RPC signature (or "pending T3 request"). T2/T3 code against that post.
- Watch STATUS.md (tolerant regexes `^(### )?\[T2\] .*SCHEMA-REQUEST` and `^(### )?\[T3\] .*SCHEMA-REQUEST`) for ~the first 30 min — their SQL is YOURS.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="Sprint 83 graph layer temporal edges predicate vocabulary")`, `memory_recall(query="migration hygiene five gates overload drop clean-DB acceptance")`, read `~/.claude/CLAUDE.md`, `./CLAUDE.md` (termdeck repo), this sprint's `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane. Post `### [T1] <VERB> <ET timestamp> — <gist>` for FINDING / SCHEMA-READY / FIX-PROPOSED / FIX-LANDED / DONE. No version bumps, no CHANGELOG, no commits, no live-DB writes (read-only ground-truthing allowed).

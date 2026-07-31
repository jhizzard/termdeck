# T1 — engram migration 033: two-phase `memory_hybrid_search` + semantic_similarity + decay profiles

**Working dir:** `~/Documents/Graciella/engram` (the Mnestra repo). You also touch ONE vendored path in the termdeck repo (below). Nothing else in termdeck.

## The problem you are fixing

The live `memory_hybrid_search` (defined last in `migrations/032_recall_boost.sql:158-298`; lineage 002 → 023 → 029 → 032) scores ALL candidate rows in both branches before ranking: `ts_rank_cd` across the table with no `@@` prefilter (FTS GIN index unused) and no `ORDER BY embedding <=> $q LIMIT k` inner query (HNSW index unused). At 9.3k rows it's already implicated in live statement timeouts (2026-07-28). It also computes `1 - (embedding <=> query_embedding)` in the candidates CTE (`032:196`) and then discards it, returning only the ordinal RRF composite.

## Deliverables

1. **`migrations/033_two_phase_hybrid_search.sql`** — `CREATE OR REPLACE FUNCTION public.memory_hybrid_search(...)`:
   - **Two-phase top-k:** branch 1 = FTS: `WHERE tsvector @@ plainto_tsquery($q)` ordered by `ts_rank_cd` `LIMIT k_branch`; branch 2 = vector: `ORDER BY embedding <=> $q_embedding LIMIT k_branch` (shape the inner queries so the planner can actually use the GIN and HNSW indexes — that is the entire point). Union the two candidate sets, THEN compute RRF `1/(rrf_k + rank)` per branch and apply the existing multipliers (recency half-life by source_type, type-weight, project-affinity, recall_boost clamp) on the fused set only. `k_branch` = a defaulted param (suggest `p_branch_limit int DEFAULT 60`) ≥ `match_count`.
   - **Preserve exact existing behavior semantics** for default args: same weights (1.0/1.0), same rrf_k 60, same multipliers as 032 (`:243-272`, `:279`), same RETURNS TABLE columns and order — additive changes only.
   - **Add to RETURNS TABLE:** `semantic_similarity double precision` = the row's raw cosine similarity (NULL when the row only came from the FTS branch and you'd have to recompute — in that case DO recompute it; every returned row should carry it).
   - **Add param `p_decay_profile text DEFAULT 'standard'`:** `'solved-problem'` flattens ONLY `bug_fix` and `debugging` half-lives from 30d to 365d; every other type unchanged; any unknown value = `'standard'` (never error).
   - **Hygiene gates (all five, non-negotiable):** `SECURITY` as in 032 (match it), `SET search_path = public, pg_catalog`, `REVOKE EXECUTE ... FROM PUBLIC;` then targeted `GRANT` matching 032's grant set exactly. RLS stays enabled everywhere; no new PUBLIC anything.
2. **Also update `memory_hybrid_search_explain`** if 032 defines it as a sibling — keep the pair consistent.
3. **TS layer (additive):** `src/recall.ts` / `src/search.ts` / `src/layered.ts` — pass through `semantic_similarity` into result objects (do NOT change `smartRank` ordering; do NOT change default call params). Webhook `src/webhook-server.ts` recall/search ops: include the field in responses.
4. **Vendored copy:** byte-identical migration file at `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/packages/server/src/setup/mnestra-migrations/033_two_phase_hybrid_search.sql` (Sprint 62 precedent — `diff` must be empty).
5. **Tests:** extend the engram test suite: two-phase results ≡ old results on a seeded fixture (rank order for default args), `semantic_similarity` present and in [−1, 1], `p_decay_profile='solved-problem'` reorders an old-bug_fix-vs-fresh-fact fixture, grant assertions (the CI role-provision pattern from `ci.yml` applies). `npm test` green.
6. **EXPLAIN evidence:** run `EXPLAIN (ANALYZE, BUFFERS)` against a local/CI Postgres with the indexes present; paste the plan excerpts showing GIN + HNSW usage into your FIX-LANDED post. If you can't get HNSW locally, say so explicitly — T4 and ORCH verify on the daily-driver at close (DO NOT apply 033 to the live DB yourself).

## Interfaces

- Post `### [T1] SCHEMA-READY 2026-MM-DD HH:MM ET — <exact function signature>` the moment the signature is frozen — T2/T3 are coding against it.
- Watch STATUS.md (tolerant regex `^(### )?\[T2\] .*SCHEMA-REQUEST`) for ~the first 30 min: if T2 needs a flashback-events column/TTL support, that SQL goes in YOUR 033, not theirs.

## Boot + discipline

Boot: `memory_recall(project="termdeck", query="Sprint 82 calibration two-phase hybrid search")`, `memory_recall(query="RRF score calibration ordinal ceiling")`, read `~/.claude/CLAUDE.md`, `./CLAUDE.md` (termdeck repo), this sprint's `PLANNING.md` + `STATUS.md`, then this brief. Stay in lane. Post `### [T1] <VERB> <ET timestamp> — <gist>` for FINDING / FIX-PROPOSED / SCHEMA-READY / FIX-LANDED / DONE. No version bumps, no CHANGELOG, no commits, no live-DB writes.

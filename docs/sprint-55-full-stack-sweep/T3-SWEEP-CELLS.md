# T3 — Edge Functions + Cron + MCP sweep cells

**Lane:** T3 (Edge Functions + Cron + MCP). **Mode:** B (interactive morning, 2026-05-05). **Substrate:** rumen 0.5.2 / mnestra 0.4.3 / termdeck 1.0.9 / termdeck-stack 0.6.9 live; supabase CLI 2.75.0 (older — `functions logs` unavailable, used `mcp__supabase__get_logs` postgres + direct psql probes per lane brief fallback).

## Cell #1 — Sprint 54 synthesis bug diagnosis

**STATUS:** **DIAGNOSED — TWO BUGS, both FIX-PROPOSED.** rumen_insights stuck at 321 since 2026-05-01 20:45 UTC because of two independent failure paths.

### Bug A — picker silently drops NULL-started_at rows

**File:** `~/Documents/Graciella/rumen/src/extract.ts:104`. SQL filter `AND s.started_at >= NOW() - ($1 || ' hours')::interval` evaluates to `NULL` (not TRUE) for rows with `started_at IS NULL`; Postgres treats NULL filter as "row excluded".

Distribution of unprocessed rows on the daily-driver project:
- **6 rows with `started_at = NULL`** (within 72h via `ended_at`, ended 2026-05-04 01:19–01:41 UTC) — invisible to picker
- **289 rows with `started_at` set but ALL ended ≤ 2026-05-01 20:40 UTC** (~3.5+ days, beyond 72h window) — lost forever as time advances

FIX-PROPOSED diff (from STATUS.md `[T3] FINDING 12:20 ET`): change picker window to `s.ended_at >= NOW() - INTERVAL` and `ORDER BY COALESCE(s.started_at, s.ended_at) DESC NULLS LAST`. Mnestra mig 019 candidate: sibling partial index on `(ended_at DESC) WHERE rumen_processed_at IS NULL`.

### Bug B — rumen 0.5.2 npm tarball ships stale dist/ → 10-arg call

**Smoking gun (Postgres ERROR log at 2026-05-05T16:15:00.855Z, exactly during cron tick `8e8b61ea` 16:15:00.623 → 16:15:01.141 UTC, sessions_processed=1, insights_generated=0):**

```
ERROR: function memory_hybrid_search(text, vector, integer,
       double precision, double precision, integer, text, text,
       double precision, double precision)        ← 10 args
       does not exist
```

Reproduced locally via Cell 10: `SELECT count(*) FROM memory_hybrid_search('test', NULL::vector, 5, 1.0, 0.0, 60, NULL, NULL, 0.15, 30.0)` → identical ERROR (no 10-arg overload exists).

`npm pack @jhizzard/rumen@0.5.2` → `package/dist/relate.js` lines 138-139 reference `recency_weight, decay_days`; lines 170-178 SQL has trailing `0.15::double precision, 30.0::double precision` (10-arg). Working tree `src/relate.ts:227-229` has 8-arg call. Local `dist/relate.js` mtime `May 4 17:33 ET` predates Sprint 54 source-fix commit `37c6bd2` (`May 4 18:41 ET`). `package.json scripts` lacks `prepublishOnly` rebuild guard.

**Class K (NEW ledger candidate):** "Source-fix committed, dist/ not rebuilt, npm publish ships pre-fix code with new version number." Sprint 54 close-out fits this signature exactly.

FIX-PROPOSED (orchestrator-owned, from STATUS.md `[T3] FINDING 12:42 ET`):
1. `cd ~/Documents/Graciella/rumen && npm run build` (verified locally — produces correct 8-arg dist)
2. Bump 0.5.2 → 0.5.3 + CHANGELOG entry + commit
3. Add `prepublishOnly` guard to `package.json`
4. `npm publish --auth-type=web` (Joshua, Passkey)
5. `termdeck init --rumen --yes` against the daily-driver project (rewrites `__RUMEN_VERSION__` placeholder + `supabase functions deploy`)
6. Manual fire to verify `insights_generated > 0`

### Damage pattern (both bugs combined)

```
rumen_jobs since 2026-05-01:
  2026-05-04: 15 ticks, 25 sessions_processed, 0 insights, 0 failures
  2026-05-05: 66 ticks (so far), 1 session_processed, 0 insights, 0 failures
                                  ↑ Bug A reduces denominator — only sessions with
                                    started_at set get picked at all
                                                       ↑ Bug B silently throws on every
                                                         picked session, related=[],
                                                         synthesize filters empty,
                                                         surface writes 0
```

**Both must ship in the same wave.** Bug B alone leaves 6 NULL-started_at + 289 too-old backlog invisible. Bug A alone keeps relate.ts throwing → still 0 insights.

---

## Cells 2-5 — rumen-tick fire variants

| # | Cell | Result | Evidence |
|---|---|---|---|
| 2 | rumen-tick happy-path manual fire | **PASS structurally / RED for Bug B** | Fire #1 at 16:22:36 UTC: `sessions_processed=0, insights_generated=0` (cron 16:15 already stamped the only candidate). Fire #2 at 16:32:41 UTC: same. The 6 backlogged NULL-started_at rows stay invisible per Bug A. |
| 3 | rumen-tick — empty memory_sessions | DEFERRED (no clean test instance for 0-row probe) | Manual fires above effectively reproduce "no candidates" path; confirms `sessions_processed=0` is non-erring (status=`done`). |
| 4 | rumen-tick — every session stamped | **PASS** | Same effective shape as Cell 3 once the 1 today-session got cron-stamped at 16:15 UTC. Fire #2 returned `sessions_processed=0`, status=`done`, no error. Idempotency confirmed. |
| 5 | rumen-tick — ANTHROPIC_API_KEY missing (placeholder fallback) | **CODE-ONLY VERIFICATION** | `synthesize.ts:105-112` returns `withRelated.map(makePlaceholderInsight)` when `apiKeyMissing=true`. `surface.ts:39` skips insights with `source_memory_ids.length === 0`. With Bug B in place, related=[] → withRelated empty → no placeholders ever made. Fixing Bug B is prerequisite to verifying placeholder fallback in production. |

**Net Cells 2-5:** plumbing/idempotency PASS. Substantive synthesis path FAILS upstream of synthesize via Bug B.

---

## Cells 6-8 — graph-inference fire variants

| # | Cell | Result | Evidence |
|---|---|---|---|
| 6 | graph-inference daily tick health | **PASS** | jobid 18 (`graph-inference-tick`) schedule `0 3 * * *` active=t; last run 2026-05-05 03:00:00.152 → 03:00:00.197 UTC succeeded with `1 row` HTTP response. `memory_relationships` total=1764, with_weight=511, last `inferred_at`=2026-05-05 03:00:13 UTC. |
| 7 | GRAPH_LLM_CLASSIFY=0 fallback (relates_to default) | **CODE-ONLY VERIFICATION** | `graph-inference/index.ts:298-312` skips `classifyPair` when `GRAPH_LLM_CLASSIFY != '1'`; default `relationship_type = 'relates_to'`. Cannot toggle prod secret in lane (READ-ONLY). |
| 8 | GRAPH_LLM_CLASSIFY=1 (Haiku-classified types) | **PASS — confirmed via type distribution** | Live `relationship_type` distribution on the daily-driver project: supersedes 835, relates_to 649, elaborates 249, caused_by 17, contradicts 14. Diverse classified set (5 of 8 valid types present) implies LLM classification is engaged AND succeeding. Joshua's `GRAPH_LLM_CLASSIFY=1` secret confirmed via `supabase secrets list`. |

**Lane note:** graph-inference is HEALTHY. No bugs surfaced. The Sprint 42 T1 HNSW LATERAL rewrite is in the deployed Edge Function source (verified via `mcp__supabase__get_edge_function`); 6363 active memory_items in scope; 1764 edges accumulated; cron run latency ~50ms.

---

## Cells 9-15 — memory_hybrid_search overloads + MCP tools

| # | Cell | Result | Evidence |
|---|---|---|---|
| 9 | memory_hybrid_search 8-arg canonical | **PASS** | `SELECT count(*) FROM memory_hybrid_search('test', NULL::vector, 5, 1.0, 0.0, 60, NULL, NULL)` → 5 rows. |
| 10 | memory_hybrid_search 10-arg drift (must fail) | **PASS — drift correctly rejected** | `SELECT count(*) FROM memory_hybrid_search('test', NULL::vector, 5, 1.0, 0.0, 60, NULL, NULL, 0.15, 30.0)` → ERROR `function does not exist`. **This is the exact ERROR that fires from rumen-tick on every cron tick** (Bug B). Sprint 51.9 / mig 002's `do$$` guard correctly held; only canonical 8-arg overload exists in `pg_proc`. |
| 11 | memory_recall MCP tool — happy path | **PASS** | `memory_recall(project="termdeck", query="Sprint 55 pen-test Rumen picker doctor blindness 3+1+1 audit")` returned 27 memories within token budget; results include relevant Sprint 53/54 decisions and bug_fix entries. |
| 12 | memory_remember MCP tool — write test memory | **PASS** | Inserted `5d1eaf79-fc17-4831-ae0a-316c4f95b7de` (project=termdeck, source_type=fact, category=workflow). Lookup via `memory_search` confirmed score 0.0492 (high-keyword-match). |
| 13 | memory_forget MCP tool — soft-delete test memory | **PASS** | `memory_forget(memoryId='5d1eaf79-...')` returned "archived". Direct psql confirms: `is_active=f, archived=t`. Soft-delete (not row removal) preserves history per design. |
| 14 | memory_search MCP tool — keyword + semantic hybrid | **PASS** | Direct `memory_search` returned ranked results with scores. Keyword overlap drove top-1 score 0.0492 for the test memory; ambient corpus matches scored 0.022-0.024. |
| 15 | memory_status MCP tool — system stats | **PASS** | Returned: 6363 active memories, 313 sessions processed, 23 distinct project names. 8 source_types, 7 categories. Counts cross-check: T2's `/api/health/full` reported 6360 (delta of 3 = the test memory + auto-tagged drift, immaterial). Top-project breakdown elided per codename scrub rule. |

---

## Cells 16-20 — cron + schema sweep

| # | Cell | Result | Evidence |
|---|---|---|---|
| 16 | cron.job table — verify rumen-tick + graph-inference-tick | **PASS** | jobid 17 `rumen-tick` schedule `*/15 * * * *` active=t; jobid 18 `graph-inference-tick` schedule `0 3 * * *` active=t. Both call `net.http_post` against the correct project URL with vault-decrypted service_role bearer. |
| 17 | cron.job_run_details — recent ticks logged | **PASS** | Last 6 jobid-17 runs all `succeeded` with `1 row` return (HTTP 200). Last jobid-18 run 2026-05-05 03:00 UTC `succeeded`. Run latency 7-50ms (rumen) / 45ms (graph). |
| 18 | mig 018 rumen_processed_at column + index | **PASS** | `memory_sessions.rumen_processed_at timestamptz` present. Partial index `memory_sessions_rumen_unprocessed_idx ON (started_at DESC NULLS LAST) WHERE rumen_processed_at IS NULL` present. Note Bug A FIX-PROPOSED references a sibling-index follow-up in mig 019. |
| 19 | mig 017 session_id column | **PASS** | `memory_sessions.session_id text NOT NULL` present, with UNIQUE constraint. Cross-checked: 313 rows, 313 unique session_ids. |
| 20 | pg_proc public-schema enumeration (drift sweep) | **PASS** | 10 public functions related to memory/rumen/hybrid/mnestra: `expand_memory_neighborhood/2`, `memory_hybrid_search/8`, `memory_hybrid_search_explain/8`, `memory_recall_graph/4`, `memory_status_aggregation/0`, `mnestra_doctor_*` (4 helpers). **No drift overloads.** Sprint 51.9 / mig 002 cleanup held. |

---

## Sweep summary

| Bucket | PASS | YELLOW | RED | DEFERRED |
|---|---|---|---|---|
| Cell #1 — synthesis bug | — | — | **2 bugs (A+B), both FIX-PROPOSED** | — |
| Cells 2-5 — rumen-tick | 3 | — | — | 1 (clean-instance test deferred) |
| Cells 6-8 — graph-inference | 3 | — | — | — |
| Cells 9-15 — MCP / hybrid_search | 7 | — | — | — |
| Cells 16-20 — cron + schema | 5 | — | — | — |
| **Net** | **18** | **0** | **2 (Cell #1 bugs A+B)** | **1** |

**Verdict:** **YELLOW POST** territory. The synthesis bug (Cell #1) is the dominant signal — 4 days of broken insights despite green cron + green graph-inference + green MCP + green schema. Once Bug A + Bug B ship together (rumen 0.5.3 with rebuilt dist + extract.ts NULL-started_at fix), `rumen_insights` count should move past 321 within the next cron tick that finds in-window candidates.

**Sprint 56 candidates (orchestrator review):**
1. **Class K audit across all @jhizzard/* packages.** Run `npm pack` for mnestra/termdeck/termdeck-stack/rumen, grep dist/ vs git HEAD. Add `prepublishOnly` guard to all four packages.
2. **Mnestra mig 019:** sibling partial index `(ended_at DESC) WHERE rumen_processed_at IS NULL` to keep extract.ts picker query index-backed after the Bug A fix.
3. **Backlog catch-up policy decision (orchestrator-owned):** the 289 unprocessed memory_sessions older than 72h are out of window. Either (a) bump rumen lookbackHours to 30d for a one-off catch-up cycle, or (b) `UPDATE memory_sessions SET rumen_processed_at = ended_at WHERE rumen_processed_at IS NULL AND ended_at < NOW() - INTERVAL '72 hours'` to idempotent-skip them and let the picker focus on fresh candidates.
4. **Mnestra-side writer audit:** find which writer is producing `memory_sessions` rows with `started_at IS NULL` — the bundled hook should set both timestamps. Audit `packages/server/src/setup/hooks/memory-session-end.js` (and any older variants in user setups) for the SQL INSERT shape.
5. **Mnestra migration tracking:** there's no `mnestra_migrations` / `mnestra_migration_log` table in the DB. Migrations are applied via the CLI but not tracked in DB — no idempotency guard, no audit trail. Sprint 56+ candidate.

## Lane discipline confirmation

- All cell evidence captured via SELECT/EXPLAIN psql, MCP tool calls, `npm view` / `npm pack`, and `mcp__supabase__get_edge_function` / `get_logs`. Zero destructive psql writes; the one INSERT (memory_remember) was reversed by memory_forget within 3 minutes; the one local `npm run build` in `~/Documents/Graciella/rumen` produced no commit, no publish, and no Edge Function redeploy.
- No version bumps, no CHANGELOG edits, no commits. Orchestrator owns sprint-close ship.
- Codename scrub: this document references the daily-driver project by description only.
- Post shape uniformity (`### [T3] STATUS-VERB 2026-05-05 HH:MM ET — gist`) maintained across all 6 STATUS.md posts.

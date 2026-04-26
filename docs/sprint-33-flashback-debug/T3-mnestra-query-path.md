# T3 — Mnestra query path

You are Terminal 3 in Sprint 33 / Flashback debug. Your lane: Mnestra-side. If T2 fires a query but Mnestra returns nothing useful, the silence is here. Probe the live store directly with SQL to verify what's actually retrievable.

## Read first
1. `docs/sprint-33-flashback-debug/PLANNING.md` — pipeline diagram, lane assignments
2. `docs/sprint-33-flashback-debug/STATUS.md` — protocol
3. `~/.claude/CLAUDE.md` and `./CLAUDE.md`
4. `~/Documents/Graciella/engram/migrations/002_mnestra_search_function.sql` — the search RPC's actual signature
5. `~/Documents/Graciella/engram/src/recall.ts` (or wherever `memory_recall` lives) — query construction, threshold defaults
6. `packages/server/src/preflight.js` — how TermDeck checks Mnestra reachability at startup

## You own
- READ-ONLY in `~/Documents/Graciella/engram/` — do NOT edit Mnestra source unless a bug clearly lives there AND it's < 30 LOC AND you post a FIX-PROPOSED for review
- Live SQL probes against petvetbid Supabase using `~/.termdeck/secrets.env` DATABASE_URL
- `packages/server/src/preflight.js` (TermDeck-side reachability check)

## You do NOT touch
- T1/T2/T4 files (session.js, rag.js, mnestra-bridge, anything else in TermDeck server, tests/flashback-e2e.test.js)

## Audit checklist

1. **Corpus snapshot.** Probe Josh's live store. How many `memory_items` total? By project tag?
   ```sql
   SELECT count(*) FROM memory_items;
   SELECT project, count(*) FROM memory_items GROUP BY project ORDER BY 2 DESC;
   ```
2. **Project tags healthy?** Memory says past bugs tagged everything `chopin-nashville`. Are tags correct now? (`pvb`, `termdeck`, `claimguard` should all show counts.)
3. **Run the actual hybrid_search RPC** with realistic Flashback-shaped inputs. Pick an error message Josh has likely hit (e.g. `cat /no/such/file: No such file or directory`):
   ```sql
   SELECT * FROM memory_hybrid_search(
     'cat no such file directory',         -- query_text
     '<embedding-vector-or-NULL>'::vector, -- query_embedding
     'pvb',                                 -- project filter (or NULL)
     10,                                    -- match_count
     0.3                                    -- similarity_threshold (try multiple values)
   );
   ```
   What's the actual signature? Read migration 002. What's the threshold default the bridge uses?
4. **Threshold sweep.** Run the same query with thresholds 0.7, 0.5, 0.3, 0.1, 0.0. At what level do real similar memories start coming back? If even threshold=0 returns nothing, the embeddings or the index are the issue. If threshold=0.1 returns matches but the bridge defaults to 0.7, that's the bug.
5. **Embedding integrity.** Pick 5 memory_items rows and confirm `embedding` is non-null + correct dimensionality (1536 for text-embedding-3-large). If null on a non-trivial fraction, ingest pipeline is dropping embeddings.
6. **Recency decay sanity.** If the search applies recency decay, very old memories might be deprioritized. Run a query for an error pattern Josh hit recently AND a year ago — does the recent one rank higher?
7. **`memory_status_aggregation()`** — call it. Does it return a sensible histogram? If it errors or returns 0, the schema is wrong on Josh's store.

## Decision criteria

- **CONFIRMED-OK**: corpus is large + correctly tagged; RPC returns matches at threshold the bridge uses; embeddings are populated; status aggregation works.
- **BROKEN-AT threshold**: bridge default threshold is too high for current corpus similarity distribution. Propose lower default.
- **BROKEN-AT project tag**: most rows still tagged `chopin-nashville` (regression), filter excludes everything → propose tag-backfill SQL.
- **BROKEN-AT embeddings**: null embeddings or wrong dimensionality → ingest pipeline regression.
- **BROKEN-AT RPC signature**: signature changed since rag.js was written; bridge calls wrong arity → falls back to T2's lane to fix call site.

## Output

- `FINDING` line per category with concrete numbers (counts, thresholds, sample matches).
- `FIX-PROPOSED` if a Mnestra-side fix is small and safe (rare — most fixes will be on TermDeck side).
- `DONE` when your audit is complete.
- No version bumps, no commits.

## Reference memories
- `memory_recall("PVB 1599 memories Mnestra largest project")`
- `memory_recall("chopin-nashville tag bug backfill")` — Sprint 21 T2
- `memory_recall("queryDirect 8-argument function")` — the original signature mismatch
- `memory_recall("Rumen MCP gap NULL source_session_id")` — known issue in same neighborhood

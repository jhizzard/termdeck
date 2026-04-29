# Sprint 42 — T1: Graph-inference cron resurrection (LATERAL + HNSW)

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Rewrite the pairwise self-join in `~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts` so it scales to 5,000+ memory_items. Switch from naive nested-loop to `CROSS JOIN LATERAL (... ORDER BY embedding <=> m1.embedding LIMIT 8)` so HNSW serves per-row top-K neighbors. Reduces ~3.5M cosine evaluations to ~16K (`O(N log K)` vs `O(N²)`). Re-enable the `graph-inference-tick` pg_cron schedule disabled at Sprint 38 close-out.

## Files
- `~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts` — rewrite the SQL inside `fetchCandidatePairs`
- `~/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/tests/graph-inference.test.js` — extend with EXPLAIN-plan structural assert that confirms LATERAL + index-scan-on-embedding usage
- No migration changes (cron schedule is re-enabled by orchestrator at sprint close, not by lane code)

## Acceptance criteria
1. `graph-inference-tick` cron is re-scheduled and active.
2. Manual fire via the cron's pg_net path returns HTTP 200 within 10 seconds (vs the 150s+ timeout pre-rewrite).
3. At least one cron tick post-deploy adds ≥ 100 new edges to `memory_relationships` against the live `petvetbid` corpus.
4. EXPLAIN ANALYZE on the new query shows index-scan-on-embedding usage (HNSW), not seq-scan.

## Lane discipline
- Append-only STATUS.md updates with `T1: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: do NOT touch T2 (pty-reaper), T3 (packaging), or T4 (dashboard) files

## Pre-sprint context
- Sprint 38 substrate (memory_relationships, expand_memory_neighborhood RPC, graph-inference Edge Function source) is in place.
- Cron has been DISABLED since Sprint 38 close (memory entry: 2026-04-27 ~19:50 ET).
- Rumen MCP-side classifier currently writes edges in real time, masking the broken cron from Joshua's daily flow — but Brad's clean-install path is broken without it.
- This is the headline blocker for the TMR stack being production-ready for outside users.

# RESTART PROMPT — 2026-07-31 (post-Sprint-83) — deploy tail + Phase 4 staging

**Audience: a fresh orchestrator session.** Sprint 83 is fully shipped; this doc carries the
small live-ops tail it queued plus the arc position for Phases 4–5. Read fully before acting.

## 0. Arc position

Execution arc `SideHustles/TermDeck/EXECUTION-ARC-2026-07-30.md`: **Phases 0–3 COMPLETE.**
Sprint 83 (2026-07-31): 3+1+1 on :3001, inject 14:33 ET → FINAL-VERDICT GREEN 15:14 →
GREEN-REAFFIRMED 15:47 after the live-apply incident (below). Published + pushed + tagged:
`@jhizzard/mnestra@0.11.0` (migration 034: temporal edges + FK vocabulary + entities +
`mark_recall_cited_group` + `memory_expand_typed` + batch upsert RPCs + §2c decay repair;
`memory_cite` tool; `recall_group_id`/`[n]` handles; `problem_signature`; write-time extraction
OFF by default), `@jhizzard/rumen@0.10.0` (`runGraphConsolidation` + graph-inference
amplification exclusion), `@jhizzard/termdeck@1.16.0` + stack `1.14.0` (typed expansion in
both flashback surfaces, vendored normalizer + 034, `termdeck vault export`, client `related`
render). **Migration 034 is applied LIVE** (receipt green; expansion verified non-vacuous —
10 rows on edge-bearing seeds; 0 lints attributable). Full record:
`docs/sprint-83-graph-layer/{PLANNING,STATUS}.md` (PLANNING §Resolution is the summary).

**The live-apply incident worth knowing cold:** first apply died at `:679` —
`CREATE FUNCTION ... SET hnsw.ef_search` fails for a NON-superuser when pgvector's library
isn't loaded (placeholder GUC). Four green verifications had missed it because all four ran
as container-superuser. 034 now self-loads the extension; engram CI applies as a
non-superuser role. Kitchen memory: "agreement between substrates that share a blind spot
is not independent confirmation."

## 1. Boot (fresh session)

1. `memory_recall(project="termdeck", query="Sprint 83 shipped live apply record graph layer")`
2. `memory_recall(query="recent decisions Phase 4 promotion dry-run consolidation")`
3. Read `~/.claude/CLAUDE.md` (note the NEW § "Cite the memories you actually use") and
   termdeck `./CLAUDE.md`; then this doc.
4. Substrate preflight only if dispatching panels: `GET /api/sessions` on the port Josh names.

## 2. Immediate tail (execute-on-sight, ~15 min, no panels needed)

1. **Verify the daily-driver runtime upgrade landed** (Josh was handed this block at close;
   verify, run if missed): global `@jhizzard/mnestra` at 0.11.0 (`mnestra --version`),
   `MNESTRA_EXTRACT_ENABLED=1` present in `~/.termdeck/supervisor.env`, bridge/serve bounced
   (`curl -s 127.0.0.1:8870/healthz` fresh, and a `memory_recall` through any panel now
   prints `[n]` handles + `recall_group_id`). First real `memory_cite` round-trip = the
   label channel's first live positive — check `select count(*) from memory_recall_log
   where cited` grows within a few sessions.
2. **Deploy `graph-consolidation`** (pin `npm:@jhizzard/rumen@0.10.0` is now REAL — the
   Sprint-66 no-op trap is disarmed): from the rumen repo,
   `supabase functions deploy graph-consolidation --project-ref <daily-driver-ref>`.
3. **First consolidation run in DRY-RUN** (T3's mandate — the giant-component risk is
   unmeasured): set `GRAPH_CONSOLIDATION_DRY_RUN=1` in the function's secrets, invoke once
   service-role, read the report — specifically the component size distribution and
   `too_large` count. If one blob swallows the corpus, Leiden is the designed upgrade path
   (BACKLOG). Only after a sane dry-run: clear the flag and decide the cron — **do NOT use
   03:30 UTC (doctrine-scan owns it); stagger to 04:00 UTC**, 1 h after graph-inference.
4. **MacBook Air Part-B mirror** still open (`ACTIVATION-DAY-2026-07-30.md` §4).
5. First doctrine candidate still awaits `termdeck doctrine ratify`.

## 3. Phase 4 gate (~2026-08-13) — Sprint 84 "Write-Side Completion"

Trigger: Josh reviews ~2 weeks of promotion dry-run stats (`show me the promotion dry-run
report`). If clean → auto-promote flip (runbook A3 cron via rumen migration 003) → Sheets
intake ramp (Gemini/phone quick-capture) → ChatGPT/Grok identity-map extension (~1 h) →
`memory_session_record`. Also fold in from Sprint 83's queue: the **`ingest_capture`
extraction sweep** (rumen phase — SQL-direct captures bypass write-time extraction) and
**SR-7** (entity↔entity edge table) if T2's extractor telemetry shows demand.

## 4. Sprint 68-redux (standalone-shell capture) — after Phase 4 or parallel Deck B

Re-scope first: Gemini-native-hook approach is obsolete; redesign around the Sprint-70
stdout-wrapper pattern. Staged briefs in `docs/sprint-68-standalone-shell-capture/`.

## 5. Watch items (not tasks)

- Label accumulation: `fit-platt` reruns unchanged once ≥100 real positives (EPV gate).
- BACKLOG headliners from S83: root `tests/` glob (5 stale assertions), rumen weak
  alternate-guard test, 033 FTS `embedding is not null` total-invisibility question.
- `memory_expand_typed` returns 0 on freshly written seeds until nightly graph-inference
  crawls them — expected, not a defect; typed-edge density grows as T2's extractor runs
  (extraction is per-write; the back-catalogue stays sparse until a sweep exists).

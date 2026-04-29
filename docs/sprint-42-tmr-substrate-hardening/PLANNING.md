# Sprint 42 — TMR substrate hardening + graph-inference cron resurrection

**Status:** Planned. Inject when Joshua returns to TMR work after ClaimGuard-AI digression.
**Target version:** `@jhizzard/termdeck` v0.11.0 (minor, from current published 0.10.4 — re-enables the graph-inference cron, surfaces a real reliability fix, lifts a known kernel-PTY-exhaustion ceiling). Could land as v1.0.0 if Joshua decides the graph cron + orphan reaper are the two pieces that make the stack production-ready for outside users.
**Companion bumps anticipated:** `@jhizzard/mnestra@0.3.3` (from current 0.3.2; no API change; only if 003 templating fix moves the substituted-cron migration to the Mnestra repo too — TBD per T3's choice). `@jhizzard/termdeck-stack@0.4.6` (from current 0.4.5; audit-trail per convention).
**Last-published baselines (2026-04-28 evening):** `termdeck@0.10.4`, `mnestra@0.3.2`, `termdeck-stack@0.4.5`, `rumen@0.4.3`. The 0.10.4 hotfix shipped four client-side fixes (Brad UX panel-focus + tour-Enter swallow + guide-rail x-button overlap + graph empty-state CSS specificity). The 0.3.2 Mnestra ship fixed silent permission-denied via migration 014 + `remember.ts` throw on insert errors (Brad install incident).

## Why this sprint

Sprint 41 closed the chopin-nashville junk-drawer (957 → 40), shipped the project-tag taxonomy, fixed the graph empty-state UX bug, and ran a 9-minute wall-clock execution. The substrate is now correctly tagged AND the orchestration patterns are first-class. **Two structural gaps remain** that would bite outside users badly:

1. **graph-inference cron is DISABLED** since Sprint 38 close (memory entry: 2026-04-27 ~19:50 ET). The pairwise self-join times out at the Edge Function 150s wall-clock because HNSW can't accelerate per-pair distance evaluation. T2's lane DONE entry called the LATERAL+HNSW rewrite the required Sprint 39+ follow-up; task #19 has been queued ever since. Joshua's daily flow doesn't notice (rag-system's MCP-side classifier writes edges in real time), but Brad's clean-install path is broken — he gets the substrate but no automated edge inference. **This is the headline blocker for the TMR stack being production-ready for outside users.**

2. **Kernel PTY exhaustion** — 2026-04-28 morning incident: `forkpty: Device not configured` blocked Joshua from opening any new terminal. Root cause: 585 PTY/tty references open vs `kern.tty.ptmx_max = 511`. Eight live `claude` Claude Code sessions, each with 2 MCP children (rag-system + imessage-mcp), holding ~16 PTYs from MCP alone. The TermDeck server doesn't reap orphan node-pty children when their parent Claude session terminates. For Joshua at $25/mo Pro tier this was annoying; for any heavier user it's catastrophic. **Substrate-reliability gap that would surface as "TermDeck breaks after a week of heavy use" for any production user.**

Plus three smaller follow-ups that ride along cleanly:

3. **Migration 003 templating fix** — the `<project-ref>` placeholder bug caught at Sprint 38 close. Stack-installer should substitute at apply time. Cleanly bounds Brad-class fresh-install path.
4. **Mnestra `main` field correction** — pre-existing latent since v0.2.0. `package.json "main": "./dist/index.js"` doesn't resolve (actual file is `dist/src/index.js`). Cosmetic; consumers use `bin`. Trivial fix.
5. **Project removal UI + PTY drag/drop reordering** — Joshua's two dashboard-housekeeping asks (2026-04-27). Both ~150 LOC each. Pair into one lane.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Graph-inference cron resurrection (LATERAL + HNSW)** | Rewrite the pairwise self-join in `~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts` so it scales to 5,000+ memory_items. Switch from naive nested-loop to `CROSS JOIN LATERAL (... ORDER BY embedding <=> m1.embedding LIMIT 8)` so HNSW serves per-row top-K neighbors (HNSW's strength). Reduces ~3.5M cosine evaluations to ~16K (`O(N log K)` vs `O(N²)`). Re-enable the `graph-inference-tick` pg_cron schedule that Sprint 38 close-out disabled. Verify against the live `petvetbid` corpus (currently ~5,956 memory_items, ~778 edges). Smoke-test by manually firing the function via the cron's pg_net path and confirming `(memory_relationships count)` grows in expected magnitude (200-500 new edges per tick at threshold 0.85). | `~/Documents/Graciella/rumen/supabase/functions/graph-inference/index.ts` (rewrite the SQL inside `fetchCandidatePairs`), TermDeck `tests/graph-inference.test.js` (extend with EXPLAIN-plan structural assert that confirms LATERAL + index-scan-on-embedding usage), no migration changes |
| **T2 — TermDeck PTY orphan reaper** | The TermDeck server should detect when a Claude Code session's parent process terminates and reap the orphan node-pty children. New `packages/server/src/pty-reaper.js` runs a periodic check (every 30s) walking `process` children, comparing PIDs to a registry of known parent-PID-to-PTY mappings, killing orphans. Add a `/api/pty-reaper/status` route surfacing live count + reaped-history for observability. Tests cover the orphan-detection logic with a mocked `ps` boundary. The kernel-level PTY count via `lsof | wc -l` should drop after the reaper runs, freeing slots for new Claude sessions. **Critical for any heavy-use scenario.** | NEW `packages/server/src/pty-reaper.js`, `packages/server/src/index.js` (wire the reaper at server boot), NEW `tests/pty-reaper.test.js`, NEW `/api/pty-reaper/status` route |
| **T3 — Packaging hygiene: migration 003 templating + Mnestra main field** | Two small fixes paired into one lane. (a) Migration `003_graph_inference_schedule.sql` ships with `<project-ref>` placeholder; stack-installer should substitute at apply time using the user's Supabase project ref (already resolved during the Mnestra-MCP setup wizard). NEW `packages/stack-installer/src/migration-templating.js` reads each `*.sql` looking for `<project-ref>` markers, substitutes per the user's stored project ref, applies via psql. (b) Mnestra `package.json` `"main": "./dist/index.js"` is broken since v0.2.0 — the file is at `dist/src/index.js` due to tsconfig `rootDir: "."` preserving source layout. Fix the pointer. Both cosmetic-but-correctness fixes; both bound the clean-install user experience. | `packages/stack-installer/src/migration-templating.js` (NEW), `packages/stack-installer/src/index.js` (call the templating before psql apply), `~/Documents/Graciella/engram/package.json` (correct main field), tests for both |
| **T4 — Dashboard housekeeping: project removal UI + PTY drag/drop reordering** | Two Joshua-flagged dashboard polish items paired into one lane. (a) Project removal — NEW `DELETE /api/projects/:name` endpoint + modal with explicit "files-on-disk untouched" wording + 409 if live PTY sessions present unless `?force=true`. (b) PTY panel drag/drop reordering — pure CSS Grid + drag-handle work in `packages/client/public/app.js`. Inject identifier is the session UUID, not visual position, so drag-reorder doesn't break inject. Both light lift; both pair cleanly because they share the dashboard surface and the project-state model. | `packages/server/src/index.js` (DELETE /api/projects/:name), `packages/client/public/app.js` (project removal modal + drag-handle on .term-panel), `packages/client/public/style.css` (drag-handle styling), `packages/client/public/index.html` (remove button next to add-project +), NEW `tests/projects-routes.test.js` (DELETE happy path / 404 / 409) |

## Out of scope (Sprint 43+)

- **LLM-classification pass on remaining "uncertain" rows** — Sprint 41 left 40 chopin-nashville rows that the LLM voted to keep as legitimate competition-management content. Those are the *correctly-tagged* residue. No further classification needed. Audit query: `SELECT count(*), project FROM memory_items WHERE reclassified_by = 'sprint-41-llm-residual' GROUP BY 2`.
- **Auto-detection of project boundaries from on-disk markers** (`package.json`, `.git`, etc.) — Sprint 41 PROJECT_MAP relies on regex against cwd. Auto-detection is a richer problem, Sprint 43+.
- **Per-project recency half-life in `memory_recall_graph`** — current SQL hardcodes 30 days; `memory_hybrid_search` already has tiered decay. Sprint 43+ candidate.
- **Realtime collaborative graph editing** — out per Sprint 38 PLANNING.
- **Cross-Mnestra-instance graph federation** — out per Sprint 38 PLANNING.
- **Graph-aware recall in Flashback path** — would consume Sprint 38's `memory_recall_graph` RPC. Sprint 43+.

## Acceptance criteria

1. **T1:** `graph-inference-tick` cron is re-scheduled and active. Manual fire via the cron's pg_net path returns HTTP 200 within 10 seconds (vs the 150s+ timeout pre-rewrite). At least one cron tick post-deploy adds ≥ 100 new edges to `memory_relationships` against the live `petvetbid` corpus. EXPLAIN ANALYZE on the new query shows index-scan-on-embedding usage (HNSW), not seq-scan.
2. **T2:** Live PTY count via `lsof | wc -l` drops within 60s of a Claude Code session terminating. `/api/pty-reaper/status` surfaces a non-empty `reaped_history` after running for 5 min in a heavy-use environment. New tests pass deterministically.
3. **T3:** Stack-installer correctly substitutes `<project-ref>` in migration 003 during a fresh install (verified against a tmp test schema). Mnestra `package.json "main"` field resolves cleanly via `node -e 'require("@jhizzard/mnestra")'` without throwing.
4. **T4:** Dashboard supports DELETE for a project (with the safety modal + 409 semantics). Drag-and-drop reorder of PTY panels works without breaking inject identifiers.
5. **Net:** all four lanes ship in ≤ 30 minutes wall-clock (Sprint 41's 9-minute record stands as the bar; Sprint 42's larger code surface relaxes the bar).

## Sprint contract

Append-only STATUS.md, lane discipline, no version bumps in lane.

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

Run these before T1 + T2 boot so each lane has a fresh baseline:

```bash
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql

# 1. Current memory_items + memory_relationships counts (baseline for T1's expected delta)
$PSQL "$DATABASE_URL" -c "
  SELECT 'memory_items' AS tbl, count(*) FROM memory_items
   UNION ALL
  SELECT 'memory_relationships', count(*) FROM memory_relationships;"

# 2. Confirm graph-inference-tick cron is still disabled (Sprint 38 close-out)
$PSQL "$DATABASE_URL" -c "
  SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE '%graph-inference%';"
# expected: 0 rows (cron was unscheduled)

# 3. Current PTY count (T2's baseline)
lsof 2>/dev/null | grep -E "/dev/pty|/dev/ptmx|/dev/ttys" | wc -l

# 4. Project tag distribution (sanity-check Sprint 41 held — chopin-nashville should still be ~40)
$PSQL "$DATABASE_URL" -c "
  SELECT project, count(*) FROM memory_items GROUP BY project ORDER BY 2 DESC LIMIT 15;"
```

If chopin-nashville count drifted upward since Sprint 41 close (was 40), Joshua's PROJECT_MAP overhaul has a regression — flag immediately, do NOT inject. (Expected: 40 ± 5 if a few sessions hit Performances/Sponsors/etc. since 2026-04-28 morning; > 100 = regression that needs a follow-up before Sprint 42 lanes can land cleanly.)

## Inject readiness

When Joshua signals "starting Sprint 42" after the ClaimGuard-AI work returns to TMR:

1. **Restart TermDeck server first** (latest published v0.10.4 should already be running; if Joshua's been doing dev locally, ensure the latest source is loaded).
2. **Open 4 fresh Claude Code panels in TermDeck** (any project; the lanes' boot prompts navigate themselves).
3. **Open a 5th panel as overnight orchestrator** (paste the Sprint 42 prompt block from the bottom of this doc).
4. Say "terminals open, inject Sprint 42" — the orchestrator session fires `/tmp/inject-sprint42-prompts.js` with the two-stage submit pattern.

## Paste-ready prompt block for the overnight orchestrator session

```
You are the orchestrator for TermDeck Sprint 42 (TMR substrate hardening + graph-inference cron resurrection). Joshua is back from a ClaimGuard-AI digression and ready to fire the next TMR sprint. Boot sequence:

1. Run `date` to time-stamp.
2. memory_recall(project="termdeck", query="Sprint 42 graph-inference LATERAL HNSW PTY orphan reaper migration 003 templating Mnestra main field project removal UI drag drop")
3. memory_recall(query="recent decisions and bugs across projects")
4. Read /Users/joshuaizzard/.claude/CLAUDE.md (global rules — two-stage submit, never copy-paste, session-end email mandate)
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md (project router)
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-42-tmr-substrate-hardening/PLANNING.md (this sprint's authoritative plan + lane briefs + paste-ready inject sequence)
7. Read the four lane briefs: T1-graph-inference-rewrite.md, T2-pty-orphan-reaper.md, T3-packaging-hygiene.md, T4-dashboard-housekeeping.md.
8. memory_recall(project="termdeck", query="Sprint 41 close-out chopin-nashville 40 rows project taxonomy MAESTRO chopin-scheduler alias")

Then begin: confirm 4 fresh sessions exist via GET /api/sessions sorted by meta.createdAt. Run the pre-sprint substrate probe (PLANNING.md § "Pre-sprint substrate findings"). If chopin-nashville count drifted >100 since Sprint 41 close, do NOT inject — flag the regression to Joshua first. Otherwise fire the Sprint 42 inject using the two-stage submit pattern. Stay in orchestrator mode until all four lanes report DONE in STATUS.md, then run close-out: apply migration changes (T3 may have stack-installer changes that need npm publish), bump versions (termdeck 0.10.4→0.11.0, mnestra 0.3.2→0.3.3 if T3 touches it, termdeck-stack 0.4.5→0.4.6), update CHANGELOG, draft session-end email, commit + give Joshua publish commands. Do NOT publish to npm; do NOT push if tests have new failures; do NOT enable any new pg_cron job without confirming the LATERAL+HNSW rewrite EXPLAIN plan first.
```

## Anticipated coordination notes

- **T1 ↔ T2** are independent — graph-inference is a Rumen/Edge Function concern, PTY reaper is a TermDeck server concern. No file overlap.
- **T1 ↔ T3** — T3's migration 003 templating fix needs to play nicely with T1's re-enabled cron. Sequence at sprint close: T3 re-applies migration 003 with the substituted project ref (orchestrator does this manually if T3 ships only stack-installer changes), then T1's manual cron fire validates the full path end-to-end.
- **T2 ↔ T4** — both touch the dashboard server surface. T2 adds `/api/pty-reaper/status` (read-only); T4 adds `DELETE /api/projects/:name` (destructive, with 409 semantics). No route overlap. Coordinate on `packages/server/src/index.js` route registration ordering.
- **T3 ↔ T4** — T3 touches stack-installer + Mnestra package.json; T4 touches TermDeck server + client. No file overlap.

## Dependencies on prior sprints

- Sprint 38 substrate (memory_relationships table, expand_memory_neighborhood RPC, vault key, Edge Function source) is in place. T1 only modifies the function source, not the substrate.
- Sprint 39's flashback-diag instrumentation is unrelated to T2's PTY reaper but the diag-style observability pattern (in-memory ring buffer + structured log + per-session filter) is the model T2 should mirror for `/api/pty-reaper/status`.
- Sprint 41's project taxonomy is now canonical. T4's project removal UI consumes the taxonomy doc as its reference for valid project names + their cwd patterns (so a removed project's PROJECT_MAP entry can also be cleaned up if desired — though that's a manual edit since the hook is out-of-repo).

## Joshua's roadmap context (2026-04-28 morning)

Sprint 42 is the **post-ClaimGuard return to TMR**. Joshua's queue:
1. Sprint 41 (DONE) — project taxonomy + chopin-nashville cleanup
2. **1-2 ClaimGuard-AI sprints** ← Joshua is here
3. (then) Chopin in Bohemia
4. (then) re-start Maestro (chopin-scheduler app)
5. **Sprint 42 (this) — TMR substrate hardening** could land BETWEEN any of the above as a "pause point" when Joshua wants to come back to TermDeck and not be on the hook for new feature work, OR after Maestro restart when he sees what's needed

The doc is INJECT-READY. When Joshua decides to fire it, the lane structure + paste-ready prompt + acceptance criteria are all set.

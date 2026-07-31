# T3 — Inbox hygiene + `ingest_capture` extraction sweep

**You are T3 in Sprint 84 (Write-Side Completion).** Your lane is arc step 4.3 plus the two Sprint-83 fold-ins from BACKLOG §A. You own ALL pg_cron changes this sprint.

## Scope

1. **inbox-promote cron — ground-truth the absence, then restore.** The runbook Part A `*/10` inbox-promote pg_cron is NOT in `cron.job` at dispatch (present: rumen-tick */15, graph-inference 03:00, recall-log-purge 03:17, doctrine-scan 03:30, rumen-reinforce 03:45). Find out whether it was never scheduled or was unscheduled (check the runbook, rumen migrations, cron.job history if any). Author the restore in a migration (dry-run/report mode preserved — the auto-promote flip is a Josh gate, NOT this sprint), following the existing `net.http_post` + vault-secret pattern.
2. **inbox-purge cron:** 90-day purge of NON-pending rows only (accepted/rejected/expired). Pending rows are never purged. Follow the `purge_recall_log(90)` precedent (03:17 job) — a SQL function + a cron entry, staggered into the 03:xx–04:00 window without collisions (04:00 is graph-consolidation's, staged this evening).
3. **Pending-age alarm:** pending >7 days = the drain is broken. Alarm surface: ground-truth what exists (rumen-tick report? bridge healthz? a `memory_inbox` view the orchestrator can SELECT?) — prefer the cheapest surface that a future ORCH session or monitor will actually read; a `pending_age_alarm` view + a line in the tick's report output is a fine shape. Post FIX-PROPOSED with your chosen surface before building.
4. **`ingest_capture` extraction sweep (rumen phase):** SQL-direct captures (pre-compact hook, periodic-capture timer) bypass write-time extraction — no TS in the path (BACKLOG §A, S83 T2's structural finding). Build the sweep as a NEW rumen phase over recently-captured `memory_items`, the way the tick sweeps `memory_sessions`: batch, budgeted, idempotent (an item swept once is not re-extracted), fail-open per item. Dispatch-time telemetry: `memory_entities`=0, `memory_entity_mentions`=0 despite `MNESTRA_EXTRACT_ENABLED=1` and 25 fresh writes — likely the flag only reaches the supervisor/bridge env, so stdio-MCP writes also miss extraction. Ground-truth that hypothesis and post FINDING with what you find; the sweep should catch EVERY missed path, which is why it exists.
5. **SR-7 (`memory_entity_relationships`) — CONDITIONAL, default NO.** Entity↔entity triples currently ride the extraction report only. Build it ONLY if your sweep work surfaces real entity-level triples with nowhere to live; post FINDING with the telemetry and wait for an ORCH ruling before creating any table.

## Boot sequence

1. `memory_recall(project="termdeck", query="inbox promote dry-run runbook purge pending alarm ingest_capture extraction")`
2. Read `~/.claude/CLAUDE.md` and `./CLAUDE.md`
3. Read `docs/sprint-84-write-side-completion/PLANNING.md` then `STATUS.md`
4. Read `docs/WEB-WRITE-ACTIVATION-RUNBOOK.md` Part A. Then this brief. Ground-truth `cron.job` live (read-only), the rumen tick phases, and the engram migration conventions before writing.

## Acceptance bar

- Every migration passes a **non-superuser apply** on a production-shaped pgvector container (S83 lesson: role is the discriminator, not PG version) + the five RLS/privilege gates (REVOKE-from-PUBLIC, pinned search_path, RLS-on, no WITH CHECK(true), service-role-only where applicable).
- Purge function has tests proving pending rows survive and only >90d non-pending die; sweep has tests proving idempotency, budget cap, per-item fail-open.
- Cron additions are in migrations, not hand-applied — ORCH/Josh applies live at close (classifier blocks lane-side prod writes; do not fight it).
- T1's cadence request: when T1 posts its harvester cadence, either fold it into your cron surface or reply via STATUS why a local timer is better. Don't leave the request unanswered.

## Lane discipline

You own crons and the rumen sweep. Stay out of the bridge (T2) and the harvester (T1). Post `### [T3] VERB 2026-MM-DD HH:MM ET — <gist>` for FINDING / FIX-PROPOSED / FIX-LANDED / SCHEMA-READY / BLOCKED / DONE. No version bumps, no CHANGELOG, no commits.

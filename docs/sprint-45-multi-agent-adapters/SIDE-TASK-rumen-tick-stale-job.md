# Side-task 2 — Rumen-tick stale-job investigation

**Resolved:** 2026-05-01 14:42 EDT (Sprint 45 orchestrator)
**Status:** Root cause identified. TermDeck-side dashboard fix shipped in this sprint. Upstream rumen-package fix documented for the next rumen release.

## TL;DR

**The cron isn't broken. The dashboard query is.** `last_job_completed_at: 2026-04-16T03:30:00.956Z` was a read-side artifact, not a stale job. The Rumen Edge Function has been ticking every 15 minutes without interruption — the most recent successful `done` row's `completed_at` is `2026-05-01 18:30:02.937Z` (3h before this writeup).

Two converging defects produce the visible symptom:

1. **Upstream (rumen package):** `@jhizzard/rumen`'s `createJob` INSERT omits `started_at` and the column has no default — so every row written since this regression landed has `started_at = NULL`. 1546 / 1547 rows are NULL; the 1 surviving non-NULL row is the 2026-04-16 fluke that the dashboard kept latching onto.
2. **Downstream (TermDeck server):** `GET /api/rumen/status` orders rumen_jobs by `started_at DESC`. Postgres puts NULLs last in `DESC` order, so the query returned the one row with a populated `started_at` — the 2026-04-16 fluke — as if it were the most recent.

None of the three brief-time hypotheses survive contact with the data:

| Hypothesis | Verdict |
|---|---|
| (a) graph-inference cron writes edges but doesn't touch rumen_jobs | Irrelevant — graph-inference writes `memory_relationships` only and was never expected to touch rumen_jobs |
| (b) rag-system MCP-side classifier writes insights at ingest | False — `SELECT count(*) FROM rumen_insights WHERE job_id IS NULL` returns 0; every insight has a linked job |
| (c) rumen-tick partial-succeeding silently | False — the cron is finalizing rows correctly. The surviving 1546 rows all have `status = done` and populated `completed_at` |

## Diagnostic queries

```sql
-- 1546 / 1547 rows have NULL started_at
SELECT (started_at IS NULL) AS started_at_is_null, count(*)
  FROM rumen_jobs GROUP BY 1;
-- f | 1
-- t | 1546

-- TermDeck's pre-fix query returns the 2026-04-16 fluke
SELECT id, status, started_at, completed_at FROM rumen_jobs
  ORDER BY started_at DESC LIMIT 1;
-- b66f0e6f-… | done | NULL | 2026-04-16 03:30:00.956+00

-- Same query with COALESCE returns the actual latest
SELECT id, status, started_at, completed_at FROM rumen_jobs
  ORDER BY COALESCE(started_at, completed_at) DESC NULLS LAST LIMIT 1;
-- 8fb54666-… | done | NULL | 2026-05-01 18:30:02.937+00

-- 0 insights without a linked rumen_jobs row
SELECT count(*) FROM rumen_insights WHERE job_id IS NULL;
-- 0
```

## Root cause (upstream)

`~/Documents/Graciella/rumen/src/index.ts:171-188` — the `createJob` helper:

```ts
async function createJob(
  pool: PgPool,
  triggeredBy: 'schedule' | 'session_end' | 'manual',
): Promise<CreatedJobRow> {
  const res = await pool.query<CreatedJobRow>(
    `
      INSERT INTO rumen_jobs (triggered_by, status)
      VALUES ($1, 'running')
      RETURNING id, started_at
    `,
    [triggeredBy],
  );
```

The INSERT names `(triggered_by, status)` only. The `started_at` column has no default in the schema (verified via `\d rumen_jobs`):

```
 started_at | timestamp with time zone | | |
```

So every insert lands NULL. The `RETURNING started_at` is therefore always NULL too — TypeScript's `CreatedJobRow.started_at: string` is technically incorrect at runtime.

`completeJob` (same file, lines 212-253) updates `completed_at = NOW()` but never patches `started_at`, so the NULL persists for the lifetime of the row.

## Fix shipped — TermDeck side (this sprint)

`packages/server/src/index.js:1685-1690` (was `ORDER BY started_at DESC`):

```js
// Sprint 45 side-task 2 — order by COALESCE(started_at, completed_at) so
// jobs whose upstream writer (the @jhizzard/rumen createJob INSERT in the
// Edge Function) leaves started_at NULL still surface as "latest" via
// their populated completed_at. Pre-fix the query returned a 2026-04-16
// job permanently because that was the last row to have started_at
// populated — every subsequent insert lands started_at = NULL.
const jobSql =
  `SELECT id, status, completed_at, sessions_processed, insights_generated
     FROM rumen_jobs
     ORDER BY COALESCE(started_at, completed_at) DESC NULLS LAST
     LIMIT 1`;
```

This is the surgical fix at the read site. It restores the dashboard immediately without depending on a rumen-package release. Once the upstream fix lands and `started_at` is populated for new rows, `COALESCE` is a harmless no-op (`started_at` wins).

## Fix recommended — rumen package (queued)

Two-line patch in `~/Documents/Graciella/rumen/src/index.ts` (file is in a sibling repo; not shipped in this sprint):

```diff
       INSERT INTO rumen_jobs (triggered_by, status)
-      VALUES ($1, 'running')
+      VALUES ($1, 'running', NOW())
       RETURNING id, started_at
```

Add `started_at` as the third column in both the column list and the VALUES tuple, set to `NOW()`. Test seam: any test that asserts on `createJob`'s returned `started_at` will become deterministic instead of NULL.

Optional companion fix: a backfill migration to populate `started_at` from `completed_at` for the 1546 historical rows, so historical dashboards align too:

```sql
UPDATE rumen_jobs
   SET started_at = completed_at
 WHERE started_at IS NULL
   AND completed_at IS NOT NULL;
```

This is purely cosmetic for any dashboards that don't use the COALESCE workaround — operationally optional.

## Deferred to rumen project owner

- **Rumen package release.** A patch release (e.g. `@jhizzard/rumen@0.4.5`) shipping the `INSERT … VALUES (..., NOW())` fix and the optional backfill migration. TermDeck's `init --rumen` wizard will pick up the new version on the next install.
- **Type-tightening.** `CreatedJobRow.started_at: string` is mis-typed as non-null. Once the INSERT fix is in, the type matches reality. Without the INSERT fix, the type should be `string | null`.

## Cross-references

- TermDeck read-site: `packages/server/src/index.js:1685-1690` (fixed in this sprint)
- TermDeck endpoint: `GET /api/rumen/status` (`packages/server/src/index.js:1681-1722`)
- Edge Function caller: `packages/server/src/setup/rumen/functions/rumen-tick/index.ts` (no change needed; it just calls `runRumenJob`)
- Upstream writer: `~/Documents/Graciella/rumen/src/index.ts:171-188` (createJob — needs the 2-line fix above)
- Upstream finisher: `~/Documents/Graciella/rumen/src/index.ts:212-253` (completeJob — already correct, no change needed)
- Sprint 45 PLANNING.md § "Side-tasks for the orchestrator" item 2 (the brief that triggered this investigation)

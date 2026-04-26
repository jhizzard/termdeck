# T3 — `/api/health/full` runtime health endpoint

You are Terminal 3 in Sprint 32 / v0.7.0 of TermDeck. Your lane: build the runtime equivalent of v0.6.9's `auditPreconditions()` + `verifyOutcomes()`. Once installed, the system stays observably healthy. This endpoint answers "is this install actually healthy right now?" at any moment. Mirrors the install-time audit but with current state instead of pre-flight.

## Read first
1. `docs/sprint-32-v070/PLANNING.md` — sprint overview, especially "/api/health/full (T3)" under "Architectural decisions"
2. `docs/sprint-32-v070/STATUS.md` — protocol
3. `packages/server/src/setup/preconditions.js` — the v0.6.9 audit/verify module. Reuse where possible (DRY). Many of the SELECT queries are identical at runtime.
4. `packages/server/src/preflight.js` — the existing startup health checks. Same idea, narrower scope (network-reachability only). v0.7.0's `/api/health/full` is the bigger sibling.

## You own these files
- `packages/server/src/health.js` — NEW file, the health-aggregation module
- `packages/server/src/index.js` — exactly ONE block: the route registration `app.get('/api/health/full', ...)`. NO other edits to this file.
- `tests/health-full.test.js` — NEW file

## You DO NOT touch
- All of T1's files (database.js, session.js, theme-resolver.js, app.js theme region)
- T2's files (auth.js)
- `packages/server/src/setup/preconditions.js` — IMPORTANT: if you need to share code with the audit module, REQUEST a refactor in STATUS.md instead of modifying it directly. Concurrent edits to a shared helper module would step on T1/T4. Better to copy small bits than to coordinate.

## What "done" looks like

1. `packages/server/src/health.js` exports `getFullHealth(config, options)` — async, returns the report shape:
   ```js
   {
     ok: boolean,                    // true iff every required check is 'pass'
     timestamp: '2026-04-26T20:30:00Z',
     ttlSeconds: 30,
     checks: [
       { name: 'sqlite',           status: 'pass' },
       { name: 'mnestra-pg',       status: 'pass' },
       { name: 'memory-items-col', status: 'fail', detail: 'source_session_id missing — re-run termdeck init --mnestra --yes' },
       { name: 'pg-cron-ext',      status: 'fail', detail: 'extension not enabled — Supabase dashboard → Database → Extensions → pg_cron' },
       { name: 'pg-net-ext',       status: 'pass' },
       { name: 'vault-secret',     status: 'pass' },
       { name: 'cron-job-active',  status: 'pass' },
       { name: 'mnestra-webhook',  status: 'warn', detail: 'webhook URL configured but unreachable' },
       { name: 'rumen-pool',       status: 'warn', detail: 'best-effort, not blocking' }
     ]
   }
   ```
2. **Required checks** (status pass/fail):
   - `sqlite` — better-sqlite3 db responds to `SELECT 1`
   - `mnestra-pg` — RAG-enabled installs only: `pgRunner.connect(DATABASE_URL)` + `SELECT 1`
   - `memory-items-col` — `SELECT 1 FROM information_schema.columns WHERE table_name='memory_items' AND column_name='source_session_id'`
   - `pg-cron-ext`, `pg-net-ext`, `vault-secret`, `cron-job-active` — same SQL as `preconditions.auditRumenPreconditions` and `verifyRumenOutcomes`
3. **Warn checks** (status pass/warn — never fail):
   - `mnestra-webhook` — HTTP GET against `MNESTRA_WEBHOOK_URL/healthz` if configured, 2s timeout
   - `rumen-pool` — best-effort connection pool query
4. **Caching**: results cached in module scope for 30 seconds. Subsequent calls within the window return the cached report. `getFullHealth(config, { refresh: true })` bypasses the cache. The 30s TTL is reflected in the response's `ttlSeconds` field.
5. **Error handling**: any unexpected error in a check downgrades that check to `fail` (or `warn` for warn-checks) with the error message in `detail`. Never throws — `getFullHealth()` always returns a structured report.
6. In `index.js` add ONE block (find the natural spot near the existing `/api/health` and `/api/themes` routes):
   ```js
   // v0.7.0 — runtime health snapshot, mirrors install-time audit
   app.get('/api/health/full', async (req, res) => {
     const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
     try {
       const report = await getFullHealth(config, { refresh });
       res.status(report.ok ? 200 : 503).json(report);
     } catch (err) {
       res.status(500).json({ ok: false, error: err.message });
     }
   });
   ```
   Plus the require at the top: `const { getFullHealth } = require('./health');`

## Tests (`tests/health-full.test.js`)

Use a fake config + fake `pg` client + fake better-sqlite3 db. Cover:

1. **All checks pass → ok=true, status 200**.
2. **memory-items-col missing → ok=false, that check is `fail` with the npm-cache-clean recovery in detail**.
3. **pg-cron disabled → ok=false, that check is `fail` with the dashboard hint in detail**.
4. **Mnestra webhook unreachable → check is `warn`, ok still true (warn doesn't break health)**.
5. **Caching works**: call twice in <30s with `refresh=false`, second call doesn't re-query the fake db (assert call count). Call third with `refresh=true`, assert it re-queries.
6. **Error swallow**: inject a `throw` in one check, assert that check appears as `fail` with the error message and the report still returns.
7. **Index.js route smoke**: spawn the server (use the existing pattern from cli-default-routing.test.js), make a real HTTP request to `/api/health/full`, assert JSON response shape.

## Protocol

- Post `[T3] CLAIM packages/server/src/index.js` BEFORE you edit it. Briefly. Get in, add the route block, get out. T3 is the only task touching index.js — do not let your edits sprawl.
- Post `[T3] CLAIM packages/server/src/health.js` and `tests/health-full.test.js` for the new files.
- When done, post `[T3] DONE — /api/health/full endpoint, tests <pass>/<total>`
- Do NOT bump versions, do NOT update CHANGELOG.md, do NOT commit. T4 handles those.

## Reference memories
- `memory_recall("auditPreconditions verifyOutcomes v0.6.9")` — the install-time pattern this mirrors
- `memory_recall("preflight health badge")` — the existing startup checks
- `memory_recall("Mnestra webhook /healthz")` — the webhook contract

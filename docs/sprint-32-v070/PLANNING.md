# Sprint 32 — v0.7.0 — "Trust the install at runtime"

**Started:** 2026-04-26
**Pattern:** 4+1 orchestration. Four parallel terminals (T1–T4) work on non-overlapping files. The fifth terminal (the orchestrator, this conversation) coordinates via `STATUS.md`.

## Why v0.7.0 and not another v0.6.x

The v0.6.x lineage shipped nine patch releases over 48 hours. The arc closed with v0.6.9's `auditPreconditions()` + `verifyOutcomes()` — the architectural defense that should have been there from the start. v0.6.x = **install-time correctness**.

v0.7.0 extends that pattern from install-time into **runtime correctness**: once installed, the system stays observably healthy, and configuration changes propagate the way users expect. Tester feedback (Brad, 2026-04-26) surfaced two runtime issues that v0.6.x didn't address:

1. **Theme drift.** Editing `~/.termdeck/config.yaml` doesn't change existing terminals' themes. They render whatever was written into SQLite at session creation. Brad: *"can't get theme changed. ignores changes to config.yaml and is stuck in tokyo night."*
2. **Auth-cookie scoping.** Each new browser / incognito tab requires re-entering the auth token. Brad: *"is there a way not to have to enter the token at each termdeck session?"* On a local app the security risk of a long cookie is low; UX wins.

Plus a runtime defense `runtime/api/health/full` endpoint that mirrors the install-time audit — answers "is this install actually healthy right now?" at any moment.

## Scope (locked, do not expand)

| Tn | Lane | OWNS (files) | DOES NOT TOUCH |
|----|------|--------------|----------------|
| T1 | Theme persistence | `packages/server/src/database.js`, `packages/server/src/session.js`, NEW `packages/server/src/theme-resolver.js`, `packages/client/public/app.js` (theme region only — `changeTheme()`, `getThemeObject()`, theme dropdown render), NEW `tests/theme-persistence.test.js` | `packages/server/src/index.js` (T3 lane), any other client region, `packages/server/src/auth.js` (T2 lane) |
| T2 | Auth long-cookie | `packages/server/src/auth.js`, NEW `tests/auth-cookie.test.js` | Everything else |
| T3 | `/api/health/full` | NEW `packages/server/src/health.js`, `packages/server/src/index.js` (ONE block — the route registration), NEW `tests/health-full.test.js` | All T1 files, all T2 files |
| T4 | Docs + versions | `CHANGELOG.md`, `packages/stack-installer/CHANGELOG.md`, `docs-site/src/content/docs/termdeck/changelog.md`, `package.json` (root), `packages/cli/package.json`, `packages/stack-installer/package.json`, NEW `docs-site/src/content/docs/blog/v07-runtime.mdx`, `README.md` (only "Recent releases" or version pins if any) | All `src/`, all existing `tests/` |

**Index.js collision rule:** T3 is the ONLY task that touches `packages/server/src/index.js`. T3 adds exactly one route registration block (`app.get('/api/health/full', ...)`). T1 must keep theme work inside `session.js` and the new `theme-resolver.js` so the metadata broadcast in `index.js` doesn't need editing — it already reads `session.meta.theme`, so as long as `meta.theme` resolves correctly via the new resolver, no `index.js` changes are needed in T1.

## Architectural decisions (already made — do not re-litigate)

### Theme persistence (T1)
- Add `theme_override TEXT NULL` column to `sessions` table (in-place schema migration in `database.js`'s init code, not a SQL migration file — this is local SQLite).
- Backfill on migration: existing rows get their current `theme` value copied to `theme_override` so user customizations from before the upgrade are preserved (treat existing values as user-set, not default-snapshot).
- `theme` column stays for backwards compat but is no longer authoritative. Future cleanup can drop it; v0.7.0 keeps it.
- New `resolveTheme(session, config)` helper in `theme-resolver.js`: returns `session.theme_override || config.projects?.[session.project]?.defaultTheme || config.defaultTheme || 'tokyo-night'`.
- `session.meta.theme` becomes a getter that calls `resolveTheme()` at read time. **This is the core change** — render-time resolution, not creation-time snapshot.
- Client `changeTheme()` continues to PATCH `/api/sessions/:id` with the new theme. Server writes to `theme_override`. Setting null reverts to config-derived default.
- Client UI: add a small "Reset to default" link in the theme dropdown. Sends `PATCH { theme: null }`. Server clears `theme_override`.
- Drop the dead `projects.default_theme` SQLite column (it's never read or written; latent contract-drift trap).

### Auth long-cookie (T2)
- Cookie max-age: 30 days. Set via `Set-Cookie: termdeck_token=...; Max-Age=2592000; HttpOnly; SameSite=Lax`.
- `Secure` flag: only when the request was over HTTPS (Brad's setup is local, no TLS). Detect via `req.protocol === 'https'` or the `X-Forwarded-Proto` header from a reverse proxy.
- Same cookie name and value format. No new flag, no new config.
- Document the trade-off in `auth.js` head comment: 30 days picked because TermDeck is intended as a local dev tool; cookie compromise risk is bounded by the local-only attack surface; Brad's UX feedback (re-enter on every browser) materially impacts adoption.

### `/api/health/full` (T3)
- New module `packages/server/src/health.js` exporting `getFullHealth(config, db)` → returns `{ ok: boolean, checks: [{ name, status: 'pass' | 'fail' | 'warn', detail? }] }`.
- Checks include:
  - Postgres reachable (`SELECT 1` against `DATABASE_URL` from secrets.env, if RAG enabled)
  - `memory_items.source_session_id` present (the v0.6.5 column that drove Brad's saga)
  - pg_cron + pg_net extensions enabled (the v0.6.9 audit, run at runtime)
  - Vault secret `rumen_service_role_key` present (same)
  - `cron.job` has rumen-tick row with active=true (the v0.6.9 verify, run at runtime)
  - SQLite db reachable
  - Mnestra webhook reachable (`/healthz` against `MNESTRA_WEBHOOK_URL` if configured)
  - Rumen pool reachable (best-effort — non-blocking, surfaced as warn not fail)
- Endpoint registered in `index.js` ONE block: `app.get('/api/health/full', healthHandler)`.
- Cached for 30 seconds inside `health.js` so polling doesn't hammer the database — invalidate on demand via a refresh query param.
- Uses the `preconditions.js` helpers from v0.6.9 where possible (DRY).

## Coordination protocol

Every Tn appends to `STATUS.md` whenever they:
1. **CLAIM** a file before writing (prevents accidental overlap if scope grows)
2. **POST DONE** when their lane is shipped + tested
3. **REQUEST** something from another terminal (e.g. T3 needs T1 to expose a helper)

Format (timestamp in UTC for sortability):

```
- [2026-04-26T20:15:00Z] [T1] CLAIM packages/server/src/session.js
- [2026-04-26T20:32:00Z] [T1] DONE — theme_override column + resolver + tests pass (18/18)
- [2026-04-26T20:33:00Z] [T1] HANDOFF to T4 — bumps & changelog now safe to write
```

Orchestrator (terminal 5 / this conversation) reads STATUS.md as the source of truth, makes integration decisions, and signs off on the merge into main.

## Acceptance criteria

v0.7.0 ships when ALL of:
- T1: Brad-style "edit config.yaml + restart → existing sessions reflect new default" works end-to-end. Test pinned. Existing user customizations survive the upgrade backfill.
- T2: Auth cookie persists 30 days across browser sessions. Test pinned. `Secure` flag set correctly under HTTPS.
- T3: `GET /api/health/full` returns a JSON report covering all checks above. Cached 30s. Test pinned with mocked DB.
- T4: termdeck@0.7.0 + termdeck-stack@0.3.0 published; root + stack-installer + docs-site changelogs updated; new v07-runtime blog post drafted; portfolio status line bumped.
- All wizards from v0.6.9 still pass their existing tests (no regression).
- Full CLI suite still green (target: 72 → 80+).

Not in scope:
- Migration-001 idempotency (`CREATE OR REPLACE FUNCTION` return-type collision) — separate sprint
- Rumen-MCP gap (NULL `source_session_id` on MCP-written memories) — separate sprint
- Theme picker UX overhaul (per-project palette, custom themes) — separate sprint

## Branching

Default to direct commits to `main` per project convention. If any task hits unexpected scope creep, post a `BLOCKED` line in STATUS.md and the orchestrator decides whether to break out into a feature branch.

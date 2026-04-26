# Sprint 32 — v0.7.0 — STATUS

Append-only coordination log. Each Tn posts CLAIM / DONE / REQUEST / BLOCKED lines. Orchestrator (this conversation) reviews and signs off.

Format:
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] CLAIM <file>` — about to write to a file in your lane
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] DONE — <one-line summary, test count>`
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] HANDOFF to <Tn> — <what's now safe>`
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] REQUEST <Tn> — <what you need>`
- `[YYYY-MM-DDTHH:MM:SSZ] [Tn] BLOCKED — <reason>`

Use `date -u +%Y-%m-%dT%H:%M:%SZ` to get the timestamp.

---

- [2026-04-26T19:25:00Z] [T5/orchestrator] Sprint opened. PLANNING.md locked. T1–T4 briefings written. Awaiting four parallel terminals.
- [2026-04-26T19:31:00Z] [T4] CLAIM docs-site/src/content/docs/blog/v07-runtime.mdx
- [2026-04-26T19:31:00Z] [T4] CLAIM CHANGELOG.md
- [2026-04-26T19:31:00Z] [T4] CLAIM packages/stack-installer/CHANGELOG.md
- [2026-04-26T19:31:00Z] [T4] CLAIM docs-site/src/content/docs/termdeck/changelog.md
- [2026-04-26T19:31:00Z] [T4] CLAIM ~/Documents/Graciella/joshuaizzard-dev/src/app/page.tsx (cross-repo)
- [2026-04-26T19:31:00Z] [T4] CLAIM README.md (single drifted v0.6.4 reference at line 174)
- [2026-04-26T19:33:22Z] [T3] CLAIM packages/server/src/health.js (NEW)
- [2026-04-26T19:33:22Z] [T3] CLAIM tests/health-full.test.js (NEW)
- [2026-04-26T19:34:00Z] [T2] CLAIM packages/server/src/auth.js
- [2026-04-26T19:34:00Z] [T2] CLAIM tests/auth-cookie.test.js (NEW)
- [2026-04-26T19:35:00Z] [T2] DONE — auth cookie 30-day persistence (Max-Age=2592000, HttpOnly, SameSite=Lax, Secure-when-HTTPS via req.protocol or X-Forwarded-Proto). Server-issued via new POST /api/auth/login handler intercepted by createAuthMiddleware (no index.js change needed; login page now POSTs instead of writing document.cookie client-side, which finally enables HttpOnly). Tests 11/11 pass. No version bump, no CHANGELOG, no commit.
- [2026-04-26T19:34:43Z] [T1] CLAIM packages/server/src/database.js (in-place sessions migration + drop projects.default_theme)
- [2026-04-26T19:34:43Z] [T1] CLAIM packages/server/src/session.js (theme_override field, render-time meta.theme getter, INSERT/UPDATE rewires)
- [2026-04-26T19:34:43Z] [T1] CLAIM packages/server/src/theme-resolver.js (NEW — resolveTheme + cached config getter)
- [2026-04-26T19:34:43Z] [T1] CLAIM packages/client/public/app.js (theme region only — Reset to default link)
- [2026-04-26T19:34:43Z] [T1] CLAIM tests/theme-persistence.test.js (NEW)
- [2026-04-26T19:35:30Z] [T4] PHASE A DONE — v07-runtime.mdx blog draft written, root + stack-installer + docs-site CHANGELOG placeholder blocks added with HTML-comment fillable bullets, portfolio status line bumped to v0.7.0 (npx tsc --noEmit clean), README v0.6.4 → v0.7.0 drift fixed. Awaiting T1/T2/T3 DONE for Phase B (T2 already posted DONE).
- [2026-04-26T19:36:02Z] [T3] CLAIM packages/server/src/index.js (single block: require + GET /api/health/full route registration)
- [2026-04-26T19:36:58Z] [T3] DONE — /api/health/full runtime health endpoint. New packages/server/src/health.js (sqlite + 5 pg-side required checks mirroring v0.6.9 audit/verify SQL + 2 warn checks for mnestra-webhook + rumen-pool, 30s module-scope cache, refresh:true bypass, never-throws contract). One block added to index.js: require + handler that returns 200 when ok / 503 when any required check fails / 500 on aggregator throw. Tests 8/8 pass (7 unit with fake pg client + fake sqlite handle covering happy path, missing source_session_id column with npm-cache hint, pg_cron disabled with dashboard hint, webhook warn doesn't flip ok, cache hit/miss/refresh, swallow on warn-probe throw, swallow on required-check throw; 1 live-server smoke spawning the CLI on a fresh-HOME free port and asserting the JSON shape end-to-end). Adjacent suites still green: preconditions 11/11, health-contract 3/3, cli-default-routing 4/4. No version bump, no CHANGELOG, no commit.
- [2026-04-26T20:17:09Z] [T1] DONE — render-time theme resolution. New packages/server/src/theme-resolver.js exports resolveTheme(session, config) walking { session.theme_override → config.projects[p].defaultTheme → config.defaultTheme → 'tokyo-night' } plus an mtime-keyed disk-cache (getCurrentConfig) so the meta.theme getter doesn't re-read ~/.termdeck/config.yaml on every 2s broadcast yet still picks up edits without a restart. database.js: added sessions.theme_override column with one-shot backfill from theme (only fires when column is being added, so post-migration NULL inserts stay NULL — Brad's "stuck in tokyo night" stops sticking on fresh sessions); dropped dead projects.default_theme column (grep confirmed never read or written). session.js: meta.theme is now an Object.defineProperty getter that resolves at read time; setter routes to theme_override. SessionManager.create writes both columns (theme = legacy snapshot for back-compat, theme_override = NULL on create, populated only via PATCH). updateMeta on theme writes to theme_override; PATCH theme:null clears the override and reverts to config-derived default. Client (theme region only): added "↺ default" reset link next to the dropdown that PATCHes theme:null and applies the resolved value from the response. Tests 13/13 pass (resolveTheme x5 path coverage, backfill, idempotency on second run, fresh-create NULL invariant, config edit propagates with NO sql update between reads, override wins, PATCH null clears, getter reflects current resolveTheme output, setter routes through theme_override). Adjacent suites still green: health-contract 3/3, transcript-contract 4/4, analyzer-error-fixtures 9/9, preconditions 11/11, migration-loader-precedence 4/4, setup-prompts 5/5, failure-injection 4/5 (1 pre-existing skip), CLI suite 22/22, contract suite 7/7. End-to-end smoke confirms create→meta.theme→PATCH dracula→PATCH null→fallback path. No index.js touched. No version bump, no CHANGELOG, no commit.
- [2026-04-26T20:17:09Z] [T1] HANDOFF to T4 — theme persistence shipped on disk; bumps & changelog entries now safe to fill in.
- [2026-04-26T20:20:30Z] [T4] READY — all changelog placeholders filled from T1/T2/T3 DONE summaries (concrete file/test/behavior detail in each bullet). Versions bumped: root @jhizzard/termdeck 0.6.9→0.7.0, packages/cli @termdeck/cli-internal 0.2.7→0.3.0, packages/stack-installer @jhizzard/termdeck-stack 0.2.8→0.3.0. Compare-links added to root CHANGELOG.md and docs-site/changelog.md ([0.7.0]: ...v0.6.9...v0.7.0; [Unreleased] bumped to v0.7.0...HEAD). Stale "Meta-installer 0.1.0→0.2.0" note removed from [Unreleased] in root CHANGELOG (already captured in stack-installer CHANGELOG; doubly stale now that stack is at 0.3.0). Test counts wired in: 13 (theme) + 11 (auth) + 8 (health) = 32 net new, suite 72 → 104. Cross-repo portfolio status line bumped (npx tsc --noEmit clean, separate repo so requires its own commit). v07-runtime.mdx blog draft is `draft: true`. Files changed in this repo: package.json, packages/cli/package.json, packages/stack-installer/package.json, CHANGELOG.md, packages/stack-installer/CHANGELOG.md, docs-site/src/content/docs/termdeck/changelog.md, docs-site/src/content/docs/blog/v07-runtime.mdx (new), README.md (single line). Cross-repo: ~/Documents/Graciella/joshuaizzard-dev/src/app/page.tsx. Did NOT commit, did NOT publish — orchestrator integrates.

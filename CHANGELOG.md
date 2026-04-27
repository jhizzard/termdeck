# Changelog

All notable changes to TermDeck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Planned
- Fully-local path: SQLite + local embeddings for Mnestra (currently requires Supabase + OpenAI)
- Multi-user data validation (today's testing is single-developer)
- Control panel dashboard with Yes/No buttons for AI agent permission prompts
- Migration-001 idempotency — `CREATE OR REPLACE FUNCTION` return-type collision when re-running migrations against an already-upgraded store. Sprint-32 candidate, deferred from v0.7.0.
- Rumen-MCP gap — NULL `source_session_id` on memories written via the MCP path means they never reach Rumen synthesis. Sprint-33 candidate.

## [0.9.0] - 2026-04-27

### Added — Phase C part 1: Orchestrator-as-product

> **Theme:** Sprint 37 (4+1, ~30 min effective wall-clock with one mid-sprint nudge to T3) takes the orchestration patterns Joshua uses every day — the 4+1 sprint, the inject mandate, the CLAUDE.md hierarchy, the per-project scaffolding rituals — and ships them as a first-class shipped product feature. After this lands, a developer picking up TermDeck for the first time can read `docs/orchestrator-guide.md`, run `termdeck init --project <name>` to scaffold a full agent-ready project, and kick off a 4+1 sprint from the dashboard without touching the CLI. The two-stage submit pattern (paste, settle, `\r`) is now encoded server-side in `sprint-inject.js` so users cannot accidentally bypass it.

- **NEW `docs/orchestrator-guide.md` — canonical 9-section orchestrator reference.** Sections: 4+1 pattern, inject mandate (with two-stage submit + cURL examples + `/poke` recovery), CLAUDE.md hierarchy (global / project / session-prompt), memory-first discipline, enforcement-vs-convention rule, sprint discipline (FINDING / FIX-PROPOSED / DONE), restart-prompt rituals, per-project scaffolding (cross-references the `init --project` template manifest), channel inject patterns (WhatsApp / iMessage / self). Each section ends with a `> See also:` line pointing to the canonical source. Shipped in the npm tarball — `package.json` `files` allowlist now includes `docs/orchestrator-guide.md`. Sprint 37 T1.
- **NEW dashboard right-rail Guide panel.** Collapsible aside with toggle tab (📖 Guide), search input, TOC nav, content pane. Lazy-loads `/docs/orchestrator-guide.md` on first expand via a new `app.use('/docs', express.static(docsDir))` static mount in `packages/server/src/index.js` (+9 LOC, fs-existsSync-guarded so test environments without a `docs/` dir don't crash). Purpose-built ~110-line markdown converter with no external deps (preserves zero-build-step ethos) — handles ATX headings, paragraphs, bullets, ordered lists, fenced code, blockquotes, tables, hr, bold, italic, inline code, links, with `escapeHtml` defense-in-depth before inline regex transforms. Scroll-spy marks active TOC entry. Search filters sections + TOC entries together. Contextual auto-expand: clicking a terminal panel scrolls the Guide to "the-4-1-pattern" section. `g` keyboard shortcut toggles when no input is focused (skipped inside `.term-panel`). z-index: 50 (modals at ≥1000 sit cleanly above). +21 LOC `index.html`, +234 LOC `style.css`, +245 LOC `app.js`. Sprint 37 T1.
- **NEW `termdeck init --project <name>` scaffolding generator.** Creates a complete project skeleton in one command — `CLAUDE.md`, `CONTRADICTIONS.md`, `project_facts.md`, `README.md`, `docs/orchestration/README.md`, `docs/orchestration/RESTART-PROMPT.md.tmpl`, `.claude/settings.json`, `.gitignore`. NEW `packages/cli/templates/` directory with the 8 `.tmpl` files (~10 kB total); flat layout with hyphenated prefix encoding subdirectory placement (e.g., `docs-orchestration-README.md.tmpl` → `docs/orchestration/README.md`). NEW `packages/cli/src/templates.js` (+73 LOC) — shared module exporting `MANIFEST` (canonical 8-entry array), `listTemplates()`, `readTemplate(identifier)`, `renderTemplate(identifier, vars)`, `TEMPLATES_DIR`; identifier resolution accepts either `name` or template filename. Placeholders supported: `{{project_name}}`, `{{project_path}}` (absolute), `{{generated_at}}` (ISO 8601), `{{termdeck_version}}` (read from root `package.json` at run time); unknown `{{keys}}` left untouched so typos are visible. NEW `packages/cli/src/init-project.js` (+173 LOC) — `initProject({ name, dryRun, force, cwd })`. Validates project name (lowercase letters/digits/hyphens, no slashes / `..` / leading or trailing hyphen), refuses non-empty target without `--force` (accepts existing-but-empty), iterates `MANIFEST` to render+write 8 files, prints "Next steps" block. `--dry-run` flag prints the destination tree + first 5 lines of each rendered file without writing. Subcommand registration in `packages/cli/src/index.js` (+~28 LOC) with mode-conflict guard against `--mnestra + --project`. `package.json` `files` allowlist gains `packages/cli/templates/**`; `npm pack --dry-run` confirms all 8 `.tmpl` files appear in the tarball. NEW `tests/init-project.test.js` (+158 LOC, 11/11 pass): happy path file tree, `{{project_name}}` and `{{project_path}}` substitution, `.claude/settings.json` parses as JSON with permissions allow/deny arrays, dry-run writes nothing + lists every destination, refuses on non-empty target without `--force`, `--force` overwrites preserving siblings, refuses on subdirs-only non-empty target, accepts existing-but-empty target, `_validateName` rejects bad inputs, bad name → exit code 1. Sprint 37 T2.
- **NEW dashboard orchestration-preview surface.** "If you ran `termdeck init --project <name>` here, here's exactly what would be created" — read-only preview before commit. NEW `packages/server/src/orchestration-preview.js` (+256 LOC) — pure helper accepting `templates`, `destFor`, `initProject` by injection so logic is unit-testable without T2's CLI modules; exports `buildPreview()`, `generateScaffolding()` (async), `resolveTargetPath()`, `validateName()`, `normalizeTemplateItems()`. Two routes added to `packages/server/src/index.js` (+123 LOC) — `GET /api/projects/:name/orchestration-preview` returns `{ projectName, targetPath, exists, wouldCreate[], wouldSkip[] }`, `POST /api/projects/:name/orchestration-preview/generate` body `{ force?: boolean }` calls T2's `initProject({ dryRun: false })`. Lazy resolvers `_getT2Templates() / _getT2InitProject() / _getT2DestFor()` so a missing module returns 503 with a clear error rather than crashing. Target-path resolution: existing `config.projects[name]` → preview against the project's resolved path; otherwise `path.resolve(process.cwd(), name)` for fresh-scaffold preview. Preview button next to the existing `+` add-project button (disabled until a project is selected) opens `#previewProjectModal` mirroring the add-project-modal pattern; `.preview-project-modal` / `.ppm-*` styles include header, meta strip with exists/fresh tag, scrollable file tree with create/skip sections, expand-on-click row bodies with `<pre>` content snippets, force checkbox, generate/cancel buttons. Tokyo-Night palette consistent with existing modals. +25 LOC `index.html`, +245 LOC `style.css`, +200 LOC `app.js`. NEW `tests/orchestration-preview.test.js` (+601 LOC, 26/26 pass) — covers shape contract, name validation, fresh/existing-dir branches, T2 string-array AND object-array shapes, async exitCode propagation, force/no-force, plus an integration test against the live T2 `templates.js` + `init-project.js._destFor` so future shape drift fails this test rather than silently breaking the dashboard. Sprint 37 T3.
- **NEW in-dashboard 4+1 sprint runner with `--isolation=worktree` opt-in.** Define a sprint, name the lanes, click "kick off." TermDeck spawns four panels through the same `spawnTerminalSession({...})` code path as `POST /api/sessions` (transcripts, RAG telemetry, Mnestra flashback, command logging, status-change → RAG — no drift), runs the two-stage submit injection server-side, tails `STATUS.md` in a sidebar panel showing per-lane FINDING/FIX-PROPOSED/DONE counts. NEW `packages/server/src/sprint-inject.js` (+160 LOC) — pure two-stage submit logic: `injectSprintPrompts({ sessionIds, prompts, writeBytes, getStatus, sleep, options })` returns `{ ok, lanes:[{paste, submit, verified, poked, finalStatus}] }`, auto-pokes (`\r\r\r`) any lane that doesn't reach `status:'thinking'` within `verifyTimeoutMs` (default 8000ms). Tests pass mock `writeBytes` / `getStatus` / `sleep` so no live PTY is needed. Writes via `session.pty.write` directly, bypassing the CRLF-normalize + rate-limit in `/api/sessions/:id/input` — necessary because the bracketed-paste payload must preserve embedded `\n` as `\n`, not `\r`; routing through the public endpoint is a single-line override point if a future security review requires it. NEW `packages/server/src/sprint-routes.js` (+370 LOC) — `POST /api/sprints` (validate → scaffold sprint dir + PLANNING.md + T1-T4 lane briefs + STATUS.md + lane prompt templates → optional `git worktree add <sprint_dir>/worktrees/T<n> -b sprint-<name>-T<n>` per lane → spawn 4 panels via injected `spawnTerminalSession` callback → run `injectSprintPrompts`), `GET /api/sprints` (list), `GET /api/sprints/:name/status` (parse STATUS.md headers with cheap regex, return per-lane FINDING / FIX-PROPOSED / DONE counts + lastEntryAt + lastModifiedAt), `GET /api/sprints/:name/tail` (raw tail, `?lines=N` capped at 2000). `packages/server/src/index.js` (+24 / -3 LOC) extracts the existing inline PTY-spawn-and-wire body of `POST /api/sessions` into a `spawnTerminalSession({ command, cwd, project, label, type, theme, reason })` closure inside `createServer`; both the existing handler (now a 4-line shim) and `createSprintRoutes({ app, config, spawnTerminalSession, getSession })` call it. Worktree opt-in defaults ON in the UI per the Sprint 36 incident decision (memory: 2026-04-27 12:55 ET — worktree-based 4+1 sprint orchestration is the going-forward protocol; merge-at-close stays manual for v0.9.0, automation is Sprint 38+). UI: `#btn-sprint` topbar button + sprint modal (project picker, slug-validated name, target version, goal, T1–T4 name+goal pairs, worktree checkbox, auto-inject checkbox) + result panel with per-lane verified/poked counts from the inject result + 80-line STATUS.md tail polling every 3s. +97 LOC `index.html`, +205 LOC `app.js`, +190 LOC `style.css`. NEW `tests/sprint-inject.test.js` (+~190 LOC, 7/7 pass): bracketed-paste shape, no-CR-in-stage-1, settle/gap timing, paste-failure short-circuit, verify-and-poke, getStatus-omitted, validation. NEW `tests/sprint-routes.test.js` (+~360 LOC, 10/10 pass): parse, slugify, list/next-number, full HTTP scaffold + 8 expected PTY writes shape (4 paste + 4 lone CR, in order), validation rejections, status, tail, list. The `POST /api/sessions` refactor is regression-clean: 41/41 cross-check tests pass (`tests/health-contract.test.js tests/auth-cookie.test.js tests/cli-default-routing.test.js tests/cli-stack-detection.test.js tests/preconditions.test.js`). Sprint 37 T4.

### Notes

- **Sprint 37 wall-clock**: ~30 minutes from kickoff (16:50 ET) to last lane DONE (T3 at 17:16 ET). Mid-sprint nudge fired at T3 (17:11 ET) when its `lastActivity` went stale for 7+ minutes between turns; the nudge unblocked the lane and T3 posted DONE within five minutes. Two-stage submit pattern delivered all four boot prompts on first attempt — zero stuck panels, zero recovery `/poke` calls.
- **All four lanes coordinated entirely through STATUS.md cross-reads** — no orchestrator-mediated handoffs needed. T2 locked the templates module surface in its FIRST FINDING entry; T3 adopted T2's contract verbatim in its FIX-PROPOSED. T1 cited T2's 8-name template manifest verbatim in Guide § 8. T1's right-rail z-index (50) and T3's preview modal (3000) and T4's sprint-runner modal (also high) chose non-conflicting layers without coordination. Two `package.json` `files` allowlist additions (T1's `docs/orchestrator-guide.md` and T2's `packages/cli/templates/**`) stacked additively.
- **Server restart required** to surface the new `/docs` static route, the orchestration-preview routes, and the `/api/sprints*` routes in production browsers. Folded into the next 4+1 cohort spawn for Sprint 38 — one restart covers all four lanes' new endpoints.
- **`@jhizzard/termdeck-stack@0.4.1`** ships in lockstep as an audit-trail patch bump (Sprint 35 lesson: every termdeck release gets a paired stack-installer patch bump even when the installer source is untouched, so package-version archaeology can pin the user-visible TermDeck version that shipped alongside any installer release).
- **Substrate health snapshot at sprint close**: Mnestra ingestion +129 memories in 6 hours (5,323 → 5,452 → 5,455 by close); Rumen `rumen-tick` cron green with last 5 runs all succeeded on `*/15 * * * *` schedule; rumen_insights at 275 rows; **`memory_relationships` already populated with 749 edges** across all five schema-allowed kinds (supersedes 469, elaborates 167, relates_to 91, contradicts 14, caused_by 8) — Sprint 38's "table is dormant" framing is wrong and the lane briefs are corrected for it.

## [0.8.0] - 2026-04-27

### Added — Phase B reconciliation: launcher + UI parity, hook bundling, MCP path migration

> **Theme:** Sprint 36 (4+1, ~30 min effective wall-clock once two orchestrator hotfixes stopped the kill class) closes the personal-vs-product asymmetry that Sprint 35 (Phase A) made non-fatal. After this lands, `npx @jhizzard/termdeck` matches `scripts/start.sh` step-for-step on a fresh box, the dashboard exposes RAG-toggle in-product, the stack-installer ships Joshua's `~/.claude/hooks/memory-session-end.js` so fresh users get the same Mnestra-ingestion wiring, and Claude Code v2.1.119+ MCP entries land in the canonical `~/.claude.json` instead of the legacy `~/.claude/mcp.json` that Claude Code no longer reads.

- **`npx @jhizzard/termdeck` now runs the full `scripts/start.sh` choreography by default.** `packages/cli/src/auto-orchestrate.js`: `shouldAutoOrchestrate()` returns `true` unconditionally (was: gated on `~/.termdeck/secrets.env` + `~/.termdeck/config.yaml` presence + autoStart/rag.enabled — the Sprint 24 default that excluded fresh boxes from Step 1/4–4/4 entirely). Function preserved as a future telemetry seam. `--no-stack` still opts out for users who want the Tier-1-only path. `packages/cli/src/stack.js`: exports `CLAUDE_MCP_PATH_CANONICAL` (`~/.claude.json`) and `CLAUDE_MCP_PATH_LEGACY` (`~/.claude/mcp.json`); MCP-absence hint now checks both paths via new `hasMnestraMcpEntry()` helper and prints `TermDeck doesn't see Mnestra wired in Claude Code yet. Run: npx @jhizzard/termdeck-stack` only when neither file references Mnestra. `tests/cli-stack-detection.test.js` (7/7 pass) and `tests/cli-default-routing.test.js` (6/6 pass) updated for the new always-on policy. Sprint 36 T1.
- **MCP wiring migrated from legacy `~/.claude/mcp.json` to canonical `~/.claude.json`.** Claude Code v2.1.119+ reads top-level `mcpServers` exclusively from `~/.claude.json`; the legacy path is no longer consulted on most installs, which silently broke every fresh `npx @jhizzard/termdeck-stack` since the v2.1 release. NEW `packages/cli/src/mcp-config.js` (+174 LOC) and sibling `packages/stack-installer/src/mcp-config.js` (+138 LOC) — same exports (`CLAUDE_MCP_PATH_CANONICAL`, `CLAUDE_MCP_PATH_LEGACY`, `readMcpServers`, `mergeMcpServers`, `writeMcpServers`, `migrateLegacyIfPresent`), structure-preserving read-modify-write that only touches the `.mcpServers` key, atomic via `${path}.tmp.${pid}` then `rename`, mode 0600, current-wins on key collision. `packages/stack-installer/src/index.js` and `packages/cli/src/init-rumen.js` updated to write through the new helpers; `~/.claude/mcp.json` is left untouched (user may have other tooling pinned to it). NEW `tests/mcp-config-merge.test.js` (+331 LOC) covers legacy-only / current-only / overlap / disjoint / malformed / empty-file / preserves-other-top-level-keys (`oauthAccount`, `projects` etc.) / idempotent-second-run / mode-0600 / atomic-rename / migrate-noop-when-no-legacy. `tests/init-rumen-mcp-json.test.js` updated with one new test pinning that backfilling `SUPABASE_ACCESS_TOKEN` against a `~/.claude.json`-shaped fixture leaves all sibling top-level keys byte-identical. Sprint 36 T2.
- **Dashboard `Settings → RAG mode` toggle.** New `PATCH /api/config` endpoint (+45 LOC `packages/server/src/index.js`) accepts `{ rag: { enabled: bool } }`, validates against a strict whitelist (only `rag.enabled` writable today), persists to `~/.termdeck/config.yaml` via new `updateConfig` (+101 LOC `packages/server/src/config.js`) which round-trips YAML and writes a `.bak` before overwriting, then live-updates `RAGIntegration.enabled` via new `setEnabled()` (+22 LOC `packages/server/src/rag.js`) which re-evaluates eligibility and starts/stops the sync timer without restart, and broadcasts `config_changed` over WebSocket so multi-tab dashboards sync within ~100ms. `packages/client/public/app.js` (+103 LOC): new `renderSettingsPanel()` slot inside the existing setup modal renders an MCP-only-mode-explainer + toggle row above the tier list; new `updateRagIndicator()` paints a `RAG · on/off` chip in the topbar; `init()` wires the indicator after first config load; WS message handler adds `case 'config_changed'`. `packages/client/public/style.css` (+114 LOC): `.setup-settings`, `.settings-row`, `.toggle`, `.topbar-stat.rag-on/off` all using existing design tokens. NEW `tests/config-update.test.js` (13/13 pass, 162ms) pins the contract: rejects non-object / empty / non-whitelisted patches, rejects non-boolean values, writes/round-trips both true and false, creates the `rag` block when missing, creates a new file when none exists, preserves the projects map verbatim, refuses to overwrite malformed YAML, `.bak` write-before-overwrite, `flattenPatch` flattens nested objects, `UPDATABLE_PATHS` contract verified. Sprint 36 T3 Deliverable A.
- **Stack-installer ships the personal `~/.claude/hooks/memory-session-end.js` hook.** Joshua's box has carried this Stop-hook since 2026-03-11; fresh users running `npx @jhizzard/termdeck-stack` previously got Mnestra wired but no ingestion path because the hook was never bundled. NEW `packages/stack-installer/assets/hooks/memory-session-end.js` (vendored copy with `RAG_DIR` parameterized to `process.env.HOME` and a graceful skip-and-log when `<RAG_DIR>/src/scripts/process-session.ts` is absent — Joshua's private `rag-system` repo is not on a fresh user's box, so the hook is a no-op until that repo is published OR the hook is rewritten to call Mnestra MCP tools directly; future-sprint scope flagged). NEW `packages/stack-installer/assets/hooks/README.md` documents what the hook does, when it fires, what it writes to Mnestra, and how to disable. `packages/stack-installer/src/index.js`: new opt-in prompt `Install TermDeck's session-end memory hook? (Y/n)` (defaults Y), copies the asset to `~/.claude/hooks/memory-session-end.js` with overwrite-prompt protection on existing-and-different files, and merges a `Stop` matcher-group into `~/.claude/settings.json` preserving the 6 sibling top-level keys (`permissions`, `hooks`, `enabledPlugins`, `extraKnownMarketplaces`, `skipAutoPermissionPrompt`, `agentPushNotifEnabled`); idempotent — second install run produces no diff in settings.json. `packages/stack-installer/package.json` `files` array gains `"assets/**"` (the release-blocker T4 caught mid-lane: without this, the vendored hook would not have shipped in the npm tarball — silent install break). NEW `tests/stack-installer-hook-merge.test.js` (+443 LOC) covers idempotent install, existing-Stop-without-our-entry append, existing-Stop-WITH-our-entry no-op, malformed settings.json graceful error, all 6 top-level keys preserved verbatim, mode preservation, .bak written. Sprint 36 T4.

### Fixed

- **Server-kill class via `reclaimStalePort` cascade-kill — root cause of four Sprint 36 PTY-cohort losses.** `packages/cli/src/index.js`: `reclaimStalePort(port)` (a sibling of `stack.js`'s `reclaimPort` that I missed when patching the latter at 14:08 ET) used the same regex match `/packages\/cli\/src\/index\.js/ || /termdeck/i` and SIGTERM+SIGKILL'd anything matching, with no liveness probe. Any lane worker invoking `node --test` against a CLI test (e.g., T1's `tests/cli-default-routing.test.js`) spawned a CLI child whose entry path called `reclaimStalePort(3000)`, found the live orchestrator's server PID, and cascade-killed it + every child PTY. Reproduced four times in 30 minutes (13:35, 13:47, 14:55, 15:20 ET). Fix: liveness-probe self-recognition via `execSync curl -sf -m 1.5 -w "%{http_code}" http://127.0.0.1:${port}/api/sessions`; `HTTP 200` means the server is the orchestrator's live instance — log `[port] :${port} held by live TermDeck — not killing. Use --port <other> for a second instance.` and `process.exit(0)` instead of SIGKILLing. Mirror of `stack.js:isTermDeckLive`. Defense-in-depth: `cli/src/index.js` now also reads `TERMDECK_PORT` env into `config.port` (`else if (process.env.TERMDECK_PORT) config.port = parseInt(...)`), so tests setting `TERMDECK_PORT=0` actually take effect. Orchestrator hotfix #2 — applied 15:25 ET, validated by T1 cohort surviving its full test run against PID 2983 immediately after.
- **Server-kill class via `stack.js reclaimPort` cascade-kill — same flaw, sibling site.** `packages/cli/src/stack.js`: same liveness-probe self-recognition pattern added to `reclaimPort(port)` via new `isTermDeckLive(port)` async helper using `httpJson` (the in-module fetch wrapper). On HTTP 200 from `/api/sessions`, returns `{ reclaimed: false, blockerPids, alreadyLive: true }` and prints `TermDeck on port ${port} is live (PIDs: ...) — not killing`. Orchestrator hotfix — applied 14:08 ET.
- **`rag.js` status_changed flood — orchestrator-applied debounce.** `packages/server/src/rag.js`: rapid `active ↔ thinking` cycling from busy 4+1 lanes produced dozens of `[rag] write event=status_changed` lines per second per session, which floods stdout and the outbox without value (status edges within 1s are noise, not signal). Constructor adds `_statusWriteAt = new Map()` (sessionId → last write timestamp ms) and `_statusDebounceMs = 1000`. `onStatusChanged()` early-returns when `now - last < 1000` AND neither old nor new status is `errored` (error transitions always pass through — they carry signal). `stop()` clears the map. Designed by T3 Deliverable D, applied at the orchestrator layer (enforcement-vs-convention) after two server-kill incidents convinced both author and orchestrator that delegating to a lane that the bug kept killing was not going to converge. Validated by aggregate ~4 lines/sec across 4 active sessions = correct (1/sec/session × 4 sessions). Orchestrator hotfix — applied 14:08 ET.
- **`startTour()` half-initialized state could leave the 78%-black `.tour-spotlight` overlay stuck visible.** `packages/client/public/app.js`: T3's static audit of every viewport-spanning dark CSS rule located the literal "dark veil" symptom both Joshua and Brad reported as `.tour-spotlight` (`box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.78)` at style.css:191–200) — the only rule in the file producing a viewport-wide dark layer. Fault path: `startTour()` set the spotlight's `display = 'block'` BEFORE calling `await ensurePanelForTour()` and `renderTourStep()`, both of which can throw (POST to `/api/sessions`, DOM not ready). On any throw, the 9999px shadow stayed up with no tooltip — looks like a stuck modal overlay. Fix: wrap the post-display-block work in `try`/`catch`; on any throw, log the error and call `endTour()` (idempotent — nulls `tourState.active`, removes `.active` from backdrop, hides spotlight + tooltip with guards). +8 LOC. Zero behavior change on the happy path. Sprint 36 T3 Deliverable B.
- **Hard-refresh PTY loss verified-fixed by orchestrator hotfix #2.** T3's static + live verification confirmed the briefing's diagnosis (WS-close cascading to PTY kill) was contradicted by the current code: `ws.on('close')` only nulls `session.ws`, `session.destroy()` only clears timers + buffer, only `DELETE /api/sessions/:id` (gated behind `confirm()`) kills PTYs, and the client has no `beforeunload`/`pagehide`/`unload` handler. The original symptom Joshua reported on 2026-04-27 13:00 ET (`/api/sessions` returns count: 0 immediately after Cmd+Shift+R) was the same `reclaimStalePort` cascade-kill that took down the four Sprint 36 PTY cohorts — the live server died, taking its in-memory sessions Map with it. With the kill class closed, hard-refresh is non-destructive. T3 added a `+9 LOC` comment block to `ws.on('close')` documenting the intent so the next cohort doesn't re-misdiagnose. Sprint 36 T3 Deliverable C.
- **`migration-loader-precedence.test.js` stale assertions updated.** Test hardcoded `length === 7` from v0.6.5; Sprint 35 T2 added `008_legacy_rag_tables.sql` making the bundled count 8. Three assertions corrected (4/4 pass). Pre-existing test debt closed as part of Sprint 36 close-out.

### Notes

- **Sprint 36 wall-clock**: ~3 hours from 12:08 ET first kickoff to 15:46 ET final lane DONE — but ~2 of those hours were lost to the four server-kill incidents (cohort losses at 13:35, 13:47, 14:55, 15:20). The actual productive time once the kill class was closed (15:25 ET → 15:46 ET = 21 min) covered T3's three deliverables (A: PATCH /api/config + RAG toggle in 5 min, B: tour-spotlight try/catch in 3 min, C: verified-fixed verification in 2 min) plus T1, T2, T4 finishing their FIX-PROPOSED work that had survived the kills as on-disk edits. The lesson: enforcement-level fixes (orchestrator-applied) on convergent failure modes beat convention-level guidance ("don't run the CLI") that survives one cohort but not four.
- **Two-stage submit pattern locked into `~/.claude/CLAUDE.md`** (15:35 ET): 4+1 sprint inject MUST POST the bracketed-paste payload (`\x1b[200~ ... \x1b[201~`) and a `\r` submit as **separate** `/api/sessions/:id/input` calls with a 400ms gap. Single-stage `<text>\x1b[201~\r` injection is BANNED — OS-level chunk boundary into the PTY is non-deterministic, leaving a stuck-paste-no-submit panel ~25% of the time. Three cohort injects in this sprint validated the two-stage pattern's deterministic delivery (zero stuck panels). The cardinal sin clause: leaving a panel waiting for a human Enter press cost Joshua broken sleep on 2026-04-26 during ClaimGuard Sprints 4–5 and again on 2026-04-27 during Sprint 36's first inject. Must never recur.
- **Brad's empty-pgvector ingestion gap** is now substantively addressed by T2 (MCP path migration) + T4 (hook bundling). The full fix path requires v0.8.0 plus either publishing `rag-system` OR rewriting the hook to call Mnestra MCP tools directly (queued for a future sprint per T4's FINDING). Brad-side workaround drafted at `/tmp/brad-mnestra-hook.js` and sent via WhatsApp at 15:30 ET — fully self-contained, no `rag-system` dependency, ~120 LOC.
- **Pre-existing test failures not fixed in this release** (4 total; deferred — none are Sprint 36 regressions): (1) `stripAnsi removes standard CSI sequences (SGR colors)` — session.js util test predating Sprint 35; (2-3) `Error detection: common Node errno codes` and `Error detection: HTTP 5xx from server log` — `PATTERNS.error` regex too narrow per Sprint 33 finding; (4) `project-bound flashback: termdeck session surfaces termdeck/null memories` — depends on Mnestra Supabase fixture state. Confirmed pre-existing via stash + clean-main rerun. Flagged for an analyzer-pattern fix sprint.
- **Sprint 37 (Orchestrator-as-product) and Sprint 38 (Knowledge graph + D3.js)** plans preserved at `docs/sprint-37-orchestrator-product/PLANNING.md` and `docs/sprint-38-knowledge-graph/PLANNING.md`. Sprint 37 T4 (worktree-isolated 4+1 sprint runner) graduates from "going-forward protocol" to first-class shipped product feature — every lane in its own git worktree, no chance to cascade-kill the orchestrator's server. Today's enforcement-level liveness-probe fix is a stopgap; Sprint 37 closes the structural gap.

## [0.7.3] - 2026-04-27

### Changed — Reconciliation: align fresh-install behavior with the personal-box reality

> **Theme:** Brad's overnight crash (`/opt/structural-mvp` box, 2026-04-27) exposed an asymmetry that's been latent for months: Joshua runs `rag.enabled: false` on his daily-driver box (MCP-only mode — Mnestra fills via Claude Code's `memory_remember` calls and the personal `~/.claude/hooks/memory-session-end.js`), while `termdeck init --mnestra` flips fresh users to `rag.enabled: true` and immediately tries to write to legacy schema (`mnestra_session_memory`, `mnestra_project_memory`, `mnestra_developer_memory`, `mnestra_commands`) that no init path creates. Result: 404 cascade on every fresh-install RAG event, circuit breaker opens, all RAG syncs silently drop. **Sprint 35 (4+1, ~17 minutes wall-clock T1 → T2)** flips the install default to MCP-only AND ships the legacy schema as a real shipped migration so opt-in users no longer hit the silent 404 cascade. Plus packaging fix for the transcript table.

- **`init --mnestra` defaults to `rag.enabled: false` (MCP-only mode).** `packages/cli/src/init-mnestra.js`: the `writeYamlConfig()` step now writes `rag.enabled: false` and prints a 5-line "Setup mode: MCP-only (default)" block before the config-update step explaining how MCP-only fills `memory_items` via Claude Code memory tools, that TermDeck-side event tables stay off, and the dashboard toggle URL `http://localhost:3000/#config` plus the config.yaml fallback. `printNextSteps()` appends a 3-line restatement so users who tab away during step output still get the disclosure. File-header docstring (step 5), HELP block (step 4), and `printBanner` step 7 all rewritten to match. Sprint 35 T1 (5 edits, all in one file).
- **Legacy RAG schema now ships as `008_legacy_rag_tables.sql`.** `packages/server/src/setup/mnestra-migrations/008_legacy_rag_tables.sql` (NEW) is a byte-identical mirror of `config/supabase-migration.sql` with a four-line provenance header. `migration-runner.js::listAllMigrations()` discovers it via the existing alphabetical glob over `mnestra-migrations/*.sql` — no wiring change needed; dropping the file IS the wiring. The runner's header comment was generalized from "7-migration bootstrap sequence" to a description that defers to glob discovery. `config/supabase-migration.sql` itself was rewritten for idempotency: `CREATE EXTENSION IF NOT EXISTS pg_trgm` moved to the top so the dependent FTS index resolves on a vanilla Postgres first run; all eleven `CREATE INDEX` got `IF NOT EXISTS`; all eight `CREATE POLICY` statements gained a `DROP POLICY IF EXISTS … ON <table>;` guard immediately above them (Postgres-version-agnostic; works pre-15). Sprint 35 T2 (4 files within lane).
- **`pg_cron` / `pg_net` precondition hints now project-specific.** `packages/server/src/setup/preconditions.js`: new `extensionsDashboardUrl(supabaseUrl)` helper derives `https://supabase.com/dashboard/project/<ref>/database/extensions` from `secrets.SUPABASE_URL` (via existing `setup/supabase-url.js`) and injects it into the pg_cron and pg_net hints when derivable, falling back to the generic copy otherwise. `init --rumen` already gates on these via the v0.6.9 `auditRumenPreconditions` framework — no `init-rumen.js` change needed (T3 FINDING confirmed the gate was in place since v0.6.9; Sprint 35 T3's lane brief had described an idealized API that didn't match reality). Sprint 35 T3 (2 files).
- **`termdeck doctor` extended with Supabase schema-check section.** `packages/cli/src/doctor.js` (+312 LOC) extends Sprint 28's version-check doctor with a `_runSchemaCheck(secrets)` test seam that verifies presence of: Mnestra modern schema (`memory_items`, `memory_sessions`, `memory_relationships`, RPCs); Mnestra legacy schema (`mnestra_session_memory`, etc. — checks for the new 008 migration); transcript table (`termdeck_transcripts`); Rumen tables + `created_at` column; extensions (`pg_cron`, `pg_net`, `pgvector`, `pg_trgm`, `pgcrypto`). New `--no-schema` opt-out flag. JSON output gains a `schema` key alongside the existing `rows` key. Combined exit-code precedence: 2 (network failure) > 1 (update available OR schema gap) > 0 (clean). New tests in `tests/cli-doctor.test.js` (+130 LOC) using the fake-pg-client substring-routing pattern from `tests/preconditions.test.js`; existing tests pass `--no-schema` to stay deterministic. Sprint 35 T3 (3 files + 2 test files).
- **Boot banner shows RAG state.** `packages/cli/src/index.js`: after the `╚═══╝` box, a single dim line prints either `RAG: on — events syncing to mnestra_session_memory / mnestra_project_memory / mnestra_developer_memory` or `RAG: off (MCP-only mode) — toggle in dashboard at <url>/#config…`. `packages/server/src/index.js:1736`: matching label for direct-invocation banner — `config.rag?.supabaseUrl ? 'configured' : 'not configured'` (which had nothing to do with `enabled`) replaced with `config.rag?.enabled === true ? 'on (...)' : 'off (MCP-only mode)'` so both banners stay coherent. Sprint 35 T4.
- **Stale-port reclaim and transcript-table-missing hint ported from `scripts/start.sh`.** `packages/cli/src/index.js`: new `reclaimStalePort(port)` helper (lifted from `scripts/start.sh:127–154`) runs before `server.listen()` — `lsof -ti TCP:<port>` (with `fuser` Linux fallback), `ps -o command= -p <pid>` to identify TermDeck holders, SIGTERM → 1s grace → SIGKILL on TermDeck PIDs, hard-stop with a useful message on non-TermDeck holders. New `checkTranscriptTableHint(databaseUrl)` fire-and-forget helper (lifted from `scripts/start.sh:309–313`) probes `SELECT 1 FROM termdeck_transcripts LIMIT 0` and prints `[hint] Transcript backup table missing. Run: termdeck doctor (or psql $DATABASE_URL -f config/transcript-migration.sql)` on failure. Manual test matrix on port 3099: rag-on/off banners ✓, stale-TermDeck reclaim ✓, non-TermDeck holder hard-stops with `--port <n+1>` hint ✓, transcript hint exercised via syntax check (Joshua's Supabase already has the table). Sprint 35 T4.

### Fixed — packaging gap caught during sprint close-out

- **`config/transcript-migration.sql` now actually ships in the npm tarball.** Pre-Sprint-35 `package.json` `files` array did not include this path; `migration-runner.js:33` does `fs.existsSync(TRANSCRIPT_MIGRATION)` before applying, so on every fresh `npm install -g @jhizzard/termdeck` install since v0.6.8, the runner silently skipped the transcript migration. Brad's 2026-04-27 crash log (`relation "termdeck_transcripts" does not exist`) is the user-visible symptom. Now the file is in `files` and the migration runs as documented. Orchestrator-side correction during Sprint 35 close-out (one-line edit, audited via `npm pack --dry-run`).

### Notes
- **Sprint 35 wall-clock**: 4+1 sprint kicked off 2026-04-27 12:08 ET. T4 DONE at 12:20, T1 DONE at 12:25, T2 DONE at 12:26. T3 work product complete (verified by orchestrator at close — terminal closed before posting [T3 DONE], but `node --check` passes on all touched files, all tests pass for T3's additions, and lane scope is honored). Orchestrator close at 13:05 ET.
- **T2's pre-publish idempotency test against a scratch Supabase project deferred** — no scratch DB available at close. T2's offline statement-class analysis covers all forms (`CREATE EXTENSION IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (no-op when already enabled), `DROP POLICY IF EXISTS … ; CREATE POLICY …`, `CREATE OR REPLACE VIEW`). Every statement re-runs cleanly.
- **Pre-existing test failures in `packages/server/tests/session.test.js`** (Error detection assertions returning `'active'` instead of `'errored'`) confirmed via stash-and-rerun against `HEAD` to predate this sprint; last commit on that file was v0.2.5 (95c577d). NOT introduced by Sprint 35; not blocking publish; flagged for a separate analyzer-pattern fix sprint.
- **Sprints 36–38 planned** in `docs/sprint-36-launcher-ui-parity/`, `docs/sprint-37-orchestrator-product/`, `docs/sprint-38-knowledge-graph/`. Sprint 36 (Phase B) covers full `scripts/start.sh` parity in the published CLI, MCP path drift (`~/.claude.json` vs `~/.claude/mcp.json`), dashboard RAG-toggle UI, and bundling the personal session-end hook into `@jhizzard/termdeck-stack`. Sprint 37 ships the orchestrator-as-product layer (Orchestrator Guide, per-project scaffolding generators, in-dashboard 4+1 sprint runner with worktree-isolation option). Sprint 38 brings the dormant `memory_relationships` table to life as a Supabase-native knowledge graph with D3.js v7 force-directed visualization.
- **Two install-UX bugs surfaced during Sprint 35 are queued for Sprint 36 / Phase B**: (1) dashboard "dark veil" — stuck modal/overlay blocks pointer events to xterm.js terminals; both Joshua and Brad have hit it independently. Workaround: hard-refresh OR `document.querySelectorAll('.modal-backdrop, [class*="modal"]').forEach(el => el.remove())` in dev console. (2) Hard-refresh kills server-side PTYs — `/api/sessions` returns 0 immediately after a Cmd+Shift+R; WebSocket close event being misinterpreted as session shutdown. Both are HIGH priority for Phase B.

## [0.7.2] - 2026-04-26

### Fixed
- **chopin-nashville mis-tag of TermDeck memories — corpus repair + TermDeck-side regression lock.** Sprint 34 closes the second of two converging bugs Sprint 33 diagnosed under the *"Flashbacks are vaporware"* report. v0.7.1 fixed the analyzer regex so Flashback fires on common Unix shell errors; v0.7.2 makes the resulting toast content actually relevant for TermDeck panels by repairing the mis-tagged corpus and pinning the resolver against future drift. Sprint 34's 4+1 audit converged in ~15 minutes on a finding that resets the framing: **the chopin-nashville source is not in TermDeck.**
- **What T1 actually found.** TermDeck's `resolveProjectName(cwd, config)` (rag.js:19-41) is correct — longest-prefix-wins with explicit `path.sep` boundary so `/a/b` cannot spuriously match `/a/bb`. Live ground-truth probe against `~/.termdeck/config.yaml` (15 projects) returns `termdeck` for the TermDeck repo cwd and every subdirectory. All five RAG hooks (`onSessionCreated`, `onCommandExecuted`, `onStatusChanged`, `onSessionEnded`, `onFileEdited`) route through `_projectFor(session)`, which prefers explicit `session.meta.project` and only falls back to `resolveProjectName` if absent. **`mnestra-bridge.queryMnestra` falls back the same way.** No path-segment side-channel exists. Sprint 21 T2's writer fix landed correctly and is intact. The `1,165` mis-tagged `memory_items` rows (was 1,126 in Sprint 33's snapshot — Rumen added ~39 since) came from a writer **outside the TermDeck repo entirely:** `~/.claude/hooks/memory-session-end.js:17` carries a literal `{ pattern: /ChopinNashville|ChopinInBohemia/i, project: 'chopin-nashville' }` with no `termdeck` entry above it; first-match-wins on cwd, so every Claude Code session-end inside any TermDeck panel pattern-matches `ChopinNashville` before reaching anything more specific. The hook then spawns `~/Documents/Graciella/rag-system/src/scripts/process-session.ts --project chopin-nashville <transcript>`, ingesting the full transcript into `memory_items` with that tag. Compounded by Rumen's `extract.ts:62` (`(ARRAY_AGG(m.project))[1] AS project`) — every 15 minutes Rumen synthesizes new insights inheriting the first project tag from each session group, so the harness hook's bad tag propagates into `rumen_insights` and back into `memory_items` as synthesized rows. **Same shape as T3's separately-flagged `gorgias`-vs-`claimguard` finding** (line ~25 of the same hook: `{ pattern: /gorgias/i, project: 'gorgias' }` with no `claimguard` mapping), out of v0.7.2 scope.
- **What v0.7.2 ships in the TermDeck repo (T1, +30 LOC source + 12 tests):** `packages/server/src/rag.js` +22 LOC introducing `_resolveProjectAttribution(session)` (returns `{ tag, source: 'explicit'|'cwd'|'fallback' }`) and `_recordForSession()` (refactored common path); the five RAG hooks now route through it and emit a `[rag] write project=<tag> source=<...> session=<id> event=<type>` audit line on every legacy-table write. `packages/server/src/mnestra-bridge/index.js` +8 LOC: every `queryMnestra` invocation logs `[mnestra-bridge] query project=<tag> source=<explicit|cwd|none> mode=<direct|webhook|mcp>` so future drift in either the resolver chain OR a caller passing the wrong project becomes visible at runtime, not via SQL spelunking weeks later. NEW `tests/project-tag-resolution.test.js` (12 tests, all green) pins the contract: leaf wins over ancestor, explicit `meta.project` beats cwd resolution, missing config falls back to basename, empty config returns null, `.../ChopinNashville/SideHustles/TermDeck/termdeck` resolves to `termdeck` (the regression pin), trailing-slash cwd handled, sibling path with shared prefix does not cross-match (the `path.sep` boundary case), `_projectFor` honors explicit `meta.project` over cwd-derived value. Bridge constructor + `queryMnestra` signature unchanged externally; existing v0.7.1 tests all green (analyzer-error-fixtures, theme-persistence, init-mnestra-resume, etc.).
- **Corpus repair (T2, ~210 LOC SQL).** `scripts/migrate-chopin-nashville-tag.sql` with `docs/sprint-34-project-tag-fix/SQL-PLAN.md` documents the full plan. Three-block layout: **Block 1** (dry-run, runs always, zero mutations) emits the candidate count + per-target-project distribution + a 10-stay-+-5-move sample inspection; **Block 2** (UPDATE, commented out — requires manual uncomment after orchestrator+Josh approve Block 1's output) flips matching rows; **Block 3** (REVERT, commented out — one-shot rollback via `metadata->>'rebrand_v0_7_2_from'` stash) is the safety net. Multi-branch OR heuristic, priority-ordered: termdeck > mnestra > rumen > pvb > claimguard. **Conservative-by-design** — rows that match no branch stay `chopin-nashville`. Reversibility: every reclassified row carries its old project tag under `metadata.rebrand_v0_7_2_from` so Block 3 restores via a single statement. Path branch falls back on `metadata->>'cwd'` because `source_file_path IS NULL` for all 1,165 chopin-nashville rows (Rumen-synthesized rows do not carry a file path). Pre-flight aggregate counts (Block 1 dry-run output): chopin-nashville total = 1,165; broad-keyword `termdeck` family match = 352 (the v0.7.2 narrative number; Sprint 33's 1,126 figure was optimistic — broad-keyword union catches 352, the remaining ~700 are festival/Chopin-in-Bohemia content, pianist references, or oblique TermDeck mentions that would coin-flip if reclassified). Estimated Block 2 reclassification: ~340–352 → termdeck, ~5–20 → mnestra, ~10–25 → rumen, ~3–7 → pvb, ~2–4 → claimguard, ~750–800 stay. Out-of-scope (flagged in SQL-PLAN): gorgias→claimguard rebrand, PVB case-dupe, engram→mnestra rebrand.
- **Live-corpus regression catches (T3, 13 new test cases).** `tests/project-tag-invariant.test.js` (NEW, 6 tests): 1 distribution-sanity guard (no project >50% of total unless dominant), 4 content-vs-tag invariants (top tag for `content ILIKE '%termdeck%'` must be `termdeck`; same for pvb/claimguard/mnestra identifiers), 1 residual guard (≤25% of termdeck-identifier rows tagged chopin-nashville post-backfill — pre-backfill state today is 86%, 113/131). Skips cleanly with `pg connect/probe failed` when `DATABASE_URL` is unset (matches `failure-injection.test.js` skip-on-no-server pattern), so CI without a live Mnestra stays green. **Designed to fail pre-backfill, pass post-backfill** — the v0.7.2 release ships them red on Josh's live corpus today and turning them green is one of the success criteria for whether to RUN Block 2. `tests/flashback-e2e.test.js` grows from 2 → 3 tests with a project-bound case that creates a session with `meta.project='termdeck'`, triggers the canonical shell error, and asserts the `proactive_memory` frame includes a non-empty `memories` array. Pre-flight queries `/api/ai/query` with `project='termdeck'` and skips with a `needs-backfill` directive when zero matches, avoiding generic 8s timeouts. v0.7.1 PHASE-A diagnostic instrumentation preserved.

### Notes
- **What v0.7.2 deliberately does NOT fix.** The actual upstream emitter — `~/.claude/hooks/memory-session-end.js:17` — is in Josh's user-owned global Claude Code harness config, NOT in any TermDeck/Mnestra/Rumen repo. No code in this release touches that file. Recommended one-paste fix (also addresses T3's gorgias→claimguard finding): insert `{ pattern: /SideHustles\/TermDeck\/termdeck/i, project: 'termdeck' }` and matching leaf entries for engram/mnestra, rumen, podium, claimguard BEFORE the `ChopinNashville` and `gorgias` entries — or, more durably, rewrite `detectProject` as longest-substring-wins over a project map keyed by canonical name. Without this fix, every new Claude Code session-end inside a TermDeck panel will continue to land in `memory_items` with `project='chopin-nashville'`. The TermDeck-side audit logs added in v0.7.2 will not show this drift (the harness hook does not go through TermDeck's writer); only the live-corpus invariant probe will. POSTMORTEM at `docs/sprint-34-project-tag-fix/POSTMORTEM.md` has the full chain.
- **The principle this locks in further.** v0.6.9 added install-time `auditPreconditions()`. v0.7.0 added runtime `auditPreconditions()` via `/api/health/full`. v0.7.1 added analyzer-coverage fixtures. v0.7.2 adds **writer-side observability** — every memory write and every query now logs its project tag and resolution source, so the chain that produced 1,165 silently-mis-tagged rows over 2+ weeks would surface within minutes the next time anything similar happens.
- **Stack-installer audit-trail bumped 0.3.1 → 0.3.2.** Mnestra (0.2.2) and Rumen (0.4.3) unchanged. **A separate `@jhizzard/rumen@0.4.4` would harden Rumen's `extract.ts:62` to use mode-of-source-projects or distinct-count guard instead of `(ARRAY_AGG)[1]`** — but fixing the harness hook first heals Rumen on next tick (synthesized rows pick up the correct upstream tag), so the Rumen-side fix is lower priority than the hook fix.
- **Full CLI suite: 12 new tests in `tests/project-tag-resolution.test.js` all green; 6 new tests in `tests/project-tag-invariant.test.js` skip cleanly without a live `DATABASE_URL` and intentionally fail against the pre-backfill live corpus (turning green is the post-Block-2 success signal); `tests/flashback-e2e.test.js` grows 2 → 3 tests; all v0.7.1 tests still green.** Adjacent suites unchanged.
- **Sprint 34 wall-clock: ~15 minutes from open to all-three-DONE** (T2 22:14:45Z, T3 22:09:27Z, T1 22:15:00Z; sprint opened 22:00Z). T4 Phase A 22:10:30Z, READY post-integration.
- **Live-store backfill execution status:** *deferred — `scripts/migrate-chopin-nashville-tag.sql` ships in the package with a default-runs dry-run block; whether Block 2 is executed against the live `petvetbid` store is an orchestrator+Josh decision after sample inspection. Run via `psql "$DATABASE_URL" -f scripts/migrate-chopin-nashville-tag.sql` for the dry-run, or uncomment Block 2 first to apply.* <!-- Orchestrator: replace this line with "executed at <ts> against petvetbid; N rows reclassified" if/when Block 2 runs. -->

## [0.7.1] - 2026-04-26

### Fixed
- **Flashback never firing on common Unix shell errors.** Reported by Josh as *"Flashbacks are vaporware. They never happen, never any suggestions."* `tests/flashback-e2e.test.js` reproduced the silence cleanly: the pipeline times out at 8.6s waiting for a `status_changed→errored` row in `rag_events`. Sprint 33's 4+1 forensic audit (T1 analyzer + T2 bridge + T3 Mnestra query path + T4 e2e/postmortem) converged in ~24 minutes on a regex coverage gap in `PATTERNS.error`.
- The session.js header comment claims `PATTERNS.error` catches plain-English Unix tool errors (`No such file or directory`, `Permission denied`, `command not found`, etc.) — the regex never actually included those phrases. Pure "documentation is not verification" miss; the code lied to its own comment. The analyzer fired on structured errors (`Error:`, `Traceback`, `npm ERR!`, `error[Ennn]:`) but stayed silent for the plain-English shell errors that dominate real terminal usage. Josh's `cat /nonexistent/file/path` → `cat: /nonexistent/file/path: No such file or directory` produced zero status flips, zero bridge calls, zero `proactive_memory` frames.
- Fix in `packages/server/src/session.js` (+14 LOC): new `PATTERNS.shellError` regex covering colon-prefixed `<cmd>: <path>: No such file or directory|Permission denied|Is a directory|Not a directory|command not found`, plus `curl: (NN) Could not resolve host`, `Segmentation fault`, `ModuleNotFoundError:`, lowercase git `fatal:`. Anchored on real shell-error structure so adversarial prose mentioning the same phrases in narrative context does NOT trigger (verified against a 7-fixture false-positive suite). `_detectErrors` now falls through to `PATTERNS.shellError` when the primary pattern misses.
- New regression coverage in `tests/analyzer-error-fixtures.test.js` (+48 LOC): `SHELL_ERROR_SHOULD_TRIGGER` (10 fixtures) and `SHELL_ERROR_SHOULD_NOT_TRIGGER` (7 prose fixtures). All 4 tests in the file pass. Net-positive on `packages/server/tests/session.test.js` — turns a pre-existing `'zsh: command not found: kubectl'` failure GREEN with no other breakage.
- New instrumentation in `tests/flashback-e2e.test.js` (T4 Phase A): on test failure the dump now includes the WS frame log, sampled `session.meta` per poll, all `rag_events` for the session, and a transcript snapshot. Turns black-hole timeouts into labeled fault-isolating diagnostics — the regression defense that would have prevented Flashback going silent for 5+ sprints.

### Notes
- **Two independent root causes were diagnosed; only one is fixed in v0.7.1.** The second (T3's finding: `chopin-nashville` project-tag regression that accumulated 1,126 rows of TermDeck content under the wrong tag while the canonical `termdeck` tag has only 68) excludes Josh's relevant memories from the bridge's strict project filter even when the analyzer fires correctly. v0.7.1 ships the analyzer fix only because (a) it's surgical and pure-code, (b) T3's fix touches the live Supabase store via UPDATE statements + needs writer-side source review, and (c) shipping them separately keeps the changelog narrative honest. T1's fix unblocks `flashback-e2e.test.js` and Flashback for sessions WITHOUT a `meta.project` set (the bridge passes `filter_project=null` and search-all surfaces matches). Josh's daily live workflow needs both.
- **Sprint 34 ships T3's fix:** chopin-nashville → real-project-tag backfill SQL + a writer-side audit to find where the mis-tag happens. Fix lands as v0.7.2. POSTMORTEM at `docs/sprint-33-flashback-debug/POSTMORTEM.md` has the full diagnosis + Sprint 34 acceptance criteria.
- **The principle locked in further:** v0.6.9 added `auditPreconditions()`. v0.7.0 added runtime `auditPreconditions()` via `/api/health/full`. v0.7.1 adds a fixture suite that's the contract test that would have caught this in 2026-04-15 when the comment was written but the regex wasn't updated.
- **Stack-installer audit-trail bumped 0.3.0 → 0.3.1.** Mnestra (0.2.2) and Rumen (0.4.3) unchanged.
- Sprint 33 wall-clock: 24 minutes from open to converge across four parallel terminals. T1 + T2 + T3 + T4 all DONE within 8 minutes of each other.

## [0.7.0] - 2026-04-26

### Added — runtime correctness, the v0.6 → v0.7 arc

> **Theme:** v0.6.x closed install-time correctness with `auditPreconditions()` + `verifyOutcomes()`. v0.7.0 extends that pattern from install-time into runtime: themes that track config edits, auth that doesn't ask twice, and a runtime health endpoint that mirrors the install-time audit.

- **Theme persistence — `session.meta.theme` is now a render-time getter, not a creation-time snapshot.** Closes Brad's 2026-04-26 report (*"can't get theme changed. ignores changes to config.yaml and is stuck in tokyo night"*). New module `packages/server/src/theme-resolver.js` exports `resolveTheme(session, config)` walking `{ session.theme_override → config.projects[p].defaultTheme → config.defaultTheme → 'tokyo-night' }`, plus an mtime-keyed disk-cache (`getCurrentConfig`) so `meta.theme` doesn't re-read `~/.termdeck/config.yaml` on every 2s metadata broadcast yet still picks up edits without a server restart. `database.js`: added `sessions.theme_override TEXT NULL` via in-place schema migration with a one-shot backfill from the legacy `theme` column (only fires the first time the column is added — so post-migration `NULL` inserts stay `NULL`, preserving the user-set defaults from before the upgrade while making fresh sessions follow config out of the box). Dropped dead `projects.default_theme` column (grep confirmed never read or written; removed as a latent contract-drift trap). `session.js`: `meta.theme` is now an `Object.defineProperty` getter that resolves at read time; setter routes to `theme_override`. `SessionManager.create()` writes both columns (`theme` = legacy snapshot for back-compat, `theme_override` = `NULL` on create, populated only via PATCH). `updateMeta()` on theme writes to `theme_override`. PATCH `{ theme: null }` clears the override and reverts to the config-derived default. Client (theme region only): added an `↺ default` reset link next to the theme dropdown that PATCHes `theme: null` and applies the resolved value from the response. **No `index.js` touched** — the existing `meta.theme` reader in the metadata broadcast picks up the getter without modification. 13 new tests in `tests/theme-persistence.test.js` (resolveTheme path coverage ×5, backfill correctness, idempotency on second init, fresh-create NULL invariant, config edit propagates with no SQL update between reads, override wins over config, PATCH null clears, getter reflects current resolveTheme output, setter routes through `theme_override`).
- **Auth cookie now persists 30 days, HttpOnly, SameSite=Lax.** Closes Brad's 2026-04-26 report (*"is there a way not to have to enter the token at each termdeck session?"*). `Set-Cookie: termdeck_token=...; Max-Age=2592000; HttpOnly; SameSite=Lax`. The `Secure` flag is set when the request was over HTTPS — detected via `req.protocol === 'https'` or the `X-Forwarded-Proto` header from a reverse proxy. New `POST /api/auth/login` handler intercepted by `createAuthMiddleware` issues the cookie server-side, so **no `index.js` change was needed** — the existing middleware mount point was the only edit surface. The login page now POSTs the token instead of writing `document.cookie` from the client; this is what finally lets `HttpOnly` actually be honored (you can't write an HttpOnly cookie from JavaScript, which is why every prior auth iteration silently dropped the flag). Same cookie name and value format as v0.6.x — no migration, no new flag, no new config. Head-comment in `auth.js` documents the 30-day trade-off: TermDeck is intended as a local dev tool; cookie-compromise risk is bounded by the local-only attack surface; the UX win materially impacts adoption. 11 new tests in `tests/auth-cookie.test.js`.
- **`GET /api/health/full` runtime health endpoint.** New module `packages/server/src/health.js` exports `getFullHealth(config, db, opts)` → `{ ok, checks: [{ name, status: 'pass' | 'fail' | 'warn', detail? }] }`. Five required pg-side checks mirror the v0.6.9 audit/verify SQL — Postgres reachability, `memory_items.source_session_id` present, `pg_cron` + `pg_net` enabled, Vault `rumen_service_role_key` present, `cron.job` rumen-tick active — plus SQLite reachability, plus two warn-only probes for the Mnestra webhook (`/healthz`) and the Rumen pool. Returns `ok: true` only when every required check passes; warn-only failures surface in the report but do not flip `ok`. 30-second module-scope cache so polling from a status bar doesn't hammer Postgres; `?refresh=1` bypasses the cache. Never-throws contract — internal exceptions are caught and surface as `{ status: 'fail', detail }` rather than 500ing the request. One block added to `index.js`: `require('./health')` + a handler that returns 200 when `ok`, 503 when any required check fails, 500 only when the aggregator itself throws. Reuses `preconditions.js` helpers from v0.6.9 — install-time and runtime share one source of truth for what "healthy" means. 8 new tests in `tests/health-full.test.js` (7 unit with a fake pg client + fake sqlite handle covering happy path, missing-source_session_id with the npm-cache-clean hint, `pg_cron`-disabled with the dashboard hint, webhook warn doesn't flip `ok`, cache hit/miss/refresh, throw-swallow on warn probe, throw-swallow on required check; 1 live-server smoke spawning the CLI on a fresh-`HOME` free port and asserting the JSON shape end-to-end).

### Notes
- **The principle this extends:** v0.6.9 locked in *"documentation is not verification."* v0.7.0 extends that into runtime: an install that was correct at install time can drift later (config edits ignored, auth state dropped, extensions disabled by an admin upgrade, pools quietly stopping). Without a runtime equivalent of the audit, the user finds out via a missing Flashback toast two days later. `/api/health/full` is the on-demand answer to the same principle.
- **Behavior change for users on v0.6.x:** existing per-session theme picks are backfilled into `theme_override` and survive untouched, so customizations don't reset on upgrade. Auth cookies set on v0.6.x will be re-issued with the longer max-age and `HttpOnly` flag on the next login — no manual action. The new health endpoint is additive; the existing `/api/health` is unchanged.
- **Stack-installer audit-trail bumped 0.2.8 → 0.3.0.** Mnestra (0.2.2) and Rumen (0.4.3) unchanged.
- **Full CLI suite: 104/104 green** (was 72, +32 new — 13 in `tests/theme-persistence.test.js`, 11 in `tests/auth-cookie.test.js`, 8 in `tests/health-full.test.js`). Adjacent suites still green: preconditions 11/11, migration-loader-precedence 4/4, setup-prompts 5/5, health-contract 3/3, transcript-contract 4/4, analyzer-error-fixtures 9/9.
- **Recovery if you upgrade and a session looks wrong:** `npm cache clean --force && npm i -g @jhizzard/termdeck@latest`, restart termdeck. The `theme_override` column is added in-place by the database init code; no manual migration needed. To clear all per-session overrides and let `config.yaml` take over for fresh sessions only, click `↺ default` in each panel's theme dropdown. To reset every session at once, `UPDATE sessions SET theme_override = NULL` in `~/.termdeck/termdeck.db`.
- **What v0.7.0 deliberately does NOT include** (deferred to v0.7.x or later): migration-001 idempotency fix (`CREATE OR REPLACE FUNCTION` return-type collision on re-runs against an already-upgraded store), Rumen-MCP gap (NULL `source_session_id` on MCP-written memories never reaching Rumen synthesis), theme picker UX overhaul (per-project palette, custom themes).

## [0.6.9] - 2026-04-26

### Added — the deliberate close to the v0.6.x incident saga
- **`auditPreconditions()` and `verifyOutcomes()` for both wizards.** New module `packages/server/src/setup/preconditions.js`. Closes the failure class that produced four of the eight v0.6.x patches (v0.6.4 token, v0.6.6 pgbouncer, v0.6.7 mcp.json, "v0.6.9-equivalent" extensions): a documented manual step that wasn't verified in code.
- **`auditRumenPreconditions(secrets, env)`** runs FIRST in `init-rumen.js`, before any state-changing operation. Surfaces every gap in one pass with actionable hints: Supabase CLI auth (token in env OR `supabase login` worked), `pg_cron` extension enabled, `pg_net` extension enabled, Vault secret `rumen_service_role_key` present. Distinguishes Vault-permission-denied from Vault-secret-missing — different hints. Refuses to proceed on any gap; no partial work.
- **`verifyRumenOutcomes(secrets)`** runs after the schedule SQL applies. Confirms `cron.job` has an active rumen-tick row. Doesn't poll for the first 15-min tick (too long for an interactive wizard) but tells the user exactly what query to run after waiting.
- **`verifyMnestraOutcomes(secrets)`** runs after migrations apply. Confirms `memory_items` exists, `memory_items.source_session_id` exists (the v0.6.5 column whose absence cascaded into Brad's Rumen failures), and `memory_status_aggregation()` exists. **This is the test that, if it had existed before v0.6.5, would have caught the silent-shadow saga at install time instead of cron-tick time.**
- **10 regression tests** in `tests/preconditions.test.js` using a fake pg client. Covers all-gaps-surface, all-clean-passes, vault-permission-vs-missing-distinction, cron-active vs cron-inactive vs cron-missing, the source_session_id gap with the npm-cache-clean recovery hint, the missing-table gap, and smoke tests for the report renderers.

### Notes
- **The principle this locks in:** *"Documentation is not verification. Anything documented as a manual step must also be runtime-checked, or the first unsupervised user pays."* Saved as a global universal memory before this release shipped.
- **Behavior change for users with incomplete preconditions:** wizards that previously half-succeeded now fail-fast with a consolidated gap report. The exit code from a missing precondition is 10 (audit) or 11 (verify). Old behavior — proceeding into a half-applied state — is gone. This is a deliberate UX shift, in service of "first unsupervised user shouldn't pay."
- **Stack-installer audit-trail bumped 0.2.7 → 0.2.8.** Mnestra (0.2.2) and Rumen (0.4.3) unchanged.
- **Full CLI suite: 72/72 green** (was 62, +10 new).
- **What v0.6.9 deliberately does NOT include** (deferred to v0.7.0): theme persistence fix (Brad's "stuck in tokyo night" report), auth-cookie 30-day persistence (Brad's "have to enter token at each browser session"), `/api/health/full` runtime health endpoint. v0.7.0 is "the install you can trust to stay healthy" — extends the audit/verify pattern from install-time into runtime.
- **End of the v0.6.x arc.** Eight patches in 48 hours started with a CRLF leak and ended with a precondition-audit framework. The longitudinal failure-class analysis is in the global memory `UNIVERSAL DEBUGGING PATTERN — When a project's release stream becomes "one patch per user report"...`

## [0.6.8] - 2026-04-26

### Fixed
- **Migration loader silently shadowing newer bundled migrations with a stale `@jhizzard/mnestra` in global node_modules.** Brad reported 2026-04-26 12:47 PM after upgrading to v0.6.5 and re-running `termdeck init --mnestra --yes`: *"Still getting column m.source_session_id does not exist. The 6 migrations all applied cleanly but the column is still missing. Looks like the new migration wasn't included in the --yes run."* Root cause: `packages/server/src/setup/migrations.js`'s `listMnestraMigrations()` checked `node_modules/@jhizzard/mnestra/migrations/` BEFORE the bundled directory and used it whenever any `.sql` files were found there. The meta-installer (`@jhizzard/termdeck-stack`) installs `@jhizzard/mnestra` globally as a peer; `npm i -g @jhizzard/termdeck@latest` doesn't touch that sibling install. So Brad's stale `mnestra@0.2.1` (6 migrations) silently shadowed v0.6.5's bundled 7 migrations. The wizard reported "6 migrations applied" because it really was applying 6 — the wrong six.
- v0.6.8 flips the precedence: bundled FIRST. `node_modules/@jhizzard/mnestra/migrations/` is now used only as a safety-valve fallback when the bundled directory is missing entirely (e.g. someone `rm -rf`'d it manually). Bundled is what TermDeck developed and tested against; that's the source of truth. Same change applied to `listRumenMigrations()` for symmetry.
- New `tests/migration-loader-precedence.test.js` (4 cases) — the regression test that, if it had existed before v0.6.5, would have caught Brad's bug at test time. Pins (a) the bundled directory contains all 7 migrations, (b) `listMnestraMigrations()` returns 7 in lexical order, (c) returned paths are under the bundled directory not node_modules, (d) **a fake stale `@jhizzard/mnestra@0.2.1` with only 6 migrations does NOT shadow the bundled 7** (Brad's exact scenario).

### Notes
- **Recovery for anyone affected (Brad and any other v0.6.5/.6/.7 user with stale global Mnestra):** `npm cache clean --force && npm i -g @jhizzard/termdeck@latest`, then `termdeck init --mnestra --yes`. With v0.6.8 the wizard reads bundled migrations regardless of what's in node_modules — no separate Mnestra upgrade required. Anyone who already manually added the column or already upgraded their global Mnestra is fine; the new migration is `IF NOT EXISTS` idempotent.
- This is the bug the v0.6.5 fix was meant to ship. The schema patch was correct; the loader hid it. The right defensive change earlier would have been a contract test that exercised the loader against a stale-shadow scenario — exactly what `tests/migration-loader-precedence.test.js` now does. (Mirror of universal lesson #5 from the v0.6.x post-mortem: cross-package contracts need contract tests, not goodwill.)
- Stack-installer audit-trail bumped 0.2.6 → 0.2.7. Mnestra (0.2.2) and Rumen (0.4.3) unchanged.
- Full CLI suite: 62/62 green (was 58, +4 new).

## [0.6.7] - 2026-04-26

### Fixed
- **`SUPABASE_ACCESS_TOKEN` placeholder never being replaced in `~/.claude/mcp.json`.** Brad reported 2026-04-26: *"the token hadn't been written to the Json file which we updated manually, but you may want to put that in the patch at some point."* Root cause: the meta-installer (`@jhizzard/termdeck-stack`) wires the Supabase MCP server entry with `SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE'` as a literal placeholder. v0.6.4 told users to `export SUPABASE_ACCESS_TOKEN=...` for `supabase link` — but the export only affected their shell, never propagated into the JSON config. Claude Code's Supabase MCP server stayed broken with the placeholder until the user manually edited the file.
- New helper `wireAccessTokenInMcpJson()` in `packages/cli/src/init-rumen.js`. Runs after `supabase link` succeeds (token verified-real at that point). Reads `~/.termdeck/.claude/mcp.json` (correctly: `~/.claude/mcp.json`), replaces the placeholder if it's the literal `SUPABASE_PAT_HERE`, leaves any real user-set token untouched, atomic write with mode 0600, preserves all other `mcpServers` entries verbatim. Idempotent. No-op when the file is missing, the supabase MCP entry is missing, or `process.env.SUPABASE_ACCESS_TOKEN` is unset. Malformed JSON surfaces a soft warning but doesn't throw.
- New `tests/init-rumen-mcp-json.test.js` (10 cases): placeholder gets replaced, sibling entries preserved verbatim, mode 0600 enforced, real token never overwritten, same-token-already-set is a no-op, missing token / missing file / missing supabase entry all return clean status codes, malformed JSON returns `status=malformed`, supabase entry without an env block gets one created.

### Notes
- This closes the v0.6.4–v0.6.7 incident arc end-to-end. Brad's stack should now: (1) Mnestra schema correct (v0.6.5), (2) DATABASE_URL normalized (v0.6.6), (3) Supabase MCP token wired automatically (v0.6.7). Anyone re-running `termdeck init --rumen` after upgrading will get the JSON updated automatically — no manual edit needed.
- Stack-installer audit-trail bumped 0.2.5 → 0.2.6. Mnestra (0.2.2) and Rumen (0.4.3) unchanged.
- Full CLI suite: 58/58 green (was 48, +10 new in `init-rumen-mcp-json.test.js`).

## [0.6.6] - 2026-04-26

### Added
- **Auto-append `?pgbouncer=true&connection_limit=1` on Supabase transaction-pooler URLs.** Brad's 2026-04-26 Rumen logs surfaced the warning Supabase recommends but our wizard had been ignoring: a Shared Pooler URL on port 6543 (transaction mode) needs those query params or PgBouncer can return prepared-statement errors under load. The wizard now detects the URL shape — host ends in `.pooler.supabase.com` AND port is `6543` — and appends the params on the user's behalf. Direct connections (port 5432, `db.<ref>.supabase.co`) and session-mode pooler URLs (port 5432 on pooler hostname) are unchanged. Idempotent: a URL that already has `pgbouncer=true` is returned untouched. Wiring lives in two places: (a) `init-mnestra.js writeSecretsFile()` normalizes at write time so the URL hits disk clean; (b) `init-rumen.js preflight()` normalizes again when reading from `secrets.env` to forward to the Edge Function as a function secret, so partial-upgrade installs (users who ran v0.6.5 wizards previously) still get a clean URL handed to Rumen on a v0.6.6 re-run.
- New `tests/supabase-url-normalize.test.js` (15 cases): transaction-pooler detection (incl. future regional prefixes like `gcp-1-*`), session-mode pooler not detected, direct connection not detected, non-Supabase host not detected, append-when-missing, idempotent on already-set, preserve user-set `connection_limit`, preserve unrelated query params, defensive on null/empty/malformed input.

### Notes
- This is a UX polish release — the v0.6.5 schema fix already unblocked Rumen end-to-end. v0.6.6 closes the secondary warning Brad's logs showed alongside the schema error. Anyone whose `~/.termdeck/secrets.env` already has a transaction-pooler URL without the params can simply re-run `termdeck init --mnestra --yes` after upgrading; the normalizer rewrites the line in place via the merge-aware writer in `dotenv-io.js`.
- Stack-installer audit-trail bumped 0.2.4 → 0.2.5. Mnestra and Rumen unchanged.
- Full CLI suite: 48/48 green (was 33, +15 new in `supabase-url-normalize.test.js`).

## [0.6.5] - 2026-04-26

### Fixed
- **`termdeck init --rumen` deploying cleanly but the Edge Function failing on every cron tick with `column m.source_session_id does not exist` (Postgres SQLSTATE 42703).** Reported 2026-04-26 by Brad after v0.6.4 unblocked his Rumen install. The Rumen Edge Function deploys and runs, but the manual POST test returns 500 and every subsequent `pg_cron` tick fails inside `extract.ts` at `SELECT m.source_session_id ... FROM memory_items m GROUP BY m.source_session_id`.
- Root cause: schema drift between the published Mnestra migration set and Rumen's runtime contract. The `source_session_id TEXT` column on `memory_items` existed in the original `rag-system` schema (and is still present on stores that were upgraded from rag-system → Engram → Mnestra), but was dropped from the published Mnestra migrations during the rebrand. Rumen v0.4.x's Extract phase depends on it. Fresh installs of TermDeck → Mnestra got a schema that worked for TermDeck/Flashback but couldn't host Rumen.
- Fix: new bundled migration `007_add_source_session_id.sql` adds the column back as `TEXT`, idempotent (`ADD COLUMN IF NOT EXISTS`), with a partial index on `WHERE source_session_id IS NOT NULL`. Mirrored to the Mnestra source repo's `migrations/` directory so direct `@jhizzard/mnestra` installers also pick it up. NULL on every existing row is the correct default — old memories were never tagged with a session, and Rumen's `WHERE source_session_id IS NOT NULL` filter excludes them naturally.
- The migration loader at `packages/server/src/setup/migrations.js` already globs `*.sql` from `mnestra-migrations/` and applies in lexical order, so the new file is picked up automatically — no code changes needed.

### Notes
- **Recovery path for anyone affected (e.g. Brad):** `npm cache clean --force && npm i -g @jhizzard/termdeck@latest && termdeck init --mnestra --yes`. The `--yes` flag reuses saved secrets, the wizard re-applies all 7 migrations idempotently, the new column lands, and the next pg_cron tick (within 15 min) will succeed against memory_items. No Edge Function redeploy required — the failure is at query time, not deploy time.
- This is the **migration drift between layers** problem Codex flagged in the 2026-04-25 audit. Sprint-32's "schema_migrations tracking table" candidate (deferred from v0.6.3 live test) becomes more important after this incident — currently every fresh install re-runs all 7 migrations, which works because they're all idempotent, but a `schema_migrations` table would make this auditable.
- Stack-installer audit-trail bumped 0.2.3 → 0.2.4. Mnestra source repo also bumped 0.2.1 → 0.2.2 to ship the migration in published `@jhizzard/mnestra` for direct installers.

## [0.6.4] - 2026-04-26

### Fixed
- **`termdeck init --rumen` failing with raw "Access token not provided" stderr from `supabase link`.** Brad reported on 2026-04-26 00:25 UTC after v0.6.3 unblocked `init --mnestra`: the Supabase CLI's actionable suggestion is *"run supabase login or set SUPABASE_ACCESS_TOKEN"*, but `supabase login` opens a browser, which doesn't work on MobaXterm SSH or any headless install. The wizard previously dumped that message verbatim and exited. Now `link()` in `packages/cli/src/init-rumen.js` detects the access-token-missing signature and prints a path-aware hint with the Supabase dashboard URL (`https://supabase.com/dashboard/account/tokens`) plus the exact `export SUPABASE_ACCESS_TOKEN=sbp_...` command and a re-run instruction. Detection lives in the small `looksLikeMissingAccessToken(stderr)` helper (anchored on the literal phrase plus the env-var name so future Supabase CLI rewordings still match).
- New `tests/init-rumen-access-token.test.js` (4 cases): real-stderr match, env-var-name fallback match, no false positives on unrelated link errors, and a content lock on the printed hint (dashboard URL + `export sbp_` shape + retry command).

### Added
- **`termdeck init --mnestra --from-env`** — skip every `askSecret` prompt and read all five secrets from `process.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). Defensive bypass for any terminal that fights with our raw-mode secret prompt and a clean primitive for CI / one-shot installers. Strict by design — missing or malformed env vars exit 2 with an actionable error including the corrected invocation. Anthropic remains optional. The persist-first guarantee from v0.6.3 still applies: secrets land on disk before any pg work.
- New flag entries in `--help` and the head-of-file docstring at `packages/cli/src/init-mnestra.js`. 3 new tests in `tests/init-mnestra-resume.test.js` covering successful skip-prompts path, missing-env-var error path, and shape-validation rejection. Test harness now strips inherited Mnestra/Supabase env vars from spawned children so host credentials cannot leak.

### Notes
- All 10 net-new tests in this release pass. v0.6.3's resume-path tests still pass — no regressions in the `--yes` / `--reset` surface.
- Brad's fourth incident is fully closed by v0.6.3 + this hint. He cleared his npm cache (was running v0.6.0 the whole time despite earlier installs), upgraded to v0.6.3, and Mnestra applied cleanly end-to-end against project `rrzkceirgciiqgeefvbe`. The Rumen blocker that surfaced next is what v0.6.4 addresses.
- `@jhizzard/termdeck-stack` audit-trail bumped 0.2.2 → 0.2.3 (no installer behavior change; npx always pulls `@jhizzard/termdeck@latest`).

## [0.6.3] - 2026-04-25

### Fixed
- **`termdeck init --mnestra` discarding the user's typed-in DATABASE_URL when the Postgres connection or migration step failed — fourth report from Brad after v0.6.2.** v0.6.2 dropped the post-key confirm gate and the wizard ran cleanly past the Anthropic prompt, but if the subsequent `pgRunner.connect`, `checkExistingStore`, or `applyMigrations` step threw, the wizard exited before `writeLocalConfig()` ever ran — so `~/.termdeck/secrets.env` was never updated and the user had to retype every secret on the next attempt. Brad's exact words: *"It's killing before writing the file. Postgrep line not added to my existing file, so it wasn't changed."*
- The fix splits the file writes into two passes: (1) `writeSecretsFile()` runs immediately after `collectInputs()` returns, before any pg work — `secrets.env` lands on disk regardless of what the database does; (2) `writeYamlConfig()` (which flips `rag.enabled: true`) runs only after migrations apply cleanly, so the server can never come up against a half-applied schema.
- Added a resume path: `collectInputs()` now reads `~/.termdeck/secrets.env` at start and, if a complete set of required keys is present, offers *"Found saved secrets … Reuse?"*. With `--yes` the wizard skips the prompt and proceeds straight to the database step. With `--reset` the wizard ignores saved secrets and re-prompts from scratch. Both flags answer Brad's 17:50 ET question *"If it got that far did it write the correct secret.env? If so, can I manually do the next steps?"*
- On any pg-side failure the wizard now prints the resume hint: `termdeck init --mnestra --yes`.
- New `tests/init-mnestra-resume.test.js` (3 cases): persist-first under pg failure, `--yes` skips prompts when saved secrets are complete, `--reset` re-prompts and overwrites.

### Notes
- Reported by Brad on 2026-04-25 (fourth occurrence — first three drove v0.6.1 and v0.6.2). No retype required on existing partial installs: rerun `npx @jhizzard/termdeck-stack` (or `npm i -g @jhizzard/termdeck@latest`), then `termdeck init --mnestra --yes` will pick up the saved keys.
- `@jhizzard/termdeck-stack` does not need a republish — it always installs `@jhizzard/termdeck@latest`. An audit-trail bump to `@jhizzard/termdeck-stack@0.2.2` follows in `packages/stack-installer/CHANGELOG.md` to validate against this release.

## [0.6.2] - 2026-04-25

### Fixed
- **`termdeck init --mnestra` cancelling after the Anthropic API key prompt — third report from Brad after v0.6.1.** v0.6.1 hardened `askSecret` against CRLF leaks, ANSI escape pollution, and hard-SIGINT-on-Ctrl-C, but the wizard still aborted on Brad's terminal because the `confirm("Proceed with setup for project X?")` gate that ran immediately after the key prompt was the consistent failure surface — leftover bytes (CRLF tail, terminal cursor reports, paste-bracketing markers) carried into the readline that powered the confirm and resolved it as a cancel before the user could answer. Removed the confirm. The user already opted in by typing `termdeck init --mnestra` and supplying every secret; Mnestra's migrations are `IF NOT EXISTS` so re-runs are idempotent; Ctrl-C still aborts cleanly. The `--yes` flag is preserved as a no-op for forward compatibility (scripts that already pass it keep working). `termdeck init --rumen`'s confirm is intentionally retained — it gates a heavier deploy step and runs before any secret prompt, so the byte-contamination surface is different there.

### Notes
- Reported by Brad on 2026-04-25 (third occurrence). Upgrade with `npm install -g @jhizzard/termdeck@latest` and the Anthropic key prompt is the last interactive step before the wizard runs.
- `@jhizzard/termdeck-stack` does **not** need a republish — it always installs `@jhizzard/termdeck@latest`, so a fresh `npx @jhizzard/termdeck-stack` picks this up. `termdeck doctor` will surface the available update on existing installs.

## [0.6.1] - 2026-04-25

### Fixed
- **`termdeck init --mnestra` aborting after the Anthropic key prompt on MobaXterm SSH and other terminals that send CRLF for Enter.** Three separate bugs in the secret-prompt raw-mode loop in `packages/server/src/setup/prompts.js`:
  1. **CRLF leak.** When the terminal delivered `\r\n` as a single chunk (Windows / MobaXterm Enter), the loop matched the `\r`, resolved, and dropped the rest. The trailing `\n` then surfaced through the next prompt's stream and slipped through to the confirm() that follows the Anthropic prompt. With unfortunate timing the chunk also contained `` from a stray keystroke and the original SIGINT branch fired, killing the wizard mid-flow. Now: CRLF is drained inside the same chunk; non-newline trailing bytes are pushed back via `stdin.unshift` so the next consumer reads cleanly.
  2. **ANSI escape pollution.** Some terminals emit `[…]` sequences for non-character events (focus changes, cursor reports, paste-bracketing). The original loop fed those bytes into the password buffer and echoed `*` for each one. Now consumed silently.
  3. **Hard SIGINT during a secret prompt** is now a soft cancel — return empty string, let the caller's shape validator re-prompt — instead of `process.kill`-ing the process. The hard-kill was masking the CRLF bug above and aborting the wizard from stray bytes.
- New `tests/setup-prompts.test.js` — 7 fixtures covering Unix LF, Windows CRLF, type-ahead carry-over, ANSI cursor-position-report mid-buffer, bracketed-paste markers, soft-cancel on Ctrl-C, and DEL/backspace. All pass.

### Notes
- Reported by Brad on 2026-04-25 (twice). No workaround required — upgrade with `npm install -g @jhizzard/termdeck@latest` (or rerun `npx @jhizzard/termdeck-stack`) and the wizard works on every terminal we've tested.

## [0.6.0] - 2026-04-25

### Added — Sprint 25 (Supabase MCP wizard)
- **One-click Supabase auto-fill** in the Tier 2 setup wizard. User pastes a Supabase Personal Access Token, the wizard lists their projects via `@supabase/mcp-server-supabase`, the user picks one, and the existing Sprint 23 configure+migrate flow takes it from there. Manual paste path is preserved. Three new endpoints: `POST /api/setup/supabase/{connect,projects,select}`. PAT held in a closure for the wizard's lifetime only — never persisted, never logged.
- **Yellow `[hint]` line** on startup when RAG is enabled and the Supabase MCP isn't installed: `Supabase MCP not installed — wizard auto-fill unavailable. Install with: npx @jhizzard/termdeck-stack --tier 4`. Suppressed when `~/.claude/mcp.json` already declares a `supabase` server. Tier 1 users see no output.
- **`packages/server/src/setup/supabase-mcp.js`** — bridge module that spawns `@supabase/mcp-server-supabase` as a child, JSON-RPC over stdio, timeout-protected, kills child on resolve/reject. Zero new npm deps.

### Added — Sprint 28 (update-signal mechanisms)
- **`termdeck doctor`** subcommand prints a four-package version-check table (TermDeck + Mnestra + Rumen + termdeck-stack), comparing installed vs npm latest. Exit codes 0 (all current) / 1 (updates available) / 2 (network failure). `--json` and `--no-color` flags.
- **Rate-limited startup update-check banner.** When a TermDeck update is available, exactly one yellow `[hint]` line prints on startup. Cache at `~/.termdeck/update-check.json` enforces a 24h TTL so the check never hits the registry more than once per day. Suppressed by `TERMDECK_NO_UPDATE_CHECK=1`, by non-TTY stdout, and by a fresh cache. All failures (network, cache write, parse) are swallowed — never blocks startup.
- **README "Staying current" section** + new `docs/SEMVER-POLICY.md` documenting per-package version semantics and the upgrade-risk table.

### Notes
- v0.5.1 was queued (start.sh silent-exit fix) but folded into v0.6.0 — the fix is included.
- This is a minor bump because two new feature surfaces ship together: the Supabase MCP wizard auto-fill (Sprint 25) and the doctor + update-check signals (Sprint 28). No breaking changes for users on v0.5.x.

## [0.5.1] - 2026-04-25

### Fixed
- **`scripts/start.sh` silent exit** — running the repo-clone launcher under v0.5.0 dropped users back to the shell after printing two "Stack Launcher" banners. Root cause: the v0.5.0 CLI auto-orchestrate detection routed back into `stack.js`, whose `execTermDeck` then `require()`-d the already-cached `index.js` and the server never started. Fix is two-part: (1) `stack.js` now spawns a fresh node process for the CLI (avoids the require-cache trap) and passes `--no-stack` so the inner CLI definitively skips re-detection; (2) `scripts/start.sh` itself now passes `--no-stack` to the CLI to eliminate the duplicate Stack Launcher banner. Auto-orchestrate behavior on plain `termdeck` (no script) is unchanged.

## [0.5.0] - 2026-04-25

### Changed
- **`termdeck` (no subcommand) auto-orchestrates the stack** when a configured stack is detected (`~/.termdeck/secrets.env` present AND (`mnestra.autoStart: true` OR `rag.enabled: true`)). Otherwise behavior is unchanged from v0.4.6 — Tier-1-only boot. This eliminates the discovery friction of `termdeck stack` for returning users while keeping a friction-free path for first-run testers.
- Added `--no-stack` flag to force a Tier-1-only boot regardless of detection.
- `termdeck stack` retained as an explicit-force alias — v0.4.6 docs and muscle memory keep working.

### Added
- 13 new tests under `tests/cli-stack-detection.test.js` (8 detection cases) and `tests/cli-default-routing.test.js` (5 dispatch cases) — covers the v0.4.5 → v0.5.0 upgrade-path silence guarantee for unconfigured users.
- README + `docs/GETTING-STARTED.md` reflect the new default behavior.

### Notes
- No new fields required in `config.yaml`. Detection reads existing `mnestra.autoStart` / `rag.enabled` keys.
- Users who upgrade from v0.4.5 with no `secrets.env` see no behavioral change.

## [0.4.6] - 2026-04-25

### Added
- **`termdeck stack` subcommand**: Node port of `scripts/start.sh` that ships in the npm tarball. Boots Mnestra (when installed and `mnestra.autoStart: true`), checks Rumen via `DATABASE_URL`, and starts TermDeck — same numbered four-step output as the bash launcher. Cross-platform (no bash dependency). Closes the gap surfaced when a tester `npm install`-ed TermDeck and discovered `scripts/start.sh` wasn't in the published package.
- `--no-mnestra` flag on `termdeck stack` for Tier-1-only stack runs.
- README "Alternative install paths" entry pointing at the new subcommand.

### Notes
- `scripts/start.sh` continues to work for repo clones — unchanged. The new subcommand is a parallel path, not a replacement.

## [0.4.5] - 2026-04-19

### Added
- **Responsive layouts**: media queries for 13" laptops through 27" iMacs, min panel dimensions, toolbar compaction on small screens, resize debounce on fitAll
- **Setup wizard writes config**: user pastes Supabase credentials in the browser wizard, wizard validates + saves secrets.env + config.yaml + runs all 7 migrations automatically
- **Welcome-back flow**: returning users see a brief status toast, not the full wizard
- **Orchestrator layout v2**: 2x2 workers TOP + full-width orchestrator BOTTOM (equal thirds). JS-driven column count handles 1-5 panels.
- **Bulletproof start.sh**: numbered step-by-step output, smart Mnestra handling (kill/restart if 0 memories), first-run config creation
- **Rumen re-kickstart**: 166 insights generated with hybrid embeddings, 44 PVB-specific (up from 13). Cross-project pattern discovery confirmed working.

### Fixed
- **CI lint failures**: docs-lint job now handles clean checkouts without synced docs-site content
- **Flashback resurrection**: root cause found — `queryDirect` sent `recency_weight`/`decay_days` to an 8-argument SQL function. Removed the extra args. Flashback now fires end-to-end (verified: error → analyzer → Mnestra query → toast). Silent for 15 sprints due to this bug.
- **Data quality cleanup**: 145 sub-0.10 confidence noise insights deleted, all "chopin-nashville" project tags fixed to real config.yaml names (termdeck, scheduling, claimguard)

### Added
- **SkillForge foundation** (Tier 5): `termdeck forge` CLI command reads memory count from Mnestra and projects Opus cost. 4-phase prompt template (quality audit → pattern extraction → skill generation → self-critique). Skill installer writes .md files to `~/.claude/skills/`. Actual Opus call stubbed for v0.5.
- **Orchestrator layout fix**: explicit 4-row grid (fixes `grid-row: 1/-1` failure with auto rows)
- **Setup wizard**: click "config" to see 4-tier status (green/amber/gray), next-step commands, and a re-check button. Auto-opens on first run.
- **GET /api/setup**: tier detection endpoint returning config state and firstRun flag
- **First-run detection**: CLI prints setup hint when no config.yaml exists
- **Orchestrator layout**: new "orch" preset — 1 large panel (60% left) + stacked workers (40% right). Keyboard shortcut: Cmd/Ctrl+Shift+7
- **Session ID in panel headers**: first 8 chars visible at a glance for orchestration workflows
- **Mnestra auto-start**: `mnestra.autoStart: true` in config.yaml makes start.sh boot Mnestra automatically. Detects already-running instances.
- **Protocol-aware WebSocket**: auto-detects `ws://` vs `wss://` based on page protocol (enables HTTPS deployment)
- **TranscriptWriter pool TTL retry**: 30s cooldown matching getRumenPool pattern (was permanent failure)
- **RAG circuit breaker half-open**: retries after 5 minutes instead of staying permanently open

### Changed
- `actions/checkout` v4→v6 in CI workflow
- `uuid` 9→13 (named export `{ v4 }` verified)
- Contradictions #6 marked resolved (engram/ directory no longer exists)
- RAG telemetry push disabled by default (Mnestra + Rumen handle memory independently; engram_* tables were never created)

## [0.3.8] - 2026-04-17

### Added
- **Flashback modal**: clicking a Flashback toast now opens a proper centered modal with content, project tag, similarity score, and feedback buttons (previously opened buried drawer tab)
- **Project name resolution**: sessions and insights use config.yaml project names instead of directory path segments (fixes "chopin-nashville" appearing everywhere)
- **Insight confidence filter**: `GET /api/rumen/insights` accepts `?minConfidence=0.15` (default) to filter low-quality noise
- **Insight quality guide**: `docs/INSIGHT-QUALITY.md` with confidence score interpretation and tuning recommendations
- **`scripts/bump-version.sh`**: one-command version bump across package.json + all active docs

### Fixed
- **CLI banner right border**: dynamic version string now centers correctly in the ASCII box
- **Error detection false positive**: clean PTY exits (code 0) no longer persist "Error detected in output" status. Claude Code sessions use stricter line-start error matching to avoid flagging grep results and tool output
- **CLI bind guardrail bypass**: guard now enforced in the CLI entrypoint, not just the direct server path
- **Health badge false-green**: shows all checks when DATABASE_URL is configured, regardless of pass/fail

## [0.3.6] - 2026-04-16

### Added
- **`0.0.0.0` bind guardrail**: server refuses to start on a non-loopback host unless `auth.token` (or `TERMDECK_AUTH_TOKEN`) is configured; exits with `[security]` lines pointing to both configuration paths
- **Flashback end-to-end test** (`tests/flashback-e2e.test.js`): exercises `input → PTY error → analyzer → rag_events → mnestra-bridge` against a live server, observes via `rag_events` (write-once, race-free) rather than transient `meta.status`, skips gracefully when server or Mnestra are unavailable
- **Failure-injection test suite** (`tests/failure-injection.test.js`): 5 scenarios — Mnestra unreachable, component-failure isolation, PTY crash recovery, rapid create/destroy leak check, `/api/health` latency budget
- **`scripts/verify-release.sh`**: seven pre-publish checks (version alignment, working tree clean, `node -c` parse, `lint-docs.sh`, test suite, bin shebang, `files[]` coverage) with aggregated exit status
- `RELEASE_CHECKLIST.md`: rewritten as a TermDeck-only playbook that delegates mechanical checks to `verify-release.sh`

### Fixed
- `DEPLOYMENT.md` Binding section: previous wording was directionally correct but under-specified; now documents the exact `[security]` exit behavior, both config paths, and the three allowed loopback hosts (`127.0.0.1`, `localhost`, `::1`)

## [0.3.4] - 2026-04-16

### Added
- **Two-row toolbar layout**: replaces the horizontal-scroll toolbar; every button visible without scrolling
- **Optional token auth** (`packages/server/src/auth.js`): `Authorization: Bearer`, `?token=` query, and `termdeck_token=` cookie. Token source is `config.auth.token` OR `TERMDECK_AUTH_TOKEN`; unset = zero behavior change for local users
- **`docs/SECURITY.md`**: threat model, default posture, auth mechanics, secrets handling, transcript data hygiene
- **`docs/DEPLOYMENT.md`**: pre-exposure checklist, nginx/caddy reverse-proxy configs with 3600s WebSocket timeouts, systemd unit skeleton

### Changed
- **Status and Config buttons wired**: previously stubs; now open the status drawer and config viewer
- Removed the dead RAG indicator from the toolbar (never surfaced real state)
- `start.sh`: Node 18+ check, transcript-migration check, MCP hint, `--port` flag, stack summary on boot

## [0.3.3] - 2026-04-16

### Added
- **Contract tests** for `/api/health`, `/api/rumen/*`, and the transcript API (recent/search/replay shapes)

### Fixed
- Preflight Mnestra probe hits `/healthz` (not `/health`); resolves false-red health badge when Mnestra ≥0.2.0 is running correctly
- Toolbar overflow: tighter spacing, `overflow-x: auto`, `flex-shrink` on right section (stopgap before the 0.3.4 two-row redesign)
- `getRumenPool`: 30-second TTL retry after a transient failure, replacing the permanent per-process failure flag

### Changed
- `docs/GETTING-STARTED.md`: split `npx` vs. `clone` install paths

## [0.3.2] - 2026-04-16

### Fixed
- **RAG outbox data-loss bug**: rows were deleted before Supabase ack; writes now flushed durably
- **Transcript API contract**: request/response shape aligned with client expectations
- **Health badge**: tier-aware rendering; no longer reports false-green when Mnestra is offline
- Preflight Mnestra check: hits `/healthz` (not `/health`) and parses `store.rows`

### Changed
- Removed personal names from docs; bumped internal version refs to 0.3.2

## [0.3.1] - 2026-04-16

### Added
- **Preflight health check**: 6 parallel checks at startup (Node, ports, config, Mnestra, Rumen, Supabase)
- **Session transcripts**: schema + writer module; transcripts wired into server and surfaced via recovery UI
- **Health badge** in top bar with tier-aware display
- GETTING-STARTED.md: tier-aware guide (Tiers 1-4) with CLAUDE.md specifics and stop markers
- Tester brief: DM template + 5-step checklist for pre-launch feedback

### Fixed
- Transcript buffer cap
- RAG telemetry re-enabled with per-table 404 circuit breaker
- CI lint: bare catch blocks

## [0.3.0] - 2026-04-15

### Added
- **Rumen insights API**: async learning layer integration (Extract → Relate → Synthesize → Surface)
- **Vector embeddings** for hybrid recall across memory store
- **Client split**: `public/index.html` split into `index.html` + `style.css` + `app.js`
- **Launch collateral**: Show HN, Twitter, LinkedIn, dev.to drafts
- **Hero GIF** re-shot post-Rumen integration
- Supabase Edge Function + trigger script for Rumen
- RUMEN-UNBLOCK runbook
- `init-rumen` forwards `OPENAI_API_KEY`; migration self-heals

### Changed
- Flashback decoupled from `rag.enabled` — works standalone against Mnestra
- README rewritten with Flashback-first pitch and three-tier stack diagram

## [0.2.5] - 2026-04-15

### Added
- External audit remediation: test suite, PATCH field whitelist, hardened port regex

## [0.2.4] - 2026-04-14

### Added
- Hero GIF wired into README
- Flashback demo GIF and post-rename stills
- Tier 2 verification log

### Changed
- Sprint 3 launch materials + T1 docs sweep

## [0.2.3] - 2026-04-14

### Fixed
- Broken `termdeck init --mnestra` dispatch in 0.2.2

### Changed
- `init-engram.js` → `init-mnestra.js`
- `setup/engram-migrations/` → `setup/mnestra-migrations/`
- Stripped lingering Ingram refs (mid-session pivot residue)

## [0.2.2] - 2026-04-14

### Changed
- **Rename: Engram → Mnestra** (Ingram rejected via Ingram Industries sponsor conflict)
- Flashback toast header renders "Mnestra — possible match"
- Docs, setup wizard default package name updated
- `engram-bridge/` → `mnestra-bridge/`

### Added
- 4+1 orchestration blog post + X thread documenting the meta-moment where Flashback surfaced its own rename research mid-crisis

## [0.2.1] - 2026-04-14

### Added
- Help button links to live docs at `termdeck-docs.vercel.app`
- docs-site Vercel deploy config

## [0.2.0] - 2026-04-14

### Added
- **npm publishing**: flatten to root `@jhizzard/termdeck` with bundled server+client+config
- **Onboarding tour**: 13-step spotlight walkthrough, first-run auto-trigger, keyboard nav
- **Add-project modal** for adding projects from the UI
- **Engram bridge** (direct/webhook/mcp) — memory MCP integration (later renamed Mnestra in 0.2.2)
- **Proactive error events** surfaced as Flashback toasts
- **Session logger** and `POST /api/sessions/:id/input` for agent replies
- **INSTALL guide** and ship checklist
- Panel info tabs, switcher overlay, reply form, first-run empty state
- Alt-key handling via `e.code`, persistent launch buttons, panel indices
- dotenv secrets refactor; `@homebridge/node-pty` prebuilds
- Codespaces devcontainer; port 3000 silent auto-forward
- AI query scoped to project with `all:` prefix for cross-project search

### Changed
- Hoist runtime deps; mark CLI workspace pkg private
- Shell spawn fix (respect `SHELL` env var)
- zsh is the default shell
- Banner padding; session-logs fix

### Fixed
- Duplicate WebSocket on session create (claim `state.sessions` slot at entry)
- Disabled racy `status_broadcast` + 3s-poller auto-`createTerminalPanel` paths
- Respect `rag.enabled=false` — stop 404 push spam
- Codespaces: detect `CODESPACES` env var, skip auto-open

## [0.1.1] - 2026-04-11

### Added
- Hero screenshot and 30-second demo GIF in README
- `CONTRIBUTORS.md` documenting Joshua Izzard as sole author
- 4 reference docs in `docs/`: Rumen architecture plan, Rumen deploy checklist, Podium-derived lessons, cross-project analysis methodology
- Promotion drafts for v0.1 launch (Show HN, tweet thread, dev.to article, Reddit posts)

### Changed
- All 12 silent `catch {}` blocks replaced with `[tag]`-prefixed `console.error` calls. The 2 intentional require() fallbacks at module load are preserved.
- Established `[tag]` logging convention: `[pty]`, `[ws]`, `[db]`, `[rag]`, `[config]`, `[cli]`, `[client]`
- Tight loops (fitAll, 3-second session poll) use rate-limited one-shot warnings to avoid console spam

## [0.1.0] - 2026-03-19

### Added
- **Core PTY + WebSocket loop**: real PTY terminals via node-pty, one WebSocket per session, xterm.js client
- **6 grid layouts** (1x1, 2x1, 2x2, 3x2, 2x4, 4x2) plus focus and half modes
- **Output analyzer**: detects Claude Code, Gemini CLI, Python servers, plain shells; extracts status, ports, request counts, last commands
- **8 curated terminal themes**: Tokyo Night, Rosé Pine Dawn, Catppuccin Mocha, GitHub Light, Dracula, Solarized Dark, Nord, Gruvbox Dark
- **SQLite persistence** for sessions, commands, and RAG events
- **Project-aware launcher**: `~/.termdeck/config.yaml` defines projects with auto-cd and default themes
- **macOS .app launcher** (no terminal needed to start)
- **Windows installer** with Start Menu and Desktop shortcuts
- **WebSocket auto-reconnect** with exponential backoff
- **Status broadcast** every 2 seconds for live metadata updates
- **Keyboard shortcuts**: Ctrl+Shift+N for prompt bar, Ctrl+Shift+1-6 for layouts, Ctrl+Shift+]/[ to cycle terminals, Escape to exit focus

[Unreleased]: https://github.com/jhizzard/termdeck/compare/v0.7.2...HEAD
[0.7.2]: https://github.com/jhizzard/termdeck/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/jhizzard/termdeck/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/jhizzard/termdeck/compare/v0.6.9...v0.7.0
[0.4.5]: https://github.com/jhizzard/termdeck/compare/v0.3.4...v0.4.5
[0.3.4]: https://github.com/jhizzard/termdeck/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jhizzard/termdeck/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jhizzard/termdeck/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jhizzard/termdeck/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jhizzard/termdeck/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/jhizzard/termdeck/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jhizzard/termdeck/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jhizzard/termdeck/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jhizzard/termdeck/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jhizzard/termdeck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jhizzard/termdeck/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/jhizzard/termdeck/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jhizzard/termdeck/releases/tag/v0.1.0

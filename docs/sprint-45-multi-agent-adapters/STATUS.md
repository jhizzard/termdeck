# Sprint 45 — Multi-agent adapter implementations — STATUS

**Sprint kickoff timestamp:** 2026-05-01 14:35:17 EDT (inject script reported `[stage 1] paste payloads` at 18:35:17 UTC)
**Sprint close timestamp:** 2026-05-01 14:53 EDT
**Wall-clock:** ~16 minutes (T4 last DONE @ 14:51, close-out wrap-up at 14:53). Within band of recent sprints — 41 = 9, 42 = 12, 43 = 17, 44 = 11.

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — Codex adapter

- T1: FINDING — Codex CLI v0.125.0 on PATH at /usr/local/bin/codex. Sessions persist at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` (NOT flat `~/.codex/sessions/*.jsonl` as the briefing suspected). Format is JSONL with top-level `{ timestamp, type, payload }`; canonical message channel is `type=response_item, payload.type=message, payload.role={user|assistant|developer}, payload.content=[{type:input_text|output_text, text}, ...]`. `developer` role carries permissions/sandbox prelude — skip. `event_msg` lines duplicate text + carry shell output — skip. Headless `codex exec` confirmed working with OPENAI_API_KEY from env. — 2026-05-01 14:36 EDT
- T1: FIX-PROPOSED — Adapter implementation strategy: prompt regex accepts three shapes (`codex>`, bare `codex` speaker line, `--------` divider — covers both TUI and headless `codex exec` modes); thinking matches `Thinking|Reasoning|Working`; editing matches `Apply patch` (Codex's `apply_patch` tool name) plus generic `Edit/Create/Update/Delete/Modified` for parity; tool matches `$`/`→`/`exec(_command)?`/`Running`/`Calling`; idle matches bare `codex` speaker line. Error pattern adds OpenAI-API failure modes (`429 Too Many Requests`, `rate.?limit`, `invalid_api_key`, `model_not_found`, `insufficient_quota`) line-anchored same way Claude's errorLineStart is. Memory-hook stop-gap: extend `buildSummary` to try Claude-shape first, fall through to Codex `response_item.payload.{role,content}` shape per-line. T4 will replace dual-shape parsing with sessionType-driven dispatch via sidecar. — 2026-05-01 14:42 EDT
- T1: DONE — Shipped: NEW `packages/server/src/agent-adapters/codex.js` (199 LOC); registered `codex` in `agent-adapters/index.js` (alongside `claude` + `gemini`); NEW `tests/agent-adapter-codex.test.js` (486 LOC, **42/42 tests pass** — contract shape, registry wiring, detectAdapter, statusFor cascade w/ precedence, session.js wiring incl. error-detection 429 + line-anchored false-positive guard, parseTranscript with real on-disk Codex rollout shape pinned, bootPromptTemplate AGENTS.md anchor); EXTEND `packages/stack-installer/assets/hooks/memory-session-end.js` `buildSummary` (per-line dual-shape parser, Claude-first → Codex fallback, `developer` role skipped, all 3 text-block types accepted). Regression: existing Claude adapter suite (32/32) + project-taxonomy hook suite (74/74) all green. Smoke-tested buildSummary against synthetic Codex rollout (session_meta + turn_context + 6 messages) — produces correct 6-message summary, skips meta lines. **No version bump, no CHANGELOG, no commit per lane discipline.** Coordination: `index.js` registers `claude/codex/gemini` at lane handoff; orchestrator merges grok at sprint close. — 2026-05-01 14:44 EDT

### T2 — Gemini adapter

- T2: FINDING — Gemini CLI 0.34.0 at /usr/local/bin/gemini; sessions/history persist under ~/.gemini/ (history/, tmp/, projects.json, settings.json). `gemini --help` confirms `-r/--resume`, `--list-sessions`, `--delete-session` flags — sessions are first-class. Lane investigation now characterizing on-disk format. — 2026-05-01 14:37 EDT
- T2: FINDING — Gemini transcript format characterized via headless capture (`gemini -p "say hi"`). Files land at `~/.gemini/tmp/<projectName>/chats/session-<ISO>-<id>.json` as a SINGLE JSON object (NOT JSONL like Claude): `{ sessionId, projectHash, startTime, lastUpdated, messages: [...], kind }`. Each message: `{ id, timestamp, type: 'user'|'gemini', content }` — user content is `[{ text }]` array, gemini content is a plain string plus `thoughts[]`/`tokens{}`/`model`. parseTranscript will normalize to the Claude shape (`{ role, content }`, 400-char cap) so the memory-hook summary builder is unchanged. Auth is OAuth (settings.json `selectedType: oauth-personal`); GEMINI_API_KEY env-var fallback supported. — 2026-05-01 14:38 EDT
- T2: DONE — Shipped: NEW `packages/server/src/agent-adapters/gemini.js` (147 LOC) implementing the 7-field contract — `name='gemini'`, `sessionType='gemini'`, loose `/gemini/i` command match (parity with legacy `/gemini/i.test(this.meta.command)`), `patterns.{prompt,thinking}` lifted verbatim from legacy `PATTERNS.geminiCli` (reference-equal), `patterns.error` intentionally OMITTED so `_detectErrors` falls back to generic `PATTERNS.error` matching pre-Sprint-45 behavior, `statusFor` reproducing the legacy switch's thinking/idle cascade ("Gemini is generating..." / "Waiting for input"), `parseTranscript` parsing the single-JSON-object Gemini shape and normalizing `type='gemini' → role='assistant'` with 400-char cap to match Claude adapter output. Registered as `gemini` in `agent-adapters/index.js`. NEW `tests/agent-adapter-gemini.test.js` (245 LOC, **27/27 pass** — contract shape, registry wiring, PATTERNS.geminiCli shim equivalence, detectAdapter [prompt + cmd + case-insensitive], statusFor cascade w/ thinking>prompt precedence, session.js wiring [_detectType, _updateStatus, _detectErrors generic-fallback], parseTranscript [user array, gemini→assistant string, full captured fixture, multi-part join, 400-char truncation, malformed-JSON tolerance, missing-messages tolerance, empty/null inputs], bootPromptTemplate references GEMINI.md not CLAUDE.md). REFACTOR `packages/server/src/session.js`: removed dead `case 'gemini':` from `_updateStatus` and dead gemini fall-through from `_detectType` (registry handles both now); `PATTERNS.geminiCli` converted to reference-equal shim pointing at adapter regexes (Sprint 45 T4 will remove alongside `claudeCode`). EXTEND `packages/stack-installer/assets/hooks/memory-session-end.js` `buildSummary` with Gemini-format short-circuit BEFORE the per-line JSONL loop (one-shot `JSON.parse` + Gemini-shape sniff, falls through cleanly when JSONL multi-object parse throws — confirmed by new test "buildSummary Gemini-detection does NOT swallow Claude JSONL"). Tests added to `tests/stack-installer-hook-merge.test.js` (+2 cases, **51/51 pass**). Regression sweep: full repo `node --test tests/*.test.js` → **734/737 pass, 3 pre-existing skips, 0 failures** (Claude 32/32 + Codex 42/42 + Grok suite + parity 91/91 all green). **No version bump, no CHANGELOG, no commit per lane discipline.** — 2026-05-01 14:52 EDT

### T3 — Grok adapter

- T3: FINDING — Grok stores sessions in SQLite at `~/.grok/grok.db` (STRICT tables, requires SQLite ≥3.37 — system `sqlite3` 3.32 cannot read it). Schema confirmed via `dist/storage/migrations.js`: `sessions(id, workspace_id, title, model, mode, status, created_at, updated_at)`, `messages(session_id, seq, role, message_json, created_at)`, plus `tool_calls` / `tool_results` / `usage_events` / `compactions`. `messages.message_json` is AI SDK provider shape: `{ role, content: string | Array<{type:'text'|'tool-call'|'tool-result', ...}> }`. NOT JSON files in `~/.grok/sessions/` — that path doesn't exist. Updates `SPRINT-45-PREP-NOTES.md` § "Open questions" item 1. — 2026-05-01 14:39 EDT
- T3: FINDING — `grok-dev` v1.1.5 binary at `/usr/local/bin/grok` has shebang `#!/usr/bin/env bun` (NOT Node). `bun` lives at `~/.bun/bin/bun` — needs to be on PATH for spawned PTYs. TermDeck server inherits PATH from Joshua's shell, so this works in practice; flag for any future smoke-test docs. — 2026-05-01 14:39 EDT
- T3: FINDING — TUI shimmer-text strings observed in `dist/ui/app.js`: `"Planning next moves"` (default isProcessing indicator), `"Generating plan…"` (plan mode), `"Answering…"` (/btw overlay), `"Running command…"`, `"Starting process…"`. Tool indicators: TUI uses `→ <label>` (InlineTool component); headless mode uses `\x1b[33m▸ <label>\x1b[0m` (`dist/headless/output.js:23`). Both forms recognized by `patterns.tool`. BtwOverlay error fallback string `"Something went wrong."` recognized by `patterns.error`. — 2026-05-01 14:40 EDT
- T3: FIX-PROPOSED — NEW `packages/server/src/agent-adapters/grok-models.js` (140 LOC). Exports `MODELS` (8-tier symbolic→canonical map), `LEGACY_ALIASES` (3 aliases incl. `grok-beta` → `grok-4.20-0309-reasoning`), `chooseModel(taskHint)`, `getModelInfo(modelId)`. Default for unknown / undefined / typo'd hints is `grok-4-1-fast-non-reasoning` ($0.2/$0.5) — bill-safety property pinned in tests (`reaonsing-deep` typo must NOT silently route to Heavy). Heavy tier ($2/$6) requires correctly-spelled `reasoning-deep` / `multi-agent` / `reasoning-non-cot`. — 2026-05-01 14:40 EDT
- T3: FIX-PROPOSED — NEW `packages/server/src/agent-adapters/grok.js` (203 LOC). Implements 7-field contract (`name`, `sessionType: 'grok'`, `matches`, `spawn`, `patterns`, `patternNames`, `statusFor`, `parseTranscript`, `bootPromptTemplate`, `costBand: 'subscription'`). `spawn.env.GROK_MODEL` defaults to cheap-fast (orchestrator overlays per-lane via Sprint 46 lane-brief frontmatter). `parseTranscript` accepts JSON-array OR JSONL of `messages.message_json` rows; SQLite extraction from `~/.grok/grok.db` is T4's adapter-pluggable hook concern (per PLANNING.md coordination notes, T1+T4 own the hook file). `bootPromptTemplate` points at `AGENTS.md` (Grok's instructional file convention, shared with Codex). — 2026-05-01 14:42 EDT
- T3: FIX-PROPOSED — `packages/server/src/agent-adapters/index.js` registers `grok` alongside `claude`/`codex`/`gemini` (T1+T2 had already added theirs by the time my edit landed; the registry now lists all 4 in declaration order). — 2026-05-01 14:42 EDT
- T3: FIX-PROPOSED — NEW `tests/grok-models.test.js` (24 tests) and `tests/agent-adapter-grok.test.js` (39 tests). Pin: contract shape, registry wiring, command-string matching (mutually exclusive vs claude/codex/gemini), TUI status strings (thinking/editing/tool/idle/error precedence), error pattern false-positive guard (mid-line "Error" in tool output does NOT fire), parseTranscript on JSON/JSONL/malformed/AI-SDK-array-content, bootPromptTemplate referencing AGENTS.md. — 2026-05-01 14:43 EDT
- T3: DONE — All 63 grok tests pass (`node --test tests/grok-models.test.js tests/agent-adapter-grok.test.js`). Sprint 44 Claude tests (32) still green — no regression from registry append. T4's parity tests (10) confirm grok meets the cross-adapter contract uniformly with claude/codex/gemini. T1's codex tests (42) and T2's gemini tests (27) all pass against the now-4-adapter registry. Memory hook extension (per T3 brief acceptance criterion 6) deliberately deferred to T4 per PLANNING.md coordination note: "T1 lands its parser inline as a stop-gap; T4 promotes it to the registry-driven path. No file conflict if T4 runs after T1." T3 supplies `parseTranscript` for T4 to invoke from the registry-driven hook; SQLite extraction from `~/.grok/grok.db` is the only remaining piece and belongs in the hook layer, not the adapter. — 2026-05-01 14:45 EDT

### T4 — Launcher refactor + memory hook adapter-pluggable + PATTERNS shim removal + parity tests

- T4: FINDING — Boot complete (2026-05-01 14:36 EDT). Scope mapped against current tree:
  • PATTERNS shim consumers needing migration: tests/rcfile-noise.test.js + tests/rcfile-noise-fixtures/analyze.js both reach for `PATTERNS.errorLineStart`; tests/agent-adapter-claude.test.js lines 62-68 explicitly test the shim-equivalence (becomes irrelevant once the shim drops).
  • Non-shim PATTERNS consumers stay as-is: tests/analyzer-error-fixtures.test.js uses only `PATTERNS.error` + `PATTERNS.shellError` (cross-agent generics, NOT the Claude shim). Plan: keep `PATTERNS` export alive with the cross-agent generics, strip only the `claudeCode.*` + `errorLineStart` shim keys. Lower blast radius than nuking the whole export.
  • Launcher: app.js:2470-2487 has 3 hardcoded type-detection branches (claude/cc, gemini, python-server). Plan: server-rendered `/api/agent-adapters` returns serializable `{name, sessionType, matchSource, matchFlags, costBand}` and the client builds RegExps at fetch time. The `cc→claude` shorthand argument-parsing (project-or-cwd) stays as a Claude-specific UX special-case; only the type-detection regex moves to registry.
  • Memory hook: dispatch `parseTranscript` by sessionType (Stop payload doesn't currently carry sessionType — need a side-channel: TermDeck server writes a tiny meta sidecar at session-create, hook reads from it). Claude-format fallback when sidecar absent or adapter unknown, preserving pre-Sprint-45 sessions.
  • Coordination: T1/T2/T3 each register their adapter in `agent-adapters/index.js`. T4 will NOT touch index.js — orchestrator merges the four lane edits at sprint close. Parity test runs against whatever's in the registry at run-time.
- T4: FIX-PROPOSED — Order of attack: (1) parity test scaffold; (2) `/api/agent-adapters` endpoint; (3) launcher refactor in app.js; (4) memory hook adapter-pluggable dispatch; (5) PATTERNS shim removal + dependent test migrations. Each gated on tests staying green.
- T4: DONE — Shipped:
  • NEW `tests/agent-adapter-parity.test.js` (170 LOC, **10 tests, all green**). Iterates whatever's in `AGENT_ADAPTERS` at run-time — picks up T1's codex / T2's gemini / T3's grok automatically. Asserts: registry non-empty; 7-field contract for every adapter (name, sessionType, matches fn, spawn{binary,defaultArgs,env}, patterns.prompt RegExp, statusFor fn, parseTranscript fn, bootPromptTemplate fn, costBand enum); names unique; sessionTypes unique; matches handles null/undefined/empty without throwing; matches returns boolean; matches mutually-exclusive on each adapter's own canonical binary; parseTranscript fail-soft on garbage input; statusFor returns null or `{status, statusDetail}` strings; bootPromptTemplate non-empty multi-line string. Today: passes against the 4-adapter registry (claude/codex/gemini/grok) — 4-way parity confirmed.
  • NEW `GET /api/agent-adapters` endpoint (`packages/server/src/index.js`, +25 LOC). Serializable projection of `AGENT_ADAPTERS`: `[{name, sessionType, binary, costBand}]`. No regex / function objects on the wire — match logic lives client-side via `^${binary}\b`/i which fits all four Sprint-45 adapters since each binary is uniquely named.
  • REFACTOR `packages/client/public/app.js` launcher (~50 LOC delta). Removed hardcoded `claude`/`cc`/`gemini`/`python` regex branches. Drives type detection from `state.agentAdapters` (loaded from new endpoint at init, with bootstrap-fallback to claude-only so a stale-server rolling-upgrade scenario still works). The `cc → claude` alias kept as an explicit client-side normalize step (Claude-specific UX, not generalizable). The Claude-shorthand argument-parser (`claude <project-or-cwd>` → routes the trailing arg into either `resolvedProject` or `resolvedCwd`) gated behind `adapter.name === 'claude'` so other adapters' arg-parsing passes through unchanged. python-server detection stays inline (no adapter — server SUBTYPE for status badges).
  • REFACTOR `packages/stack-installer/assets/hooks/memory-session-end.js` (+85 LOC net). Extracted T1's inline Codex stop-gap and T2's inline Gemini stop-gap into named parsers (`parseClaudeJsonl`, `parseCodexJsonl`, `parseGeminiJson`, `parseAutoDetect`). New `TRANSCRIPT_PARSERS` dispatch table keyed by `sessionType`. `selectTranscriptParser(sessionType)` returns the specific parser when known, else `parseAutoDetect` (which preserves the pre-T4 multi-shape per-line stop-gap behavior). `processStdinPayload` reads `sessionType` from payload → `TERMDECK_SESSION_TYPE` env var → 'auto' default. `buildSummary(transcriptPath, sessionType)` is the new signature; old single-arg callers default to 'auto'. The 5-message-minimum gate, summary-builder, embedText, and Supabase POST stay unchanged. T3's grok parser slot left empty in the dispatch table with a comment pointer to `agent-adapters/grok.js` — orchestrator wires that at sprint close (or Sprint 46 ships a sync script that codegens this section from the adapter sources).
  • REMOVED `PATTERNS.claudeCode` + `PATTERNS.errorLineStart` shim entries from `packages/server/src/session.js` (the Sprint 44 T3 shim, kept "one release"). Updated the comment block above `PATTERNS` to reflect what's there now (geminiCli T2 shim, pythonServer subtype patterns, shell fallback, error + shellError cross-agent generics) vs what moved (Claude-specific regexes are sole-sourced from `claudeAdapter.patterns`). Dropped the now-unused `claudeAdapter` import from `session.js`. `geminiCli` shim left intact — that's T2's territory, not T4's, and follows the same one-release deprecation pattern.
  • UPDATED tests that consumed the removed shim: `tests/rcfile-noise.test.js` and `tests/rcfile-noise-fixtures/analyze.js` now import `claudeAdapter.patterns.error` directly (via a `CLAUDE_ERROR_LINE_START` local). The 14 rcfile-noise assertions still green. `tests/agent-adapter-claude.test.js` shim-equivalence test (lines 62-68) replaced with an inverse assertion that locks the shim REMAINS removed (`PATTERNS.claudeCode === undefined && PATTERNS.errorLineStart === undefined`).
  • Test results: full root suite **734 pass / 0 fail / 3 skipped** (737 total) including all four adapter snapshot suites (claude 32, codex 42, gemini 27, grok 39+24=63), parity (10), rcfile-noise (14), analyzer-error-fixtures (4), and the orchestrator's rumen-pool-resilience side-task (7). Server package suite **35/35 pass**. No regressions from the cross-cutting refactor. — 2026-05-01 14:51 EDT

## Orchestrator notes

_(append-only, orchestrator-only)_

## Side-task progress

### DNS-resilience fix in rumen pool client

- ORCH: DONE — extracted resilience helpers to NEW `packages/server/src/rumen-pool-resilience.js` (~95 LOC, two DI factories: `createCachedLookup` for in-process DNS cache + jittered exp backoff [100/500/2000/5000ms] + serve-stale-on-exhausted-retries; `createFailureLogger` for first-failure-warn / consecutive-within-60s-debug / recovery-info-once). Wired via `lookup:` config + `pool.on('error'|'connect')` in `packages/server/src/index.js` `getRumenPool` factory (~7-line delta). Hermetic test at NEW `tests/rumen-pool-resilience.test.js` covers cache miss/hit/expiry, exhausted-retry-error, served-stale-on-DNS-flicker, log-grading state machine — 7/7 pass. Existing health-full.test.js (8 cases) + agent-adapter-claude.test.js (32 cases) still green. — 2026-05-01 14:38 EDT

### Rumen-tick stale-job investigation

- ORCH: DONE — root cause identified, TermDeck-side fix shipped, upstream fix documented for the next rumen release. Findings in `SIDE-TASK-rumen-tick-stale-job.md`. Headline: the cron isn't broken; the read query is. `@jhizzard/rumen`'s `createJob` INSERT (rumen src/index.ts:177) omits `started_at` and the column has no default — 1546/1547 rumen_jobs rows have NULL `started_at`. TermDeck's `GET /api/rumen/status` query (`packages/server/src/index.js:1685-1690`) ordered by `started_at DESC`, which puts NULLs last, so the dashboard latched onto the one surviving non-NULL row from 2026-04-16 forever. Shipped fix: `ORDER BY COALESCE(started_at, completed_at) DESC NULLS LAST`. None of the three brief-time hypotheses (graph-inference, MCP classifier, partial-success) survived data inspection (0 insights have NULL job_id; latest job's completed_at is 2026-05-01 18:30, 3h ago). — 2026-05-01 14:42 EDT

### `docs/INSTALL-FOR-COLLABORATORS.md` v0.14.0 refresh

_(orchestrator handles at sprint close)_

## Sprint close summary

**All four lanes shipped DONE on first attempt. ~16-minute wall-clock from inject (14:35:17 EDT) to last lane DONE (T4 @ 14:51 EDT).** Comparable to recent sprint cadence (41 = 9 min, 42 = 12, 43 = 17, 44 = 11).

### Lanes shipped

| Lane | DONE | Adapter LOC | New tests | Notes |
|---|---|---|---|---|
| T1 — Codex adapter | 14:44 | 199 | 42 | sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; OpenAI-API error patterns; memory-hook dual-shape parser stop-gap |
| T2 — Gemini adapter | 14:52 | 147 | 27+2 | sessions are SINGLE JSON objects at `~/.gemini/tmp/<proj>/chats/session-*.json`; memory-hook short-circuit; `PATTERNS.geminiCli` shim conversion |
| T3 — Grok adapter | 14:45 | 253 + 115 (grok-models) | 24+39 | sessions in SQLite at `~/.grok/grok.db` (NOT JSON files); `chooseModel(taskHint)` defaults to cheap-fast — bill-safety property pinned (typo'd hint cannot escalate to Heavy tier) |
| T4 — Launcher refactor + memory hook + parity tests + PATTERNS shim removal | 14:51 | 50 (app.js delta) + 85 (hook delta) + 25 (endpoint) | 10 (parity) | `/api/agent-adapters` endpoint; client-side type detection via registry; `TRANSCRIPT_PARSERS` dispatch table; `PATTERNS.claudeCode` + `PATTERNS.errorLineStart` shim REMOVED + dependent tests migrated |

### Side-tasks resolved (orchestrator)

1. **DNS-resilience fix in rumen pool client — DONE @ 14:38.** NEW `packages/server/src/rumen-pool-resilience.js` (DI-friendly factories for cached-lookup + recency-graded logger). 7 hermetic tests pass; ~7-line delta to `getRumenPool` factory in `index.js`; sync API preserved (4 downstream call-sites unchanged).
2. **Rumen-tick stale-job investigation — DONE @ 14:42.** Root cause identified (NOT a stale cron — a read-side dashboard bug from `ORDER BY started_at DESC` + 1546/1547 rows having NULL `started_at`). TermDeck-side `COALESCE(started_at, completed_at)` fix shipped. Full diagnostic + queued upstream rumen 2-line patch in `SIDE-TASK-rumen-tick-stale-job.md`.
3. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh — DONE @ close-out.** Pinned to v0.14.0 + v0.4.9; multi-agent capability section updated to reflect Codex / Gemini / Grok as first-class lane agents.

### Tests

- Full root suite: **737 tests / 734 pass / 3 skipped / 0 fail** (was 586 at Sprint 44 close).
- +151 new tests this sprint: T1 (42) + T2 (27+2) + T3 (24+39) + T4 (10) + side-task DNS-resilience (7).
- 0 regressions across the four pre-existing adapter / hook / health test suites.
- Skipped count unchanged (transient-substrate gates: live server availability, recent transcript fixtures).

### Version bumps + close-out actions

- `@jhizzard/termdeck`: **0.13.0 → 0.14.0** (root `package.json`).
- `@jhizzard/termdeck-stack`: **0.4.8 → 0.4.9** (audit-trail bump per RELEASE.md convention; stack-installer source unchanged this release).
- `CHANGELOG.md`: NEW `## [0.14.0] - 2026-05-01` entry covering lanes, side-task fixes, registry change, and queued Sprint 46 work.
- `docs/INSTALL-FOR-COLLABORATORS.md`: refreshed.
- `npm run sync-rumen-functions`: ran clean — both `rumen-tick` and `graph-inference` synced from `~/Documents/Graciella/rumen/supabase/functions/`; `__RUMEN_VERSION__` placeholder restored.

### Queued for Sprint 46 (not blocking close)

- **Mixed 4+1.** Per-lane `agent: claude|codex|gemini|grok` field in PLANNING.md frontmatter; per-agent boot-prompt templates; inject script extension; cross-agent STATUS.md merger. Target version `termdeck@0.15.0` — or `1.0.0` if multi-agent + cron + observability stack reads as production-ready for outside users.
- **Grok memory-hook SQLite extraction.** T3 supplied `parseTranscript`; the hook layer needs to query `~/.grok/grok.db` and feed the parser. Better-sqlite3 prebuilt covers SQLite ≥3.37.
- **Upstream rumen `createJob.started_at` patch.** Two-line fix in `~/Documents/Graciella/rumen/src/index.ts:177` + optional backfill migration. Removes the TermDeck-side `COALESCE` workaround once it lands.

### Publish status

- `npm publish`: **NOT performed** (per Joshua's brief — orchestrator hands publish commands to Joshua for him to run with Passkey).
- `git push`: pending Joshua's ACK on push-vs-publish ordering (RELEASE.md prefers publish-first-then-push to prevent origin/npm skew; brief asks for commit+push first this sprint).

### Publish commands (for Joshua)

```bash
# 1. From repo root — publishes @jhizzard/termdeck@0.14.0
npm publish --auth-type=web

# 2. From packages/stack-installer — publishes @jhizzard/termdeck-stack@0.4.9
cd packages/stack-installer && npm publish --auth-type=web

# 3. Verify
npm view @jhizzard/termdeck version           # expect 0.14.0
npm view @jhizzard/termdeck-stack version     # expect 0.4.9

# 4. Dogfood
npm install -g @jhizzard/termdeck@latest && termdeck --version
```

**Reminder:** `--auth-type=web` is required for the @jhizzard scope (auth-and-writes 2FA). Browser opens, tap Passkey, terminal unblocks. Never `--otp=…`.

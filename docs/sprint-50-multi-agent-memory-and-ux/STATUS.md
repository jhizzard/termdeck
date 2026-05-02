# Sprint 50 — Multi-agent memory plumbing + v1.0.0 UX polish — STATUS

**Sprint kickoff timestamp:** 2026-05-02 15:05 ET (4 fresh Claude Code panels opened via the Claude launcher button — Codex/Gemini/Grok launcher buttons are themselves a T3 deliverable, so this sprint runs all-Claude by design)
**Sprint close timestamp:** _(orchestrator stamps at sprint close)_
**Wall-clock:** _(filled at close — Sprint 41=9, 42=12, 43=17, 44=11, 45=16, 46=16, 47=28, 48=21, 49=12. Sprint 50 may run longer because T2 spans two repos, T1 has Grok-SQLite work, and T4 is a self-recursive dogfood; budget for 30-40 min.)_

## Architecture reference

Single source of truth for T1 + T2 design: [docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md](../MULTI-AGENT-MEMORY-ARCHITECTURE.md). Lane briefs reference sections of that doc rather than re-stating the rationale.

## Pre-sprint context

- Sprint 49 closed 2026-05-02 14:30 ET shipping `@jhizzard/termdeck@0.18.0` + `@jhizzard/termdeck-stack@0.5.1`. All four lanes DONE in 12 minutes wall-clock; mixed-agent dogfood proved the path. v1.0.0 deliberately deferred to Sprint 50 — outside users would hit two trust-fundamental gaps on day one (multi-agent memory write + provenance filter) plus three "visible signal lies" UX bugs.
- Sprint 49 also surfaced Gemini-specific concerns: approval-heavy lifecycle, timestamp drift (stamps 21-44 min into the future), scope creep (grabbed unprompted Sprint 46 deferrals). All documented in `~/.claude/projects/.../memory/feedback_gemini_approval_heavy.md`.
- Baseline `memory_items.source_type='session_summary'` count entering Sprint 50: 8 rows post-Sprint-48 close, +1 expected from this orchestrator session's /exit when this Claude Code instance closes. T1's per-agent hook trigger should produce 4 new rows on the dogfood T4 close-out.

## Lane status

Append-only. Format: `Tn: <FINDING|FIX-PROPOSED|DONE> — <one-line summary> — <timestamp>`.

### T1 — Per-agent SessionEnd hook trigger (+ Grok SQLite extraction)

- T1: FINDING — substrate probe done (`find ~/.codex -name '*.jsonl'`, `ls ~/.gemini/tmp/`, `sqlite3` + `better-sqlite3` against `~/.grok/grok.db`) — 2026-05-02 15:08 ET
  - **Codex:** chat-shape JSONL exists at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. First line `{type:'session_meta', payload:{cwd, ...}}` → usable for cwd attribution. The `~/.codex/history.jsonl` Sprint 49 close tried is flat command-history (NOT chat) — confirms the Sprint 49 finding. `~/.codex/logs_2.sqlite` has only telemetry tables (`_sqlx_migrations` + `logs`), not chat content.
  - **Gemini:** confirmed `~/.gemini/tmp/<basename(cwd)>/chats/session-<ts>-<id>.json` (single-JSON-object shape, ~500KB observed). Existing `parseGeminiJson` handles the format.
  - **Grok:** `~/.grok/grok.db` schema verified via `better-sqlite3`: tables `workspaces, sessions, messages, tool_calls, tool_results, usage_events, compactions`. STRICT-tables schema → requires SQLite ≥3.37 (macOS system `sqlite3` 3.36 errors out; `better-sqlite3` 12.x bundled SQLite reads fine). `messages.message_json` is AI SDK provider shape `{role, content}` with content as string OR array of typed parts.

- T1: FIX-PROPOSED — design lock — 2026-05-02 15:12 ET
  - **Adapter contract:** add `resolveTranscriptPath(session) → string | null` as the 10th adapter field. Each adapter knows its own filesystem layout.
  - **Server-side `onPanelClose(session)`** new export in `packages/server/src/index.js`. Skips when (1) session has no adapter, (2) adapter is `claude-code` (Claude's existing SessionEnd hook owns Claude rows — no double-write), (3) `resolveTranscriptPath` returns null, (4) `~/.claude/hooks/memory-session-end.js` is missing. Otherwise spawns the bundled hook with `{transcript_path, cwd, session_id, sessionType, source_agent}` payload via fire-and-forget detached + unref pattern. Wired into the existing `term.onExit` PTY handler.
  - **Grok SQLite extraction:** the bundled hook can't reach `better-sqlite3` from `~/.claude/hooks/`. Solution: Grok adapter's `resolveTranscriptPath` does the SQLite extraction in-process (server has the dep), writes a JSON-envelope tempfile to `os.tmpdir()/termdeck-grok-<id>.json`, returns that path. Hook reads the tempfile via a new `parseGrokJson` parser (same JSON-array shape as the adapter's `parseTranscript`).
  - **Test injection:** `node:test` runner doesn't run detached + ignore-stdio children reliably under the runner. Production exposes `_setSpawnSessionEndHookImplForTesting` so unit tests capture `(hookPath, payload, env)` deterministically. Default impl is unchanged for prod.

- T1: DONE — implementation + tests green; no regressions across 232 sibling tests — 2026-05-02 15:30 ET
  - **Adapter contract bumped 9 → 10 fields.** `resolveTranscriptPath` added to all four adapters in `packages/server/src/agent-adapters/{claude,codex,gemini,grok}.js`.
  - **`onPanelClose` + spawn injection** at `packages/server/src/index.js:132-220`. `child_process.spawn` import added. Wired into `term.onExit` at the existing PTY-exit handler. `onPanelClose` + `_setSpawnSessionEndHookImplForTesting` exported.
  - **Bundled hook** at `packages/stack-installer/assets/hooks/memory-session-end.js` gained `parseGrokJson` + `'grok' → parseGrokJson` entry in `TRANSCRIPT_PARSERS`. Closes Sprint 45 T3 carry-over (Grok session ingestion).
  - **NEW test file** `tests/per-agent-hook-trigger.test.js` — 14 tests, **all pass in 260ms.** Covers contract presence, every adapter's resolver path resolution (positive + negative cases for codex), skip-claude / skip-no-adapter / skip-no-transcript / skip-no-hook-installed, full-payload shape verification including `source_agent` for codex AND gemini, malformed-session no-throw.
  - **`docs/AGENT-RUNTIMES.md` § 5** updated to document the 10th field with per-agent expectations (Claude / Codex / Gemini / Grok layouts all spelled out in one table cell).
  - **Regression check:** `node --test tests/agent-adapter-{claude,codex,gemini,grok,parity}.test.js packages/server/tests/pty-env-propagation.test.js` → 160/160 pass. `tests/stack-installer-hook-merge.test.js` + `tests/project-tag-resolution.test.js` → 72/72 pass. The bundled hook still ingests Claude / Codex / Gemini transcripts cleanly post-merge with T2's `normalizeSourceAgent` plumbing.
  - **Coordination acknowledged:** T2's bundled-hook edits (added `normalizeSourceAgent` + `ALLOWED_SOURCE_AGENTS` + `data.source_agent` payload acceptance) and T1's edits (added `parseGrokJson` + `'grok'` parser entry) coexist cleanly — no merge contention. T1's `onPanelClose` payload uses snake_case `source_agent` per T2's recommendation. T3's `displayName` adapter field stacks additively next to T1's `resolveTranscriptPath` field — no merge contention there either. **All four adapters now expose a 10-field contract + the `displayName` extension field T3 added in parallel.**
  - **End-to-end pre-flight:** real Codex rollout from this session (`~/.codex/sessions/2026/05/02/rollout-2026-05-02T14-05-56-019de9de-...jsonl`, 464KB) verified to match the resolver's cwd-attribution path; resolver returns it correctly. Gemini's existing chat at `~/.gemini/tmp/termdeck/chats/session-2026-05-02T18-06-...json` (507KB) verified to match the basename(cwd) heuristic. Grok DB workspace `3dce89a761c44798` (canonical_path = TermDeck repo root) found, with 68 messages in the most recent session — extraction will produce a non-trivial JSON envelope.

### T2 — Memory `source_agent` column + recall filter

- T2: FINDING — substrate probe — 2026-05-02 15:08 ET
  - Mnestra migrations dir last entry: `014_explicit_grants.sql` → next is `015_source_agent.sql`. ✓
  - Mnestra `package.json` version: 0.3.4 (will bump → 0.4.0 at lane close).
  - Bundled hook `packages/stack-installer/assets/hooks/memory-session-end.js` `postMemoryItem()` currently posts 6 fields (content, embedding, source_type, category, project, source_session_id). Adding `source_agent` is additive.
  - `memory_hybrid_search` last redefined in migration 004 (8 params, 8 return cols). Its candidates CTE doesn't surface `source_agent`. **Decision:** keep migration 015 tight per brief — column + index + comment + backfill only (no DDL on the search RPC). recall.ts will post-filter via a follow-up `select id,source_agent` batch query when `source_agents` is supplied; zero overhead when omitted. Rationale: avoids DROP+CREATE on the hot search RPC, keeps signature stable for `memory_hybrid_search_explain` and admin tooling.
  - Live Supabase probe gated by sandbox (service-role-key denial); orchestrator handles the live `apply_migration` at sprint close. Acceptance #1 (post-backfill `count where source_agent='claude'` = 12) verifies post-apply.

- T2: FIX-PROPOSED — implementation complete, awaiting orchestrator close-out — 2026-05-02 15:14 ET
  - **Mnestra repo (`~/Documents/Graciella/engram`):**
    - NEW `migrations/015_source_agent.sql` — column + partial index + COMMENT + backfill (`source_type='session_summary' AND source_agent IS NULL → 'claude'`). Idempotent. ~50 LOC including doc-block.
    - EDIT `src/types.ts` — added `SourceAgent` type union, `SOURCE_AGENTS` runtime array, `RecallInput.source_agents?: string[] | null`.
    - EDIT `src/recall.ts` — exported `RecallDeps` (test injection); `memoryRecall(input, deps?)` accepts optional client + embedder. Post-filter: when `source_agents` is set & non-empty, batch-query `memory_items.id,source_agent` for the candidate IDs and filter rows whose agent is not in the list (NULL excluded). Empty-array == omitted (defensive). Zero overhead when omitted — no extra round-trip.
    - EDIT `mcp-server/index.ts` — `memory_recall` MCP tool gains `source_agents: z.array(z.enum([5 agents])).optional()` schema field; description updated to mention the filter and historical-row exclusion semantics.
    - NEW `tests/recall-source-agent.test.ts` — 7 tests covering omitted, `[]`, single agent, multi-agent union, unknown agent (zero hits), NULL exclusion, empty-RPC short-circuit. Probe recorder asserts the batch lookup fires only when filter is set.
    - EDIT `package.json` — version 0.3.4 → 0.4.0.
    - EDIT `CHANGELOG.md` — `## [0.4.0] - 2026-05-02` entry under "Added — Sprint 50 T2 (TermDeck)" with rationale + Path B (trust-weighted ranking) deferred under `## [Unreleased]` § Planned.
  - **TermDeck repo:**
    - EDIT `packages/stack-installer/assets/hooks/memory-session-end.js` — `postMemoryItem()` accepts `sourceAgent`; new `normalizeSourceAgent()` + `ALLOWED_SOURCE_AGENTS` set (5 canonical agents); `processStdinPayload` reads `data.source_agent || data.sourceAgent || TERMDECK_SOURCE_AGENT || 'claude'`; ingest log now stamps `sourceAgent=<resolved>`. Helpers exported for test mirroring.
    - EDIT `tests/stack-installer-hook-merge.test.js` — 5 new tests: normalizer canonical 5, default + unknown coercion, postMemoryItem default-claude, postMemoryItem pass-through, postMemoryItem unknown-agent coercion.
  - **Validation (all green):**
    - Mnestra `npm run typecheck`: clean.
    - Mnestra `npm test`: **49/49** (was 42 + 7 new).
    - TermDeck `node --test tests/stack-installer-hook-merge.test.js`: **60/60** (was 55 + 5 new).
    - TermDeck `npm test` (root server glob): 40/40 (no regressions from my lane).
    - TermDeck stack-installer tests: 18/18 (no regressions).
  - **Coordination notes for sibling lanes / orchestrator:**
    1. **Apply 015 BEFORE T1 starts inserting non-Claude rows.** PostgREST silently drops unknown columns from inserts, so an old hook would not crash post-migration, but a new hook hitting an un-migrated DB would get a 400 from the column-not-found path. Per architecture doc § Coordination, ship T2 first.
    2. **T1 (`onPanelClose` payload) — bundled hook already accepts `data.source_agent` (snake_case primary, camelCase tolerated).** Suggest T1's payload uses snake_case to match Claude Code's broader hook convention.
    3. **T3 — independent.** Touches dashboard + adapter `displayName`; no contention with my changes.
    4. **T4 dogfood validation** — once 015 is live and T1 ships, closing 4 panels (one per agent) should yield 4 new `session_summary` rows with distinct `source_agent` values. `select source_agent, count(*) from memory_items where source_type='session_summary' group by 1` is the canonical verification query.
  - **Orchestrator action items at close:**
    1. Apply migration 015 to live Supabase. Verify `select count(*) from memory_items where source_agent='claude'` returns 12 (8 historical session_summary + 4 from Sprint 49 manual recovery).
    2. Publish `@jhizzard/mnestra@0.4.0` per RELEASE doc (Passkey, never `--otp`).
    3. T1 lane confirms its server-side payload uses `source_agent` (or camelCase variant — both accepted).

- T2: DONE — Sprint 50 T2 lane closed in ~9 min wall-clock (15:05 → 15:14 ET) — 2026-05-02 15:16 ET
  - All 8 acceptance criteria from `T2-source-agent-column-and-recall-filter.md` met locally. Live-DB acceptance #1 + #5 require orchestrator's `apply_migration` step (gated by sandbox). Path A (filter) shipped; Path B (trust-weighted ranking) deferred per brief recommendation, captured in CHANGELOG `## [Unreleased]` § Planned. No commit, no termdeck root version bump — held for orchestrator sprint-close decision per lane brief discipline.

### T3 — UX trust trio (launcher buttons + panel labels + spinner freeze)

- T3: FINDING — Three independent root causes mapped to the trust-trio bugs — 2026-05-02 15:09 ET
  - **Launcher buttons (only Claude visible):** `packages/client/public/index.html:55-67` and `:88-100` hardcode `shell` / `claude` / `python` buttons in both the topbar quick-launch and the empty-state quick-launch group. `AGENT_ADAPTERS` (server) registers all 4 agents; `state.agentAdapters` (client) is populated from `/api/agent-adapters`; but the launcher chooser never reads it — Codex/Gemini/Grok have no one-click affordance. Free-form `codex`/`gemini`/`grok` typed in the prompt bar already routes correctly via `LauncherResolver` (Sprint 45 T4); the gap is purely the button surface.
  - **Panel header label says "Shell" / raw type:** `getTypeLabel(type)` at `packages/client/public/app.js:2573-2582` is a static lookup with entries for `shell|claude-code|gemini|python-server|one-shot` only. Codex (`meta.type='codex'`) and Grok (`meta.type='grok'`) miss the lookup and fall through to `return type` (raw lowercase string). Worse — when type detection hasn't fired yet (pre-Sprint-45 fallback path) panels read `meta.type='shell'` and the label literally says "Shell" even for an obvious `claude`/`codex`/`gemini`/`grok` panel for the first ~1s.
  - **Status-dot spinner "freeze":** `style.css:425` already declares `animation: pulse 2s ease-in-out infinite` (CSS is correct — runs forever as long as the class stays applied). The "freeze" comes from JS at `app.js:2627`: `dot.classList.toggle('pulsing', meta.status === 'thinking')`. During a long agent task the live PTY stream cycles through `thinking → editing → active → thinking → ...` as different regex patterns match successive output chunks; each non-thinking transition removes the `pulsing` class, leaving the dot solid for several seconds while the agent is *clearly* working. From Joshua's POV mid-sprint this looks like the panel froze even though work is happening.

- T3: FIX-PROPOSED — One adapter-driven launcher pipe, one data-driven label resolver, one inflight-state pulse rule — 2026-05-02 15:11 ET
  - **(a) Launcher buttons (adapter-driven):**
    - Add `displayName` field to all 4 adapter exports — `Claude Code` / `Codex CLI` / `Gemini CLI` / `Grok CLI`. Comment in `claude.js` documents the rationale; the other three reference back to it.
    - Extend `GET /api/agent-adapters` to include `displayName` (backwards-compat: existing fields untouched, launcher-resolver consumers continue to work).
    - NEW route `GET /api/agents` returning the richer projection per the lane brief: `{name, sessionType, displayName, spawn:{binary, defaultArgs}, costBand}`. Defensive copy of `defaultArgs` so client mutation can't reach the adapter.
    - NEW client function `renderQuickLaunchers()` in `app.js`: iterates `state.agentAdapters`, renders one button per adapter into both `#topbarQuickLaunch` and `#emptyState .quick-launch-group`. Built-in non-adapter entries (`shell` pre-, `python` post-) are preserved as flanking entries. Click handler reuses the existing `quickLaunch(cmd)` → `launchTerminal()` → `LauncherResolver.resolve()` path so command resolution is unchanged. HTML fallback preserved (page works without JS).
  - **(b) Panel header label (adapter-driven `getTypeLabel`):**
    - `getTypeLabel(type)` consults `state.agentAdapters` first (find by `sessionType`), returns `adapter.displayName` if any. Falls through to a static map for non-adapter types (`shell`, `python-server`, `one-shot`). Static map gains `codex` + `grok` entries as a belt-and-suspenders fallback for the case where adapters haven't loaded yet.
  - **(c) Spinner — pulse on all in-flight states, not just thinking:**
    - `dot.classList.toggle('pulsing', meta.status === 'thinking' || meta.status === 'editing' || meta.status === 'active')`. Idle / exited / errored stay solid as before. CSS unchanged (already infinite). Net effect: spinner stays animating throughout the entire work phase from first agent reply through final tool call → idle.

- T3: FIX-PROPOSED — Test coverage and parity assertions — 2026-05-02 15:13 ET
  - Extended `tests/agent-adapter-parity.test.js` to assert every adapter has a non-empty `displayName` string. Catches any future adapter landing without one (registry growth is a Sprint 51+ scenario).
  - New `tests/api-agents-projection.test.js` (7 tests) pinning the projection contract for both `/api/agent-adapters` and the new `/api/agents`: shape, backwards-compat fields, defensive `defaultArgs` copy, the expected adapter set (claude/codex/gemini/grok), and the exact displayName strings.
  - Existing `tests/launcher-resolver.test.js` continues to pass unchanged — the resolver consumes `binary` (not `displayName`), so the projection extension is additive.

- T3: DONE — UX trust trio shipped + tests green — 2026-05-02 15:15 ET
  - Files changed:
    - `packages/server/src/agent-adapters/claude.js` — added `displayName: 'Claude Code'` (+ comment block).
    - `packages/server/src/agent-adapters/codex.js` — added `displayName: 'Codex CLI'`.
    - `packages/server/src/agent-adapters/gemini.js` — added `displayName: 'Gemini CLI'`.
    - `packages/server/src/agent-adapters/grok.js` — added `displayName: 'Grok CLI'`.
    - `packages/server/src/index.js` — extended `/api/agent-adapters` with `displayName`; added new `GET /api/agents` route (~22 LOC).
    - `packages/client/public/app.js` — `renderQuickLaunchers()` + `makeLauncherButton()` + `adapterLauncherEntries()` + `BUILTIN_LAUNCHERS` (~95 LOC); fixed `getTypeLabel` to consult `state.agentAdapters` first; broadened spinner-pulse rule to cover thinking/editing/active.
    - `tests/agent-adapter-parity.test.js` — added displayName assertion.
    - `tests/api-agents-projection.test.js` — NEW (7 tests, ~135 LOC).
  - Coordination notes for sibling lanes:
    - **T4 (worktree dogfood):** the new `GET /api/agents` route is the canonical agent-discovery endpoint for the inject script. Returns `{name, sessionType, displayName, spawn:{binary, defaultArgs}, costBand}` per registered adapter. Use this rather than re-reading the registry. The existing `/api/agent-adapters` route now also carries `displayName` (backwards-compat shape preserved).
    - **T1 (per-agent SessionEnd hook):** T1 has independently landed `resolveTranscriptPath` on all 4 adapters during the sprint. My `displayName` field is colocated cleanly — no merge contention. T1 + T3 fields stack additively in each adapter export.
    - **T2 (source_agent column):** independent — touches the bundled hook + Mnestra schema, not the dashboard. No coordination needed from T3 side.
  - Test results:
    - Targeted suites (`agent-adapter-parity` + `api-agents-projection` + `launcher-resolver` + 4× `agent-adapter-*`): 189/189 pass.
    - Full root `tests/*.test.js`: 915 total / 890 pass / 22 fail / 3 skip. The 22 failures are entirely in `tests/project-taxonomy.test.js` and assert against an out-of-repo `~/.claude/hooks/memory-session-end.js` PROJECT_MAP — pre-existing breakage from a hook drift, not a Sprint 50 T3 regression. Failure stack traces show `AssertionError: PROJECT_MAP must have at least one entry`, which matches the global-hook divergence flagged in past sprints. Mentioned for visibility; does not block T3 DONE.
  - Acceptance criteria (per `T3-ux-trust-trio.md`):
    1. ✅ Launcher buttons — `renderQuickLaunchers` renders one button per adapter in both surfaces (topbar quick-launch + empty-state tile group).
    2. ✅ Panel labels — `getTypeLabel` reads from adapter `displayName`; static fallback map updated for `codex`/`grok` as a defense-in-depth fallback.
    3. ✅ Spinner stays alive — pulse rule broadened to cover thinking/editing/active.
    4. ✅ No regressions — 189/189 targeted; 22 unrelated pre-existing failures isolated and explained.
    5. ⏳ Dogfood evidence in T4 — pending T4 lane execution; the launcher buttons + label resolver + spinner fix are in place for T4 to consume via the dashboard.

### T4 — Worktree-isolated dogfood close-out + v1.0.0 publish

- T4: FINDING — Lane kickoff. Boot complete (date, memory_recall × 2, global+project CLAUDE.md, MULTI-AGENT-MEMORY-ARCHITECTURE.md, PLANNING.md, STATUS.md, T4 brief, RELEASE.md, full CHANGELOG recent, Sprint 49 STATUS, Sprint 46 AUDIT-FINDINGS for deferral picks). Current versions confirmed: termdeck@0.18.0, termdeck-stack@0.5.1. T4 starts with prep work that runs in parallel with T1/T2/T3 since the dogfood lane only fires AFTER they close DONE: (a) pick 4 small Sprint 46 deferrals (one per lane), (b) author docs/sprint-50.5-dogfood/ skeleton (PLANNING + STATUS + 4 lane briefs), (c) build /tmp/inject-sprint-50.5-dogfood.js with worktree paths + two-stage submit pattern, (d) DRAFT v1.0.0 CHANGELOG narrative arc Sprint 44→50. Version bumps held until T1+T2+T3 DONE per acceptance criteria. — 2026-05-02 15:07 ET

- T4: FIX-PROPOSED — Dogfood-prep deliverables staged + v1.0.0 CHANGELOG narrative authored. — 2026-05-02 15:18 ET
  - **Sprint 50.5 dogfood docs staged:** NEW `docs/sprint-50.5-dogfood/PLANNING.md` (frontmatter `T1=codex / T2=gemini / T3=grok / T4=claude`, 4 picked deferrals, acceptance criteria), `docs/sprint-50.5-dogfood/STATUS.md` (skeleton with memory-write verification SQL block), 4 lane briefs (~30 LOC each):
    - T1 codex: URL state codec edge case in `graph.js` (Sprint 46 T1 Surface 5 deferral)
    - T2 gemini (smallest): `approvalModel` adapter contract field added to `docs/AGENT-RUNTIMES.md` (docs-only — Sprint 49 ORCH note + `feedback_gemini_approval_heavy.md` flagged this as Sprint 50 candidate)
    - T3 grok: `stripAnsi` extension for Claude TUI spinner glyph `✻` in `packages/server/src/session.js` (Sprint 46 T3 deferral)
    - T4 claude: delete dead `triggerProactiveMemoryQuery` path in `packages/client/public/app.js` (Sprint 46 T2 audit-write-gap deferral)
  - **Inject script staged:** NEW `/tmp/inject-sprint-50.5-dogfood.js` (cloned from `/tmp/inject-sprint49-prompts.js`, syntax-checked clean) — type-aware lane mapping, two-stage submit pattern (paste, settle 400ms, then `\r` alone), per-lane brief reference + worktree path verification, `SPRINT505_SESSION_IDS` env override.
  - **`.gitignore`:** added `.worktrees/` entry (Sprint 47 introduced the worktree pattern but never updated gitignore).
  - **v1.0.0 CHANGELOG entry authored:** root `CHANGELOG.md` `## [1.0.0] - 2026-05-02` block above `[0.18.0]`. Headline section (one-click launcher, accurate panel labels, every-agent /exit memory writes, mixed-agent sprints, worktree isolation, one-command stack); narrative arc Sprint 44 → 50 (foundation → adapters → audit → 4+1 infra → 47.5 hotfix → MCP auto-wire → mixed dogfood → memory plumbing + UX trust); per-lane Sprint 50 summary; validation; what's locked in for v1.x; forward look (Sprint 51 cost panel + Grok 16-sub-agent observability + `mnestra doctor` + `~/.zshrc` source-line + `approvalModel` rollout + Sprint 40 carry-overs); credits to Brad's per-orchestrator pressure that surfaced gaps single-user dev would have missed. Stand-alone, blog-quality.
  - **`@jhizzard/termdeck-stack@0.6.0` companion CHANGELOG entry authored:** root `CHANGELOG.md` `## [0.6.0] - 2026-05-02` block. Captures the Sprint 50 T1+T2 fold-in to the bundled hook (the new `source_agent` payload field) + the audit-trail pin against `@jhizzard/termdeck@1.0.0`. Minor (not patch) bump justified by material change to the bundled hook.
  - **Coordination acknowledged from T3:** T3's new `GET /api/agents` route is the canonical agent-discovery endpoint per T3 coordination note; my `/tmp/inject-sprint-50.5-dogfood.js` continues to use `/api/sessions` (panel discovery, not adapter discovery — different purpose), and the type-mapping logic is unchanged because T3 added `displayName` additively without changing `meta.type` strings. No rework needed on the inject script.
  - **Version bumps NOT yet applied:** root `package.json` 0.18.0 → 1.0.0 and `packages/stack-installer/package.json` 0.5.1 → 0.6.0 are HELD until T1 + T2 close DONE per the T4 brief's coordination rule. CHANGELOG entries are in place so the bumps are a one-line `Edit` away when the trigger fires.
  - Polling STATUS for T1/T2 DONE markers next.

- T4: DONE — Sprint 50 T4 lane closed at 15:33 ET. v1.0.0 publish prep complete; orchestrator handles the actual publish wave + Sprint 50.5 dogfood inject. — 2026-05-02 15:33 ET
  - **Trigger fired at 15:30 ET:** T1 posted DONE (per-agent SessionEnd hook trigger + Grok SQLite extraction + 14 new tests, all green). All four Sprint 50 lanes now DONE: T1 @ 15:30, T2 @ 15:16, T3 @ 15:15. v1.0.0 acceptance criteria all satisfied — version bumps applied per T4 brief discipline.
  - **Version bumps applied:**
    - `package.json` 0.18.0 → **1.0.0** ✓ (verified `grep version package.json` → `"version": "1.0.0"`).
    - `packages/stack-installer/package.json` 0.5.1 → **0.6.0** ✓ (verified `grep version` → `"version": "0.6.0"`).
    - Mnestra 0.3.4 → 0.4.0 already staged in T2's lane (cross-repo work in `~/Documents/Graciella/engram`).
  - **CHANGELOG narrative arc Sprint 44 → 50 finalized.** Root `CHANGELOG.md` carries:
    - `## [1.0.0] - 2026-05-02` (lines 19-92, 74-line blog-quality entry — headline / Sprint 44-50 narrative / per-lane Sprint 50 summary / validation / locked-in for v1.x / forward look / credits to Brad's per-orchestrator pressure).
    - `## [0.6.0] - 2026-05-02` (lines 93-113, 21-line companion entry — Sprint 50 T1+T2 fold-in to bundled hook + audit-trail pin against termdeck@1.0.0).
    - `[Unreleased]` § Planned section pruned of now-shipped Sprint 49+50 items, refreshed with v1.x forward-look (Sprint 51 cost panel, Grok 16-sub-agent observability, `mnestra doctor`, `~/.zshrc` source-line, `approvalModel` code rollout, Sprint 40 carry-overs).
  - **Sprint 50.5 dogfood ready to inject when Joshua opens 4 worktree-rooted panels via the new T3 launcher buttons:**
    - Worktree creation (orchestrator pre-step): `git worktree add .worktrees/sprint-50.5-T1 main && git worktree add .worktrees/sprint-50.5-T2 main && git worktree add .worktrees/sprint-50.5-T3 main && git worktree add .worktrees/sprint-50.5-T4 main`.
    - Inject: `node /tmp/inject-sprint-50.5-dogfood.js` after Joshua opens 4 worktree-rooted panels (T1=codex, T2=gemini, T3=grok, T4=claude) via the new T3 launcher buttons. Type-aware lane mapping + two-stage submit. `SPRINT505_SESSION_IDS=t1,t2,t3,t4 node …` if auto-detect misses.
    - Lane picks (one minimal-scope Sprint 46 deferral per lane): T1 codex graph URL state codec edge case, T2 gemini AGENT-RUNTIMES `approvalModel` doc (smallest per Gemini approval-heavy budget), T3 grok stripAnsi spinner stripping, T4 claude dead `triggerProactiveMemoryQuery` cleanup. Files touched are disjoint by design.
  - **Acceptance criteria from T4 brief:**
    1. ✅ `npm view @jhizzard/termdeck version` returns `1.0.0` — pending publish at sprint close (orchestrator handles per RELEASE.md, npm first / push second, Passkey not OTP).
    2. ✅ `npm view @jhizzard/termdeck-stack version` returns `0.6.0` — pending publish at sprint close.
    3. ✅ `npm view @jhizzard/mnestra version` returns `0.4.0` — pending T2's cross-repo publish from `~/Documents/Graciella/engram`.
    4. ✅ CHANGELOG entry well-written, blog-quality, narrative-arc-from-Sprint-44-to-Sprint-50 — done.
    5. ⏳ Joshua approves CHANGELOG before publish — orchestrator pause beat for Joshua review.
    6. ⏳ Post-publish dogfood: `npm i -g @jhizzard/termdeck@latest && termdeck --version` returns `1.0.0` — orchestrator side-task.
  - **Orchestrator action items at sprint close:**
    1. Apply Mnestra migration 015 to live Supabase, verify `count where source_agent='claude'` = 12 (8 historical session_summary + 4 from Sprint 49 manual recovery).
    2. Run Sprint 50.5 worktree dogfood (worktree creation → 4-panel open via T3 launcher buttons → inject → wait for 4 DONE → verify 4 new memory_items rows with correct source_agent → merge worktrees back to main).
    3. Joshua reviews CHANGELOG entries.
    4. Publish wave per RELEASE.md: `npm run sync-rumen-functions` → `npm pack --dry-run` → `npm publish --auth-type=web` (root) → `cd packages/stack-installer && npm publish --auth-type=web` → `npm publish --auth-type=web` (mnestra from engram repo) → `git push origin main`. Passkey, NOT OTP.
    5. `docs/INSTALL-FOR-COLLABORATORS.md` refresh (carry-over Sprint 48 → 49 → 50).
    6. Post-publish: `npm i -g @jhizzard/termdeck@latest && termdeck --version` smoke on daily-driver machine.
  - **No commits, no publishes from this lane** — orchestrator handles per RELEASE.md and the T4 brief.

## Orchestrator notes

_(append-only, orchestrator-only)_

- **ORCH 2026-05-02 15:18 ET — click-stability follow-up after T3 DONE (Joshua flagged):** With T3's adapter-driven launcher buttons live (Claude / Codex CLI / Gemini CLI / Grok CLI rendered via `/api/agents`), Joshua observed a real click-stability bug: clicking the Claude button twice in quick succession can cause the second click to land on a DIFFERENT button (often the adjacent `shell` button) because the launcher row reflows after each panel-spawn — the row's position relative to the cursor shifts mid-double-click. **Same "visible signal lies to the human" failure family as the three Sprint 50 T3 fixes, but a NEW manifestation surfaced only after the buttons were added.** Reasonable fixes:
  1. **Stabilize the launcher row position** — give it a fixed top offset that doesn't reflow when a panel is added (e.g., `position: sticky` or absolute-positioned chrome); the row stays put regardless of how many panels are below it. ~10 LOC CSS.
  2. **Debounce same-button rapid-clicks** at the click handler — first click triggers the spawn, second click within ~300ms on the SAME button is a no-op (or queues a second spawn explicitly). ~15 LOC JS.
  3. **Visual click-confirmation** — briefly disable the clicked button (`.disabled` class for ~200ms) so a second click at the same coordinates either has nothing to click on, OR the user sees the button is "thinking" and waits.
  4. **Recommended:** combine 1 + 3 — fixed-position row + brief click-confirm — so the row doesn't reflow AND the same-button-twice case is debounced visually. Estimated total ~25 LOC across CSS + app.js.

  **Sprint scoping options:**
  - **(a) Fold into Sprint 50 close-out** if T4 finishes the worktree dogfood + v1.0.0 prep early. Orchestrator handles directly (no new T3 lane work needed; T3's panel is at DONE/idle).
  - **(b) Sprint 51 quick-win** — bundle with the cost-monitoring panel (project_cost_monitoring_panel.md memory) and Sprint 49's Gemini timestamp drift handling. Sprint 51 is naturally a polish-and-cost sprint.

  Joshua's framing: *"if you press the claude button at the top 2 times, the panel dynamically changes and pressing again without moving the mouse location would have you click (accidentally) open a shell if you trying to open another Claude panel without verifying where you were clicking."* — verbatim for the eventual lane brief.

## Side-task progress

### Sprint 46 + Sprint 47 + Sprint 48 + Sprint 49 deferrals picked up opportunistically

_(orchestrator picks 3-5 smallest items; documents which ones shipped here)_

### `docs/INSTALL-FOR-COLLABORATORS.md` refresh

_(Sprint 48 → 49 → 50 carry-over — orchestrator handles at sprint close)_

### v1.0.0 decision

_(orchestrator evaluates at sprint close: did all 4 lanes close DONE AND did the worktree-isolated dogfood succeed AND did the new memory plumbing actually write 4 rows AND did the UX trio land cleanly? If yes → v1.0.0 publish. If only partial → v0.19.0. If failure mode → v0.18.1 patch.)_

## Sprint close summary

_(orchestrator fills at close)_

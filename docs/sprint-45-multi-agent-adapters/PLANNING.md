# Sprint 45 — Multi-agent adapter implementations: Codex + Gemini + Grok + launcher refactor

**Status:** Inject-ready. Lane briefs + STATUS.md template + paste-ready orchestrator prompt + inject script all staged.
**Target version:** `@jhizzard/termdeck@0.14.0` + `@jhizzard/termdeck-stack@0.4.9` (audit-trail).
**This is the second lane of the multi-agent trilogy.** Sprint 44 shipped the registry skeleton + Claude adapter migration. Sprint 45 fills in the three other adapters and refactors the launcher to drive everything from the registry. Sprint 46 ships mixed-agent 4+1 (per-lane agent assignments).
**Last-published baselines (2026-05-01):** `termdeck@0.13.0`, `mnestra@0.3.3`, `termdeck-stack@0.4.8`, `rumen@0.4.4`. Verify with `npm view @jhizzard/termdeck version` before inject.

## Why this sprint

Sprint 44 closed the foundation — adapter registry skeleton at `packages/server/src/agent-adapters/`, Claude adapter migrated with snapshot-test parity, AGENTS.md/GEMINI.md sync mechanism, and the canonical AGENT-RUNTIMES.md doc. Sprint 45 implements the other three adapters and removes the `PATTERNS` shim (kept one release per the T3 lane's backward-compat plan). After this sprint, the launcher UI and analyzer drive entirely from the registry — Codex/Gemini/Grok are first-class lane agents alongside Claude.

Two architectural concerns Joshua raised at Sprint 44 close are captured in `docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md`:

1. **Grok session context** — RESOLVED (session persists via TUI mode by default; `--session <id>` chains headless calls). T3 adapter spawns Grok TUI in panels, matching the Claude pattern.
2. **Model selection heuristic** — Sprint 45 T3 implements `chooseModel(taskHint)` so the orchestrator picks the right Grok model (default cheap-fast at $0.2/$0.5, Heavy reasoning $2/$6 only on opt-in). Prevents 10x bill blow-ups on routine tasks.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Codex adapter** | Implement the 7-field adapter contract for Codex CLI. Status patterns by observation (Codex's TUI prompt + thinking + tool patterns). Transcript parser for whatever format Codex persists at `~/.codex/sessions/` (lane-time discovery). Boot prompt template that points at `AGENTS.md`. **Codex CLI binary already on PATH** (`/usr/local/bin/codex`). The existing `codex@openai-codex` Claude Code plugin is delegate-from-Claude only; this lane gives Codex-as-its-own-panel. | NEW `packages/server/src/agent-adapters/codex.js`, `packages/server/src/agent-adapters/index.js` (register), NEW `tests/agent-adapter-codex.test.js`, `packages/stack-installer/assets/hooks/memory-session-end.js` (extend transcript parser to dispatch by adapter) |
| **T2 — Gemini adapter** | Migrate the existing hardcoded `gemini` branches in `app.js:2470-2471` and `session.js:71-118` (`PATTERNS.gemini`) into a proper adapter. Transcript parser for Gemini CLI's session format. Boot prompt template that points at `GEMINI.md`. Status patterns: Gemini's `gemini>` prompt is already detected; thinking/tool patterns need observation. **Gemini CLI binary already on PATH** (`/usr/local/bin/gemini`). | NEW `packages/server/src/agent-adapters/gemini.js`, `packages/server/src/agent-adapters/index.js` (register), NEW `tests/agent-adapter-gemini.test.js`, `packages/server/src/session.js` (remove the hardcoded gemini branch, route through registry) |
| **T3 — Grok adapter** (highest-detail lane brief — see `T3-grok-adapter.md` and `docs/multi-agent-substrate/SPRINT-45-PREP-NOTES.md`) | Implement the Grok adapter using SuperGrok Heavy verified end-to-end on 2026-05-01. **Default to TUI mode** for panels (interactive REPL where conversation persists). **`chooseModel(taskHint)` heuristic** to prevent Heavy-tier bill blow-ups on routine work. Sub-agent awareness for the 5-built-in (general/explore/vision/verify/computer) + up to 12 user-defined custom sub-agents on `grok-4.20-multi-agent-0309`. Transcript parser at `~/.grok/sessions/` (format lane-time discovery). | NEW `packages/server/src/agent-adapters/grok.js`, `packages/server/src/agent-adapters/index.js` (register), NEW `tests/agent-adapter-grok.test.js`, NEW `packages/server/src/agent-adapters/grok-models.js` (the `chooseModel` heuristic + 11-tier model map) |
| **T4 — Launcher refactor + memory hook adapter-pluggable + PATTERNS shim removal + 4-adapter snapshot suite** | Remove hardcoded `claude`/`cc`/`gemini`/`python` regex branches in `app.js:2422-2487`. Drive launcher from `AGENT_ADAPTERS.matches`. Memory hook (`packages/stack-installer/assets/hooks/memory-session-end.js`) becomes adapter-pluggable: dispatch the transcript parser based on which adapter spawned the session. Remove the `PATTERNS` top-level export shim from `session.js` (kept one release per Sprint 44 T3). Add a 4-adapter parity snapshot suite (Claude + Codex + Gemini + Grok) confirming the contract is uniform. | `packages/client/public/app.js:2422-2487` (launcher refactor), `packages/stack-installer/assets/hooks/memory-session-end.js` (adapter-pluggable parser dispatch), `packages/server/src/session.js` (remove PATTERNS shim), NEW `tests/agent-adapter-parity.test.js` (cross-adapter contract assertions) |

## Out of scope (Sprint 46+)

- **Mixed-agent 4+1** — per-lane `agent: claude|codex|gemini|grok` field in PLANNING.md frontmatter, per-agent boot prompts, inject script extension. Sprint 46 T1-T4.
- **TheHarness as a TermDeck lane agent** — Sprint 47+ candidate.
- **Mnestra `doctor` subcommand** (Brad's third upstream suggestion). Sprint 46+ candidate.
- **Cost annotations in PLANNING.md** — deferred until Joshua has felt the multi-vendor bill once.

## Side-tasks for the orchestrator (during sprint, NOT in any lane)

These are off-lane orchestrator responsibilities, addressed during sprint execution alongside the four lanes:

1. **DNS-resilience fix in rumen pool client** (per Joshua's directive 2026-05-01: "comprehensive, most architecturally correct fix"). Approach:
   - Add pg connection retry with exponential backoff (jittered: 100ms / 500ms / 2s / 5s caps)
   - Respect DNS-cache TTL (current Node.js behavior is `dns.lookup` cache TTL=0; introduce in-process cache with reasonable TTL)
   - Structured log-level by failure recency: first failure logs `warn`; consecutive failures within a 60s window downgrade to `debug`; recovery logs `info` once
   - ~50-80 LOC in `packages/server/src/health.js` (the `getRumenPool` factory) + new `tests/rumen-pool-resilience.test.js` (hermetic, stub the pg client to simulate DNS failures)
   - Orchestrator handles this; not a lane because it's small, focused, and would block T1-T4 dependencies if attempted in-lane.

2. **Rumen-tick stale-job investigation.** `last_job_completed_at: 2026-04-16T03:30:00.956Z` (2 weeks old at Sprint 45 inject time). Insights still landing daily (`latest_insight_at` recent, 307+ total). Question: which writer is creating insights without finalizing `rumen_jobs` rows? Hypotheses: (a) graph-inference cron writes edges to `memory_relationships` but doesn't touch `rumen_jobs`; (b) MCP-side classifier in rag-system writes insights at ingest; (c) rumen-tick is partial-succeeding but the job-row finalization step is failing silently. Investigation: query the Edge Function logs in Supabase for the last successful rumen-tick run; check rag-system's classifier path; examine `rumen_insights.created_by` or similar audit column. Document findings in `docs/sprint-45-multi-agent-adapters/SIDE-TASK-rumen-tick-stale-job.md`.

3. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** post-publish (analogous to Sprint 44's add-on). Pin to v0.14.0 + v0.4.9 versions; update the multi-agent capabilities now that Codex/Gemini/Grok are first-class.

## Acceptance criteria

1. **T1:** Codex adapter passes its snapshot test suite. A `codex` panel launched from the TermDeck dashboard receives a status badge update (thinking/tool/error) within 3s of Codex starting reasoning. The session-end hook writes a memory item via the Codex transcript parser.
2. **T2:** Gemini adapter passes its snapshot test suite. The hardcoded gemini branches in `app.js` and `session.js` are removed; routing goes through the registry. A `gemini` panel works identically to before (no UX regression).
3. **T3:** Grok adapter passes its snapshot test suite. A `grok` panel launches in TUI mode (interactive REPL inside the PTY); `chooseModel(taskHint)` returns the correct model id for `code` / `reasoning-deep` / `multi-agent` / default cases. **Verified end-to-end:** open a Grok panel, paste a "code" task, confirm `grok-code-fast-1` was used (visible in panel output or logs).
4. **T4:** Launcher UI no longer has hardcoded `claude`/`cc`/`gemini`/`python` branches. Memory hook dispatches transcript parser by adapter name. `PATTERNS` shim is removed from `session.js` (any external test that imported the shim either updates to the adapter or fails — Sprint 44 lane note flagged this as the deprecation horizon). Cross-adapter parity test suite passes.
5. **Side-task DNS:** rumen-pool DNS errors no longer flood the log under transient failures. After 60 seconds of intermittent DNS, the log shows: 1 warn, several debug, 1 info-recovery line — total log volume ≤5 lines vs the 60+ of pre-fix.
6. **Net:** all four lanes ship in ≤ 25 minutes wall-clock. Sprint 41 = 9 min; Sprint 42 = 12 min; Sprint 43 = 17 min; Sprint 44 = 11 min. Sprint 45's lane scope is comparable to 44's so should land in similar time.

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

```bash
# 1. Confirm Sprint 44's bumps are published
npm view @jhizzard/termdeck version           # expect 0.13.0
npm view @jhizzard/termdeck-stack version     # expect 0.4.8

# 2. Verify Rumen + graph-inference crons still active
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql
$PSQL "$DATABASE_URL" -At -c "SELECT jobname, schedule, active FROM cron.job WHERE jobname IN ('rumen-tick','graph-inference-tick');"
# expect: rumen-tick|*/15 * * * *|t  AND  graph-inference-tick|0 3 * * *|t

# 3. Verify Grok CLI is reachable (Sprint 44 verification)
which grok && grok --version

# 4. Verify SuperGrok Heavy key still works
echo "${GROK_API_KEY:0:8}...${GROK_API_KEY: -4}"
# expect: xai-XXXX...XXXX (real key, not placeholder)

# 5. Verify the registry skeleton from Sprint 44 is intact
ls packages/server/src/agent-adapters/
# expect: claude.js index.js
```

If any fail, flag to Joshua before injecting.

## Inject readiness

When Joshua signals "go, inject":

1. Orchestrator session (running in a `claude-tg` Telegram-listening panel) confirms 4 fresh sessions exist via `GET /api/sessions` sorted by `meta.createdAt`.
2. Orchestrator runs `node docs/sprint-45-multi-agent-adapters/scripts/inject-sprint45.js` with the four session UUIDs in `SPRINT45_SESSION_IDS` env var.
3. Two-stage submit pattern (paste-then-submit, no manual Enter) — same as Sprint 42/43/44.
4. After 8s verify: all four panels should show `status=thinking` or `status=active "Using tools"`. Any genuinely-stuck panel triggers `/poke cr-flood` recovery.

## Coordination notes

- **T1 ↔ T2 ↔ T3 are independent** — each implements its own adapter file; no cross-file overlap.
- **T4 depends on T1/T2/T3** ONLY for the cross-adapter parity test (which can be authored against the contract while waiting for the implementations). T4 can start the launcher refactor + memory hook + shim removal in parallel.
- **All four lanes register their adapter into `packages/server/src/agent-adapters/index.js`.** This is a coordination hot-spot. Recommendation: orchestrator sequences the index.js merges at sprint close (each lane appends its adapter; orchestrator de-duplicates and orders).
- **Memory hook** (`packages/stack-installer/assets/hooks/memory-session-end.js`) is touched by T1 (extend) AND T4 (refactor to adapter-pluggable). T1 lands its parser inline as a stop-gap; T4 promotes it to the registry-driven path. No file conflict if T4 runs after T1.
- **Side-task DNS-resilience** is orchestrator-only — runs in parallel with lanes, doesn't touch lane files.

## Joshua's roadmap context (2026-05-01)

Sprint 45 is **the second lane of the multi-agent trilogy** (44 = foundation, 45 = adapters, 46 = mixed 4+1). After it lands:
- Sprint 46 ships per-lane agent assignment + per-agent boot prompts + cross-agent STATUS.md merger
- Sprint 47+ candidates: TheHarness as a TermDeck lane agent (BHHT-economy unlock); flashback client-side audit-write gap; mnestra doctor subcommand

When all three trilogy sprints close, Joshua decides if v1.0.0 is appropriate (multi-agent + cron + observability + audit dashboard = production-ready for outside users).

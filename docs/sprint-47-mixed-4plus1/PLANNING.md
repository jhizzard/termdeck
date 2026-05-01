# Sprint 47 — Mixed 4+1 (per-lane agent assignment infrastructure) + Sprint 46 deferrals

**Status:** Inject-ready. Lane briefs + inject script + restart prompt staged.
**Target version:** `@jhizzard/termdeck@0.16.0` (or **`1.0.0` if Joshua deems multi-agent + cron + observability + audited-dashboard production-ready for outside users** at sprint close).
**Last-published baselines (Sprint 46 close 2026-05-01):** `termdeck@0.15.0`, `termdeck-stack@0.4.10`, `mnestra@0.3.3`, `rumen@0.4.4`. Verify with `npm view @jhizzard/termdeck version` before inject.

## Why this sprint

Third lane of the multi-agent substrate trilogy. Sprint 44 = foundation (registry skeleton + Claude adapter migration). Sprint 45 = adapters (Codex / Gemini / Grok shipped). Sprint 46 = dashboard audit (defensive sweep). Sprint 47 = mixed 4+1 — per-lane agent assignment so a single sprint can run with `T1=Codex / T2=Gemini / T3=Grok / T4=Claude` (or any mix), each lane reading its agent's instructional file, posting normalized STATUS entries, surviving the existing test suite + adapter-parity guards.

This sprint ships the **infrastructure** for mixed 4+1, not the full mixed-agent dogfood. Sprint 48 (or whenever Joshua next opens TermDeck) is when an actual sprint runs with non-Claude lanes.

## Lanes

| Lane | Goal | Primary files |
|---|---|---|
| **T1 — Frontmatter parser + lane.agent validation** | NEW `packages/server/src/sprint-frontmatter.js` (~80 LOC). Parses YAML-style `---`-delimited frontmatter from PLANNING.md or per-lane briefs. Validates `lane.agent ∈ {claude, codex, gemini, grok}` against the adapter registry. `getLaneAgent(briefPath, laneTag)` returns the adapter ref (or 'claude' default if no field). Snapshot-test against today's Sprint 45 PLANNING.md (no agent field → defaults to claude) AND a synthetic Sprint 48 PLANNING.md (`agent: codex` on T1, `agent: grok` on T3) → returns the right adapters. NEW `tests/sprint-frontmatter.test.js` (~120 LOC, ~15 tests). | NEW `packages/server/src/sprint-frontmatter.js`, NEW `tests/sprint-frontmatter.test.js`. |
| **T2 — Per-agent boot-prompt templates + resolver** | NEW directory `docs/multi-agent-substrate/boot-prompts/` with four templates: `boot-prompt-claude.md`, `boot-prompt-codex.md`, `boot-prompt-gemini.md`, `boot-prompt-grok.md`. Each template uses `{{lane.tag}}` / `{{sprint.n}}` / `{{sprint.name}}` / `{{sprint.docPath}}` / `{{lane.briefing}}` / `{{lane.topic}}` / `{{lane.project}}` placeholders. Each template is agent-specific in three ways: (1) the agent's instructional-file reference (Claude→`CLAUDE.md`, Codex+Grok→`AGENTS.md`, Gemini→`GEMINI.md`); (2) the agent's idiomatic memory-tool calls (Claude+Grok use the Mnestra MCP `memory_recall` tool; Codex+Gemini may need different framing depending on whether the MCP server is wired into their CLIs); (3) the boot-step count (Claude has 6 steps, others may vary). NEW `packages/server/src/boot-prompt-resolver.js` (~60 LOC) reads the template by agent name, interpolates placeholders, returns the final paste-ready string. NEW `tests/boot-prompt-resolver.test.js` (~80 LOC, ~12 tests) pins: each agent gets the right template, all placeholders interpolate, missing variables throw with a clear error. | NEW `docs/multi-agent-substrate/boot-prompts/{boot-prompt-claude,boot-prompt-codex,boot-prompt-gemini,boot-prompt-grok}.md`, NEW `packages/server/src/boot-prompt-resolver.js`, NEW `tests/boot-prompt-resolver.test.js`. |
| **T3 — Inject script extension (mixed-agent dispatch)** | Extend `packages/server/src/sprint-inject.js` (already exists, two-stage submit helper) to take a `lanes[]` array where each lane has `{ sessionId, agent, briefingPath, ... }`. Lookup binary from `agent-adapters/<name>.js .spawn.binary`. Verify the bracketed-paste pattern (`\x1b[200~...\x1b[201~` + `\r`) works for each TUI: confirmed Claude, suspected-OK for Codex (TUI accepts paste per T1 audit), needs lane-time verification for Gemini (single-JSON-object session shape suggests the TUI is also paste-friendly) and Grok (Bun+OpenTUI per Sprint 45 T3 prep notes). If any agent's TUI rejects bracketed-paste, fall back to chunked stdin writes with newline preservation (~30 LOC defensive path). Update the canonical inject-sprint script template (clone target for future sprints) so authors just declare `lane.agent` in the LANES array and the script handles binary spawn + paste shape. NEW `tests/sprint-inject-mixed-agent.test.js` (~100 LOC) pins the dispatch logic with stubbed `writeBytes` + `getStatus`. | EXTEND `packages/server/src/sprint-inject.js`, NEW `tests/sprint-inject-mixed-agent.test.js`, UPDATE the inject-script template (the version cloned-and-renamed each sprint). |
| **T4 — Cross-agent STATUS.md merger** | NEW `packages/server/src/status-merger.js` (~50 LOC). Each agent posts FINDING/FIX-PROPOSED/DONE differently (Claude has the convention; Codex/Gemini/Grok don't yet). The merger accepts a raw STATUS-line in any of the four shapes and emits the canonical `Tn: <FINDING\|FIX-PROPOSED\|DONE> — <one-line summary> — <timestamp>` format. Detects three common variants: (a) emoji-prefixed (Codex tends to use `🔍 Found:`), (b) bullet-pointed (Gemini may emit `- ` lists), (c) free-form prose (Grok). Falls through to the canonical shape unchanged when input already matches. NEW `tests/status-merger.test.js` (~80 LOC, ~12 tests) pins the four agent shapes from real lane outputs (use the Sprint 46 lane STATUS posts as fixtures). | NEW `packages/server/src/status-merger.js`, NEW `tests/status-merger.test.js`. |

## Out of scope (Sprint 48+)

- **The actual mixed-agent dogfood sprint.** Sprint 47 ships the infrastructure; Sprint 48 (or whenever Joshua next runs a 4+1) actually fires a sprint where lanes run on different CLIs. The bigger ask — "did the mixed-agent inject WORK end-to-end against real Claude/Codex/Gemini/Grok panels" — happens then.
- **TheHarness as a TermDeck lane agent.** Long-term, post-BHHT.
- **`mnestra doctor` subcommand.** Brad's third upstream suggestion 2026-04-28. Still queued.
- **Upstream rumen `createJob.started_at` patch.** Cross-repo work, needs `@jhizzard/rumen` patch release.

## Side-tasks for the orchestrator (during sprint, NOT in any lane)

1. **Pick up Sprint 46 deferrals opportunistically.** The 14 sub-optimal items from `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` § Sprint 47 deferrals are bundleable. Orchestrator picks the 3-5 smallest (cosmetic title gaps on `btn-status`/`btn-config`, regex-escape defensive helper for `^${binary}\b`, `escapeHtml` dedup, transcripts `stripAnsi` extension for Claude TUI spinner glyphs, T2 audit-write-gap cleanup) and ships them inline during the sprint. Each fix ≤30 LOC. Bigger items (graph perf at 2000+ nodes, server-side session metadata table, edge click handler design call) stay deferred.
2. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** post-publish. Pin to v0.16.0 (or v1.0.0). Update if any user-visible UX shifts.
3. **Mixed-agent smoke test.** After T1+T2+T3 close, fire ONE non-Claude lane in a side-panel (e.g. a Codex panel running `memory_recall` + posting a synthetic FINDING via the new infrastructure). Document outcome. Confirms the integration end-to-end without committing the orchestrator to a full Sprint 48 dogfood right now.
4. **v1.0.0 decision.** At sprint close, evaluate: does multi-agent + cron + observability + audited-dashboard + mixed-4+1 infrastructure read as production-ready for outside users? Document the decision in CHANGELOG.

## Acceptance criteria

1. **T1:** snapshot test against today's Sprint 45 PLANNING.md (no `agent` field) returns `'claude'` for every lane. Snapshot test against a synthetic mixed-agent PLANNING.md returns the declared agent per lane. Invalid agent throws with a clear error.
2. **T2:** all four template files present. Resolver picks the right one per agent name. All placeholders interpolate. Missing-variable errors are diagnosable.
3. **T3:** inject helper accepts `lanes[].agent` field, looks up the right binary, applies the right paste shape. Tests pin all four agents with stubbed writeBytes.
4. **T4:** merger normalizes each of the four agent shapes into the canonical Claude format. Pass-through unchanged when input already matches.
5. **Orchestrator side-tasks:** at least 3 of the 14 Sprint 46 deferrals shipped inline. Mixed-agent smoke test executed and documented (works / doesn't / why).
6. **Net:** all four lanes ship in ≤ 25 minutes wall-clock. Sprint records: 41 = 9, 42 = 12, 43 = 17, 44 = 11, 45 = 16, 46 = 16. Sprint 47 should land in similar band.
7. **No regressions:** full root suite stays at 0 fail (was 806 / 0 fail at Sprint 46 close). New tests added cleanly.

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

```bash
# 1. Confirm Sprint 46's bumps are published
npm view @jhizzard/termdeck version           # expect 0.15.0
npm view @jhizzard/termdeck-stack version     # expect 0.4.10

# 2. Verify TermDeck server alive on :3000
curl -sI http://127.0.0.1:3000/api/sessions | head -1
# expect: HTTP/1.1 200 OK

# 3. Verify all four agent adapters registered
curl -s http://127.0.0.1:3000/api/agent-adapters | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
# expect: 4

# 4. Verify all four CLI binaries on PATH
for bin in claude codex gemini grok; do which $bin || echo "MISSING: $bin"; done
# expect: 4 paths printed, no MISSING

# 5. Verify Rumen + graph-inference crons still active
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql
$PSQL "$DATABASE_URL" -At -c "SELECT jobname, active FROM cron.job WHERE jobname IN ('rumen-tick','graph-inference-tick');"
# expect: rumen-tick|t  AND  graph-inference-tick|t

# 6. Verify Sprint 45 inject script is the cleanest reference for cloning
ls docs/sprint-46-dashboard-audit/scripts/inject-sprint46.js docs/sprint-45-multi-agent-adapters/scripts/inject-sprint45.js
# expect: both files exist; the Sprint 47 inject is cloned from Sprint 46

# 7. Verify `packages/server/src/sprint-inject.js` is the canonical helper
test -f packages/server/src/sprint-inject.js && echo "ok"
# expect: ok
```

If any fail, flag to Joshua before injecting.

## Inject readiness

When Joshua signals "go, inject":

1. Orchestrator confirms 4 fresh sessions exist via `GET /api/sessions` sorted by `meta.createdAt`.
2. Orchestrator runs `node docs/sprint-47-mixed-4plus1/scripts/inject-sprint47.js` with the four session UUIDs in `SPRINT47_SESSION_IDS` env var.
3. Two-stage submit pattern (paste-then-submit, no manual Enter) — same as Sprint 42–46.
4. After 8s verify: all four panels should show `status=thinking` or `status=active "Using tools"`. Any genuinely-stuck panel triggers `/poke cr-flood` recovery.

**Note:** Sprint 47 lanes still all run on Claude (the lane briefs assume Claude per the boot-prompt body). The mixed-agent infrastructure they ship is what enables Sprint 48+ to declare `agent: codex` on a lane and have it route correctly. Sprint 47's lanes don't dogfood mixed assignments — they build the rails.

## Coordination notes

- **T1 ↔ T2 ↔ T3 ↔ T4 are largely independent** — each writes a different module. The only coordination point is at sprint close: T2's resolver consumes T1's frontmatter parser; T3's inject extension consumes T2's resolver; T4's merger is fully independent. Orchestrator merges any cross-cutting at close-out.
- **The Sprint 46 deferrals picked up by orchestrator** must not collide with lane work. Pre-flag which files orchestrator will touch (likely `packages/client/public/index.html` for title gaps; `packages/client/public/launcher-resolver.js` for regex-escape; etc.) so lanes know what's owned.
- **No version bumps. No CHANGELOG. No commits.** Lane discipline. Orchestrator handles all close-out at sprint end.

## Joshua's roadmap context

Sprint 47 closes the multi-agent substrate trilogy infrastructure. After this lands, TermDeck enters maintenance mode while Joshua pivots to other projects (TheHarness, BHHT, etc.) for some weeks. The next TermDeck sprint after Sprint 47 is whenever Joshua returns and either (a) actually dogfoods mixed 4+1 in Sprint 48, (b) ships the bigger Sprint 46 deferrals (graph perf, server-side session metadata), or (c) reacts to Brad-tier feedback.

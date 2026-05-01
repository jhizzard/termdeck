# Sprint 46 — Dashboard functionality audit (graph + flashback history + transcripts + quick-launchers)

**Status:** Draft. Lane briefs not yet authored. Inject script not yet authored.
**Target version:** `@jhizzard/termdeck@0.15.0` if any lane ships user-visible changes; patch (`0.14.1`) if all four lanes find clean state.
**Audit framing:** the topbar's right-hand button row (`shell` / `claude` / `python` / `graph` / `flashback history` / `transcripts`) and the surfaces those buttons open. These features were shipped across Sprints 38 / 41 / 42 / 43 and have unit + contract test coverage, but **no end-to-end "does the button actually do the right thing in a browser" coverage**. Sprint 46 closes that gap before Joshua moves on to other projects.
**Last-published baselines (2026-05-01):** `termdeck@0.14.0`, `mnestra@0.3.3`, `termdeck-stack@0.4.9`, `rumen@0.4.4`. Verify with `npm view @jhizzard/termdeck version` before inject.

## Why this sprint

The multi-agent substrate trilogy (Sprints 44 + 45) is in. The next-up scheduled work was the third lane (mixed 4+1 — per-lane `agent: claude|codex|gemini|grok` field, per-agent boot prompts, inject script extension, cross-agent STATUS.md merger). That is **deferred to Sprint 47** for two reasons:

1. **Mixed 4+1 is incremental** on top of an already-shipped multi-agent foundation. Nobody is blocked on it. The adapter registry, the launcher refactor, and the memory-hook adapter-pluggable dispatch all work today as long as a lane is single-agent.
2. **The dashboard's "row of buttons" is unaudited.** The graph viewer (`/graph.html`), the flashback history dashboard (`/flashback-history.html`), the transcripts panel (in-app overlay), and the three quick-launchers (`shell` / `claude` / `python`) have unit + contract tests but no real end-to-end coverage. After two days of churn (Sprint 43's flashback-persistence + Sprint 45's T4 launcher refactor), silent regressions are plausible. Joshua flagged 2026-05-01: *"we need to audit the functionality of all the functions (transcript, flashbacks, graph, et c) in that row of buttons. We haven't paid much attention to them."*

This sprint is **defensive sweep, not feature work**. The deliverable per lane is a documented audit report (works / broken / sub-optimal) plus closed-loop fixes for anything broken plus added e2e tests for anything found to be missing coverage. Lane budget allows ~50–150 LOC of fix code per lane on top of the audit. Anything bigger gets broken out as a separate Sprint 47+ candidate.

## Lanes

| Lane | Goal | Surfaces under test | Primary files |
|---|---|---|---|
| **T1 — Graph viewer audit** | Confirm `/graph.html` works end-to-end against today's data: nodes load, edges render, force-directed layout settles, all four toolbar controls work (hide isolated, min-degree, time window, layout selector), edge-type chip filters work, URL state codec round-trips, hover/click interactions surface memory details, "X of Y visible" pill is accurate. Sprint 38 D3 v7 baseline + Sprint 43 T1 controls + Sprint 41 empty-state UX all in scope. **Acceptance:** open the page against the live petvetbid memory store, exercise every control, document outcomes in `T1-graph-audit-report.md`. Add e2e tests for any control without coverage. Fix anything broken. | `packages/client/public/graph.html`, `graph.js`, `graph-controls.js`, `style.css` (graph rules); server endpoints `GET /api/graph/nodes`, `GET /api/graph/edges`, `POST /api/memory_recall_graph`; tests `tests/graph-controls.test.js`, `graph-routes.test.js`, `graph-inference.test.js`, `memory_recall_graph.test.js`. NEW `tests/graph-viewer-e2e.test.js` if e2e gaps found. NEW `docs/sprint-46-dashboard-audit/T1-graph-audit-report.md`. |
| **T2 — Flashback history audit** | Confirm `/flashback-history.html` works end-to-end: time-window filter (24h/7d/30d/all) returns correct rows, 3-tier funnel (fires → dismissed → clicked-through) numbers match SQLite source-of-truth, dismiss + click-through buttons round-trip via `POST /api/flashback/:id/{dismissed,clicked}` and update the row, zero-state message renders sensibly when no fires exist, links to source sessions resolve. Sprint 39 in-memory ring + Sprint 43 T2 SQLite persistence + Sprint 43 T2 funnel dashboard all in scope. The known follow-up flagged by Sprint 43 T2 — client-side `triggerProactiveMemoryQuery` path at `app.js:543` does NOT write to `flashback_events` — gets a verdict (fix in this sprint, defer to 47, or leave as documented limitation). **Acceptance:** outcomes documented in `T2-flashback-audit-report.md`; any broken control fixed; missing e2e coverage added. | `packages/client/public/flashback-history.html`, `flashback-history.js`; server endpoints `GET /api/flashback/history`, `POST /api/flashback/:id/dismissed`, `POST /api/flashback/:id/clicked`; SQLite `flashback_events` table; `packages/server/src/flashback-diag.js`; tests `tests/flashback-events.test.js`, `flashback-e2e.test.js`, `flashback-diag.test.js`, `flashback-production-flow.test.js`. NEW `docs/sprint-46-dashboard-audit/T2-flashback-audit-report.md`. |
| **T3 — Transcripts panel audit** | Confirm the transcripts overlay (injected into the topbar by `app.js:4340`) works end-to-end: "Recent" tab populates from `/api/transcripts/recent?minutes=60`, "Search" tab works against `/api/transcripts/search?q=…` with FTS, clicking into a session loads ordered chunks via `/api/transcripts/:sessionId`, copy-to-clipboard button populates the OS clipboard, "Back" button returns from session-detail to list view, "Close" button dismisses the overlay cleanly. Cross-check the panel against Sprint 45 T4's launcher refactor — the launcher code shares helpers with the panel rendering and could have introduced regressions. **Acceptance:** outcomes documented in `T3-transcripts-audit-report.md`; broken paths fixed; missing e2e coverage added. | `packages/client/public/app.js:4340-4660` (transcript panel injection + tabs + session loader + search); server `packages/server/src/transcripts.js`; routes at `packages/server/src/index.js:1550-1640` (search/recent/session-id); tests `tests/transcript-contract.test.js`. NEW `docs/sprint-46-dashboard-audit/T3-transcripts-audit-report.md`. NEW `tests/transcripts-panel-e2e.test.js` if e2e gaps found. |
| **T4 — Quick-launchers + topbar UX cross-cut** | Confirm the three topbar quick-launch buttons (`shell` / `claude` / `python`) actually spawn correctly via `quickLaunch(cmd)` at `app.js:1577` against today's adapter-driven launcher (Sprint 45 T4 refactored this path). Confirm the dashboard's main launcher input (free-form command) routes through the same `AGENT_ADAPTERS.matches` path correctly for each of the four CLIs. Confirm the topbar's right-hand button ROW renders consistently across themes (tokyo-night, light, etc.) and viewport widths. Confirm there are no orphaned / dead buttons (e.g. references to a feature that was removed). Confirm tooltips are accurate. Cross-check the parity-row index.html quick-launch tile (`index.html:90+`, the larger empty-state tiles) against the topbar mini-buttons — both paths should behave identically. **Acceptance:** outcomes documented in `T4-topbar-audit-report.md`; any UI defect fixed; theme parity verified. | `packages/client/public/index.html` topbar + empty-state quick-launch tiles; `packages/client/public/app.js:1577` (`quickLaunch`), launcher refactor at `app.js:2422-2520`; `packages/server/src/agent-adapters/*` (registry consumed by launcher); CSS in `packages/client/public/style.css`. NEW `docs/sprint-46-dashboard-audit/T4-topbar-audit-report.md`. NEW `tests/quick-launch-e2e.test.js` if e2e gaps found. |

## Out of scope (Sprint 47+)

- **Mixed 4+1** — per-lane `agent: claude|codex|gemini|grok` field in PLANNING.md frontmatter, per-agent boot prompts, inject script extension, cross-agent STATUS.md merger. The original Sprint 46 plan; deferred so the audit can land first. Sprint 47 picks this up if Joshua returns to TermDeck after the other-projects push.
- **Grok memory-hook SQLite extraction.** Sprint 45 T3 supplied `parseTranscript`; the hook layer needs to query `~/.grok/grok.db` and synthesize a JSONL feed. Sprint 47+ candidate (or earlier patch).
- **Upstream rumen `createJob.started_at` patch** — cross-repo work, needs its own `@jhizzard/rumen` patch release. The TermDeck-side `COALESCE(started_at, completed_at)` workaround shipped in Sprint 45 makes this non-urgent.
- **`mnestra doctor` subcommand** — Brad's third upstream suggestion 2026-04-28. Still queued.
- **Sprint 40 candidates** still in CHANGELOG `[Unreleased]` § Planned: harness session-end hook PROJECT_MAP forward-fix, analyzer broadening (uppercase ERROR / lowercase ENOENT / HTTP 5xx false-negative gaps), LLM-classification pass on the ~898 chopin-nashville-tagged "other/uncertain" rows.
- **TheHarness as a TermDeck lane agent** — Sprint 47+ candidate per the multi-agent design memorialization.

## Side-tasks for the orchestrator (during sprint, NOT in any lane)

These are off-lane orchestrator responsibilities, addressed during sprint execution alongside the four lanes:

1. **Cross-lane audit roll-up** — `docs/sprint-46-dashboard-audit/AUDIT-FINDINGS.md` aggregates the four T*-audit-report.md files into a single executive summary with a triage table (works / fixed-this-sprint / deferred-to-Sprint-47). Owned by orchestrator at sprint close.
2. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh** post-publish if any audit finding affects user-facing UX (e.g. a known limitation worth flagging to Brad-tier testers). Pin to v0.15.0 (or v0.14.1) versions.
3. **Sprint 47 stub plan** — `docs/sprint-47-mixed-4plus1/PLANNING.md` skeleton that re-anchors the deferred mixed-4+1 work so the next session has a clean starting point. Lane briefs not authored, just the sprint frame.

## Acceptance criteria

1. **T1:** every graph-viewer control documented as works / broken / sub-optimal in `T1-graph-audit-report.md`. All "broken" findings either fixed in this sprint or explicitly deferred with a Sprint 47+ note. E2e tests added for any control found to lack coverage.
2. **T2:** every flashback-history control documented in `T2-flashback-audit-report.md`. The known client-side `triggerProactiveMemoryQuery` audit-write gap from Sprint 43 T2 gets a verdict (fix / defer / document-as-limitation). Funnel numbers cross-checked against SQLite source-of-truth.
3. **T3:** every transcripts-panel control documented in `T3-transcripts-audit-report.md`. Cross-check against Sprint 45 T4's shared helpers — any regression introduced by the launcher refactor surfaced and fixed.
4. **T4:** quick-launcher buttons spawn correctly for all three (shell / claude / python). Free-form launcher routes through registry correctly for all four CLIs (claude / codex / gemini / grok). Theme parity verified across at least 2 themes. Tooltip accuracy verified.
5. **Side-tasks:** rolled-up `AUDIT-FINDINGS.md` posted; INSTALL doc updated if needed; Sprint 47 stub plan dropped.
6. **Net:** all four lanes ship in ≤ 25 minutes wall-clock. Sprint 41 = 9 min; 42 = 12; 43 = 17; 44 = 11; 45 = 16. Audit lanes should land within band — they're focused investigation + small fixes, not cross-cutting refactors.
7. **No regressions:** full root suite stays at 0 fail (was 737 / 734 pass / 3 skipped at Sprint 45 close). New e2e tests added cleanly, existing 734 stay green.

## Pre-sprint substrate findings (orchestrator probe at sprint kickoff — re-run before injecting)

```bash
# 1. Confirm Sprint 45's bumps are published
npm view @jhizzard/termdeck version           # expect 0.14.0
npm view @jhizzard/termdeck-stack version     # expect 0.4.9

# 2. Verify TermDeck server alive on :3000
curl -s http://127.0.0.1:3000/api/sessions | head -1
# expect: a JSON array (possibly empty) with HTTP 200

# 3. Verify dashboard pages render
curl -sI http://127.0.0.1:3000/graph.html | head -1
curl -sI http://127.0.0.1:3000/flashback-history.html | head -1
# expect: HTTP/1.1 200 OK on each

# 4. Verify the four agent adapters are registered (Sprint 45 T4 endpoint)
curl -s http://127.0.0.1:3000/api/agent-adapters | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
# expect: 4

# 5. Verify Rumen + graph-inference crons still active (since graph viewer depends on populated edges)
set -a; source ~/.termdeck/secrets.env; set +a
PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql
$PSQL "$DATABASE_URL" -At -c "SELECT jobname, active FROM cron.job WHERE jobname IN ('rumen-tick','graph-inference-tick');"
# expect: rumen-tick|t  AND  graph-inference-tick|t

# 6. Verify SQLite flashback_events table exists (Sprint 43 T2)
sqlite3 ~/.termdeck/termdeck.db ".schema flashback_events" | head -3
# expect: CREATE TABLE flashback_events ...

# 7. Spot-check current row counts (informational baseline before audit)
sqlite3 ~/.termdeck/termdeck.db "SELECT count(*) AS flashback_events FROM flashback_events;"
$PSQL "$DATABASE_URL" -At -c "SELECT count(*) AS memory_items, count(DISTINCT project) AS projects FROM memory_items;"
$PSQL "$DATABASE_URL" -At -c "SELECT count(*) AS edges FROM memory_relationships;"
```

If any fail, flag to Joshua before injecting.

## Inject readiness

When Joshua signals "go, inject":

1. Orchestrator session (running in a `claude-tg` Telegram-listening panel) confirms 4 fresh sessions exist via `GET /api/sessions` sorted by `meta.createdAt`.
2. Orchestrator runs `node docs/sprint-46-dashboard-audit/scripts/inject-sprint46.js` with the four session UUIDs in `SPRINT46_SESSION_IDS` env var. (Inject script not yet authored; clone-and-rename from `docs/sprint-45-multi-agent-adapters/scripts/inject-sprint45.js` with lane-specific topic strings.)
3. Two-stage submit pattern (paste-then-submit, no manual Enter) — same as Sprint 42–45.
4. After 8s verify: all four panels should show `status=thinking` or `status=active "Using tools"`. Any genuinely-stuck panel triggers `/poke cr-flood` recovery.

## Coordination notes

- **T1 ↔ T2 ↔ T3 ↔ T4 are independent** — each touches a different surface (graph / flashback / transcripts / topbar). No shared file overlap except `app.js`, where T3 owns the transcripts-panel block (lines ~4340–4660) and T4 owns the launcher block (lines ~1577 + ~2422–2520). T3 + T4 should coordinate any shared-helper refactor at sprint close (orchestrator merges).
- **Audit reports go in dedicated files** (`T1-graph-audit-report.md` etc.), NOT inline in STATUS.md. STATUS.md gets the FINDING / FIX-PROPOSED / DONE markers + one-line summaries; the detailed walkthrough lives in the audit reports so they're discoverable forever.
- **Lanes test against the live petvetbid memory store and live SQLite** — no test fixtures or stubs for the actual audit (e2e is e2e). Hermetic unit tests added on top are fine, but the audit verdict is "did this work in a browser today, against real data."
- **Browser:** Chromium (Joshua's daily driver) is the canonical target. Firefox + Safari spot-check at orchestrator's discretion if a CSS-related defect is found.
- **Side-task `AUDIT-FINDINGS.md`** is orchestrator-only, runs at sprint close after all four lanes post DONE.

## Joshua's roadmap context (2026-05-01)

Sprint 46 is **a defensive sweep** before Joshua moves on to other projects. After this lands:
- Sprint 47+ candidates (when Joshua returns to TermDeck): mixed 4+1 (per-lane agent assignment), Grok memory-hook SQLite extraction, mnestra doctor subcommand, TheHarness as a TermDeck lane agent.
- This sprint is also the natural inflection for **v1.0.0 consideration** if all four lanes find clean state. Multi-agent + cron + observability + dashboard-audited reads as production-ready for outside users. Joshua decides at sprint close.

When Sprint 46 closes, Joshua's expected to pivot away from TermDeck for some weeks — TheHarness, BHHT, or other queue items. The audit gives Brad-tier testers a known-clean dashboard to land on while the maintainer is heads-down elsewhere.

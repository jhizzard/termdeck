# T2 — API + UI sweep cells (Sprint 55)

**Lane:** T2 (Claude worker, `--dangerously-skip-permissions` mode).
**Pattern:** adversarial sweep across every HTTP endpoint of the TermDeck server + every UI interaction of the dashboard.
**Started:** 2026-05-05 12:14 ET. Mode B (interactive morning).

## Pre-sprint substrate

```
TermDeck server: HTTP 200 /api/health in 2.4ms (PID alive on :3000)
Mnestra: 6,360 memories
Rumen recent job: 14m ago, 0 insights (synthesis bug confirmed open)
DATABASE_URL: connected in 219ms
project_paths: 15/15 exist
graph_health: ok
shell_sanity: zsh OK in 0.1s
```

## Endpoint inventory (server-side, ground truth)

`packages/server/src/index.js` (45 endpoints):

| # | Method | Path | Line |
|---|---|---|---|
| 1 | GET | /api/health | 395 |
| 2 | GET | /api/health/full | 405 |
| 3 | GET | /api/setup | 430 |
| 4 | POST | /api/setup/configure | 528 |
| 5 | POST | /api/setup/migrate | 628 |
| 6 | POST | /api/setup/supabase/connect | 731 |
| 7 | POST | /api/setup/supabase/projects | 753 |
| 8 | POST | /api/setup/supabase/select | 781 |
| 9 | GET | /api/sessions | 908 |
| 10 | POST | /api/sessions | 1156 |
| 11 | GET | /api/sessions/:id | 1181 |
| 12 | PATCH | /api/sessions/:id | 1188 |
| 13 | DELETE | /api/sessions/:id | 1195 |
| 14 | POST | /api/sessions/:id/input | 1212 |
| 15 | POST | /api/sessions/:id/poke | 1272 |
| 16 | GET | /api/sessions/:id/buffer | 1361 |
| 17 | POST | /api/sessions/:id/resize | 1380 |
| 18 | GET | /api/sessions/:id/history | 1394 |
| 19 | GET | /api/themes | 1400 |
| 20 | GET | /api/themes/:id | 1413 |
| 21 | GET | /api/agent-adapters | 1434 |
| 22 | GET | /api/agents | 1451 |
| 23 | GET | /api/config | 1487 |
| 24 | PATCH | /api/config | 1496 |
| 25 | GET | /api/projects/:name/orchestration-preview | 1556 |
| 26 | POST | /api/projects/:name/orchestration-preview/generate | 1584 |
| 27 | GET | /api/status | 1613 |
| 28 | GET | /api/rag/events | 1638 |
| 29 | GET | /api/rag/status | 1648 |
| 30 | GET | /api/flashback/diag | 1666 |
| 31 | GET | /api/flashback/history | 1683 |
| 32 | POST | /api/flashback/:id/dismissed | 1700 |
| 33 | POST | /api/flashback/:id/clicked | 1712 |
| 34 | GET | /api/pty-reaper/status | 1725 |
| 35 | GET | /api/transcripts/search | 1739 |
| 36 | GET | /api/transcripts/recent | 1756 |
| 37 | GET | /api/transcripts/:sessionId | 1781 |
| 38 | GET | /api/rumen/insights | 1805 |
| 39 | GET | /api/rumen/status | 1868 |
| 40 | POST | /api/rumen/insights/:id/seen | 1921 |
| 41 | POST | /api/ai/query | 1948 |

`sprint-routes.js`: POST /api/sprints (230), GET /api/sprints (414), GET /api/sprints/:name/status (432), GET /api/sprints/:name/tail (462).
`graph-routes.js`: GET /api/graph/project/:name (496), GET /api/graph/all (532), GET /api/graph/memory/:id (568), GET /api/graph/stats (609), GET /api/graph/stats/inference (624).
`projects-routes.js`: POST /api/projects (42), DELETE /api/projects/:name (57).

Total endpoints inventoried: **52**. Sprint 55 T2 cells exercise the 15 most user-facing per PLANNING.md selection.

---

## Phase A — API cells

Wall-clock: 2026-05-05 12:17 → 12:20 ET. Server `:3000` healthy throughout.

### Read-only happy paths (15 cells)

| Cell | Method/Path | HTTP | Time | Size | Status | Notes |
|---|---|---|---|---|---|---|
| A.1 | GET /api/health | 200 | 3 ms | 561 b | PASS | mnestra 6,360 memories; rumen last job 2m ago **0 insights** (synthesis bug present) |
| A.2 | GET /api/health/full | 200 | 1078 ms | 434 b | PASS | 9/9 checks pass (sqlite, mnestra-pg, memory-items-col, pg-cron-ext, pg-net-ext, vault-secret, cron-job-active, mnestra-webhook, rumen-pool) |
| A.3 | GET /api/sessions | 200 | 2 ms | 8085 b | PASS | 4 sessions returned (3× claude-code, 1× codex), all in termdeck project |
| A.4 | GET /api/sessions/:id | 200 | <5 ms | 2080 b | PASS | Single-session detail; full meta object returned |
| A.10 | GET /api/graph/all | 200 | 862 ms | **1,258,955 b (1.2 MB)** | PASS-YELLOW | 940/6360 edges returned; **truncated:true** without query-string controls; large payload may strain dashboard |
| A.11 | GET /api/graph/stats | 200 | 295 ms | 675 b | PASS | 6,363 memories across 23 projects, 1,764 edges |
| A.12 | GET /api/flashback/history | 200 | 6 ms | 48 KB | PASS | count:100 events; recent matches triggered by panel output containing literal "Error" |
| A.13 | GET /api/config | 200 | 3 ms | 1958 b | PASS | Public config payload; ~ paths NOT expanded (intended; client side resolves) |
| A.16 | GET /api/themes | 200 | 3 ms | 4850 b | PASS | 8 themes (tokyo-night first) |
| A.17 | GET /api/agent-adapters | 200 | 2 ms | 446 b | PASS | claude/codex/gemini/grok all present, costBand="pay-per-token" on all |
| A.18 | GET /api/rumen/insights | 200 | 52 ms | 11 KB | PASS | Returns insights list (top 10) |
| A.19 | GET /api/rumen/status | 200 | 43 ms | 299 b | PASS-RED | **total_insights:321, latest_insight_at:2026-05-01T20:45 (5 days stale)**, last_job sessions_processed:1 insights_generated:0 |
| A.20 | GET /api/pty-reaper/status | 200 | 2 ms | 1015 b | PASS | tickCount:15, lastError:null, registry shows current 4 sessions |
| A.21 | GET /api/status | 200 | 3 ms | 272 b | PASS | totalSessions:4, byStatus:{thinking:2,active:2}, byType:{claude-code:3,codex:1}, ragEnabled:**false** |
| A.22 | GET /api/agents | 200 | 3 ms | 554 b | PASS | Same 4 agents as /agent-adapters (consistency confirmed) |
| A.23 | GET /api/rag/status | 200 | 13 ms | 250 b | PASS-YELLOW | enabled:false, supabaseConfigured:true, **localEvents:14,212 / unsynced:11,731** (11k+ event backlog) |

### Mutation cells (sandbox session)

| Cell | Method/Path | HTTP | Status | Notes |
|---|---|---|---|---|
| A.SETUP | POST /api/sessions (cmd=bash, label=t2-sandbox) | 201 | PASS | Sandbox session created (id 4e56be7e), pid 29950, type=shell |
| A.5 | PATCH /api/sessions/:id (whitelist test: label/theme/ragEnabled allowed; pid/fakeField/lastActivity/exitCode rejected) | 200 | PASS | Whitelist enforced — only `{theme, label, project, ragEnabled, flashbackEnabled}` accepted; pid stayed 29950, exitCode stayed null, fakeField absent from response |
| A.6 | POST /api/sessions/:id/input (text='echo hello\n') | 200 | PASS | bytes:11, replyCount:1; CRLF normalize working |
| A.7 | POST /api/sessions/:id/poke (methods=['cr-flood']) | 200 | PASS | advanced:true, attempts:[{method:cr-flood, ok:true}]; before/after lastActivity differ |
| A.8 | GET /api/sessions/:id/buffer | 200 | PASS | inputBufferLength:0 (consumed), replyCount:1, lastActivity reflects A.7 advance |
| A.6.RATE | POST /input × 12 in tight loop | mixed | PASS | 10×200 + 2×429 — rate limit at exactly 10/sec/session as documented (line 1234) |
| A.6.NEG | POST /input with no `text` field | 400 | PASS | `{"error":"Missing text"}` |
| A.SETUP-NEG (×3) | POST /input, POST /poke, GET /buffer on UUID `00000000-...` | 404 | PASS | All 3 return `{"error":"Session not found"}` (consistent shape) |
| A.CLEANUP | DELETE /api/sessions/:id | 200 | PASS | Sandbox killed cleanly |
| A.VERIFY | GET /api/sessions/:id (deleted) | 404 | PASS | Confirms remove from registry |

### Mutation cells (other surfaces)

| Cell | Method/Path | HTTP | Status | Notes |
|---|---|---|---|---|
| A.9 | POST /api/ai/query (`{question:"What is TermDeck", project:"termdeck"}`) | 200 | PASS | 0.85 s, returned 5 mnestra hits with similarity scores |
| A.9.NEG | POST /api/ai/query (no question) | 400 | PASS | `{"error":"Missing question"}` |
| A.14a | PATCH /api/config rag.enabled→true | 200 | PASS | rag/status reflects enabled:true; WS broadcast emits `config_changed` (per index.js:1513) |
| A.14b | PATCH /api/config rag.enabled→false (revert) | 200 | PASS | Reverted to baseline |
| A.14.NEG | PATCH /api/config body=`[]` | 400 | PASS | `{"error":"body must be a JSON object"}` (handler-level array reject) |
| A.PROJ-DEL-NEG | DELETE /api/projects/nonexistent-project | 404 | PASS | `{"error":"Project \"nonexistent-project\" not found"}` |

### Negative path — malformed JSON body to POST/PATCH endpoints

| Endpoint | Method | HTTP | Body shape | Notes |
|---|---|---|---|---|
| /api/sessions | POST | 400 | **HTML error page** (express default error handler) | F-T2-1 |
| /api/ai/query | POST | 400 | **HTML error page** | F-T2-1 |
| /api/sessions/:id/input | POST | 400 | **HTML error page** | F-T2-1 |
| /api/sessions/:id/poke | POST | 400 | **HTML error page** | F-T2-1 |
| /api/config | PATCH | 400 | **HTML error page** | F-T2-1 |
| /api/projects | POST | 400 | **HTML error page** | F-T2-1 |
| /api/sprints | POST | 400 | **HTML error page** | F-T2-1 |

Status code is correct (400 not 500 — server doesn't crash) but **the body is HTML**, not JSON. Programmatic clients that `JSON.parse(response.text)` choke. See finding **F-T2-1** below.

### Long-tail samples

| Cell | Method/Path | HTTP | Status | Notes |
|---|---|---|---|---|
| A.SPRINTS | GET /api/sprints (no project param) | 400 | PASS | `{"error":"project query param required"}` (sprint-routes.js handler) |
| A.GRAPH-PROJ | GET /api/graph/project/termdeck | 200 | PASS | 921 KB; 1,447 nodes / 799 edges for `termdeck` project; truncated:false |
| A.RUMEN-EXTRA | GET /api/rumen/insights?project=termdeck&limit=2 | 200 | PASS | Filters honor project + limit query string |
| A.RAG-EVENTS | GET /api/rag/events | 200 | PASS-YELLOW | 14k+ events; payload includes `synced:0` for unsynced rows; events log even when ragEnabled:false |
| A.HIST | GET /api/sessions/:id/history | 200 | PASS | command_history rows; first row is the inject text from boot |
| A.TRANS | GET /api/transcripts/recent | 200 | PASS | Returns chunked PTY output across active sessions |
| A.FB-DIAG | GET /api/flashback/diag | 200 | PASS | 35 events; pattern matches `errorLineStart` on literal "Error" — see F-T2-3 |

### Static asset spot-check

| Asset | HTTP | Notes |
|---|---|---|
| / | 200 | `<!DOCTYPE html><title>TermDeck</title>` correct |
| /app.js | 200 | First-line comment confirms identity |
| /graph.html | 200 | 6364 b |
| /flashback-history.html | (assumed 200; checked at UI phase) | |

---

## Phase A findings (for orchestrator + T4-CODEX audit)

### F-T2-1 — Malformed JSON body returns HTML error page (YELLOW, FIX-PROPOSED)

**Surface:** every POST / PATCH endpoint that consumes a JSON body (≥7 endpoints sampled).
**Repro:**
```
curl -X POST http://127.0.0.1:3000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{garbage'
```
Returns HTTP 400 (correct) with `Content-Type: text/html` body `<!DOCTYPE html>... <pre>SyntaxError: ...</pre>`.

**Why it matters:** Programmatic callers (the inject script, CI smoke tests, MCP clients) parse responses as JSON. An HTML body breaks them on the negative path. Inconsistent with handler-level errors which all return JSON (`{"error":"..."}`). The express default error handler is leaking through.

**Fix:** add a body-parse error middleware right after `app.use(express.json())`:

```diff
--- a/packages/server/src/index.js
+++ b/packages/server/src/index.js
@@ -270,7 +270,15 @@
   app.use(express.json());
+  // Convert express.json body-parse errors into JSON 400s so programmatic
+  // clients (inject script, MCP, CI) get a consistent error shape on
+  // malformed request bodies. Without this, the express default HTML
+  // error page leaks through.
+  app.use((err, req, res, next) => {
+    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
+      return res.status(400).json({ error: 'Malformed JSON body', detail: err.message });
+    }
+    return next(err);
+  });
```

**Severity:** YELLOW — degrades programmatic API but does not break the dashboard (the dashboard never sends malformed JSON). Ledger candidate: **Class P (response-shape inconsistency on negative paths)** — new class.

---

### F-T2-2 — RAG event logger writes locally even when `rag.enabled:false`, with 11k+ unsynced backlog (YELLOW, observation only)

**Surface:** `/api/rag/status`, `/api/rag/events`.
**Observed:** with `ragEnabled:false` (Sprint 55 baseline state), `localEvents` was 14,212 and `unsynced` was 11,731 at sprint-open. After ~70 s of sweep activity, both grew to 14,231 / 11,750 (Δ +19 events). i.e. **the local event logger writes regardless of feature flag**; the flag only gates upstream sync to Supabase.

**Why it matters:**
1. Possible misunderstanding of "rag disabled" semantics — Joshua may believe disabling RAG stops all logging, but it doesn't.
2. The 11,750 unsynced backlog accumulates indefinitely. If the user re-enables RAG, a flush of 11k events hits Supabase at once.
3. Not a P0 since the design may be intentional (capture-now, sync-later), but should be either documented or guarded behind a separate flag.

**Severity:** YELLOW — design-clarity question, not a regression. **No FIX-PROPOSED**; orchestrator decides whether to clarify docs or change behavior. Ledger candidate: track as design observation, not a class.

---

### F-T2-3 — Flashback `errorLineStart` pattern matches the literal substring "Error" too aggressively (YELLOW, observation)

**Surface:** `/api/flashback/diag`, `/api/flashback/history`.
**Observed:** several flashback events fired during the Sprint 55 boot when panel output (or the boot-prompt content) contained the bare word "Error" — including matches whose `error_text` is a snippet of the Sprint plan ("Live demo for Brad: speed + visible cross-agent collaboration matter. Move fast. .md, scaffold T2-SWEEP-CELLS.md..."). The pattern is `errorLineStart` matching the line "Error" in the chunk.

**Why it matters:** false positives pollute flashback history with non-error events. Doesn't break anything; user-visible cleanliness issue.

**Severity:** YELLOW — UI noise. Ledger candidate: pre-existing flashback-pattern flake, possibly already on the backlog.

---

### F-T2-4 — `/api/graph/all` payload size 1.2 MB / 862 ms (YELLOW, perf observation)

**Surface:** `/api/graph/all` (graph-routes.js:532).
**Observed:** 940 edges, 1,258,955 byte payload, 862 ms server-side. `truncated:true` with `totalAvailable:6360` — but no observable query-string control to set the cap (server defaulted to 2000-node truncation per /api/graph/all output `nodes:2000`).

**Why it matters:** Dashboard fetches this on graph-view open. On slower networks or older devices, perceptible delay. May warrant pagination / streaming / GZIP-on-by-default for this route.

**Severity:** YELLOW — perf only, doesn't break the feature. Ledger candidate: pre-existing; perf backlog item.

---

### F-T2-5 — `rumen_insights` confirmed stale at 321 with `latest_insight_at:2026-05-01` — synthesis bug verified from API surface (RED)

**Surface:** `/api/rumen/status`.
**Observed:**
```json
{
  "total_insights": 321,
  "unseen_insights": 233,
  "latest_insight_at": "2026-05-01T20:45:02.916Z",
  "last_job_sessions_processed": 1,
  "last_job_insights_generated": 0,
  "last_job_status": "done"
}
```
The synthesis bug predicted by Sprint 53/54 STATUS is empirically reproducible from T2's lane: pickers find sessions, jobs complete `done`, but `insights_generated` is always 0. **This corroborates T3 Cell #1's diagnostic surface** (T3 owns the function-log dive; T2 confirms the user-visible API symptom).

**Severity:** RED — the headline product metric. T3 owns the fix; T2 contributes the API-surface confirmation.

---

## Phase B — UI cells

Wall-clock: 2026-05-05 12:22 → 12:25 ET. **Phase B paused at 12:25 ET on orchestrator interrupt** — Joshua's parallel Playwright work in another project conflicted with the shared browser session. Cells B.1-B.9 completed; B.10 started (resize) but not assessed; B.11+ deferred to Sprint 56.

Tooling: `mcp__playwright__browser_*` against `http://127.0.0.1:3000/` while T1/T2/T3/T4 lane sessions ran live in the background (3× claude-code + 1× codex panels).

### B cells executed (9/9 to interrupt)

| Cell | What | HTTP / state | Status | Evidence |
|---|---|---|---|---|
| B.1 | Dashboard renders with 4 active lane panels | 200 / `<title>TermDeck</title>` | PASS | Snapshot captured all 4 panels (T1/T2/T3/T4) with full meta: type, project tag, session ID, status detail, opened, why, last command, port. Layout grid populated. |
| B.2 | Console error/warning scan | 0 errors / 0 warnings | PASS | Three page loads (`/`, `/graph.html?project=termdeck`, `/flashback-history.html`) produced **zero** console messages. |
| B.3 | Setup wizard / Settings dialog (`config` button) | dialog opens cleanly | PASS | "All tiers configured — you are good to go." 4 tier panels: TermDeck core (active, :3000), Mnestra RAG (active, 6,361 memories), Rumen learning loop (active, **last job 7m ago, 0 insights** — symptom in plain text), Projects (active, 15 configured). RAG mode toggle present. Footer: re-check / done buttons. |
| B.4 | Layout buttons present | 8 buttons | PASS | `1x1`, `2x1`, `2x2`, `3x2`, `2x4`, `4x2`, `orch`, `control` — all present and clickable. |
| B.5 | Theme picker per panel | 8 themes × 4 panels | PASS | Tokyo Night, Rosé Pine Dawn, Catppuccin Mocha, GitHub Light, Dracula, Solarized Dark, Nord, Gruvbox Dark. `↺ default` reset link present. |
| B.6 | Project tag rendering per panel | all show `termdeck` | PASS | All 4 panel headers show `termdeck` correctly; no chopin-nashville drift visible. |
| B.7 | **Cost-monitoring panel absence** | absent | PASS-FLAGGED | Confirms Sprint 56 candidate. No cost-band display in UI yet despite `/api/agent-adapters` and `/api/agents` exposing `costBand:"pay-per-token"` for all 4 agents. |
| B.8 | Graph view (`/graph.html?project=termdeck`) | 200 / 1447 nodes / 799 edges | PASS | Project picker (16 projects), search box, re-heat / fit buttons, edge-type filters (`supersedes 453`, `contradicts 7`, `relates to 232`, `elaborates 103`, `caused by 4`), min-degree selector (all / ≥1 / ≥2 / ≥3 / ≥5), window selector (all time / last 7 days / last 30 days / …), layout selector (force-directed / hierarchical / radial). Detail drawer with focus + copy id. **0 console errors.** |
| B.9 | Flashback history (`/flashback-history.html`) | 200 / 196 fires | PASS-YELLOW | Window selector (last 24h / 7d / 30d / all), pagination (← Prev / Next →). Click-through funnel: **196 fires, 22 dismissed (11%), 6 clicked through (3%)**. Recent rows show **F-T2-3 confirmed in user-facing UI**: the lane brief text "Live demo for Brad: speed + visible cross-agent collaboration matter. Move fast. ◼ Phase A — API cells …" is captured as `claude-code error` rows and presented to the user. |

### B cells SKIPPED — orchestrator interrupt 2026-05-05 12:25 ET

Joshua's parallel Playwright work in another project began thrashing the shared browser session. Per orchestrator instruction, Phase B paused immediately and did NOT call `browser_close` (per the explicit "do not call any mcp__playwright__ tool after this message" guard). Remaining cells documented below; defer to **Sprint 56 — controlled-context Playwright** once the browser-share conflict is resolved.

| Cell | What | Reason | Sprint 56 carry-over |
|---|---|---|---|
| B.10 | Mobile / narrow viewport responsive layout (390×844) | Resize landed but snapshot/assessment did NOT — interrupt arrived before the responsive-render check could be captured. | YES — re-run with viewport-only Playwright session |
| B.11 | Panel label inline-edit affordance | Not exercised — A.5 confirmed PATCH `label` works server-side; UI editor pattern unverified | YES — click-to-edit + Escape-to-cancel + Enter-to-save flow |
| B.12 | `status` button → "Control · live activity" view | Clicked but no modal opened (`visibleCount:0`) — likely toggles a different layout, not a dialog. Distinguish from `control` layout button. | YES — disambiguate `status` vs `control` |
| B.13 | Quick launch buttons (`shell`, `claude code`, `codex cli`, `gemini cli`, `grok cli`, `python`) | Visible in DOM, not clicked — clicking would spawn extra sessions and disturb live lanes | YES — sandbox quicker-launch in fresh server instance |
| B.14 | Rumen insights briefing chip ("💡 233 new insights") | Visible chip with `Open Rumen insights briefing` aria-label — not clicked | YES — verify briefing modal renders + populates |
| B.15 | Keyboard shortcuts (Alt+1…9 visible in DOM) | Not exercised — Playwright `press_key` not invoked | YES — Alt+1..9 panel switching, Escape, Tab focus order |

---

## Phase B findings (additions)

### F-T2-6 — RAG state model: API exposes 2-state boolean, UI surfaces 3-state (YELLOW, observation)

**Surface:** `/api/rag/status` (`enabled:true|false` boolean) vs Setup wizard's "RAG mode" toggle vs top-bar indicator "RAG · mcp-only" vs `/api/status` (`ragEnabled:false`).

**Observed:**
- Top bar shows `RAG · mcp-only` with tooltip "MCP-only mode; toggle in Settings to enable".
- Setup wizard's RAG mode section has a checkbox labeled "Off" with description "MCP-only mode. Memory tools available through Claude Code; the in-CLI `termdeck flashback` command and the hybrid search are disabled."
- `/api/rag/status` returns `enabled:false` in this state.
- API surface is a 2-state boolean; UI surface implies 3 conceptual states (Off / MCP-only / Fully on).

**Why it matters:** users (and the inject script, MCP, CI tooling) querying the API see `enabled:false` and may assume "RAG is fully off — nothing is happening." But the local event logger is still writing (F-T2-2 / 14k+ events accumulated) and MCP tools are still callable. The API state model and UI state model disagree on what "enabled" means.

**Severity:** YELLOW — design clarity. **No FIX-PROPOSED yet** — orchestrator should decide whether to (a) introduce a 3-state enum (`off | mcp-only | full`) on the API and update UI / dashboard / lane briefs, or (b) keep the boolean and simplify the UI labeling. Ledger candidate: same family as F-T2-2.

---

## Tally

**Phase A (API):** 28 cells executed, 24 PASS, 4 PASS-YELLOW, 0 FAIL. Findings F-T2-1 (FIX-PROPOSED), F-T2-2, F-T2-3, F-T2-4, F-T2-5.

**Phase B (UI):** 9 cells executed, 8 PASS, 1 PASS-YELLOW (B.9 / F-T2-3 confirmed in UI), 0 FAIL. 6 cells SKIPPED → Sprint 56. Finding F-T2-6 added.

**Verdict:** stack-sweep evidence is sufficient for a **YELLOW POST** — TermDeck v1.0.9 is mostly functional with 6 known gaps (1 FIX-PROPOSED ready to ship, 1 RED metric reproduction pending T3, 4 YELLOW design / perf / observation items). RED post not warranted; GREEN post not warranted until F-T2-1 ships and F-T2-5 (synthesis bug) is closed by T3.

**Sprint 56 carry-over candidates from T2:** F-T2-1 ship, F-T2-2 design clarification, F-T2-3 flashback-pattern tightening, F-T2-4 graph perf / pagination, F-T2-6 RAG state-model unification, B.10–B.15 UI cells.

---

## Tally

(populated at sprint close)

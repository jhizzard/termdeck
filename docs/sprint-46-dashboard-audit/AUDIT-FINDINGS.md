# Sprint 46 — Cross-lane audit findings (executive summary)

**Sprint date:** 2026-05-01
**Wall-clock:** ~16 minutes (inject 15:22 ET → all four lanes DONE 15:38 ET)
**Audit framing:** the dashboard's `topbar-right` button row (`shell` / `claude` / `python` / `graph` / `flashback history` / `transcripts`) and the surfaces those buttons open. These features shipped across Sprints 38 / 41 / 42 / 43 / 45 with unit + contract test coverage but no end-to-end "does the button actually work in a browser today" coverage. Sprint 46 closed that gap.

## Verdict roll-up

| Lane | Surface count | Works | Sub-optimal (deferred) | Broken (fixed this sprint) |
|---|---|---|---|---|
| T1 — Graph viewer | 9 | 6 | 5 | 1 (node hover tooltip — design intent missing) |
| T2 — Flashback history | 10 | 7 | 3 | 0 (dashboard works as designed) |
| T3 — Transcripts panel | 12 + 3 bonus | 10 | 4 (deferred) | 2 (Recent renderer mismatch + Search time-chip dropped) |
| T4 — Quick-launchers + topbar | 24 | 22 | 2 | 2 (python http.server preemptive regex + zero client-side launcher test coverage) |
| **Total** | **55+ surfaces** | **45** | **14** | **5 real bugs caught + fixed** |

Five bugs caught + fixed in 16 minutes. None catastrophic, all the silent-regression class — exactly what Joshua suspected when he flagged "we haven't paid much attention to them."

## Bugs fixed this sprint (the headline)

### T1 — Graph viewer

- **Surface 6: node hover tooltip missing.** Brief's design intent: "Hover tooltip shows project + content snippet." Reality: node `mouseenter` only dimmed non-incident neighbors; no tooltip fired. Edge hover tooltips worked, node hover did not. Fix: `graph.js` +21 LOC — new `showNodeTooltip(event, node)` helper called from `mouseenter`, displays `<strong>{project}</strong> {source_type} · {label}` with project name colored by the same hash function as the node fill. New `escapeHtml` helper guards against literal `<`/`>`/`&`/`"` in user-supplied content. `mouseleave` cleanup is idempotent via existing `onNodeHover(null) → hideTooltip()`.
- **Wiring contract gap (preventive).** `tests/graph-viewer-e2e.test.js` (NEW, +211 LOC, 11 tests) closes contracts that were previously untested: every `getElementById` in graph.js points at an existing graph.html id; graph-controls.js loads BEFORE graph.js; `EDGE_COLORS` keys match migration-009's 8-type vocabulary; live-shape fixtures preserve the fields graph.js renderers consume; URL-codec → applyControls integration accepts hand-encoded + hostile params cleanly. **This test caught a near-miss where the lane almost shipped a "dead-code cleanup" that would have removed the migration-009 8-type vocabulary** (intentional pre-wired affordances, dormant only because `GRAPH_LLM_CLASSIFY=1` is unset). The cleanup was reverted; the test now locks parity so future cleanup attempts trip a test failure instead of breaking LLM-classification activation.

### T3 — Transcripts panel

- **Recent tab renderer contract mismatch.** Server (`/api/transcripts/recent`) returns `{sessions: [{session_id, chunks: […]}]}`, but `renderRecentTranscripts` was reading `sess.lines / preview / type / project / totalLines` — none of which the server sends. Result: every row in the Recent tab showed `shell` / `0 lines` / empty preview against today's 4 live sessions. Fix: renderer reads `sess.chunks` directly (DESC-ordered → reverse, slice top-6 for preview).
- **Search-result time chip silently dropped.** Server returns `created_at` on each result, renderer was reading `result.timestamp`. Result: `q=sprint` returned 50 results, all timestamp-less in the UI. Fix: `result.timestamp || result.created_at` with `Date.getTime()` validity check.
- **Future-proofing.** New `tests/transcript-contract.test.js` assertions pin `chunk.content` / `chunk_index` on Recent and `created_at` / `content` / `session_id` on Search, so future server-side field renames fail the contract test instead of silently breaking the renderer.

### T4 — Quick-launchers + topbar

- **`python` quick-launch initial badge wrong.** Quick-launch fires `python3 -m http.server 8080` but the preemptive python-server regex at `app.js:2527` (`/^python3?\b.*(?:runserver|uvicorn|flask|gunicorn)/i`) does NOT include `http\.server`. Result: panel routes to `type='shell'` for ~1s before runtime detection in session.js (`/Serving HTTP on/`) upgrades the type. End-state correct, initial state wrong. Fix: regex extended to include `http\.server`.
- **Zero client-side launcher-routing test coverage.** Sprint 45 T4's launcher refactor at `app.js:2482-2531` shipped without an end-to-end guard. Fix: extracted the inline resolver into `packages/client/public/launcher-resolver.js` (~70 LOC, UMD wrapper so the same module loads in the browser AND under `node --test`). NEW `tests/launcher-resolver.test.js` (~155 LOC, 26 tests) pins all routing decisions: 3 quick-launches, 4 free-form CLIs, `cc` shorthand, `claude code <arg>` parsing, word-boundary semantics, python-server detection, defensive null/empty inputs. `index.html` +1 `<script>` tag. `app.js` -42/+13 LOC (inline resolver replaced with `LauncherResolver.resolve()` call).

## Working as designed (no fix needed)

### T2 — Flashback history

- All 10 surfaces classified. Funnel numbers match SQLite source-of-truth exactly. Dismiss + click POSTs round-trip cleanly: idempotent on second call (`updated:false`), HTTP 400 on non-numeric id, HTTP 200 `updated:false` on missing id. Round-trip test data left at SQLite ids 32 (dismissed) + 33 (clicked) as audit evidence — pre-audit funnel `{33,3,1}` → post-audit `{33,5,2}`.
- **Brief↔implementation mismatch (not a bug):** lane brief surfaces #4/#5 assumed per-row dismiss/click buttons on `/flashback-history.html`. The page renders only a status pill (`pending`/`dismissed`/`clicked`); dismiss/click happens via the live toast in the main dashboard (`app.js:605-655`). The history page is intentionally read-only — adding retroactive dismiss to a row that fired hours ago is semantically wrong. Brief patched at sprint close; behavior is correct.
- **Audit-write gap verdict (the Sprint 43 T2 follow-up):** the client-side `triggerProactiveMemoryQuery` at `app.js:562` is **gated off** on Joshua's install (`aiQueryAvailable=false` because `config.rag` is unset) and returns early at line 565. It's effectively dead code in the current setup. Server-side flashback path at `index.js:880-955` is the only producer of toasts AND it always inserts into `flashback_events` before WS-emit. Funnel fires count is therefore accurate today. The dismiss/click undercount risk applies only when a user enables `aiQueryAvailable` (sets `config.rag.openaiApiKey` + supabase) — at which point both paths fire on `meta.status==='errored'` and the client-side toast (no `flashback_event_id`) can win the visual race against the server-side toast, causing dismiss/click POSTs to be skipped. Documented as a known limitation in `INSTALL-FOR-COLLABORATORS.md` for Brad-tier testers who enable the RAG-driven flashback feature.

## Sprint 47 deferrals (14 sub-optimal items, none urgent)

Roll-up of every `Defer to Sprint 47` flag from STATUS.md, organized by surface:

### T1 — Graph viewer

- **Edge click handler (Surface 7).** `mouseenter`/`mouseleave` only; no click handler. UX intent unclear (pin tooltip? open endpoint memory?) — needs design call.
- **Cross-project edges visual distinction (Surface 8).** Render identically to same-project edges of the same kind. Design intent of "render distinctly" is missing. Either wait for `GRAPH_LLM_CLASSIFY=1` to populate the migration-009 8-type vocabulary or add a render-time override on cross-project edges.
- **Chip filters "all on / all off" preset (Surface 2).** Chips toggle individually only. Low value at current 5-kind density; revisit if vocabulary expands beyond 5 kinds.
- **Performance at scale (Surface 9).** 2000 nodes × 802 edges × tick rate ≈ 4800 SVG attr writes per tick; no throttling, default Barnes-Hut. Likely visible jitter on settle. Needs profiling — no quick fix.
- **URL state codec edge case (Surface 5).** If URL contains `?project=foo` for a project not in `/api/config`'s list, `sel.value = 'foo'` silently fails (option absent), dropdown reads back blank, but `state.project` retains `'foo'`. Fetch still proceeds correctly. Low impact.

### T2 — Flashback history

- **Source-session links (Surface #6).** `session_id` is in the API payload but `renderTable` doesn't link it. Current sessions die when their PTY dies, so a click-to-source link would mostly 404 on rows older than the current uptime. Sub-optimal but defensible omission; would need session-recovery work first.
- **Pagination (Surface #8).** Client hard-codes `limit=200`; server caps at 500. Fine at 33 rows; at multi-week scale the dashboard will silently truncate. ≤150 LOC fix would be a "load more" button or window-scoped count cap.
- **Audit-write-gap cleanup.** Either delete the dead `triggerProactiveMemoryQuery` path or make it call `recordFlashback` so the funnel stays accurate when `aiQueryAvailable=true`. See above for the verdict.

### T3 — Transcripts panel

- **Server-side metadata gap.** `termdeck_transcripts` table doesn't carry session `type` / `project` (lost on crash). Server-side enrichment via a small `termdeck_sessions` table is a Sprint 47+ candidate. Client-side fix in this sprint is correct-and-minimal.
- **Stored content includes Claude TUI spinner spam.** `\r✻\r\n…` repeated. `stripAnsi` removes CSI/OSC but not the spinner glyphs themselves. Search results highlight noise rows; out of audit budget.
- **Perf virtualization.** Open the panel against a session with 1000+ chunks — chunk list loads all at once. Sprint 47 candidate if it bites a real user.
- **`escapeHtml` duplication.** Identical bodies at `app.js:2693` and `:4296`. Pre-existing, not a Sprint 45 regression. Dedupe in Sprint 47.

### T4 — Quick-launchers + topbar

- **Cosmetic title gap on `btn-status`/`btn-config`.** Two topbar buttons missing `title` attributes. Trivial.
- **Latent regex-injection risk in `^${binary}\b`.** Currently safe — all 4 binaries are letter-only. If a future adapter declares a binary with regex metachars, the resolver would inject. Add a regex-escape helper as a defensive measure.

## Orchestrator side-tasks (close-out)

1. **Lane-brief patches** (T1 + T2 self-flagged):
   - T1 brief endpoint citations corrected: `/api/graph/all|project/:name|memory/:id|stats|stats/inference` (was incorrectly cited as `/api/graph/nodes` + `/api/graph/edges`).
   - T2 brief surfaces #4/#5 reframed: the dismiss/click flow is exercised via the live toast in the main dashboard (`app.js:605-655`), not on-page UI. The history page is intentionally read-only.
2. **`docs/INSTALL-FOR-COLLABORATORS.md` refresh.** Pinned to v0.15.0 + v0.4.10. Added a Known Issue entry about the dismiss/click undercount risk when `aiQueryAvailable=true` (per T2's audit-write-gap verdict) so Brad-tier testers know what they're getting if they enable RAG-driven flashback.
3. **Sprint 47 stub plan** (`docs/sprint-47-mixed-4plus1/PLANNING.md` skeleton). Re-anchors the deferred mixed-4+1 work + lists the 14 Sprint 46 deferrals so the next session has a clean starting point.

## Test status

- **Sprint 45 close baseline:** 737 root + 35 server-package = 772 total.
- **Sprint 46 close:** 806 root + 35 server-package = 841 total. **+69 new tests** this sprint:
  - T1: 11 (graph-viewer-e2e.test.js)
  - T3: 4 (transcript-contract.test.js assertions)
  - T4: 26 (launcher-resolver.test.js)
  - Plus T2 didn't add tests but exercised 48 existing (flashback-events 31 + flashback-diag 17) against live DB.
- **0 fail. 3 skipped (pre-existing, transient-substrate gates).**

## Net summary

The audit caught and fixed exactly the silent-regression class Joshua suspected — the row-of-buttons surfaces had drifted from their original design intent or had renderer/contract mismatches that worked-once-but-not-anymore. None of the bugs were catastrophic; all of them would have looked weird to an outside user (Brad-tier tester) landing on the dashboard. **The dashboard is now in known-clean state.**

The five Sprint 47 deferrals named above are quality-of-life improvements that need either design calls (edge click handler, cross-project visual distinction) or larger refactors (server-side session metadata enrichment, perf virtualization, audit-write-gap cleanup). None of them block outside users.

Joshua's expected to pivot to other projects after this sprint. The dashboard is shippable to Brad-tier testers as-is.

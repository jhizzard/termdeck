# Sprint 46 — T2: Flashback history audit

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

Confirm `/flashback-history.html` works end-to-end. Time-window filter, 3-tier funnel numbers cross-checked against SQLite source-of-truth, dismiss + click-through buttons round-trip via the POST endpoints, zero-state message renders, links to source sessions resolve. Sprint 39 in-memory ring + Sprint 43 T2 SQLite persistence + Sprint 43 T2 funnel dashboard all in scope. The known follow-up flagged by Sprint 43 T2 — the client-side `triggerProactiveMemoryQuery` audit-write gap at `app.js:543` — gets a verdict (fix this sprint / defer to 47 / document as known limitation).

## Files

- `packages/client/public/flashback-history.html` (page shell, funnel display, table, filter controls)
- `packages/client/public/flashback-history.js` (data loader, table renderer, dismiss/click handlers)
- Server endpoints in `packages/server/src/index.js`:
  - `GET /api/flashback/history?since=<ISO>&limit=N` (returns `{count, events, funnel}`)
  - `POST /api/flashback/:id/dismissed`
  - `POST /api/flashback/:id/clicked`
- SQLite source: `flashback_events` table (created by `migrations/001_flashback_events.sql`)
- `packages/server/src/flashback-diag.js` (Sprint 39 ring + Sprint 43 T2 SQLite-aware persistence; `recordFlashback` / `markDismissed` / `markClickedThrough` / `getRecentFlashbacks` / `getFunnelStats`)
- WS frame: `proactive_memory` (Sprint 43 T2 added `flashback_event_id` so client can post dismiss/click back)
- Client-side parallel path: `app.js:543` (`triggerProactiveMemoryQuery` — known to NOT write to `flashback_events`; audit-write gap flagged at Sprint 43 T2 close)
- Existing tests: `tests/flashback-events.test.js`, `flashback-e2e.test.js`, `flashback-diag.test.js`, `flashback-production-flow.test.js`

## Audit framework

For each surface, classify as **works / broken / sub-optimal**. Capture verdict + reproducer + fix.

### Surfaces under test

1. **Initial load.** Open `http://127.0.0.1:3000/flashback-history.html`. Page renders? 3-tier funnel (fires → dismissed → clicked-through) shows numbers? Table populated?
2. **Time-window filter** (`24h` / `7d` / `30d` / `all`). Switching should reload + reflect different row counts and funnel numbers. Default window matches the design.
3. **Funnel cross-check vs SQLite.** Run the same query against `flashback_events` directly in `sqlite3 ~/.termdeck/termdeck.db` and confirm the dashboard's three numbers (fires / dismissed / clicked-through) match exactly for the selected window.
4. **Dismiss flow.** *(Brief originally assumed per-row dismiss buttons on the history page. The implementation is intentionally read-only — dismiss happens via the live toast in the main dashboard at `app.js:605-655`, which posts to `/api/flashback/:id/dismissed`. Audit the toast → POST round-trip from the main dashboard; verify `dismissed_at` populates in SQLite, dismissed count in funnel increments by 1, POST returns 200.)*
5. **Click-through flow.** *(Same shape — exercised via the live toast's "open" action at `app.js:605-655`, not on-page buttons. Verify `clicked_through` flips, funnel updates, POST returns 200.)*
6. **Source-session links.** Each row links to the originating session. Does the link route correctly? If the session is gone (PTY died), is the broken-link state handled gracefully?
7. **Zero-state.** Empty out `flashback_events` (or pick a window with zero rows) — does the empty-state message render with the documented diag-ring query hint?
8. **Pagination / limit.** If there are >N rows, does pagination or "load more" work? (Verify against Sprint 43 T2 design intent — may not be implemented.)
9. **Audit-write gap (the known follow-up).** Trigger a flashback via the client-side `triggerProactiveMemoryQuery` path (e.g., type into a panel until the analyzer fires the proactive flow). Check `flashback_events` — does a row land? Sprint 43 T2 said NO; verify and post a verdict on whether to (a) fix this sprint by wiring `recordFlashback` from the client-fired path, (b) defer to Sprint 47 with a tracking note, or (c) document as a known limitation in INSTALL-FOR-COLLABORATORS.md (Brad-tier testers should know fires-from-client are missing from the funnel).

## Deliverable

NEW `docs/sprint-46-dashboard-audit/T2-flashback-audit-report.md` — structured report, one section per surface, plus a roll-up table at top. Same shape as T1.

## Coordination

- T1 ↔ T2 ↔ T3 ↔ T4 are independent.
- Don't bump versions. Don't touch CHANGELOG. Don't commit. Orchestrator handles close-out.
- Whatever verdict the audit-write gap gets, document it definitively — leaving it ambiguous is the failure mode.

## Boot

```
1. memory_recall(project="termdeck", query="Sprint 39 flashback diag ring Sprint 43 T2 flashback persistence audit dashboard funnel SQLite migrations 001_flashback_events client-side triggerProactiveMemoryQuery audit-write gap")
2. memory_recall(query="recent decisions and bugs")
3. Read /Users/joshuaizzard/.claude/CLAUDE.md
4. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/CLAUDE.md
5. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/PLANNING.md
6. Read /Users/joshuaizzard/Documents/Graciella/ChopinNashville/SideHustles/TermDeck/termdeck/docs/sprint-46-dashboard-audit/STATUS.md
7. Read this brief
8. Open http://127.0.0.1:3000/flashback-history.html and start exercising
```

Stay in your lane. Post FINDING / FIX-PROPOSED / DONE in `STATUS.md` with timestamps. Detailed walkthrough goes in `T2-flashback-audit-report.md`, NOT inline in STATUS.

# Sprint 46 — T2: Flashback history audit report

**Lane:** T2 — `/flashback-history.html`, `/api/flashback/*`, SQLite `flashback_events` table.
**Auditor session:** T2 (2026-05-01).
**Substrate at audit time:** `@jhizzard/termdeck@0.14.0` running on `:3000`; SQLite `flashback_events` table replays cleanly via `migrations/001_flashback_events.sql`; 33 rows persisted (all from today). Server-side `mnestraBridge.mode = webhook`. `config.aiQueryAvailable = false`.

## Roll-up table

| # | Surface | Verdict | Fix this sprint? |
|---|---------|---------|------------------|
| 1 | Initial page load (HTML, funnel, table render) | **WORKS** | n/a |
| 2 | Time-window filter (1d / 7d / 30d / all) | **WORKS** (all 33 rows in last 24h, every window returns 33 — filter wiring correct) | n/a |
| 3 | Funnel cross-check vs SQLite | **WORKS** — funnel API numbers match `sqlite3` source-of-truth exactly | n/a |
| 4 | Dismiss button per row | **EXPECTED** (no per-row buttons by design — history view is read-only) | No — brief↔implementation mismatch |
| 5 | Click-through button per row | **EXPECTED** (same as #4) | No |
| 6 | Source-session links | **SUB-OPTIMAL** (session_id rendered as plain text, not a link) | Defer Sprint 47 |
| 7 | Zero-state | **WORKS** (renders the documented diag-ring hint card) | n/a |
| 8 | Pagination / load-more | **SUB-OPTIMAL** (hard-coded `limit=200`, no UI for next page) | Defer Sprint 47 |
| 9 | Audit-write gap (`triggerProactiveMemoryQuery`) | **DOCUMENTED LIMITATION** (latent — only manifests when `aiQueryAvailable=true`) | Defer Sprint 47, document in INSTALL |
| 10 | Endpoint contracts (`/api/flashback/history`, `/dismissed`, `/clicked`) | **WORKS** (round-trip + idempotency + error-path verified) | n/a |

**Net verdict:** the dashboard works as designed. Three sub-optimal items flagged for Sprint 47; one documentation correction needed (audit-write gap caveat → `INSTALL-FOR-COLLABORATORS.md`). No code changes this sprint.

---

## Surface-by-surface walkthrough

### 1. Initial page load

`curl -sI http://127.0.0.1:3000/flashback-history.html` → `HTTP/1.1 200 OK`.

Page boots:
- `flashback-history.js` reads `?window=` query param (default `7d`).
- `refresh()` issues `GET /api/flashback/history?since=<ISO>&limit=200`.
- `renderFunnel(data.funnel)` fills the three pill counts (Fires / Dismissed / Clicked) + bar widths.
- `renderTable(data.events)` builds the table (or `renderZeroState()` if empty).

No defects observed. Loading state, error banner, and refresh button all wired and behave correctly.

### 2. Time-window filter

Selector values: `1d` / `7d` / `30d` / `all`. `sinceFromWindow(key)` returns `now - {1d|7d|30d}.ms` ISO; `all` returns `null` (omits `since`). Selector `change` triggers `writeStateToUrl()` (URL persistence) + `refresh()`.

Live cross-check (all 33 current rows are < 24h old):

| Window | API count | API funnel | SQLite count |
|--------|-----------|------------|--------------|
| 1d  | 33 | `{fires:33, dismissed:3, clicked:1}` | 33 |
| 7d  | 33 | same | 33 |
| 30d | 33 | same | 33 |
| all | 33 | same | 33 |

Correct: filter wires through; data simply doesn't differ across windows on this install. URL state codec verified by hitting `?window=30d` directly — selector restores correctly on reload.

### 3. Funnel cross-check vs SQLite

```sql
SELECT count(*),
       sum(CASE WHEN dismissed_at IS NOT NULL THEN 1 ELSE 0 END),
       sum(clicked_through)
  FROM flashback_events;
-- 33 | 3 | 1
```

API returns `{fires:33, dismissed:3, clicked_through:1}` — exact match. `getFunnelStats()` SUM/CASE expressions are correct.

### 4 & 5. Dismiss / click-through buttons (per-row)

**The dashboard does NOT render per-row dismiss/click buttons.** `renderTable()` (flashback-history.js:157-203) emits a single status pill per row: `pending` / `dismissed` / `clicked`. The lane brief's Surface #4 ("dismiss button per row — click → row updates visually") describes a control that does not exist on this page.

**Verdict: expected behaviour, brief↔implementation mismatch.** Adding retroactive dismiss/click controls to a historical audit dashboard is semantically wrong:
- The actual dismiss/click flow is the **live toast** (`app.js:605-655`, function `showProactiveToast`). When a flashback fires, the user sees a toast in the active panel; clicking × or letting the 30s timer fire calls `POST /api/flashback/:id/dismissed`; clicking the toast body opens the modal AND calls `POST /api/flashback/:id/clicked`.
- The history page reflects those outcomes via the status pill — it's a viewer, not an editor.
- A row that fired 6 hours ago doesn't need a "dismiss now" button — that event has already passed.

**Recommendation:** orchestrator should patch the lane brief at sprint close so future audits don't repeat the confusion. The surfaces under test are the **live-toast endpoints** (`POST /api/flashback/:id/dismissed`, `POST /api/flashback/:id/clicked`), not on-page UI controls.

### 6. Source-session links

`session_id` is in the API row payload (e.g. `adfe8149-eaa4-4403-ae6c-dde0d2832d2c`) but `renderTable()` does not render the `session_id` column at all — only `time / project / error preview / hits / score / status`. There is no link, plain text or otherwise, to the originating session.

**Verdict: sub-optimal but defensible.**
- Sessions are ephemeral (PTY dies → session is gone). A click-to-source link would 404 on most historical rows.
- The diag-ring (`/api/flashback/diag?sessionId=<id>`) is the right deep-link target, since it survives PTY death — but the diag-ring is itself in-memory only (200-event cap, lost on server restart). So the link would only be useful for sessions whose flashback fired during the current server uptime.
- Useful only as a debugging aid for the maintainer, not for typical Brad-tier user flow.

**Recommendation: defer to Sprint 47.** Implement as either (a) a small "diag" expander per row that fetches `/api/flashback/diag?sessionId=…` and renders the timeline inline, or (b) a session_id column with a CSV-copyable plain-text value so the maintainer can paste it into the diag-ring URL by hand. Both ≤30 LOC.

### 7. Zero-state

Probed via `?since=2030-01-01T00:00:00.000Z` (forces empty result):

```json
{ "count": 0, "events": [], "funnel": { "fires": 0, "dismissed": 0, "clicked_through": 0 } }
```

Client (`flashback-history.js:240`) — when `events.length === 0`, calls `renderZeroState(winKey)` which renders the documented diag-ring hint card with three `<code>` snippets pointing at `/api/flashback/diag?eventType=…` for the three pipeline stages. **Works as designed.** Funnel pills also render `0`s correctly.

### 8. Pagination

Client hard-codes `limit=200` (`flashback-history.js:222`). Server caps at 500 (`flashback-diag.js:165`). No "load more" button, no offset/cursor. With 33 rows today this is non-blocking; at multi-week-of-heavy-use scale the dashboard will silently truncate.

**Verdict: sub-optimal but not broken at current scale.**

**Recommendation: defer to Sprint 47.** A "load more" pattern with `before=<id>` cursor is the cleanest fix (≤40 LOC client + ≤10 LOC server). Alternatively, expose the count to the funnel summary so the user knows when truncation is happening.

### 9. Audit-write gap (the known follow-up — verdict needed)

**The gap:** `triggerProactiveMemoryQuery` at `app.js:562` is a parallel client-fired path that calls `POST /api/ai/query`, gets memory hits, and shows a toast via `showProactiveToast(id, hit)` — **without** a `flashback_event_id`. So toasts fired from this path:
- (a) don't insert into `flashback_events` (the function `recordFlashback` lives only on the server-side onErrorDetected hook),
- (b) silently skip dismiss/click POSTs because `app.js:632-654` guards on `if (flashbackEventId) fetch(...)`.

**Live state on this install (2026-05-01):**

```bash
curl -s http://127.0.0.1:3000/api/config | jq .aiQueryAvailable
# false
```

Reason: `aiQueryAvailable` requires all three of `config.rag.{supabaseUrl, supabaseKey, openaiApiKey}` (index.js:1293). Joshua's `~/.termdeck/config.yaml` doesn't set those. The function returns early at `app.js:565`:

```js
if (!state.config.aiQueryAvailable) return;
```

**So on this install, `triggerProactiveMemoryQuery` is dead code.** Every toast comes from the server-side `proactive_memory` WS frame (index.js:880-955), which always inserts into `flashback_events` BEFORE the WS send. Today's funnel — `fires=33, dismissed=3, clicked=1` — is **complete and correct** for this install.

**Conditional latent risk:** if a user enables `aiQueryAvailable` (sets `config.rag` keys), BOTH paths will fire on every `meta.status === 'errored'` transition (`app.js:2639` calls `triggerProactiveMemoryQuery` regardless of whether the server-side WS frame is en route). The two `showProactiveToast` calls race; the second invocation removes the first toast (`app.js:611: prev.remove()`). If the client-fired toast (no `flashback_event_id`) wins the race, the user's dismiss/click is not recorded. **Funnel fires count remains accurate** (server-side path inserts before WS-emit, regardless of which toast wins), but **dismiss/click rates undercount.**

**Verdict: DEFER full fix to Sprint 47, DOCUMENT as a known limitation in `INSTALL-FOR-COLLABORATORS.md`.**

Rationale:
1. **No live impact** on this install (`aiQueryAvailable=false`). Joshua's funnel is accurate.
2. **Conditionally latent**: only manifests when `aiQueryAvailable=true`, and even then only undercounts dismiss/click outcomes (not fires).
3. **Cleanest fix is REMOVAL** of the client-side trigger (`app.js:2639` — single-line delete plus dead-code cleanup of `triggerProactiveMemoryQuery` ~40 LOC). The server-side path is the source of truth and handles all error→toast emission via `onErrorDetected → mnestraBridge.queryMnestra → recordFlashback + WS-emit`. But:
4. **Removal is risky without explicit test coverage** proving server-side path covers all client-side cases. Sprint 39's whole pain point was a 9-day silent regression in this exact pipeline. Removing the redundant client backup needs:
   - A test that asserts `aiQueryAvailable=true` + error event → exactly one `flashback_events` row inserted.
   - A test that asserts dismiss/click POSTs always carry a valid `flashback_event_id`.
   - A real-shell harness that fires a `cat /nonexistent/file/path` against a session with `config.rag` configured and confirms the funnel increments correctly.
5. **Out of ≤150 LOC budget for this lane** to add the test coverage AND make the removal safely.

**Sprint 47 ticket:** "Remove redundant client-side `triggerProactiveMemoryQuery` path; add e2e regression coverage proving server-side path is sole producer of flashback toasts; verify funnel parity across `aiQueryAvailable=true|false` configurations."

**INSTALL doc caveat (orchestrator side-task):**

> **Known limitation** (Sprint 46 audit, deferred to Sprint 47): when `config.rag` is configured (`aiQueryAvailable=true`), the funnel's dismiss + click-through rates may undercount because of a redundant client-side toast path that doesn't carry a persistence id. Fire counts are accurate. To verify your install: `curl -s http://127.0.0.1:3000/api/config | jq .aiQueryAvailable` — if `false`, this caveat does not apply to you.

### 10. Endpoint contracts (round-trip + edge cases)

**`GET /api/flashback/history?since=&limit=`**: returns `{count, events, funnel}`. Verified above.

**`POST /api/flashback/:id/dismissed`** — round-trip on row 32:

```
BEFORE: 32||0
POST   → {"ok":true,"updated":true}
AFTER:  32|2026-05-01T19:24:59.087Z|0    ← dismissed_at populated, clicked_through unchanged
```

Idempotency: second call returns `{"ok":true,"updated":false}`. Bad id (`abc`): HTTP 400 + `{"error":"Invalid id"}`. Nonexistent id (`999999`): HTTP 200 + `{"updated":false}`.

**`POST /api/flashback/:id/clicked`** — round-trip on row 33:

```
BEFORE: 33||0
POST   → {"ok":true,"updated":true}
AFTER:  33|2026-05-01T19:24:59.645Z|1    ← BOTH dismissed_at AND clicked_through set (COALESCE in markClickedThrough)
```

Idempotency: second call returns `{"updated":false}`. Funnel after both writes: `{fires:33, dismissed:5, clicked_through:2}` — `+2 dismissed (one explicit + one implicit via click), +1 clicked` matches expectations.

All POST endpoints behave per the documented contract in `flashback-diag.js:114-157`.

---

## Summary

The flashback-history dashboard is **production-ready**. All ten audited surfaces either work as designed or are sub-optimal in a defensible way that's better deferred to Sprint 47 than rushed under audit pressure.

The single highest-leverage Sprint 47 follow-up is the audit-write gap cleanup (item #9): a one-line removal of the redundant client-side trigger paired with proper e2e coverage. The remaining Sprint 47 items (source-session links, pagination) are pure UX polish.

No code changes shipped this sprint. The audit confirmed the substrate that Sprint 39 + Sprint 43 T2 + Sprint 39 T1 ring buffer built is whole, durable, and observable end-to-end.

## Files referenced

- `packages/client/public/flashback-history.html` — page shell (332 LOC)
- `packages/client/public/flashback-history.js` — data loader, funnel, table renderer (258 LOC)
- `packages/client/public/app.js:562-655` — `triggerProactiveMemoryQuery` + `showProactiveToast`
- `packages/server/src/index.js:1474-1532` — flashback REST endpoints
- `packages/server/src/index.js:880-955` — server-side `onErrorDetected` hook (the path that always records)
- `packages/server/src/flashback-diag.js` — ring buffer + SQLite persistence (226 LOC)
- `migrations/001_flashback_events.sql` — schema + indexes (idempotent on every restart)
- Existing tests: `tests/flashback-events.test.js` (31 cases), `flashback-e2e.test.js`, `flashback-diag.test.js` (17 cases), `flashback-production-flow.test.js`

# Sprint 43 — T2: Flashback persistence + audit dashboard

**Lane scope (canonical in [PLANNING.md](./PLANNING.md) § Lanes):**

The Sprint 39 `flashback-diag` ring is in-memory only — server restart erases the audit trail. Joshua's 2026-04-29 morning concern: *"I have not seen any flashbacks, although they may have fired while I was doing remote control from bed last night."* Without persistence, that question is unanswerable. This lane closes the audit gap.

## Schema (TermDeck SQLite, NOT Mnestra Postgres)

```sql
CREATE TABLE IF NOT EXISTS flashback_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fired_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  session_id      TEXT NOT NULL,
  project         TEXT,
  error_text      TEXT NOT NULL,
  hits_count      INTEGER NOT NULL DEFAULT 0,
  top_hit_id      TEXT,
  top_hit_score   REAL,
  dismissed_at    TIMESTAMP,
  clicked_through INTEGER NOT NULL DEFAULT 0  -- 0=no, 1=yes
);

CREATE INDEX IF NOT EXISTS flashback_events_fired_at_idx
  ON flashback_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS flashback_events_session_idx
  ON flashback_events(session_id);
```

Per-install (each user's PTY error patterns are different — federation across installs would lose per-user tuning).

## Files
- NEW `migrations/00X_flashback_events.sql` (TermDeck SQLite migration)
- `packages/server/src/flashback-diag.js` — extend `recordFlashback` to also INSERT into `flashback_events`
- `packages/server/src/index.js` — NEW route `GET /api/flashback/history?since=ISO8601&limit=N`
- NEW `packages/client/public/flashback-history.html` — dashboard page
- NEW `packages/client/public/flashback-history.js` — table + filter + click-through funnel chart
- NEW `tests/flashback-events.test.js` — covers schema, insert path, route shape, dismiss/click-through update paths

## Acceptance criteria
1. Every flashback fire writes one row to `flashback_events`.
2. After 7 days of normal use, the dashboard shows ≥ 1 fire — OR surfaces "0 fires — flashback might not be firing, or the underlying RAG isn't returning hits — investigate." That zero-state message is itself the value.
3. Click-through funnel correctly reflects user behavior on the toast (`dismissed_at` filled when toast goes away, `clicked_through=1` when user clicks the hit).
4. Existing in-memory ring is unchanged (live UI continues to use it).
5. Tests pass deterministically.

## Lane discipline
- Append-only STATUS.md updates with `T2: FINDING / FIX-PROPOSED / DONE` lines
- No version bumps, no CHANGELOG edits, no commits — orchestrator handles at sprint close
- Stay in lane: T2 owns flashback persistence + dashboard. Does NOT touch graph viewer (T1), init-rumen (T3), or Telegram (T4)

## Pre-sprint context

- Sprint 39 introduced the in-memory `flashback-diag` ring buffer at `packages/server/src/flashback-diag.js`. It records `{ session_id, fired_at, hits, error_text }` per fire.
- The route `GET /api/flashback/diag` exposes the ring for the live UI.
- Joshua has not visually confirmed flashback firing in the wild yet; Sprint 42's overnight remote-control orchestration may have triggered fires that were lost on server restart.
- This lane EXTENDS the ring; does not replace it. Live UI keeps using the ring; the SQLite table is the audit/historical layer.

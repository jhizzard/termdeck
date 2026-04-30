-- 001_flashback_events.sql
-- Sprint 43 T2 — Flashback persistence + audit dashboard.
--
-- Per-install audit table for every Flashback toast that fires. Each row
-- records the moment a proactive_memory frame was sent over the WebSocket to
-- the user's panel, plus what the toast contained (top hit) and whether the
-- user dismissed or clicked through. The Sprint 39 in-memory ring (capacity
-- 200) survives intact for the live UI; this table is the durable audit
-- layer that survives server restart.
--
-- Per-install (SQLite, NOT Mnestra Postgres) because each user's PTY error
-- patterns are different and federation across installs would lose per-user
-- tuning. Lives in the same ~/.termdeck/termdeck.db as sessions/rag_events.
--
-- Indexes target the two query paths:
--   - GET /api/flashback/history?since=<ISO> ORDER BY fired_at DESC LIMIT N
--     → fired_at_idx (DESC ordering covered by SQLite reverse scan)
--   - per-session debugging joins → session_idx
--
-- Schema is idempotent (CREATE TABLE/INDEX IF NOT EXISTS) so it replays
-- safely on every server start via database.js.

CREATE TABLE IF NOT EXISTS flashback_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fired_at        TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  project         TEXT,
  error_text      TEXT    NOT NULL,
  hits_count      INTEGER NOT NULL DEFAULT 0,
  top_hit_id      TEXT,
  top_hit_score   REAL,
  dismissed_at    TEXT,
  clicked_through INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS flashback_events_fired_at_idx
  ON flashback_events(fired_at DESC);
CREATE INDEX IF NOT EXISTS flashback_events_session_idx
  ON flashback_events(session_id);

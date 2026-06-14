// Database layer - SQLite for session persistence and command history

const path = require('path');
const os = require('os');
const fs = require('fs');

// Sprint 43 T2: load a numbered migration .sql file from the repo-root
// `migrations/` directory if present, falling back to an inline string for
// packaged npm installs where the `files` allowlist in package.json does not
// ship `migrations/`. Authoritative source-of-truth is the .sql file; the
// fallback is kept in lockstep when the schema changes.
function loadMigrationSql(name, fallback) {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'migrations', name),
    path.join(__dirname, '..', '..', '..', '..', 'migrations', name),
  ];
  for (const candidate of candidates) {
    try {
      const sql = fs.readFileSync(candidate, 'utf8');
      if (sql && sql.trim().length) return sql;
    } catch (_e) { /* try next */ }
  }
  return fallback;
}

const FLASHBACK_EVENTS_INLINE_SQL = `
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
`;

// Sprint 78 T2 — advisory_events durable audit table. A flashback_events
// SIBLING (same shape/contract): one row per advisor outcome (delivered OR
// suppressed OR ttl-dropped), so the agent-facing advisory channel is as
// auditable as the human-facing flashback toast. `delivered`/`agent_injected`
// distinguish "the deliver path ran" from "the submit confirmed in the PTY";
// `suppressed_reason` carries the throttle reason (rate_session / rate_10min /
// dup_key / cooldown / quarantined / ttl_dropped / …) for the non-delivered
// rows. Idempotent CREATE so it replays safely on every server start. SQLite
// has no source-of-truth migration file for this table (it ships only in the
// inline fallback, like the audit table did pre-001) — the advisor is
// offline-complete (A10) and SQLite-only this sprint.
const ADVISORY_EVENTS_INLINE_SQL = `
  CREATE TABLE IF NOT EXISTS advisory_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fired_at          TEXT    NOT NULL,
    session_id        TEXT    NOT NULL,
    project           TEXT,
    rule_id           TEXT    NOT NULL,
    dedupe_key        TEXT    NOT NULL,
    error_text        TEXT,
    delivered         INTEGER NOT NULL DEFAULT 0,
    suppressed_reason TEXT,
    agent_injected    INTEGER NOT NULL DEFAULT 0,
    acked_at          TEXT,
    created_at        TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS advisory_events_fired_at_idx
    ON advisory_events(fired_at DESC);
  CREATE INDEX IF NOT EXISTS advisory_events_session_idx
    ON advisory_events(session_id);
  CREATE INDEX IF NOT EXISTS advisory_events_rule_idx
    ON advisory_events(rule_id);
  CREATE INDEX IF NOT EXISTS advisory_events_dedupe_idx
    ON advisory_events(dedupe_key);

  CREATE TABLE IF NOT EXISTS advisory_quarantine (
    rule_id        TEXT PRIMARY KEY,
    quarantined_at TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    reason         TEXT
  );
`;

function initDatabase(Database) {
  const dbPath = path.join(os.homedir(), '.termdeck', 'termdeck.db');

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'shell',
      project TEXT,
      label TEXT,
      command TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL,
      exited_at TEXT,
      exit_code INTEGER,
      reason TEXT,
      theme TEXT DEFAULT 'tokyo-night',
      theme_override TEXT,
      role TEXT
    );

    CREATE TABLE IF NOT EXISTS command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      command TEXT NOT NULL,
      output_snippet TEXT,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS rag_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      synced INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      default_command TEXT DEFAULT 'bash',
      rag_namespace TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_commands_session ON command_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_rag_synced ON rag_events(synced);
    CREATE INDEX IF NOT EXISTS idx_rag_project ON rag_events(project);
  `);

  // Migration: add command_history.source on existing databases
  try {
    const cols = db.prepare(`PRAGMA table_info(command_history)`).all();
    const hasSource = cols.some((c) => c.name === 'source');
    if (!hasSource) {
      db.exec(`ALTER TABLE command_history ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`);
      db.exec(`UPDATE command_history SET source = 'user' WHERE source IS NULL`);
      console.log("[db] Migrated command_history: added 'source' column");
    }
  } catch (err) {
    console.warn('[db] command_history.source migration failed:', err.message);
  }

  // Migration (v0.7.0): add sessions.theme_override and backfill from theme.
  // The backfill runs exactly once — only when the column is being added — so
  // post-migration sessions created with theme_override=NULL stay un-overridden
  // and pick up config.yaml changes via the theme-resolver. Pre-v0.7.0 rows
  // had `theme` written by the dropdown PATCH, so treating them as user-set is
  // the correct preservation of customizations.
  // (SQLite has no `ADD COLUMN IF NOT EXISTS`, so we PRAGMA-check first — same
  // pattern as the command_history.source migration above.)
  try {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all();
    const hasOverride = cols.some((c) => c.name === 'theme_override');
    if (!hasOverride) {
      db.exec(`ALTER TABLE sessions ADD COLUMN theme_override TEXT`);
      const updated = db.prepare(`UPDATE sessions SET theme_override = theme WHERE theme IS NOT NULL`).run();
      console.log(`[db] Migrated sessions: added 'theme_override' column, backfilled ${updated.changes} row(s) from theme`);
    }
  } catch (err) {
    console.warn('[db] sessions.theme_override migration failed:', err.message);
  }

  // Migration (Sprint 65 T2): add sessions.role for the explicit
  // orchestrator/worker/reviewer/auditor panel-role flag (Brad's 2026-05-13
  // v2 dashboard spec — Approach A). SQLite has no `ADD COLUMN IF NOT EXISTS`,
  // so PRAGMA-check first — same pattern as the command_history.source and
  // sessions.theme_override migrations above. No backfill: pre-Sprint-65 rows
  // stay role=NULL (unroled), which is the correct default for sessions that
  // pre-date the feature.
  try {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all();
    const hasRole = cols.some((c) => c.name === 'role');
    if (!hasRole) {
      db.exec(`ALTER TABLE sessions ADD COLUMN role TEXT`);
      console.log("[db] Migrated sessions: added 'role' column");
    }
  } catch (err) {
    console.warn('[db] sessions.role migration failed:', err.message);
  }

  // Migration (v0.7.0): drop the dead projects.default_theme column. It was
  // CREATE'd in early v0.1 but was never read or written by any code path
  // (see Sprint 32 T1 grep). Removing it eliminates a latent contract-drift
  // trap. SQLite supports DROP COLUMN since 3.35 (well below better-sqlite3's
  // bundled version). No `IF EXISTS` in SQLite, so PRAGMA-check first.
  try {
    const cols = db.prepare(`PRAGMA table_info(projects)`).all();
    const hasDefaultTheme = cols.some((c) => c.name === 'default_theme');
    if (hasDefaultTheme) {
      db.exec(`ALTER TABLE projects DROP COLUMN default_theme`);
      console.log("[db] Migrated projects: dropped dead 'default_theme' column");
    }
  } catch (err) {
    console.warn('[db] projects.default_theme drop migration failed:', err.message);
  }

  // Sprint 43 T2: flashback_events durable audit table. Schema lives in
  // migrations/001_flashback_events.sql (repo-root, source-of-truth) with
  // an inline fallback for packaged installs. Idempotent CREATE so this
  // replays safely on every server start.
  try {
    db.exec(loadMigrationSql('001_flashback_events.sql', FLASHBACK_EVENTS_INLINE_SQL));
  } catch (err) {
    console.warn('[db] flashback_events migration failed:', err.message);
  }

  // Sprint 78 T2: advisory_events + advisory_quarantine. Inline-only (no
  // repo-root migration file — SQLite-only, offline-complete this sprint).
  // Idempotent CREATE; fail-soft so a broken advisor schema can never block
  // server start (the advisor is non-critical-path by design).
  try {
    db.exec(ADVISORY_EVENTS_INLINE_SQL);
  } catch (err) {
    console.warn('[db] advisory_events migration failed:', err.message);
  }

  // Sprint 78 T1: doctrine_events store, sibling of flashback_events /
  // advisory_events in this shared handle (no second DB file). The DDL is
  // canonical in the top-level doctrine/index.js module (one schema, used by
  // both the loader's throttle and this wiring). Lazy-required inside the
  // try/catch so a doctrine-module problem can never break server boot —
  // fail-soft, idempotent CREATE.
  try {
    const doctrine = require('../../../doctrine');
    db.exec(doctrine.DOCTRINE_EVENTS_SQL);
    doctrine.setDb(db); // hand the loader its throttle/recordGateEvent handle
  } catch (err) {
    console.warn('[db] doctrine_events init failed (fail-soft):', err && err.message);
  }

  return db;
}

function logCommand(db, sessionId, command, outputSnippet, source) {
  db.prepare(`
    INSERT INTO command_history (session_id, command, output_snippet, timestamp, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, command, outputSnippet || null, new Date().toISOString(), source || 'user');
}

function logRagEvent(db, sessionId, eventType, payload, project) {
  db.prepare(`
    INSERT INTO rag_events (session_id, event_type, payload, project, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, eventType, JSON.stringify(payload), project, new Date().toISOString());
}

function getUnsyncedRagEvents(db, limit = 50) {
  return db.prepare(`
    SELECT * FROM rag_events WHERE synced = 0 ORDER BY timestamp ASC LIMIT ?
  `).all(limit);
}

function markRagEventsSynced(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE rag_events SET synced = 1 WHERE id IN (${placeholders})`).run(...ids);
}

function getSessionHistory(db, sessionId) {
  return db.prepare(`
    SELECT * FROM command_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50
  `).all(sessionId);
}

function getProjectSessions(db, project) {
  return db.prepare(`
    SELECT * FROM sessions WHERE project = ? ORDER BY created_at DESC
  `).all(project);
}

module.exports = {
  initDatabase,
  logCommand,
  logRagEvent,
  getUnsyncedRagEvents,
  markRagEventsSynced,
  getSessionHistory,
  getProjectSessions
};

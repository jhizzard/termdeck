// Sprint 32 / v0.7.0 — T1 — theme persistence + render-time resolution.
//
// Covers:
//   1. db init backfills theme_override = theme on existing pre-v0.7.0 rows
//   2. fresh sessions get theme_override = NULL → resolveTheme falls through
//   3. config.defaultTheme edits propagate to existing un-overridden sessions
//      with NO SQL UPDATE between reads
//   4. theme_override always wins over project / global defaults
//   5. resolveTheme smoke: all four code paths (override, project, global, fallback)
//   6. PATCH theme:null clears the override

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { resolveTheme, _resetCacheForTests } = require('../packages/server/src/theme-resolver');
const { initDatabase, SessionManager } = (() => {
  const dbMod = require('../packages/server/src/database');
  const sessMod = require('../packages/server/src/session');
  return { initDatabase: dbMod.initDatabase, SessionManager: sessMod.SessionManager };
})();

// initDatabase opens ~/.termdeck/termdeck.db on disk. We need an in-memory db
// AND the same migrations applied. Easiest: replicate the relevant init slice
// here against a fresh :memory: db. This is a deliberate copy — the alternative
// is making initDatabase accept an injected path, which crosses into setup
// territory and isn't strictly necessary for what we're testing.
function makeInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

function applyV070Migrations(db) {
  // Mirrors database.js post-v0.7.0 schema. Used by tests that simulate a
  // fresh install (no pre-existing rows).
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
      theme_override TEXT
    );
  `);
}

function applyPreV070Schema(db) {
  // Mirrors the v0.6.x sessions schema — no theme_override column. Used by the
  // backfill test to verify the migration path picks up legacy customizations.
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
      theme TEXT DEFAULT 'tokyo-night'
    );
  `);
}

// Lifted directly from database.js. Tests assert the *behavior* of this block,
// so we run it here against an in-memory db to isolate from disk side effects.
function runV070SessionsMigration(db) {
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all();
  const hasOverride = cols.some((c) => c.name === 'theme_override');
  if (!hasOverride) {
    db.exec(`ALTER TABLE sessions ADD COLUMN theme_override TEXT`);
    db.prepare(`UPDATE sessions SET theme_override = theme WHERE theme IS NOT NULL`).run();
  }
}

test.beforeEach(() => {
  _resetCacheForTests();
});

test('resolveTheme — override wins over everything else', () => {
  const session = { theme_override: 'solarized-dark', project: 'pvb' };
  const config = { defaultTheme: 'catppuccin-mocha', projects: { pvb: { defaultTheme: 'nord' } } };
  assert.equal(resolveTheme(session, config), 'solarized-dark');
});

test('resolveTheme — project default wins when no override', () => {
  const session = { theme_override: null, project: 'pvb' };
  const config = { defaultTheme: 'catppuccin-mocha', projects: { pvb: { defaultTheme: 'nord' } } };
  assert.equal(resolveTheme(session, config), 'nord');
});

test('resolveTheme — global default when no override and no per-project', () => {
  const session = { theme_override: null, project: 'pvb' };
  const config = { defaultTheme: 'catppuccin-mocha', projects: { pvb: { /* no defaultTheme */ } } };
  assert.equal(resolveTheme(session, config), 'catppuccin-mocha');
});

test('resolveTheme — falls through to tokyo-night when nothing else is set', () => {
  const session = { theme_override: null, project: null };
  const config = { /* empty */ };
  assert.equal(resolveTheme(session, config), 'tokyo-night');
});

test('resolveTheme — null project resolves through global default', () => {
  const session = { theme_override: null, project: null };
  const config = { defaultTheme: 'gruvbox-dark', projects: { pvb: { defaultTheme: 'nord' } } };
  assert.equal(resolveTheme(session, config), 'gruvbox-dark');
});

test('migration backfills theme_override = theme on pre-v0.7.0 rows', () => {
  const db = makeInMemoryDb();
  applyPreV070Schema(db);

  // Seed a legacy row with a customized theme — represents a v0.6.x user who
  // chose Dracula via the dropdown, which wrote to sessions.theme directly.
  db.prepare(`
    INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme)
    VALUES ('s1', 'shell', 'pvb', 'pvb shell', 'zsh', '/tmp', '2026-04-25T00:00:00Z', 'manual', 'dracula')
  `).run();
  // And one with NULL theme to confirm the backfill leaves NULLs alone.
  db.prepare(`
    INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme)
    VALUES ('s2', 'shell', null, 'untyped', 'zsh', '/tmp', '2026-04-25T00:00:00Z', 'manual', null)
  `).run();

  runV070SessionsMigration(db);

  const s1 = db.prepare(`SELECT theme, theme_override FROM sessions WHERE id = 's1'`).get();
  assert.equal(s1.theme, 'dracula', 'legacy theme column preserved');
  assert.equal(s1.theme_override, 'dracula', 'override backfilled from theme');

  const s2 = db.prepare(`SELECT theme, theme_override FROM sessions WHERE id = 's2'`).get();
  assert.equal(s2.theme, null);
  assert.equal(s2.theme_override, null, 'NULL theme stays NULL — no override imputed');
});

test('migration is idempotent — second run does NOT re-backfill new sessions', () => {
  const db = makeInMemoryDb();
  applyPreV070Schema(db);
  db.prepare(`
    INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme)
    VALUES ('legacy', 'shell', null, 'l', 'zsh', '/tmp', '2026-04-25T00:00:00Z', 'manual', 'nord')
  `).run();

  runV070SessionsMigration(db); // adds column + backfills 'legacy' → nord

  // Now insert a brand-new v0.7.0-style row (theme_override = NULL on purpose).
  db.prepare(`
    INSERT INTO sessions (id, type, project, label, command, cwd, created_at, reason, theme, theme_override)
    VALUES ('fresh', 'shell', null, 'f', 'zsh', '/tmp', '2026-04-26T00:00:00Z', 'manual', 'tokyo-night', null)
  `).run();

  runV070SessionsMigration(db); // should be a no-op — column already exists

  const fresh = db.prepare(`SELECT theme_override FROM sessions WHERE id = 'fresh'`).get();
  assert.equal(fresh.theme_override, null, 'second migration run did NOT re-impute override on fresh row');
});

test('SessionManager.create writes theme_override = NULL by default', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);

  const sessions = new SessionManager(db);
  const s = sessions.create({
    type: 'shell',
    project: 'pvb',
    label: 'test',
    command: 'zsh',
    cwd: '/tmp',
    theme: 'dracula',  // index.js currently passes the resolved default here
    reason: 'test'
  });

  const row = db.prepare(`SELECT theme, theme_override FROM sessions WHERE id = ?`).get(s.id);
  assert.equal(row.theme_override, null, 'options.theme does NOT pollute theme_override');
});

test('config edit propagates to existing un-overridden session WITHOUT a SQL UPDATE', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);
  const sessions = new SessionManager(db);
  const s = sessions.create({ type: 'shell', project: 'pvb', label: 'p', cwd: '/tmp', theme: 'tokyo-night', reason: 't' });

  // First read: config says nord
  let cfg = { defaultTheme: 'nord', projects: {} };
  assert.equal(resolveTheme(s, cfg), 'nord');

  // User edits config.yaml: defaultTheme is now gruvbox-dark.
  cfg = { defaultTheme: 'gruvbox-dark', projects: {} };
  assert.equal(resolveTheme(s, cfg), 'gruvbox-dark', 'config edit visible at next read with NO db write');

  // Verify no UPDATE occurred — theme_override is still NULL.
  const row = db.prepare(`SELECT theme_override FROM sessions WHERE id = ?`).get(s.id);
  assert.equal(row.theme_override, null);
});

test('user override (PATCH) wins over later config edits', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);
  const sessions = new SessionManager(db);
  const s = sessions.create({ type: 'shell', project: 'pvb', label: 'p', cwd: '/tmp', theme: 'tokyo-night', reason: 't' });

  // User picks dracula via the dropdown → PATCH /api/sessions/:id { theme: 'dracula' }
  sessions.updateMeta(s.id, { theme: 'dracula' });

  const row = db.prepare(`SELECT theme_override FROM sessions WHERE id = ?`).get(s.id);
  assert.equal(row.theme_override, 'dracula', 'PATCH wrote to theme_override');

  // Even if the global default changes, the user's choice sticks.
  const cfg = { defaultTheme: 'catppuccin-mocha', projects: { pvb: { defaultTheme: 'nord' } } };
  assert.equal(resolveTheme(s, cfg), 'dracula');
});

test('PATCH theme:null clears the override and reverts to config default', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);
  const sessions = new SessionManager(db);
  const s = sessions.create({ type: 'shell', project: 'pvb', label: 'p', cwd: '/tmp', theme: 'tokyo-night', reason: 't' });

  sessions.updateMeta(s.id, { theme: 'dracula' });
  sessions.updateMeta(s.id, { theme: null });

  const row = db.prepare(`SELECT theme_override FROM sessions WHERE id = ?`).get(s.id);
  assert.equal(row.theme_override, null, 'theme:null cleared the override');

  const cfg = { defaultTheme: 'gruvbox-dark', projects: {} };
  assert.equal(resolveTheme(s, cfg), 'gruvbox-dark', 'session reverts to config-derived default');
});

test('Session.meta.theme is a getter — reflects current resolveTheme output', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);
  const sessions = new SessionManager(db);
  const s = sessions.create({ type: 'shell', project: null, label: 'p', cwd: '/tmp', reason: 't' });

  // Prime the disk-cache so meta.theme's getter (which calls resolveTheme(this)
  // with no explicit config) sees our test config instead of reading
  // ~/.termdeck/config.yaml.
  const { _setCachedConfigForTests } = require('../packages/server/src/theme-resolver');
  _setCachedConfigForTests({ defaultTheme: 'nord', projects: {} });
  assert.equal(s.meta.theme, 'nord', 'getter resolves against cached config');

  _setCachedConfigForTests({ defaultTheme: 'gruvbox-dark', projects: {} });
  assert.equal(s.meta.theme, 'gruvbox-dark', 'getter re-resolves on next read');

  // toJSON spreads meta — the getter fires at spread time, freezing the value.
  const json = s.toJSON();
  assert.equal(json.meta.theme, 'gruvbox-dark');
});

test('Session.meta.theme setter routes assignment through theme_override', () => {
  const db = makeInMemoryDb();
  applyV070Migrations(db);
  const sessions = new SessionManager(db);
  const s = sessions.create({ type: 'shell', project: null, label: 'p', cwd: '/tmp', reason: 't' });

  const { _setCachedConfigForTests } = require('../packages/server/src/theme-resolver');
  _setCachedConfigForTests({ defaultTheme: 'tokyo-night', projects: {} });

  s.meta.theme = 'solarized-dark';
  assert.equal(s.theme_override, 'solarized-dark', 'assignment went through the setter');
  assert.equal(s.meta.theme, 'solarized-dark', 'getter now returns the override');

  s.meta.theme = null;
  assert.equal(s.theme_override, null);
  assert.equal(s.meta.theme, 'tokyo-night');
});

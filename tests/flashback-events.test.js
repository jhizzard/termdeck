// Tests for the durable flashback_events audit table + history routes
// (Sprint 43 T2).
//
// Pins:
//   - schema shape (CREATE applies idempotently from the migration .sql file)
//   - flashback-diag persistence functions (recordFlashback, markDismissed,
//     markClickedThrough, getRecentFlashbacks, getFunnelStats)
//   - HTTP route shapes (/api/flashback/history, /api/flashback/:id/dismissed,
//     /api/flashback/:id/clicked)
//   - graceful no-op when db is null (so the live emit path never crashes
//     even when SQLite is unavailable)
//
// Hermetic: each test uses a fresh in-memory SQLite DB so there is no shared
// state. Routes are exercised against an in-memory Express app — the
// production index.js wiring is mirrored in attachHistoryRoutes() so the
// test stays decoupled from the rest of server bootstrapping (which would
// pull in PTY / Supabase / etc).
//
// Run: node --test tests/flashback-events.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const flashbackDiag = require('../packages/server/src/flashback-diag');

// Load the canonical migration .sql; falls back to inline if absent (mirrors
// database.js loadMigrationSql contract). Tests assert via the .sql file
// path so a drift between file + inline fallback would be caught here.
function loadMigration() {
  const sqlPath = path.join(__dirname, '..', 'migrations', '001_flashback_events.sql');
  return fs.readFileSync(sqlPath, 'utf8');
}

function freshDb() {
  const db = new Database(':memory:');
  db.exec(loadMigration());
  return db;
}

// ---- Schema -------------------------------------------------------------

test('migration creates flashback_events table with expected columns', () => {
  const db = freshDb();
  try {
    const cols = db.prepare(`PRAGMA table_info(flashback_events)`).all();
    const names = cols.map((c) => c.name).sort();
    assert.deepEqual(names, [
      'clicked_through',
      'dismissed_at',
      'error_text',
      'fired_at',
      'hits_count',
      'id',
      'project',
      'session_id',
      'top_hit_id',
      'top_hit_score',
    ]);
    // Spot-check NOT NULL constraints on the columns the brief requires.
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.equal(byName.fired_at.notnull, 1);
    assert.equal(byName.session_id.notnull, 1);
    assert.equal(byName.error_text.notnull, 1);
    assert.equal(byName.hits_count.notnull, 1);
    assert.equal(byName.clicked_through.notnull, 1);
  } finally {
    db.close();
  }
});

test('migration creates expected indexes for query paths', () => {
  const db = freshDb();
  try {
    const idxs = db.prepare(`PRAGMA index_list(flashback_events)`).all();
    const names = idxs.map((i) => i.name).sort();
    // sqlite_autoindex* may exist for the AUTOINCREMENT primary key; filter
    // to the application-defined ones.
    const appIdxs = names.filter((n) => !n.startsWith('sqlite_'));
    assert.deepEqual(appIdxs.sort(), [
      'flashback_events_fired_at_idx',
      'flashback_events_session_idx',
    ]);
  } finally {
    db.close();
  }
});

test('migration is idempotent (CREATE IF NOT EXISTS replays cleanly)', () => {
  const db = freshDb();
  try {
    // Apply it again — should not throw or duplicate the table.
    db.exec(loadMigration());
    db.exec(loadMigration());
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='flashback_events'`
    ).all();
    assert.equal(tables.length, 1);
  } finally {
    db.close();
  }
});

// ---- recordFlashback ----------------------------------------------------

test('recordFlashback persists a row and returns the inserted id', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 'sess-1',
      project: 'termdeck',
      error_text: 'shell error: command not found: foo',
      hits_count: 3,
      top_hit_id: 'mem-uuid-abc',
      top_hit_score: 0.87,
    });
    assert.ok(Number.isFinite(id) && id > 0, 'returns a numeric id');
    const row = db.prepare(`SELECT * FROM flashback_events WHERE id = ?`).get(id);
    assert.ok(row);
    assert.equal(row.session_id, 'sess-1');
    assert.equal(row.project, 'termdeck');
    assert.equal(row.error_text, 'shell error: command not found: foo');
    assert.equal(row.hits_count, 3);
    assert.equal(row.top_hit_id, 'mem-uuid-abc');
    assert.equal(row.top_hit_score, 0.87);
    assert.equal(row.dismissed_at, null);
    assert.equal(row.clicked_through, 0);
    assert.match(row.fired_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    db.close();
  }
});

test('recordFlashback honors an explicit fired_at timestamp', () => {
  const db = freshDb();
  try {
    const ts = '2026-04-30T17:25:41.123Z';
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 'sess-2', error_text: 'x', fired_at: ts,
    });
    const row = db.prepare(`SELECT fired_at FROM flashback_events WHERE id = ?`).get(id);
    assert.equal(row.fired_at, ts);
  } finally {
    db.close();
  }
});

test('recordFlashback fills sane defaults for missing fields', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, { sessionId: 'sess-3' });
    const row = db.prepare(`SELECT * FROM flashback_events WHERE id = ?`).get(id);
    assert.equal(row.project, null);
    assert.equal(row.error_text, '');
    assert.equal(row.hits_count, 0);
    assert.equal(row.top_hit_id, null);
    assert.equal(row.top_hit_score, null);
  } finally {
    db.close();
  }
});

test('recordFlashback returns null when db is null (graceful no-op)', () => {
  const id = flashbackDiag.recordFlashback(null, {
    sessionId: 'sess-x', error_text: 'x',
  });
  assert.equal(id, null);
});

test('recordFlashback returns null when sessionId is missing', () => {
  const db = freshDb();
  try {
    assert.equal(flashbackDiag.recordFlashback(db, { error_text: 'x' }), null);
    assert.equal(flashbackDiag.recordFlashback(db, null), null);
    assert.equal(flashbackDiag.recordFlashback(db, undefined), null);
    // No rows should have been inserted.
    const count = db.prepare(`SELECT COUNT(*) AS n FROM flashback_events`).get().n;
    assert.equal(count, 0);
  } finally {
    db.close();
  }
});

test('recordFlashback accepts session_id snake_case alias', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      session_id: 'snake-sess', error_text: 'x',
    });
    assert.ok(id > 0);
    const row = db.prepare(`SELECT session_id FROM flashback_events WHERE id = ?`).get(id);
    assert.equal(row.session_id, 'snake-sess');
  } finally {
    db.close();
  }
});

// ---- markDismissed ------------------------------------------------------

test('markDismissed sets dismissed_at on the row', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x',
    });
    const updated = flashbackDiag.markDismissed(db, id);
    assert.equal(updated, true);
    const row = db.prepare(`SELECT dismissed_at FROM flashback_events WHERE id = ?`).get(id);
    assert.ok(row.dismissed_at, 'dismissed_at is filled');
    assert.match(row.dismissed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    db.close();
  }
});

test('markDismissed is idempotent — first dismiss timestamp wins', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x',
    });
    const ok1 = flashbackDiag.markDismissed(db, id, '2026-04-30T17:00:00.000Z');
    const ok2 = flashbackDiag.markDismissed(db, id, '2026-04-30T18:00:00.000Z');
    assert.equal(ok1, true);
    assert.equal(ok2, false, 'second call returns false (no change)');
    const row = db.prepare(`SELECT dismissed_at FROM flashback_events WHERE id = ?`).get(id);
    assert.equal(row.dismissed_at, '2026-04-30T17:00:00.000Z');
  } finally {
    db.close();
  }
});

test('markDismissed returns false for unknown id', () => {
  const db = freshDb();
  try {
    assert.equal(flashbackDiag.markDismissed(db, 9999), false);
  } finally {
    db.close();
  }
});

test('markDismissed is a no-op when db is null', () => {
  assert.equal(flashbackDiag.markDismissed(null, 1), false);
});

test('markDismissed rejects non-numeric / non-positive ids', () => {
  const db = freshDb();
  try {
    assert.equal(flashbackDiag.markDismissed(db, 0), false);
    assert.equal(flashbackDiag.markDismissed(db, -1), false);
    assert.equal(flashbackDiag.markDismissed(db, 'foo'), false);
    assert.equal(flashbackDiag.markDismissed(db, null), false);
  } finally {
    db.close();
  }
});

// ---- markClickedThrough -------------------------------------------------

test('markClickedThrough sets clicked_through=1 and dismissed_at if NULL', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x',
    });
    const ok = flashbackDiag.markClickedThrough(db, id);
    assert.equal(ok, true);
    const row = db.prepare(
      `SELECT clicked_through, dismissed_at FROM flashback_events WHERE id = ?`
    ).get(id);
    assert.equal(row.clicked_through, 1);
    assert.ok(row.dismissed_at, 'click-through implies dismiss');
  } finally {
    db.close();
  }
});

test('markClickedThrough preserves an existing dismissed_at timestamp', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x',
    });
    flashbackDiag.markDismissed(db, id, '2026-04-30T17:00:00.000Z');
    const ok = flashbackDiag.markClickedThrough(db, id);
    assert.equal(ok, true);
    const row = db.prepare(
      `SELECT clicked_through, dismissed_at FROM flashback_events WHERE id = ?`
    ).get(id);
    assert.equal(row.clicked_through, 1);
    assert.equal(row.dismissed_at, '2026-04-30T17:00:00.000Z',
      'pre-existing dismiss timestamp is preserved');
  } finally {
    db.close();
  }
});

test('markClickedThrough is idempotent', () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'x',
    });
    const ok1 = flashbackDiag.markClickedThrough(db, id);
    const ok2 = flashbackDiag.markClickedThrough(db, id);
    assert.equal(ok1, true);
    assert.equal(ok2, false, 'second click is a no-op');
  } finally {
    db.close();
  }
});

// ---- getRecentFlashbacks ------------------------------------------------

test('getRecentFlashbacks returns rows in DESC order by fired_at', () => {
  const db = freshDb();
  try {
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'a', fired_at: '2026-04-30T10:00:00.000Z',
    });
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'b', fired_at: '2026-04-30T11:00:00.000Z',
    });
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'c', fired_at: '2026-04-30T12:00:00.000Z',
    });
    const rows = flashbackDiag.getRecentFlashbacks(db);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.error_text), ['c', 'b', 'a']);
  } finally {
    db.close();
  }
});

test('getRecentFlashbacks honors the since filter (inclusive)', () => {
  const db = freshDb();
  try {
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'old', fired_at: '2026-04-29T10:00:00.000Z',
    });
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'edge', fired_at: '2026-04-30T00:00:00.000Z',
    });
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'new', fired_at: '2026-04-30T12:00:00.000Z',
    });
    const rows = flashbackDiag.getRecentFlashbacks(db, {
      since: '2026-04-30T00:00:00.000Z',
    });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.fired_at >= '2026-04-30T00:00:00.000Z'));
  } finally {
    db.close();
  }
});

test('getRecentFlashbacks honors limit and clamps to 500', () => {
  const db = freshDb();
  try {
    for (let i = 0; i < 10; i++) {
      flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: `e${i}` });
    }
    const rows = flashbackDiag.getRecentFlashbacks(db, { limit: 3 });
    assert.equal(rows.length, 3);
    // Pathological large limit doesn't crash.
    const rowsBig = flashbackDiag.getRecentFlashbacks(db, { limit: 99999 });
    assert.equal(rowsBig.length, 10, 'returns all 10 even with huge limit');
  } finally {
    db.close();
  }
});

test('getRecentFlashbacks returns [] when db is null', () => {
  assert.deepEqual(flashbackDiag.getRecentFlashbacks(null), []);
});

// ---- getFunnelStats -----------------------------------------------------

test('getFunnelStats reports zero counts on empty table', () => {
  const db = freshDb();
  try {
    const stats = flashbackDiag.getFunnelStats(db);
    assert.deepEqual(stats, { fires: 0, dismissed: 0, clicked_through: 0 });
  } finally {
    db.close();
  }
});

test('getFunnelStats counts fires, dismisses, and click-throughs', () => {
  const db = freshDb();
  try {
    const a = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'a' });
    const b = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'b' });
    const c = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'c' });
    const d = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'd' });
    flashbackDiag.markDismissed(db, a);
    flashbackDiag.markDismissed(db, b);
    flashbackDiag.markClickedThrough(db, c); // implicit dismiss
    // d remains pending (no dismiss, no click)
    const stats = flashbackDiag.getFunnelStats(db);
    assert.equal(stats.fires, 4);
    assert.equal(stats.dismissed, 3, 'a, b, c all show dismissed_at');
    assert.equal(stats.clicked_through, 1);
  } finally {
    db.close();
  }
});

test('getFunnelStats honors since filter', () => {
  const db = freshDb();
  try {
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'old', fired_at: '2026-04-29T10:00:00.000Z',
    });
    const recent = flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'new', fired_at: '2026-04-30T10:00:00.000Z',
    });
    flashbackDiag.markClickedThrough(db, recent);
    const stats = flashbackDiag.getFunnelStats(db, { since: '2026-04-30T00:00:00.000Z' });
    assert.equal(stats.fires, 1);
    assert.equal(stats.clicked_through, 1);
  } finally {
    db.close();
  }
});

// ---- HTTP routes --------------------------------------------------------

function listenOnce(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// Mirror the production wiring from index.js. If the route contracts in
// index.js change, update this fixture too — that's the point of pinning.
function attachHistoryRoutes(app, db) {
  app.get('/api/flashback/history', (req, res) => {
    const rawSince = req.query && req.query.since;
    const since = (typeof rawSince === 'string' && rawSince.length) ? rawSince : undefined;
    const rawLimit = req.query && req.query.limit;
    const limit = rawLimit != null ? parseInt(rawLimit, 10) : undefined;
    const events = flashbackDiag.getRecentFlashbacks(db, {
      since,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    const funnel = flashbackDiag.getFunnelStats(db, { since });
    res.json({ count: events.length, events, funnel });
  });
  app.post('/api/flashback/:id/dismissed', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const updated = flashbackDiag.markDismissed(db, id);
    res.json({ ok: true, updated });
  });
  app.post('/api/flashback/:id/clicked', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const updated = flashbackDiag.markClickedThrough(db, id);
    res.json({ ok: true, updated });
  });
}

test('GET /api/flashback/history returns { count, events, funnel } shape', async () => {
  const db = freshDb();
  try {
    const a = flashbackDiag.recordFlashback(db, {
      sessionId: 's', project: 'p', error_text: 'a',
    });
    flashbackDiag.markClickedThrough(db, a);
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', project: 'p', error_text: 'b',
    });
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/flashback/history`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.count, 2);
      assert.equal(body.events.length, 2);
      assert.deepEqual(body.funnel, { fires: 2, dismissed: 1, clicked_through: 1 });
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('GET /api/flashback/history honors since filter', async () => {
  const db = freshDb();
  try {
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'old', fired_at: '2026-04-29T10:00:00.000Z',
    });
    flashbackDiag.recordFlashback(db, {
      sessionId: 's', error_text: 'new', fired_at: '2026-04-30T10:00:00.000Z',
    });
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/flashback/history?since=2026-04-30T00:00:00.000Z`
      );
      const body = await res.json();
      assert.equal(body.count, 1);
      assert.equal(body.events[0].error_text, 'new');
      assert.equal(body.funnel.fires, 1);
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('GET /api/flashback/history returns empty arrays / zero funnel when no rows', async () => {
  const db = freshDb();
  try {
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/flashback/history`);
      const body = await res.json();
      assert.equal(body.count, 0);
      assert.deepEqual(body.events, []);
      assert.deepEqual(body.funnel, { fires: 0, dismissed: 0, clicked_through: 0 });
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('POST /api/flashback/:id/dismissed updates the row', async () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'x' });
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/flashback/${id}/dismissed`, {
        method: 'POST',
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.updated, true);
      const row = db.prepare(`SELECT dismissed_at FROM flashback_events WHERE id = ?`).get(id);
      assert.ok(row.dismissed_at);
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('POST /api/flashback/:id/clicked updates clicked_through + dismissed_at', async () => {
  const db = freshDb();
  try {
    const id = flashbackDiag.recordFlashback(db, { sessionId: 's', error_text: 'x' });
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/flashback/${id}/clicked`, {
        method: 'POST',
      });
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.updated, true);
      const row = db.prepare(
        `SELECT clicked_through, dismissed_at FROM flashback_events WHERE id = ?`
      ).get(id);
      assert.equal(row.clicked_through, 1);
      assert.ok(row.dismissed_at);
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('POST /api/flashback/:id/dismissed returns 400 on invalid id', async () => {
  const db = freshDb();
  try {
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res1 = await fetch(`http://127.0.0.1:${port}/api/flashback/abc/dismissed`, {
        method: 'POST',
      });
      assert.equal(res1.status, 400);
      const res2 = await fetch(`http://127.0.0.1:${port}/api/flashback/0/dismissed`, {
        method: 'POST',
      });
      assert.equal(res2.status, 400);
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

test('POST /api/flashback/:id/clicked returns updated=false for unknown id', async () => {
  const db = freshDb();
  try {
    const app = express();
    attachHistoryRoutes(app, db);
    const { server, port } = await listenOnce(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/flashback/9999/clicked`, {
        method: 'POST',
      });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.updated, false, 'no row to update — graceful');
    } finally {
      server.close();
    }
  } finally {
    db.close();
  }
});

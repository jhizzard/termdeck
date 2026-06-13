// Sprint 78 T1 — doctrine_events throttle (shouldNotify) + recordGateEvent +
// DDL wiring. The per-RULE registry-stage throttle T2 consumes: 30-min per-rule
// cooldown + hard 3-advisories/lane/hour budget (overflow → ORCH). Deterministic
// via an injected clock (opts.now) + an in-memory better-sqlite3 handle (opts.db),
// so no wall-clock dependence and no shared-state bleed between tests.
//
// Run: node --test packages/server/tests/doctrine-throttle.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const doctrine = require('../../../doctrine');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(doctrine.DOCTRINE_EVENTS_SQL);
  return db;
}

const T0 = '2026-06-13T20:00:00.000Z';
const T0_PLUS_31MIN = '2026-06-13T20:31:00.000Z';
const T0_PLUS_29MIN = '2026-06-13T20:29:00.000Z';

test('DOCTRINE_EVENTS_SQL creates the table + both indexes', () => {
  const db = freshDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doctrine_events'").all();
  assert.equal(tables.length, 1, 'doctrine_events table exists');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'doctrine_events%' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(idx, ['doctrine_events_lane_fired_idx', 'doctrine_events_rule_fired_idx'], 'both indexes created');
  db.close();
});

test('shouldNotify: first call for a rule notifies and records a notified row', () => {
  const db = freshDb();
  const r = doctrine.shouldNotify('rule-a', 'sess1:errX', { lane: 'panel1', surface: 'inject-advisory', db, now: T0 });
  assert.equal(r.notify, true);
  assert.equal(r.outcome, 'notified');
  assert.equal(r.recorded, true);
  const rows = db.prepare("SELECT rule_id, lane, outcome FROM doctrine_events WHERE outcome='notified'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule_id, 'rule-a');
  db.close();
});

test('shouldNotify: 2nd call for the same rule within the 30-min cooldown is suppressed', () => {
  const db = freshDb();
  const first = doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', db, now: T0 });
  assert.equal(first.notify, true);
  const second = doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', db, now: T0_PLUS_29MIN });
  assert.equal(second.notify, false);
  assert.equal(second.reason, 'rule-cooldown-active');
  assert.equal(second.outcome, 'suppressed-cooldown');
  db.close();
});

test('shouldNotify: same rule AFTER the cooldown window notifies again', () => {
  const db = freshDb();
  doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', db, now: T0 });
  const later = doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', db, now: T0_PLUS_31MIN });
  assert.equal(later.notify, true, 'cooldown elapsed ⇒ notify again');
  assert.equal(later.outcome, 'notified');
  db.close();
});

test('shouldNotify: hard 3-advisories/lane/hour budget — 4th distinct rule overflows to ORCH', () => {
  const db = freshDb();
  // 3 DISTINCT rules (so cooldown never binds), same lane, same hour ⇒ all notify
  for (const rid of ['r1', 'r2', 'r3']) {
    const r = doctrine.shouldNotify(rid, 'k', { lane: 'panelBudget', db, now: T0 });
    assert.equal(r.notify, true, `${rid} should notify (under budget)`);
  }
  // 4th distinct rule, same lane, same hour ⇒ budget exceeded ⇒ overflow → ORCH
  const fourth = doctrine.shouldNotify('r4', 'k', { lane: 'panelBudget', db, now: T0 });
  assert.equal(fourth.notify, false);
  assert.equal(fourth.reason, 'lane-hourly-budget-exceeded');
  assert.equal(fourth.outcome, 'overflow-orch');
  assert.equal(fourth.route, 'orch');
  db.close();
});

test('shouldNotify: lane budgets are independent (another lane is unaffected)', () => {
  const db = freshDb();
  for (const rid of ['r1', 'r2', 'r3']) doctrine.shouldNotify(rid, 'k', { lane: 'laneA', db, now: T0 });
  const over = doctrine.shouldNotify('r4', 'k', { lane: 'laneA', db, now: T0 });
  assert.equal(over.notify, false, 'laneA exhausted');
  const otherLane = doctrine.shouldNotify('r5', 'k', { lane: 'laneB', db, now: T0 });
  assert.equal(otherLane.notify, true, 'laneB has its own budget');
  db.close();
});

test('shouldNotify: a falsy-but-present lane ("") is bucketed faithfully (guard/insert agree)', () => {
  // Regression guard: recordGateEvent records lane verbatim (not `|| null`), so
  // the `WHERE lane = ?` budget query matches the `if (lane != null)` guard even
  // for an empty-string lane — no silent unthrottled hole.
  const db = freshDb();
  for (const rid of ['r1', 'r2', 'r3']) {
    assert.equal(doctrine.shouldNotify(rid, 'k', { lane: '', db, now: T0 }).notify, true);
  }
  const fourth = doctrine.shouldNotify('r4', 'k', { lane: '', db, now: T0 });
  assert.equal(fourth.notify, false, 'empty-string lane budget binds (not silently unthrottled)');
  assert.equal(fourth.outcome, 'overflow-orch');
  const rows = db.prepare("SELECT lane, COUNT(*) AS n FROM doctrine_events WHERE outcome='notified' GROUP BY lane").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, '', 'lane recorded verbatim as empty string, not coerced to NULL');
  db.close();
});

test('shouldNotify: budget counts only DELIVERED rows (suppressed/overflow do not consume budget)', () => {
  const db = freshDb();
  // one notified + several cooldown-suppressed for the SAME rule should not eat the lane budget
  doctrine.shouldNotify('rZ', 'k', { lane: 'laneC', db, now: T0 });            // notified (1)
  doctrine.shouldNotify('rZ', 'k', { lane: 'laneC', db, now: T0_PLUS_29MIN }); // suppressed-cooldown
  doctrine.shouldNotify('rZ', 'k', { lane: 'laneC', db, now: T0_PLUS_29MIN }); // suppressed-cooldown
  // two MORE distinct rules still fit under the 3/hr budget (only 1 delivered so far)
  assert.equal(doctrine.shouldNotify('rY', 'k', { lane: 'laneC', db, now: T0_PLUS_29MIN }).notify, true);
  assert.equal(doctrine.shouldNotify('rW', 'k', { lane: 'laneC', db, now: T0_PLUS_29MIN }).notify, true);
  db.close();
});

test('shouldNotify: no db ⇒ fail-soft notify:true (never throws), no row recorded', () => {
  doctrine.setDb(null); // ensure no ambient injected handle
  let r;
  assert.doesNotThrow(() => { r = doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', now: T0 }); });
  assert.equal(r.notify, true);
  assert.equal(r.reason, 'no-db-failsoft');
  assert.equal(r.recorded, false);
});

test('shouldNotify: record:false returns a decision but writes no row', () => {
  const db = freshDb();
  const r = doctrine.shouldNotify('rule-a', 'k', { lane: 'panel1', db, now: T0, record: false });
  assert.equal(r.notify, true);
  assert.equal(r.recorded, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doctrine_events').get().n, 0, 'no row written when record:false');
  db.close();
});

test('recordGateEvent: writes a row with the given fields', () => {
  const db = freshDb();
  const res = doctrine.recordGateEvent({ rule_id: 'rule-x', lane: 'p', surface: 'inject-advisory', outcome: 'notified', reason: 'ok', session_id: 's1', detail: { foo: 1 } }, { db, now: T0 });
  assert.equal(res.recorded, true);
  const row = db.prepare('SELECT * FROM doctrine_events').get();
  assert.equal(row.rule_id, 'rule-x');
  assert.equal(row.outcome, 'notified');
  assert.equal(row.session_id, 's1');
  assert.equal(JSON.parse(row.detail).foo, 1, 'object detail serialized to JSON');
  db.close();
});

test('recordGateEvent: NEVER throws on a broken db handle (fail-soft)', () => {
  const brokenDb = { prepare() { throw new Error('boom'); } };
  let res;
  assert.doesNotThrow(() => { res = doctrine.recordGateEvent({ rule_id: 'r', outcome: 'notified' }, { db: brokenDb }); });
  assert.equal(res.recorded, false);
  assert.equal(res.reason, 'error');
});

test('shouldNotify: NEVER throws on a broken db handle (fail-soft, allows delivery)', () => {
  const brokenDb = { prepare() { throw new Error('boom'); } };
  let r;
  assert.doesNotThrow(() => { r = doctrine.shouldNotify('r', 'k', { lane: 'p', db: brokenDb, now: T0 }); });
  assert.equal(r.notify, true);
  assert.equal(r.reason, 'throttle-error-failsoft');
});

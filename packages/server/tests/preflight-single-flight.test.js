// Preflight single-flight fences (2026-09-02).
//
// Why this file exists
// ────────────────────
// The stack badge in the client renders `passed/total` over the seven
// checks GET /api/health returns. Three of those seven checks are backed by
// only TWO dependencies:
//
//   mnestra_reachable + mnestra_has_memories  →  the Mnestra daemon /healthz
//   database_url + rumen_recent (+ graph_health)  →  one remote Postgres
//
// Before this change each check opened its OWN connection: two GETs of the
// same /healthz URL, and two-to-three separate pg Pools created in the same
// tick with their own 5 s connect budgets. So a dependency that was merely
// SLOW — routine on a host running an eight-panel sprint — knocked out a
// whole group at once and the badge read "5/7" on a demonstrably healthy
// stack. The Sprint 8K hotfix raised the mnestra budget but left the
// duplicate request, and never touched the Postgres pair at all.
//
// These fences lock in the rule `health.js` already applies to
// /api/health/full: one probe per dependency, one root cause per failure.
//
// Run: node --test packages/server/tests/preflight-single-flight.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runPreflight, _resetCache, _budgets } = require('../src/preflight');

const CONFIG = { rag: {}, projects: {} };

function fakePool(handlers) {
  const calls = { queries: [], ended: 0 };
  return {
    calls,
    pool: {
      query: async (sql) => {
        calls.queries.push(sql);
        for (const [pattern, fn] of handlers) {
          if (pattern.test(sql)) return fn(sql);
        }
        return { rows: [] };
      },
      end: async () => { calls.ended++; },
    },
  };
}

const OK_HANDLERS = [
  [/SELECT 1 AS ok/, () => ({ rows: [{ ok: 1 }] })],
  [/rumen_jobs/, () => ({ rows: [{ status: 'done', completed_at: new Date(), insights_generated: 3 }] })],
];

function withDatabaseUrl(value, fn) {
  const stash = process.env.DATABASE_URL;
  if (value === null) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  return (async () => {
    try { return await fn(); } finally {
      if (stash === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = stash;
    }
  })();
}

test.beforeEach(() => { _resetCache(); });

// ── Mnestra: one /healthz request serves both checks ──────────────────────

test('mnestra: a single /healthz request backs BOTH mnestra checks', async () => {
  const urls = [];
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async (url) => { urls.push(url); return JSON.stringify({ store: { rows: 4242 } }); },
    });
    const reachable = result.checks.find((c) => c.name === 'mnestra_reachable');
    const has = result.checks.find((c) => c.name === 'mnestra_has_memories');
    assert.equal(reachable.passed, true);
    assert.equal(has.passed, true);
    assert.match(reachable.detail, /4,242 memories/);
    assert.match(has.detail, /4,242 memories loaded/);
  });
  assert.equal(urls.length, 1, `exactly one /healthz request expected; got ${urls.length}: ${JSON.stringify(urls)}`);
});

test('mnestra: a dead daemon is probed once, and both checks tell the same story', async () => {
  let calls = 0;
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => {
        calls++;
        const err = new Error('connect ECONNREFUSED 127.0.0.1:37778');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    const reachable = result.checks.find((c) => c.name === 'mnestra_reachable');
    const has = result.checks.find((c) => c.name === 'mnestra_has_memories');
    assert.equal(reachable.passed, false);
    assert.equal(has.passed, false);
    // Both must attribute the SAME underlying failure.
    assert.match(reachable.detail, /ECONNREFUSED/);
    assert.match(has.detail, /ECONNREFUSED/);
  });
  // ECONNREFUSED is conclusive — nothing is listening. No retry.
  assert.equal(calls, 1, `a refused connection must be probed once; got ${calls}`);
});

// This is the exact live failure observed on deck :3002 at 13:10 ET on
// 2026-09-02: both mnestra checks red with detail "timeout" while the store
// was healthy (11,124 rows) and a sibling deck polled 7/7 one second later.
test('mnestra: a timeout gets exactly one retry, and a daemon that answers on it is GREEN', async () => {
  let calls = 0;
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => {
        calls++;
        if (calls === 1) throw new Error('timeout');
        return JSON.stringify({ store: { rows: 11124 } });
      },
    });
    const reachable = result.checks.find((c) => c.name === 'mnestra_reachable');
    const has = result.checks.find((c) => c.name === 'mnestra_has_memories');
    assert.equal(reachable.passed, true, `slow-but-alive must not read as dead; got ${reachable.detail}`);
    assert.equal(has.passed, true, `slow-but-alive must not read as dead; got ${has.detail}`);
  });
  assert.equal(calls, 2, `one timeout ⇒ exactly one retry; got ${calls} probes`);
});

test('mnestra: the retry is bounded — a persistently timing-out daemon still goes red, not forever', async () => {
  let calls = 0;
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => { calls++; throw new Error('timeout'); },
    });
    for (const name of ['mnestra_reachable', 'mnestra_has_memories']) {
      const c = result.checks.find((x) => x.name === name);
      assert.equal(c.passed, false);
      assert.match(c.detail, /timeout/);
    }
  });
  assert.equal(calls, 2, `at most one retry; got ${calls} probes`);
});

// ── Postgres: one pool serves database_url + rumen_recent ─────────────────

test('postgres: a single pool backs database_url and rumen_recent, and is closed once', async () => {
  const fake = fakePool(OK_HANDLERS);
  let factoryCalls = 0;
  await withDatabaseUrl('postgres://fake/db', async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => JSON.stringify({ store: { rows: 10 } }),
      pgPoolFactory: () => { factoryCalls++; return fake.pool; },
    });
    const db = result.checks.find((c) => c.name === 'database_url');
    const rumen = result.checks.find((c) => c.name === 'rumen_recent');
    assert.equal(db.passed, true, `database_url should pass; got ${db.detail}`);
    assert.equal(rumen.passed, true, `rumen_recent should pass; got ${rumen.detail}`);
  });
  assert.equal(factoryCalls, 1, `exactly one pg Pool per preflight run; got ${factoryCalls}`);
  assert.equal(fake.calls.ended, 1, 'the shared pool must be closed exactly once');
});

test('postgres: the pool is closed even when a check throws', async () => {
  const fake = fakePool([[/SELECT 1 AS ok/, () => { throw new Error('connect ETIMEDOUT'); }]]);
  await withDatabaseUrl('postgres://fake/db', async () => {
    await runPreflight(CONFIG, {
      httpGet: async () => JSON.stringify({ store: { rows: 10 } }),
      pgPoolFactory: () => fake.pool,
    });
  });
  assert.equal(fake.calls.ended, 1, 'pool must be closed on the failure path too');
});

test('postgres: a dead connection names database_url as the root cause instead of a second red row', async () => {
  const fake = fakePool([[/./, () => { throw new Error('connect ETIMEDOUT'); }]]);
  await withDatabaseUrl('postgres://fake/db', async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => JSON.stringify({ store: { rows: 10 } }),
      pgPoolFactory: () => fake.pool,
    });
    const db = result.checks.find((c) => c.name === 'database_url');
    const rumen = result.checks.find((c) => c.name === 'rumen_recent');
    assert.equal(db.passed, false);
    assert.match(rumen.detail, /database_url is the root cause/,
      `rumen_recent must point at the root cause; got: ${rumen.detail}`);
    // rumen_recent never issues its own query once the shared connection is known dead.
    assert.equal(fake.calls.queries.filter((q) => /rumen_jobs/.test(q)).length, 0);
  });
});

test('postgres: DATABASE_URL unset still reports both checks with the same reason', async () => {
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => JSON.stringify({ store: { rows: 10 } }),
    });
    const db = result.checks.find((c) => c.name === 'database_url');
    const rumen = result.checks.find((c) => c.name === 'rumen_recent');
    assert.equal(db.passed, false);
    assert.equal(db.detail, 'DATABASE_URL not set');
    assert.equal(rumen.passed, false);
    assert.match(rumen.detail, /DATABASE_URL not set/);
  });
});

// ── Shape contract: the badge still counts seven checks ───────────────────

test('contract: runPreflight still returns exactly the seven named checks', async () => {
  await withDatabaseUrl(null, async () => {
    const result = await runPreflight(CONFIG, {
      httpGet: async () => JSON.stringify({ store: { rows: 10 } }),
    });
    const names = result.checks.map((c) => c.name);
    assert.deepEqual(names, [
      'mnestra_reachable',
      'mnestra_has_memories',
      'rumen_recent',
      'database_url',
      'project_paths',
      'shell_sanity',
      'graph_health',
    ]);
    assert.equal(typeof result.passed, 'boolean');
    assert.ok(!Number.isNaN(Date.parse(result.timestamp)));
  });
});

// ── Budgets: load-tolerant by default, env-tunable ────────────────────────

test('budgets: every probe budget is a bounded, non-trivial liveness window', () => {
  // A budget tight enough to call a loaded-but-working host "broken" is the
  // bug this file exists to prevent; an unbounded one would hang the badge.
  for (const [name, ms] of Object.entries({
    mnestra: _budgets.mnestraMs,
    pg: _budgets.pgMs,
    shell: _budgets.shellMs,
  })) {
    assert.ok(Number.isFinite(ms), `${name} budget must be a finite number`);
    assert.ok(ms >= 5_000, `${name} budget must survive a loaded host (>= 5s); got ${ms}`);
    assert.ok(ms <= 60_000, `${name} budget must stay a liveness bound (<= 60s); got ${ms}`);
  }
});

test('budgets: each one is overridable from the environment', () => {
  // The constants are read at module load, so assert the contract on a
  // freshly-required copy rather than mutating the already-loaded module.
  const path = require.resolve('../src/preflight');
  const stash = {
    m: process.env.TERMDECK_MNESTRA_PROBE_TIMEOUT_MS,
    p: process.env.TERMDECK_PG_PROBE_TIMEOUT_MS,
    s: process.env.TERMDECK_SHELL_PROBE_TIMEOUT_MS,
  };
  process.env.TERMDECK_MNESTRA_PROBE_TIMEOUT_MS = '11000';
  process.env.TERMDECK_PG_PROBE_TIMEOUT_MS = '12000';
  process.env.TERMDECK_SHELL_PROBE_TIMEOUT_MS = '13000';
  delete require.cache[path];
  try {
    const fresh = require(path);
    assert.equal(fresh._budgets.mnestraMs, 11000);
    assert.equal(fresh._budgets.pgMs, 12000);
    assert.equal(fresh._budgets.shellMs, 13000);
  } finally {
    for (const [k, v] of [
      ['TERMDECK_MNESTRA_PROBE_TIMEOUT_MS', stash.m],
      ['TERMDECK_PG_PROBE_TIMEOUT_MS', stash.p],
      ['TERMDECK_SHELL_PROBE_TIMEOUT_MS', stash.s],
    ]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[path];
    require(path);
  }
});

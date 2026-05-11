// Sprint 63 T3 §3.2 — Health-probe red:<category> taxonomy fence tests.
//
// Why this file exists
// ────────────────────
// Pre-Sprint-63 every non-pass health check collapsed to `status: 'fail'`
// with a free-text `detail` string. The Brad 2026-05-11 r730 cascade
// proved the cost: a SQLite ABI mismatch left `db = null` at boot, and the
// resulting `red: timeout` detail strings (from probes that hit timeouts
// trying to use the indirectly-broken handle) masked the actual
// `init-failed` root cause for hours of chasing the wrong symptom.
//
// `health.js` now classifies every non-pass check into one of:
//   • `red:unreachable`     — ECONNREFUSED / EHOSTUNREACH / ENETUNREACH /
//                              ENOTFOUND on connect
//   • `red:timeout`         — AbortError / req timeout / pg ETIMEDOUT
//   • `red:dependency-down` — peer responded but the dependency is unhealthy
//                              (HTTP 5xx / SQL schema error)
//   • `red:init-failed`     — local handle never initialized (db === null
//                              at boot / DATABASE_URL not set)
//
// This file fences each category against synthetic inputs so a refactor
// can't silently collapse the taxonomy back into a single string.
//
// Run: node --test packages/server/tests/health-probe-taxonomy.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES,
  classifyDbFailure,
  classifyHttpFailure,
  _resetCache,
  _resetInitLogged,
} = require('../src/health');

// Stash the cache + log-once gate before each test so cases don't bleed.
test.beforeEach(() => {
  _resetCache();
  _resetInitLogged();
});

// ── Pure classifier coverage ──────────────────────────────────────────────

test('classifyHttpFailure: timeout when code=TIMEOUT', () => {
  assert.equal(classifyHttpFailure({ ok: false, code: 'TIMEOUT', error: 'timeout' }), CATEGORIES.TIMEOUT);
});

test('classifyHttpFailure: timeout when error=timeout (string match fallback)', () => {
  assert.equal(classifyHttpFailure({ ok: false, error: 'timeout' }), CATEGORIES.TIMEOUT);
});

test('classifyHttpFailure: unreachable on ECONNREFUSED', () => {
  assert.equal(classifyHttpFailure({ ok: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED 127.0.0.1:37778' }), CATEGORIES.UNREACHABLE);
});

test('classifyHttpFailure: unreachable on ENOTFOUND', () => {
  assert.equal(classifyHttpFailure({ ok: false, code: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND nonsense.local' }), CATEGORIES.UNREACHABLE);
});

test('classifyHttpFailure: dependency-down on HTTP 503', () => {
  assert.equal(classifyHttpFailure({ ok: false, status: 503 }), CATEGORIES.DEPENDENCY_DOWN);
});

test('classifyHttpFailure: dependency-down on HTTP 502', () => {
  assert.equal(classifyHttpFailure({ ok: false, status: 502 }), CATEGORIES.DEPENDENCY_DOWN);
});

test('classifyDbFailure: unreachable on ECONNREFUSED', () => {
  assert.equal(classifyDbFailure({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), CATEGORIES.UNREACHABLE);
});

test('classifyDbFailure: timeout on ETIMEDOUT', () => {
  assert.equal(classifyDbFailure({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }), CATEGORIES.TIMEOUT);
});

test('classifyDbFailure: timeout when message contains timeout', () => {
  assert.equal(classifyDbFailure({ message: 'Connection timeout exceeded' }), CATEGORIES.TIMEOUT);
});

test('classifyDbFailure: dependency-down on SQL 42703 (column does not exist)', () => {
  // The Brad 2026-05-11 scenario for the rumen_jobs.created_at bug —
  // a reachable Postgres answered with a schema error. That's "peer
  // responded badly," not "peer unreachable" or "peer slow."
  assert.equal(classifyDbFailure({ code: '42703', message: 'column "created_at" does not exist' }), CATEGORIES.DEPENDENCY_DOWN);
});

test('classifyDbFailure: dependency-down on SQL 42P01 (relation does not exist)', () => {
  assert.equal(classifyDbFailure({ code: '42P01', message: 'relation "rumen_jobs" does not exist' }), CATEGORIES.DEPENDENCY_DOWN);
});

test('classifyDbFailure: dependency-down on unknown error (safe default)', () => {
  // Unknown failure shapes should not pretend to be reachable-but-bad
  // OR unreachable. Default to dependency-down so the operator's
  // first thought is "the peer is unhealthy" — which is correct in the
  // overwhelming majority of generic SQL-error cases.
  assert.equal(classifyDbFailure({ message: 'something weird' }), CATEGORIES.DEPENDENCY_DOWN);
});

// ── End-to-end through getFullHealth ──────────────────────────────────────

const { getFullHealth, REQUIRED_CHECKS } = require('../src/health');

test('end-to-end: sqlite db === null → red:init-failed', async () => {
  // `db: null` is the v1.1.1-fail-fast SHOULD-never-fire surface, but the
  // probe must still classify correctly because future optional deps may
  // legitimately be null. Pre-Sprint-63 this came back as a generic
  // status:'fail' with no category.
  const report = await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
  const sqlite = report.checks.find((c) => c.name === 'sqlite');
  assert.ok(sqlite, 'sqlite check must be present in report');
  assert.equal(sqlite.status, 'fail');
  assert.equal(sqlite.category, CATEGORIES.INIT_FAILED);
  assert.ok(
    sqlite.detail.startsWith(CATEGORIES.INIT_FAILED),
    `detail must lead with ${CATEGORIES.INIT_FAILED} prefix; got: ${sqlite.detail}`,
  );
});

test('end-to-end: DATABASE_URL not set → mnestra-pg = red:init-failed (not red:timeout)', async () => {
  // The brief: distinguish init-failed from timeout. Pre-Sprint-63 a
  // missing DATABASE_URL still produced `status: 'fail'` with no category.
  // Brad's r730 cascade was exactly this shape: the dashboard couldn't
  // tell "you never set the URL" from "the URL is slow."
  //
  // The test process inherits the operator's shell env via `npm test`, so
  // `process.env.DATABASE_URL` may already be set from ~/.termdeck/secrets.env.
  // Stash + clear it for the duration of this case so the probe sees the
  // "never configured" surface, not the developer's daily-driver URL.
  const stash = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const report = await getFullHealth(
      { rag: {} },
      {
        refresh: true,
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        databaseUrl: null,
      },
    );
    const pg = report.checks.find((c) => c.name === 'mnestra-pg');
    assert.ok(pg, 'mnestra-pg check must be present');
    assert.equal(pg.status, 'fail');
    assert.equal(pg.category, CATEGORIES.INIT_FAILED);
    // Dependents share the same category — operator should see one root
    // cause rather than 6 independent-looking RED rows.
    for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
      const dep = report.checks.find((c) => c.name === name);
      assert.equal(dep.category, CATEGORIES.INIT_FAILED, `${name} should propagate the init-failed category`);
    }
  } finally {
    if (stash !== undefined) process.env.DATABASE_URL = stash;
  }
});

test('end-to-end: pg connect ECONNREFUSED → red:unreachable', async () => {
  // Stub pgClient by intercepting the safeQueryRow path. We can't
  // monkey-patch the require here, so use the dep-injection seam: pass
  // a fake `_pgClient` whose query() throws ECONNREFUSED to exercise
  // the per-query classifier branch.
  const fakeClient = {
    query: async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    end: async () => {},
  };
  const report = await getFullHealth(
    { rag: { databaseUrl: 'postgres://fake' } },
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: 'postgres://fake',
      _pgClient: fakeClient,
    },
  );
  const pg = report.checks.find((c) => c.name === 'mnestra-pg');
  assert.equal(pg.status, 'fail');
  assert.equal(pg.category, CATEGORIES.UNREACHABLE);
});

test('end-to-end: pg query ETIMEDOUT → red:timeout', async () => {
  const fakeClient = {
    query: async () => {
      const err = new Error('Connection timeout exceeded');
      err.code = 'ETIMEDOUT';
      throw err;
    },
    end: async () => {},
  };
  const report = await getFullHealth(
    { rag: { databaseUrl: 'postgres://fake' } },
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: 'postgres://fake',
      _pgClient: fakeClient,
    },
  );
  const pg = report.checks.find((c) => c.name === 'mnestra-pg');
  assert.equal(pg.status, 'fail');
  assert.equal(pg.category, CATEGORIES.TIMEOUT);
});

test('end-to-end: pg query SQL 42703 → red:dependency-down', async () => {
  // The Brad 2026-05-11 column-not-exist symptom — a reachable healthy
  // peer that answered with a schema error. Pre-Sprint-63 this looked
  // identical (in status/detail) to "peer unreachable."
  const fakeClient = {
    query: async () => {
      const err = new Error('column "created_at" does not exist');
      err.code = '42703';
      throw err;
    },
    end: async () => {},
  };
  const report = await getFullHealth(
    { rag: { databaseUrl: 'postgres://fake' } },
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: 'postgres://fake',
      _pgClient: fakeClient,
    },
  );
  const pg = report.checks.find((c) => c.name === 'mnestra-pg');
  assert.equal(pg.status, 'fail');
  assert.equal(pg.category, CATEGORIES.DEPENDENCY_DOWN);
});

test('end-to-end: webhook HTTP 503 → red:dependency-down', async () => {
  // Test-seam probe simulates a healthy peer responding 503.
  const report = await getFullHealth(
    { rag: { mnestraWebhookUrl: 'http://127.0.0.1:9/mnestra' } },
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: null,
      _mnestraWebhookProbe: async () => ({ ok: false, status: 503, error: 'HTTP 503' }),
    },
  );
  const webhook = report.checks.find((c) => c.name === 'mnestra-webhook');
  assert.equal(webhook.status, 'warn');
  assert.equal(webhook.category, CATEGORIES.DEPENDENCY_DOWN);
});

test('end-to-end: webhook ECONNREFUSED → red:unreachable', async () => {
  const report = await getFullHealth(
    { rag: { mnestraWebhookUrl: 'http://127.0.0.1:9/mnestra' } },
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: null,
      _mnestraWebhookProbe: async () => ({ ok: false, code: 'ECONNREFUSED', error: 'connect ECONNREFUSED' }),
    },
  );
  const webhook = report.checks.find((c) => c.name === 'mnestra-webhook');
  assert.equal(webhook.status, 'warn');
  assert.equal(webhook.category, CATEGORIES.UNREACHABLE);
});

test('end-to-end: webhook URL not configured → red:init-failed', async () => {
  const report = await getFullHealth(
    { rag: {} }, // no mnestraWebhookUrl
    {
      refresh: true,
      db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
      databaseUrl: null,
    },
  );
  const webhook = report.checks.find((c) => c.name === 'mnestra-webhook');
  assert.equal(webhook.status, 'warn');
  assert.equal(webhook.category, CATEGORIES.INIT_FAILED);
});

// ── Log-once gate ─────────────────────────────────────────────────────────

test('log-once: db===null produces exactly one [health] sqlite warn across 3 cycles', async () => {
  const origWarn = console.warn;
  const warnLines = [];
  console.warn = (...args) => warnLines.push(args.join(' '));
  try {
    // Three consecutive cycles (refresh:true bypasses the 30s cache).
    await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
    await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
    await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
  } finally {
    console.warn = origWarn;
  }
  const sqliteWarns = warnLines.filter((l) => l.includes('[health] sqlite handle null at boot'));
  assert.equal(sqliteWarns.length, 1, `exactly one sqlite init-failed warn expected across 3 cycles; got ${sqliteWarns.length}: ${JSON.stringify(warnLines)}`);
});

test('log-once: 3 cycles all return red:init-failed in JSON even though warn fires once', async () => {
  // The log-once gate must NOT alter the JSON report — that would
  // create a "the first poll is RED, the second is GREEN" oscillation.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const r1 = await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
    const r2 = await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
    const r3 = await getFullHealth({}, { refresh: true, db: null, databaseUrl: null });
    for (const r of [r1, r2, r3]) {
      const sqlite = r.checks.find((c) => c.name === 'sqlite');
      assert.equal(sqlite.category, CATEGORIES.INIT_FAILED);
    }
  } finally {
    console.warn = origWarn;
  }
});

// ── Outer-catch fallbacks carry categories (T4-CODEX AUDIT-CONCERN 13:27 ET) ─

// Pre-Sprint-63 (and through T3's first FIX-LANDED), the four outer catches
// inside `getFullHealth` emitted raw `{ name, status, detail }` objects with
// no `category` field. T4-CODEX flagged this: any unexpected throw in a probe
// path reintroduces uncategorized rows despite the in-probe taxonomy. These
// fences drive a synthetic throw via the `_throwIn` test seam and assert the
// outer catch produces a properly categorized envelope.

test('outer catch fence: sqlite probe throws → category set + detail prefixed', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const report = await getFullHealth(
      { rag: {} },
      {
        refresh: true,
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        databaseUrl: null,
        _throwIn: 'sqlite',
      },
    );
    const sqlite = report.checks.find((c) => c.name === 'sqlite');
    assert.equal(sqlite.status, 'fail');
    assert.ok(sqlite.category, 'sqlite outer catch must attach a category');
    // Default-safe classification for a no-code Error → dependency-down.
    assert.equal(sqlite.category, CATEGORIES.DEPENDENCY_DOWN);
    assert.ok(sqlite.detail.startsWith(CATEGORIES.DEPENDENCY_DOWN));
    assert.ok(sqlite.detail.includes('test-fence'));
  } finally { console.warn = origWarn; }
});

test('outer catch fence: pg suite throws → primary + 5 dependents all carry the same category', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const report = await getFullHealth(
      { rag: {} },
      {
        refresh: true,
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        databaseUrl: null,
        _throwIn: 'pg',
      },
    );
    const pg = report.checks.find((c) => c.name === 'mnestra-pg');
    assert.equal(pg.status, 'fail');
    assert.equal(pg.category, CATEGORIES.DEPENDENCY_DOWN);
    assert.ok(pg.detail.startsWith(CATEGORIES.DEPENDENCY_DOWN));
    // Dependent propagation — one root cause, not 6 RED rows.
    for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
      const dep = report.checks.find((c) => c.name === name);
      assert.equal(dep.status, 'fail', `${name} should be fail`);
      assert.equal(dep.category, CATEGORIES.DEPENDENCY_DOWN, `${name} should propagate dependency-down`);
      assert.ok(dep.detail.includes('pg suite aborted'), `${name} should reference suite abort`);
    }
  } finally { console.warn = origWarn; }
});

test('outer catch fence: webhook probe throws → warn with category', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const report = await getFullHealth(
      { rag: {} },
      {
        refresh: true,
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        databaseUrl: null,
        _throwIn: 'webhook',
      },
    );
    const webhook = report.checks.find((c) => c.name === 'mnestra-webhook');
    assert.equal(webhook.status, 'warn');
    assert.ok(webhook.category, 'webhook outer catch must attach a category');
    // HTTP-probe outer catch goes through `classifyHttpFailure`, whose
    // default branch for no-code/no-status errors is `red:unreachable`
    // (HTTP failures without a known shape are far more often network-level
    // than peer-responded-badly). This is asymmetric with the db classifier,
    // which defaults to `red:dependency-down`. The asymmetry is intentional
    // and is itself part of the contract being fenced here.
    assert.equal(webhook.category, CATEGORIES.UNREACHABLE);
    assert.ok(webhook.detail.startsWith(CATEGORIES.UNREACHABLE));
  } finally { console.warn = origWarn; }
});

test('outer catch fence: rumen-pool probe throws → warn with category', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const report = await getFullHealth(
      { rag: {} },
      {
        refresh: true,
        db: { prepare: () => ({ get: () => ({ ok: 1 }) }) },
        databaseUrl: null,
        _throwIn: 'rumen-pool',
      },
    );
    const pool = report.checks.find((c) => c.name === 'rumen-pool');
    assert.equal(pool.status, 'warn');
    assert.ok(pool.category, 'rumen-pool outer catch must attach a category');
    assert.equal(pool.category, CATEGORIES.DEPENDENCY_DOWN);
    assert.ok(pool.detail.startsWith(CATEGORIES.DEPENDENCY_DOWN));
  } finally { console.warn = origWarn; }
});

// Belt-and-suspenders: the assertion that the outer-catch fallback has no
// uncategorized escape hatch. Iterate every check in the report from a
// fence-induced multi-probe-throw scenario (here we throw pg, leaving the
// other probes to run normally) and assert NO check returns with
// status:'fail'|'warn' and a missing `category` field.
test('outer catch fence: invariant — no non-pass check is ever missing category', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    // Use a config that intentionally produces non-pass on multiple probes:
    // null db (init-failed sqlite) + null DATABASE_URL (init-failed pg suite)
    // + no webhook URL (init-failed webhook) + pg unavailable (init-failed
    // rumen-pool) + throw the pg outer to exercise that path too.
    const stash = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const report = await getFullHealth(
        { rag: {} },
        {
          refresh: true,
          db: null,
          databaseUrl: null,
          _throwIn: 'pg',
        },
      );
      for (const c of report.checks) {
        if (c.status === 'pass') continue;
        assert.ok(c.category, `non-pass check ${c.name} must have a category; got: ${JSON.stringify(c)}`);
        assert.ok(
          c.detail && c.detail.startsWith('red:'),
          `non-pass check ${c.name} detail must lead with red:<category>; got: ${c.detail}`,
        );
      }
    } finally {
      if (stash !== undefined) process.env.DATABASE_URL = stash;
    }
  } finally { console.warn = origWarn; }
});

// ── Required-checks contract preserved ────────────────────────────────────

test('REQUIRED_CHECKS still contains the seven names dashboards count on', () => {
  // The names are part of the public contract (client app.js + doctor).
  // Adding categories must not rename or drop any of them.
  const expected = new Set([
    'sqlite',
    'mnestra-pg',
    'memory-items-col',
    'pg-cron-ext',
    'pg-net-ext',
    'vault-secret',
    'cron-job-active',
  ]);
  assert.equal(REQUIRED_CHECKS.size, expected.size);
  for (const name of expected) assert.ok(REQUIRED_CHECKS.has(name), `${name} should still be required`);
});

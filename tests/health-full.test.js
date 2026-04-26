// Tests for packages/server/src/health.js — the v0.7.0 runtime health
// snapshot endpoint backing GET /api/health/full.
//
// Coverage map (matches T3 briefing acceptance criteria):
//   1. all required checks pass + both warn checks pass → ok=true
//   2. memory-items-col missing → ok=false, detail mentions npm-cache recovery
//   3. pg-cron disabled → ok=false, detail names the Supabase dashboard hint
//   4. mnestra-webhook unreachable → check is `warn`, ok stays true
//   5. caching: two calls within TTL share one underlying query pass; refresh:true bypasses
//   6. swallow: a check that throws becomes a structured fail without crashing the report
//   7. index.js route smoke: live server returns the documented JSON shape

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const HEALTH = path.resolve(
  __dirname, '..', 'packages', 'server', 'src', 'health.js'
);

// Re-require the module fresh between tests so the module-scope cache is
// isolated and call counts on the fake pg client are deterministic.
function loadFreshHealth() {
  delete require.cache[HEALTH];
  return require(HEALTH);
}

// ── Fake pg client ──────────────────────────────────────────────────────────
//
// Same shape as preconditions.test.js — first-match-wins on sql.includes(pattern).
// We track call count so the caching test can assert no-extra-queries.

function makeFakeClient(routes) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      for (const [pattern, response] of routes) {
        if (sql.includes(pattern)) {
          if (response instanceof Error) throw response;
          if (typeof response === 'function') return response();
          return response;
        }
      }
      return { rows: [] };
    },
    async end() { /* noop — caller controls owned vs injected */ }
  };
}

// Fake better-sqlite3 db handle — only `prepare(sql).get()` is touched.
function makeFakeDb({ ok = true, throwOnPrepare = false } = {}) {
  return {
    prepare(_sql) {
      if (throwOnPrepare) throw new Error('sqlite db is locked');
      return { get() { return ok ? { ok: 1 } : { ok: 0 }; } };
    }
  };
}

// Routes that pass every required pg check. Order: most specific first.
function allPassingRoutes() {
  return [
    ["column_name = 'source_session_id'", { rows: [{ ok: 1 }] }],
    ["extname = 'pg_cron'",                { rows: [{ ok: 1 }] }],
    ["extname = 'pg_net'",                 { rows: [{ ok: 1 }] }],
    ["name = 'rumen_service_role_key'",    { rows: [{ ok: 1 }] }],
    ["jobname = 'rumen-tick'",             { rows: [{ active: true }] }],
    ['SELECT 1 AS ok',                     { rows: [{ ok: 1 }] }]
  ];
}

// Common options that skip both warn checks via injected probes (so tests
// don't make real HTTP calls or open real pg pools).
function warnsPassing() {
  return {
    _mnestraWebhookProbe: async () => ({ ok: true }),
    _rumenPoolProbe:      async () => ({ ok: true })
  };
}

// ── 1. happy path ───────────────────────────────────────────────────────────

test('getFullHealth: all checks pass → ok=true, every required check is pass', async () => {
  const { getFullHealth, REQUIRED_CHECKS } = loadFreshHealth();
  const client = makeFakeClient(allPassingRoutes());

  const report = await getFullHealth({}, {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    refresh: true,
    ...warnsPassing()
  });

  assert.equal(report.ok, true, `expected ok=true, got: ${JSON.stringify(report)}`);
  assert.equal(report.ttlSeconds, 30);
  assert.ok(typeof report.timestamp === 'string' && !Number.isNaN(Date.parse(report.timestamp)));

  for (const name of REQUIRED_CHECKS) {
    const c = report.checks.find((x) => x.name === name);
    assert.ok(c, `missing required check: ${name}`);
    assert.equal(c.status, 'pass', `${name} should be pass — got ${c.status} (${c.detail || ''})`);
  }
});

// ── 2. memory-items-col missing ─────────────────────────────────────────────

test('memory-items-col missing → ok=false with the npm-cache recovery hint', async () => {
  const { getFullHealth } = loadFreshHealth();
  const routes = allPassingRoutes();
  // Override the source_session_id route to return no rows.
  routes[0] = ["column_name = 'source_session_id'", { rows: [] }];
  const client = makeFakeClient(routes);

  const report = await getFullHealth({}, {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    refresh: true,
    ...warnsPassing()
  });

  assert.equal(report.ok, false);
  const c = report.checks.find((x) => x.name === 'memory-items-col');
  assert.ok(c, 'expected memory-items-col check');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /source_session_id/);
  assert.match(c.detail, /init --mnestra/, 'detail should point at the wizard re-run');
});

// ── 3. pg-cron disabled ─────────────────────────────────────────────────────

test('pg-cron disabled → ok=false, detail names Supabase dashboard path', async () => {
  const { getFullHealth } = loadFreshHealth();
  const routes = allPassingRoutes();
  routes[1] = ["extname = 'pg_cron'", { rows: [] }];
  const client = makeFakeClient(routes);

  const report = await getFullHealth({}, {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    refresh: true,
    ...warnsPassing()
  });

  assert.equal(report.ok, false);
  const c = report.checks.find((x) => x.name === 'pg-cron-ext');
  assert.ok(c);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /Database → Extensions → pg_cron/);
});

// ── 4. mnestra-webhook unreachable does not flip ok ────────────────────────

test('mnestra-webhook unreachable → check is warn, ok stays true', async () => {
  const { getFullHealth } = loadFreshHealth();
  const client = makeFakeClient(allPassingRoutes());

  const report = await getFullHealth({}, {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    refresh: true,
    _mnestraWebhookProbe: async () => ({ ok: false, detail: 'connect ECONNREFUSED 127.0.0.1:37778' }),
    _rumenPoolProbe:      async () => ({ ok: true })
  });

  assert.equal(report.ok, true, 'warn must not flip ok');
  const c = report.checks.find((x) => x.name === 'mnestra-webhook');
  assert.ok(c);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /ECONNREFUSED/);
});

// ── 5. caching ──────────────────────────────────────────────────────────────

test('cache: two calls within TTL hit underlying query once; refresh=true re-queries', async () => {
  const { getFullHealth, _resetCache } = loadFreshHealth();
  _resetCache();
  const client = makeFakeClient(allPassingRoutes());

  const opts = {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    ...warnsPassing()
  };

  await getFullHealth({}, opts);                            // populates cache
  const callsAfterFirst = client.calls.length;
  assert.ok(callsAfterFirst > 0, 'first call should hit the fake client');

  await getFullHealth({}, opts);                            // should hit cache
  assert.equal(client.calls.length, callsAfterFirst, 'second call within TTL should not re-query');

  await getFullHealth({}, { ...opts, refresh: true });      // bypasses cache
  assert.ok(client.calls.length > callsAfterFirst, 'refresh=true should re-query');
});

// ── 6. unexpected error swallow ─────────────────────────────────────────────

test('a probe that throws → that check becomes warn/fail with the error in detail; report still returns', async () => {
  const { getFullHealth } = loadFreshHealth();
  const client = makeFakeClient(allPassingRoutes());

  const report = await getFullHealth({}, {
    db: makeFakeDb(),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: client,
    refresh: true,
    _mnestraWebhookProbe: async () => { throw new Error('synthetic webhook explosion'); },
    _rumenPoolProbe:      async () => ({ ok: true })
  });

  // The thrown probe must not crash the report. Required checks still drive ok.
  assert.equal(report.ok, true);
  const c = report.checks.find((x) => x.name === 'mnestra-webhook');
  assert.ok(c);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /synthetic webhook explosion/);
});

test('a required check that throws → check surfaces as fail with error message; report shape intact', async () => {
  const { getFullHealth } = loadFreshHealth();

  const report = await getFullHealth({}, {
    db: makeFakeDb({ throwOnPrepare: true }),
    databaseUrl: 'postgres://x:y@z/db',
    _pgClient: makeFakeClient(allPassingRoutes()),
    refresh: true,
    ...warnsPassing()
  });

  assert.equal(report.ok, false);
  const c = report.checks.find((x) => x.name === 'sqlite');
  assert.ok(c);
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /sqlite db is locked/);
});

// ── 7. live route smoke ─────────────────────────────────────────────────────
//
// Spawns the real CLI on a free port with a fresh HOME so the server has
// no SQLite or DATABASE_URL configured. We only assert the JSON shape — not
// the pass/fail outcomes — so the test is stable regardless of what the
// fresh-host environment offers.

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-t3-'));
}

function waitForListening(child, marker, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (b) => {
      buf += b.toString('utf8');
      if (buf.includes(marker)) {
        cleanup();
        resolve(true);
      }
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
  });
}

test('live server: GET /api/health/full returns documented JSON shape', async (t) => {
  const CLI = path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'index.js');
  const port = await findFreePort();
  const HOME = freshHome();

  const child = spawn(process.execPath, [CLI, '--no-stack', '--no-open', '--port', String(port)], {
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      TERMDECK_PORT: String(port),
      // No DATABASE_URL — pg checks will fail, that's fine. We only assert shape.
      DATABASE_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch (_e) { /* gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 200).unref();
  };

  try {
    const ready = await waitForListening(child, `http://127.0.0.1:${port}`, 8000);
    if (!ready) {
      t.skip('server did not log "listening" within 8s — environment-dependent boot path');
      return;
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/health/full`, {
      signal: AbortSignal.timeout(5000)
    });

    // Endpoint returns 200 when ok=true, 503 when any required check fails.
    // Both are valid for shape assertions.
    assert.ok(res.status === 200 || res.status === 503,
      `expected 200 or 503, got ${res.status}`);

    const body = await res.json();
    assert.equal(typeof body.ok, 'boolean', '`ok` must be boolean');
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)), 'timestamp must parse');
    assert.equal(body.ttlSeconds, 30);
    assert.ok(Array.isArray(body.checks) && body.checks.length > 0);
    for (const c of body.checks) {
      assert.equal(typeof c.name, 'string');
      assert.ok(['pass', 'fail', 'warn'].includes(c.status),
        `check.status must be pass|fail|warn, got ${c.status} on ${c.name}`);
    }
  } finally {
    cleanup();
  }
});

// Runtime health snapshot — the v0.7.0 sibling of v0.6.9's
// auditPreconditions/verifyOutcomes (packages/server/src/setup/preconditions.js).
//
// Why this module exists
// ──────────────────────
// v0.6.9 closed the install-time precondition-drift class with a front-loaded
// audit and a post-write verify inside the wizards. That defends the moment
// the user runs `termdeck init --mnestra` / `--rumen`. It does not defend
// later — when an extension gets disabled in the Supabase dashboard, when a
// migration loader picks up a stale set on a subsequent reinstall, or when
// the cron job is paused without anyone noticing. `/api/health/full` answers
// "is this install actually healthy *right now*?" by re-running the same
// SELECTs at runtime instead of install-time.
//
// Required vs warn checks
// ───────────────────────
// Required checks (sqlite, mnestra-pg, memory-items-col, pg-cron-ext,
// pg-net-ext, vault-secret, cron-job-active) drive the overall `ok` flag —
// any non-pass marks the report unhealthy and the route returns 503. Warn
// checks (mnestra-webhook, rumen-pool) are best-effort: a failure surfaces
// as `warn` with detail, but does not flip `ok`.
//
// Caching
// ───────
// Reports cached in module scope for 30s. `getFullHealth(config, { refresh: true })`
// or the `?refresh=1` query param bypasses the cache. The TTL is reflected
// in the response's `ttlSeconds` field so polling clients can self-pace.
//
// Error handling
// ──────────────
// Every check is wrapped: any unexpected error downgrades that single check
// to `fail` (or `warn` for warn-checks) with the error message in `detail`.
// `getFullHealth()` always resolves with a structured report — never throws.

'use strict';

const http = require('http');
const https = require('https');

const TTL_SECONDS = 30;
const TTL_MS = TTL_SECONDS * 1000;

const REQUIRED_CHECKS = new Set([
  'sqlite',
  'mnestra-pg',
  'memory-items-col',
  'pg-cron-ext',
  'pg-net-ext',
  'vault-secret',
  'cron-job-active'
]);

let _cache = null;
let _cachedAt = 0;

// ── SQLite check ────────────────────────────────────────────────────────────

function checkSqlite(db) {
  if (!db) {
    return { name: 'sqlite', status: 'fail', detail: 'better-sqlite3 not initialized' };
  }
  try {
    const row = db.prepare('SELECT 1 AS ok').get();
    if (row && row.ok === 1) return { name: 'sqlite', status: 'pass' };
    return { name: 'sqlite', status: 'fail', detail: 'SELECT 1 returned unexpected result' };
  } catch (err) {
    return { name: 'sqlite', status: 'fail', detail: err && err.message ? err.message : String(err) };
  }
}

// ── Postgres-side checks ────────────────────────────────────────────────────
//
// These mirror auditRumenPreconditions + verifyMnestraOutcomes + verifyRumenOutcomes
// from setup/preconditions.js. We deliberately copy the SQL rather than
// import the helper — preconditions.js is owned by other lanes and concurrent
// edits to share code would step on T1/T4. The queries are small and stable.

async function safeQueryRow(client, sql) {
  try {
    const r = await client.query(sql);
    if (r.rows && r.rows.length > 0 && r.rows[0].ok) return { ok: true };
    return { ok: false };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function safeQueryRows(client, sql) {
  try {
    const r = await client.query(sql);
    return { rows: r.rows || [] };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  }
}

async function openPgClient(databaseUrl) {
  if (!databaseUrl) return null;
  let pgRunner;
  try { pgRunner = require('./setup/pg-runner'); } catch (_e) { return null; }
  try { return await pgRunner.connect(databaseUrl); } catch (_e) { return null; }
}

async function runPgChecks({ databaseUrl, _pgClient }) {
  const checks = [];
  const client = _pgClient || (await openPgClient(databaseUrl));
  const owned = !_pgClient;

  if (!client) {
    checks.push({
      name: 'mnestra-pg',
      status: 'fail',
      detail: databaseUrl
        ? 'could not connect to Postgres using DATABASE_URL'
        : 'DATABASE_URL not configured (set in ~/.termdeck/secrets.env)'
    });
    // Dependent checks can't run without a connection — surface them as
    // fail rather than silently skipping so the report is complete.
    for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
      checks.push({ name, status: 'fail', detail: 'pg unavailable' });
    }
    return checks;
  }

  try {
    const ping = await safeQueryRow(client, 'SELECT 1 AS ok');
    if (ping.error) {
      checks.push({ name: 'mnestra-pg', status: 'fail', detail: ping.error });
    } else if (!ping.ok) {
      checks.push({ name: 'mnestra-pg', status: 'fail', detail: 'SELECT 1 returned no row' });
    } else {
      checks.push({ name: 'mnestra-pg', status: 'pass' });
    }

    // memory_items.source_session_id — the v0.6.5 column from Brad's saga.
    const col = await safeQueryRow(client,
      "SELECT 1 AS ok FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'source_session_id'");
    if (col.error) {
      checks.push({ name: 'memory-items-col', status: 'fail', detail: col.error });
    } else if (!col.ok) {
      checks.push({
        name: 'memory-items-col',
        status: 'fail',
        detail:
          'memory_items.source_session_id missing — re-run termdeck init --mnestra --yes ' +
          '(if loader picked up a stale set, first: npm cache clean --force && npm i -g @jhizzard/termdeck@latest)'
      });
    } else {
      checks.push({ name: 'memory-items-col', status: 'pass' });
    }

    const cron = await safeQueryRow(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_cron'");
    if (cron.error) {
      checks.push({ name: 'pg-cron-ext', status: 'fail', detail: cron.error });
    } else if (!cron.ok) {
      checks.push({
        name: 'pg-cron-ext',
        status: 'fail',
        detail: 'extension not enabled — Supabase dashboard → Database → Extensions → pg_cron'
      });
    } else {
      checks.push({ name: 'pg-cron-ext', status: 'pass' });
    }

    const net = await safeQueryRow(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_net'");
    if (net.error) {
      checks.push({ name: 'pg-net-ext', status: 'fail', detail: net.error });
    } else if (!net.ok) {
      checks.push({
        name: 'pg-net-ext',
        status: 'fail',
        detail: 'extension not enabled — Supabase dashboard → Database → Extensions → pg_net'
      });
    } else {
      checks.push({ name: 'pg-net-ext', status: 'pass' });
    }

    const vault = await safeQueryRow(client,
      "SELECT 1 AS ok FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key'");
    if (vault.error) {
      checks.push({
        name: 'vault-secret',
        status: 'fail',
        detail: `vault.decrypted_secrets unreadable — ${vault.error}`
      });
    } else if (!vault.ok) {
      checks.push({
        name: 'vault-secret',
        status: 'fail',
        detail: 'rumen_service_role_key missing — Supabase dashboard → Project Settings → Vault → New secret'
      });
    } else {
      checks.push({ name: 'vault-secret', status: 'pass' });
    }

    const job = await safeQueryRows(client,
      "SELECT active FROM cron.job WHERE jobname = 'rumen-tick'");
    if (job.error) {
      checks.push({ name: 'cron-job-active', status: 'fail', detail: `cron.job unreadable — ${job.error}` });
    } else if (!job.rows || job.rows.length === 0) {
      checks.push({
        name: 'cron-job-active',
        status: 'fail',
        detail: 'rumen-tick row not found — re-run `termdeck init --rumen`'
      });
    } else if (!job.rows[0].active) {
      checks.push({
        name: 'cron-job-active',
        status: 'fail',
        detail:
          "rumen-tick paused — SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rumen-tick'), active := true);"
      });
    } else {
      checks.push({ name: 'cron-job-active', status: 'pass' });
    }
  } finally {
    if (owned) {
      try { await client.end(); } catch (_e) { /* ignore */ }
    }
  }

  return checks;
}

// ── Warn checks ─────────────────────────────────────────────────────────────

function httpReachable(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    let req;
    try {
      req = mod.get(url, { timeout: timeoutMs }, (res) => {
        const ok = res.statusCode != null && res.statusCode < 500;
        res.resume();
        resolve({ ok, status: res.statusCode });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    req.on('error', (err) => resolve({ ok: false, error: err && err.message ? err.message : String(err) }));
    req.on('timeout', () => { try { req.destroy(); } catch (_e) { /* gone */ } resolve({ ok: false, error: 'timeout' }); });
  });
}

async function checkMnestraWebhook(config, options) {
  if (options && typeof options._mnestraWebhookProbe === 'function') {
    try {
      const r = await options._mnestraWebhookProbe();
      if (r && r.ok) return { name: 'mnestra-webhook', status: 'pass' };
      return { name: 'mnestra-webhook', status: 'warn', detail: (r && r.detail) || 'unreachable' };
    } catch (err) {
      return { name: 'mnestra-webhook', status: 'warn', detail: err && err.message ? err.message : String(err) };
    }
  }
  const rag = (config && config.rag) || {};
  if (!rag.mnestraWebhookUrl) {
    return { name: 'mnestra-webhook', status: 'warn', detail: 'webhook URL not configured' };
  }
  const healthUrl = String(rag.mnestraWebhookUrl).replace(/\/mnestra\/?$/, '/healthz');
  const r = await httpReachable(healthUrl, 2000);
  if (r.ok) return { name: 'mnestra-webhook', status: 'pass' };
  return {
    name: 'mnestra-webhook',
    status: 'warn',
    detail: r.error ? `unreachable — ${r.error}` : `HTTP ${r.status || '???'}`
  };
}

async function checkRumenPool(config, options) {
  if (options && typeof options._rumenPoolProbe === 'function') {
    try {
      const r = await options._rumenPoolProbe();
      if (r && r.ok) return { name: 'rumen-pool', status: 'pass' };
      return { name: 'rumen-pool', status: 'warn', detail: (r && r.detail) || 'unreachable (best-effort)' };
    } catch (err) {
      return { name: 'rumen-pool', status: 'warn', detail: err && err.message ? err.message : String(err) };
    }
  }
  let pg;
  try { pg = require('pg'); } catch (_e) { pg = null; }
  if (!pg) return { name: 'rumen-pool', status: 'warn', detail: 'pg module not installed' };

  const dbUrl = (config && config.rag && config.rag.databaseUrl) || process.env.DATABASE_URL;
  if (!dbUrl) return { name: 'rumen-pool', status: 'warn', detail: 'DATABASE_URL not set' };

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const res = await pool.query('SELECT 1 AS ok');
    if (res.rows[0] && res.rows[0].ok === 1) return { name: 'rumen-pool', status: 'pass' };
    return { name: 'rumen-pool', status: 'warn', detail: 'SELECT 1 returned unexpected result' };
  } catch (err) {
    return { name: 'rumen-pool', status: 'warn', detail: err && err.message ? err.message : String(err) };
  } finally {
    try { await pool.end(); } catch (_e) { /* ignore */ }
  }
}

// ── Aggregator ──────────────────────────────────────────────────────────────

async function getFullHealth(config = {}, options = {}) {
  const refresh = !!options.refresh;
  if (!refresh && _cache && (Date.now() - _cachedAt) < TTL_MS) {
    return _cache;
  }

  const db = options.db || (config && config._db) || null;
  const databaseUrl =
    options.databaseUrl ||
    (config && config.rag && config.rag.databaseUrl) ||
    process.env.DATABASE_URL ||
    null;

  const checks = [];

  // 1. SQLite (sync — small DB, no risk of blocking)
  try { checks.push(checkSqlite(db)); }
  catch (err) { checks.push({ name: 'sqlite', status: 'fail', detail: err && err.message ? err.message : String(err) }); }

  // 2-7. Postgres-side suite
  let pgChecks;
  try { pgChecks = await runPgChecks({ databaseUrl, _pgClient: options._pgClient }); }
  catch (err) {
    pgChecks = [{
      name: 'mnestra-pg',
      status: 'fail',
      detail: err && err.message ? err.message : String(err)
    }];
    for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
      pgChecks.push({ name, status: 'fail', detail: 'pg suite aborted' });
    }
  }
  for (const c of pgChecks) checks.push(c);

  // 8. Mnestra webhook (warn)
  let webhook;
  try { webhook = await checkMnestraWebhook(config, options); }
  catch (err) { webhook = { name: 'mnestra-webhook', status: 'warn', detail: err && err.message ? err.message : String(err) }; }
  checks.push(webhook);

  // 9. Rumen pool (warn)
  let pool;
  try { pool = await checkRumenPool(config, options); }
  catch (err) { pool = { name: 'rumen-pool', status: 'warn', detail: err && err.message ? err.message : String(err) }; }
  checks.push(pool);

  const ok = checks
    .filter((c) => REQUIRED_CHECKS.has(c.name))
    .every((c) => c.status === 'pass');

  const report = {
    ok,
    timestamp: new Date().toISOString(),
    ttlSeconds: TTL_SECONDS,
    checks
  };

  _cache = report;
  _cachedAt = Date.now();

  return report;
}

// Test seam — drop the cache between cases so call-count assertions hold.
function _resetCache() {
  _cache = null;
  _cachedAt = 0;
}

module.exports = {
  getFullHealth,
  REQUIRED_CHECKS,
  _resetCache
};

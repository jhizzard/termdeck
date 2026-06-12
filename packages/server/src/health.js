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
// Failure taxonomy (Sprint 63 T3 §3.2 — Brad r730 cascade 2026-05-11)
// ──────────────────────────────────────────────────────────────────
// Pre-Sprint-63 every check that didn't return `pass` collapsed to `fail`
// with a free-text `detail` string. Operators triaging "why is the install
// red?" had to read each detail and guess. The cost was real: on 2026-05-11
// a SQLite ABI mismatch left `db = null` at boot; the resulting
// `red: timeout` strings (from probes that timed-out trying to use the null
// handle indirectly) masked the actual `init-failed` root cause for hours.
//
// Every non-pass check now carries a `category` field with one of:
//   `red:unreachable`     — network/socket level (ECONNREFUSED / EHOSTUNREACH
//                            / ENETUNREACH / ENOTFOUND on connect)
//   `red:timeout`         — request issued, no response in the window
//                            (AbortError / req timeout / pg ETIMEDOUT)
//   `red:dependency-down` — peer responded but the dependency is unhealthy
//                            (HTTP 5xx / SQL schema error from a reachable DB)
//   `red:init-failed`     — local handle the probe needs was never initialized
//                            (db === null at boot / DATABASE_URL not set)
//
// `detail` strings are prefixed with the category for human readability:
// `red:unreachable (could not connect to Postgres using DATABASE_URL)`.
//
// init-failed surfaces use a log-once gate so a 30s-poll cycle on a process
// with a missing handle (e.g. better-sqlite3 not loaded) writes ONE warn at
// boot, not 2880 warns/day. Probes still emit `red:init-failed` per cycle
// in the JSON report — only the log emission is gated.
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
// to `fail` (or `warn` for warn-checks) with the error message in `detail`
// and a `category` from the taxonomy above. `getFullHealth()` always
// resolves with a structured report — never throws.

'use strict';

const http = require('http');
const https = require('https');
// Sprint 75 T2 (part C): endpoint-shape classifier — could-not-connect
// envelopes name the IPv6-only direct endpoint as the likely cause when
// DATABASE_URL has that shape. Warn-only suffix; never changes categories.
const { classifyDbEndpoint } = require('./setup/supabase-url');

// Suffix appended to connect-failure details when DATABASE_URL is the
// IPv6-only direct endpoint (db.<project-ref>.supabase.co — AAAA-only DNS).
function directEndpointSuffix(databaseUrl) {
  try {
    if (classifyDbEndpoint(databaseUrl).kind === 'direct') {
      return ' (DATABASE_URL is the IPv6-only db.<project-ref> direct endpoint — on IPv4-only hosts pg clients hang until a pool/connect timeout; use the Shared Pooler URL)';
    }
  } catch (_e) { /* warn-only */ }
  return '';
}

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

// Sprint 63 T3 §3.2 — stable taxonomy strings. Exported so dashboard / doctor
// / external graders can filter by category instead of pattern-matching the
// detail prose. Frozen object so callers can rely on `CATEGORIES.UNREACHABLE`
// without accidentally rebinding.
const CATEGORIES = Object.freeze({
  UNREACHABLE: 'red:unreachable',
  TIMEOUT: 'red:timeout',
  DEPENDENCY_DOWN: 'red:dependency-down',
  INIT_FAILED: 'red:init-failed',
});

let _cache = null;
let _cachedAt = 0;

// Sprint 63 T3 §3.2 — log-once gate for init-failed surfaces. A 30s health
// poll on a process with a missing handle would otherwise log every cycle
// (~2880 warn lines/day per missing handle). Probes that detect a null
// handle at boot call `logInitFailedOnce(name, reason)`; the first call
// emits a warn line, subsequent calls are silent for the lifetime of the
// process. Probes still emit `red:init-failed` in the JSON report on every
// cycle — only the log line is gated. Reset via `_resetInitLogged()` test
// seam between cases.
const _initLoggedOnce = new Map();
function logInitFailedOnce(probeName, reason) {
  if (_initLoggedOnce.has(probeName)) return;
  _initLoggedOnce.set(probeName, reason);
  // eslint-disable-next-line no-console
  console.warn(
    `[health] ${probeName} handle null at boot — probes will return ` +
    `${CATEGORIES.INIT_FAILED} until next process start; reason: ${reason}`
  );
}

// Classify an HTTP-side failure shape `{ ok, status, error, code }` (as
// returned by `httpReachable`) into one of the four red:* categories.
function classifyHttpFailure(r) {
  if (!r) return CATEGORIES.UNREACHABLE;
  if (r.code === 'TIMEOUT' || r.code === 'ABORT_ERR' || r.code === 'ERR_TIMEOUT' || r.error === 'timeout') {
    return CATEGORIES.TIMEOUT;
  }
  if (r.code === 'ECONNREFUSED' || r.code === 'EHOSTUNREACH' || r.code === 'ENETUNREACH' || r.code === 'ENOTFOUND') {
    return CATEGORIES.UNREACHABLE;
  }
  if (typeof r.status === 'number' && r.status >= 500) return CATEGORIES.DEPENDENCY_DOWN;
  if (typeof r.status === 'number') return CATEGORIES.DEPENDENCY_DOWN; // any non-2xx-3xx-4xx-network is "peer responded badly"
  return CATEGORIES.UNREACHABLE;
}

// Classify a database / Node-side failure into one of the four categories.
// Accepts either a raw Error or a `{ error, code }` envelope from
// `safeQueryRow` / `safeQueryRows`.
function classifyDbFailure(errOrEnvelope) {
  if (!errOrEnvelope) return CATEGORIES.DEPENDENCY_DOWN;
  const code = errOrEnvelope.code || (errOrEnvelope._err && errOrEnvelope._err.code);
  const msg = String(errOrEnvelope.message || errOrEnvelope.error || errOrEnvelope);
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND') {
    return CATEGORIES.UNREACHABLE;
  }
  if (code === 'ETIMEDOUT' || code === 'ERR_TIMEOUT' || /\btimeout\b/i.test(msg)) {
    return CATEGORIES.TIMEOUT;
  }
  // SQL errors (42703 column-not-exist, 42P01 relation-not-exist, etc.) →
  // the dependency answered but its schema is misconfigured. That's
  // "dependency unhealthy," not "unreachable" or "timeout."
  return CATEGORIES.DEPENDENCY_DOWN;
}

// Helpers to compose check results with a category-prefixed detail. Keeps
// each call site readable + ensures the prefix is consistent across probes.
function failCheck(name, category, why) {
  return { name, status: 'fail', category, detail: `${category} (${why})` };
}
function warnCheck(name, category, why) {
  return { name, status: 'warn', category, detail: `${category} (${why})` };
}
function passCheck(name) {
  return { name, status: 'pass' };
}

// ── SQLite check ────────────────────────────────────────────────────────────

function checkSqlite(db) {
  if (!db) {
    // Sprint 63 T3 §3.2 — `db === null` is `red:init-failed`, NOT `red:timeout`.
    // The v1.1.1 fail-fast on SQLite ABI mismatch makes this surface rare in
    // practice, but the probe must still classify correctly because future
    // optional deps may be allowed to be null. Log-once gate prevents the
    // 30s poll from flooding logs.
    logInitFailedOnce('sqlite', 'better-sqlite3 not initialized');
    return failCheck('sqlite', CATEGORIES.INIT_FAILED, 'better-sqlite3 not initialized');
  }
  try {
    const row = db.prepare('SELECT 1 AS ok').get();
    if (row && row.ok === 1) return passCheck('sqlite');
    return failCheck('sqlite', CATEGORIES.DEPENDENCY_DOWN, 'SELECT 1 returned unexpected result');
  } catch (err) {
    const cat = classifyDbFailure(err);
    return failCheck('sqlite', cat, err && err.message ? err.message : String(err));
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
    // Surface `code` so the caller can classify into the red:* taxonomy
    // without re-parsing the message string.
    return {
      error: err && err.message ? err.message : String(err),
      code: err && err.code,
    };
  }
}

async function safeQueryRows(client, sql) {
  try {
    const r = await client.query(sql);
    return { rows: r.rows || [] };
  } catch (err) {
    return {
      error: err && err.message ? err.message : String(err),
      code: err && err.code,
    };
  }
}

// Sprint 63 T3 §3.2 — track whether the most recent connect attempt timed out
// vs. was outright unreachable. The pg client doesn't expose this from inside
// the helper, so the helper records it in a return envelope.
async function openPgClient(databaseUrl) {
  if (!databaseUrl) return { client: null, reason: 'no-url' };
  let pgRunner;
  try { pgRunner = require('./setup/pg-runner'); }
  catch (_e) { return { client: null, reason: 'pg-runner-unavailable' }; }
  try {
    const client = await pgRunner.connect(databaseUrl);
    return { client, reason: null };
  } catch (err) {
    return {
      client: null,
      reason: 'connect-failed',
      error: err && err.message ? err.message : String(err),
      code: err && err.code,
    };
  }
}

// Sprint 63 T3 §3.2 — dependent-checks shape when there's no client. Pre-
// Sprint-63 these collapsed to status:'fail', detail:'pg unavailable' with
// no category; operators couldn't distinguish "DATABASE_URL not set"
// (`init-failed` — fix the .env) from "Postgres unreachable" (`unreachable`
// — fix the network) from "Postgres took 5s and gave up" (`timeout` — bump
// timeout or check pgbouncer). Each downstream check now carries the same
// category as the connect attempt so the dashboard can render one row
// "Postgres unreachable" and dim the six dependents instead of six
// independent-looking RED rows.
function pushPgUnavailableChecks(checks, primaryName, category, primaryDetail, dependentDetail) {
  checks.push(failCheck(primaryName, category, primaryDetail));
  for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
    checks.push(failCheck(name, category, dependentDetail));
  }
}

async function runPgChecks({ databaseUrl, _pgClient }) {
  const checks = [];

  let client = _pgClient || null;
  let owned = false;
  let connectEnvelope = null;
  if (!client) {
    connectEnvelope = await openPgClient(databaseUrl);
    client = connectEnvelope.client;
    owned = client != null;
  }

  if (!client) {
    if (!databaseUrl) {
      // No URL → init-failed (operator never set DATABASE_URL). Log-once.
      logInitFailedOnce('mnestra-pg', 'DATABASE_URL not configured');
      pushPgUnavailableChecks(
        checks,
        'mnestra-pg',
        CATEGORIES.INIT_FAILED,
        'DATABASE_URL not configured — set in ~/.termdeck/secrets.env',
        'pg unavailable — DATABASE_URL not configured'
      );
    } else {
      // URL set but connect failed → classify by code (timeout vs unreachable).
      const cat = classifyDbFailure(connectEnvelope || {});
      const why = (connectEnvelope && connectEnvelope.error
        ? `could not connect to Postgres using DATABASE_URL — ${connectEnvelope.error}`
        : 'could not connect to Postgres using DATABASE_URL')
        + directEndpointSuffix(databaseUrl);
      pushPgUnavailableChecks(checks, 'mnestra-pg', cat, why, 'pg unavailable — connect failed');
    }
    return checks;
  }

  try {
    const ping = await safeQueryRow(client, 'SELECT 1 AS ok');
    if (ping.error) {
      checks.push(failCheck('mnestra-pg', classifyDbFailure(ping), ping.error));
    } else if (!ping.ok) {
      checks.push(failCheck('mnestra-pg', CATEGORIES.DEPENDENCY_DOWN, 'SELECT 1 returned no row'));
    } else {
      checks.push(passCheck('mnestra-pg'));
    }

    // memory_items.source_session_id — the v0.6.5 column from Brad's saga.
    const col = await safeQueryRow(client,
      "SELECT 1 AS ok FROM information_schema.columns " +
      "WHERE table_schema = 'public' AND table_name = 'memory_items' AND column_name = 'source_session_id'");
    if (col.error) {
      checks.push(failCheck('memory-items-col', classifyDbFailure(col), col.error));
    } else if (!col.ok) {
      checks.push(failCheck(
        'memory-items-col',
        CATEGORIES.DEPENDENCY_DOWN,
        'memory_items.source_session_id missing — re-run termdeck init --mnestra --yes ' +
        '(if loader picked up a stale set, first: npm cache clean --force && npm i -g @jhizzard/termdeck@latest)'
      ));
    } else {
      checks.push(passCheck('memory-items-col'));
    }

    const cron = await safeQueryRow(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_cron'");
    if (cron.error) {
      checks.push(failCheck('pg-cron-ext', classifyDbFailure(cron), cron.error));
    } else if (!cron.ok) {
      checks.push(failCheck(
        'pg-cron-ext',
        CATEGORIES.DEPENDENCY_DOWN,
        'extension not enabled — Supabase dashboard → Database → Extensions → pg_cron'
      ));
    } else {
      checks.push(passCheck('pg-cron-ext'));
    }

    const net = await safeQueryRow(client,
      "SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_net'");
    if (net.error) {
      checks.push(failCheck('pg-net-ext', classifyDbFailure(net), net.error));
    } else if (!net.ok) {
      checks.push(failCheck(
        'pg-net-ext',
        CATEGORIES.DEPENDENCY_DOWN,
        'extension not enabled — Supabase dashboard → Database → Extensions → pg_net'
      ));
    } else {
      checks.push(passCheck('pg-net-ext'));
    }

    const vault = await safeQueryRow(client,
      "SELECT 1 AS ok FROM vault.decrypted_secrets WHERE name = 'rumen_service_role_key'");
    if (vault.error) {
      checks.push(failCheck('vault-secret', classifyDbFailure(vault), `vault.decrypted_secrets unreadable — ${vault.error}`));
    } else if (!vault.ok) {
      checks.push(failCheck(
        'vault-secret',
        CATEGORIES.DEPENDENCY_DOWN,
        'rumen_service_role_key missing — Supabase dashboard → Project Settings → Vault → New secret'
      ));
    } else {
      checks.push(passCheck('vault-secret'));
    }

    const job = await safeQueryRows(client,
      "SELECT active FROM cron.job WHERE jobname = 'rumen-tick'");
    if (job.error) {
      checks.push(failCheck('cron-job-active', classifyDbFailure(job), `cron.job unreadable — ${job.error}`));
    } else if (!job.rows || job.rows.length === 0) {
      checks.push(failCheck(
        'cron-job-active',
        CATEGORIES.DEPENDENCY_DOWN,
        'rumen-tick row not found — re-run `termdeck init --rumen`'
      ));
    } else if (!job.rows[0].active) {
      checks.push(failCheck(
        'cron-job-active',
        CATEGORIES.DEPENDENCY_DOWN,
        "rumen-tick paused — SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rumen-tick'), active := true);"
      ));
    } else {
      checks.push(passCheck('cron-job-active'));
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
        const status = res.statusCode;
        res.resume();
        resolve({ ok, status });
      });
    } catch (err) {
      // Sprint 63 T3 §3.2 — surface `code` so the caller can classify into
      // the red:* taxonomy without re-parsing the message.
      resolve({
        ok: false,
        error: err && err.message ? err.message : String(err),
        code: err && err.code,
      });
      return;
    }
    req.on('error', (err) => resolve({
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code,
    }));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_e) { /* gone */ }
      resolve({ ok: false, error: 'timeout', code: 'TIMEOUT' });
    });
  });
}

async function checkMnestraWebhook(config, options) {
  if (options && typeof options._mnestraWebhookProbe === 'function') {
    try {
      const r = await options._mnestraWebhookProbe();
      if (r && r.ok) return passCheck('mnestra-webhook');
      const cat = classifyHttpFailure(r);
      return warnCheck('mnestra-webhook', cat, (r && r.detail) || (r && r.error) || 'unreachable');
    } catch (err) {
      const cat = classifyHttpFailure({ code: err && err.code, error: err && err.message });
      return warnCheck('mnestra-webhook', cat, err && err.message ? err.message : String(err));
    }
  }
  const rag = (config && config.rag) || {};
  if (!rag.mnestraWebhookUrl) {
    // Sprint 63 T3 §3.2 — URL not configured = init-failed (operator never
    // set up the webhook), not unreachable. Log-once so a 30s poll on an
    // unconfigured install doesn't flood warns.
    logInitFailedOnce('mnestra-webhook', 'rag.mnestraWebhookUrl not configured');
    return warnCheck('mnestra-webhook', CATEGORIES.INIT_FAILED, 'webhook URL not configured');
  }
  const healthUrl = String(rag.mnestraWebhookUrl).replace(/\/mnestra\/?$/, '/healthz');
  const r = await httpReachable(healthUrl, 2000);
  if (r.ok) return passCheck('mnestra-webhook');
  const cat = classifyHttpFailure(r);
  const why = r.error
    ? `${r.error}${typeof r.status === 'number' ? ` (HTTP ${r.status})` : ''}`
    : `HTTP ${r.status || '???'}`;
  return warnCheck('mnestra-webhook', cat, why);
}

async function checkRumenPool(config, options) {
  if (options && typeof options._rumenPoolProbe === 'function') {
    try {
      const r = await options._rumenPoolProbe();
      if (r && r.ok) return passCheck('rumen-pool');
      // Test-seam probe should pass `category` if it has one; else infer.
      const cat = (r && r.category) || classifyDbFailure(r || {});
      return warnCheck('rumen-pool', cat, (r && r.detail) || (r && r.error) || 'unreachable (best-effort)');
    } catch (err) {
      const cat = classifyDbFailure(err);
      return warnCheck('rumen-pool', cat, err && err.message ? err.message : String(err));
    }
  }
  let pg;
  try { pg = require('pg'); } catch (_e) { pg = null; }
  if (!pg) {
    logInitFailedOnce('rumen-pool', 'pg module not installed');
    return warnCheck('rumen-pool', CATEGORIES.INIT_FAILED, 'pg module not installed');
  }

  const dbUrl = (config && config.rag && config.rag.databaseUrl) || process.env.DATABASE_URL;
  if (!dbUrl) {
    logInitFailedOnce('rumen-pool', 'DATABASE_URL not set');
    return warnCheck('rumen-pool', CATEGORIES.INIT_FAILED, 'DATABASE_URL not set');
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const res = await pool.query('SELECT 1 AS ok');
    if (res.rows[0] && res.rows[0].ok === 1) return passCheck('rumen-pool');
    return warnCheck('rumen-pool', CATEGORIES.DEPENDENCY_DOWN, 'SELECT 1 returned unexpected result');
  } catch (err) {
    const cat = classifyDbFailure(err);
    const detail = (err && err.message ? err.message : String(err))
      + directEndpointSuffix(dbUrl);
    return warnCheck('rumen-pool', cat, detail);
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

  // Sprint 63 T3 §3.2 outer-catch hardening (T4-CODEX AUDIT-CONCERN 13:27 ET):
  // every probe is independently wrapped here so an unexpected throw in a
  // single probe path can't sink the whole report. Pre-Sprint-63 these four
  // catches emitted raw `{ status: 'fail'|'warn', detail }` with no
  // `category` field — operators triaging "why is the dashboard red?" still
  // had to read prose. The whole point of the taxonomy is that there is no
  // such thing as an uncategorized non-pass row. Every fallback now runs the
  // captured `err` through `classifyDbFailure` / `classifyHttpFailure` and
  // composes a normal `failCheck` / `warnCheck` envelope. When the
  // classifier can't infer (truly opaque throw — bug in the probe itself,
  // not in the dependency), the default branch in each classifier returns
  // `red:dependency-down`, which is the right-by-default category for "the
  // probe's path is broken" — operator's first action is to inspect the
  // peer / its config, not the local handle.

  // Sprint 63 T3 §3.2 — `_throwIn` test seam. The probe functions each have
  // their own try/catch so unreached-by-design inputs can't throw out into
  // the outer catches below. The fence tests need a way to simulate "a
  // probe's path threw before its own catch caught it" — i.e., the
  // belt-and-suspenders outer catch. Set `_throwIn` to one of
  // `'sqlite' | 'pg' | 'webhook' | 'rumen-pool'` to inject a synthetic
  // throw at the corresponding outer-try entry. Never set in production —
  // ignored if the value is falsy.
  const throwIn = options._throwIn || null;
  const synth = (where) => new Error(`test-fence: simulated throw in ${where} probe path`);

  // 1. SQLite (sync — small DB, no risk of blocking)
  try {
    if (throwIn === 'sqlite') throw synth('sqlite');
    checks.push(checkSqlite(db));
  }
  catch (err) {
    const cat = classifyDbFailure(err);
    checks.push(failCheck('sqlite', cat, err && err.message ? err.message : String(err)));
  }

  // 2-7. Postgres-side suite
  let pgChecks;
  try {
    if (throwIn === 'pg') throw synth('pg');
    pgChecks = await runPgChecks({ databaseUrl, _pgClient: options._pgClient });
  }
  catch (err) {
    const cat = classifyDbFailure(err);
    const why = err && err.message ? err.message : String(err);
    pgChecks = [failCheck('mnestra-pg', cat, why)];
    // Dependents inherit the same category — see runPgChecks header for the
    // rationale (one root-cause row, not 6 independent-looking REDs).
    for (const name of ['memory-items-col', 'pg-cron-ext', 'pg-net-ext', 'vault-secret', 'cron-job-active']) {
      pgChecks.push(failCheck(name, cat, 'pg suite aborted'));
    }
  }
  for (const c of pgChecks) checks.push(c);

  // 8. Mnestra webhook (warn)
  let webhook;
  try {
    if (throwIn === 'webhook') throw synth('webhook');
    webhook = await checkMnestraWebhook(config, options);
  }
  catch (err) {
    const cat = classifyHttpFailure({ code: err && err.code, error: err && err.message });
    webhook = warnCheck('mnestra-webhook', cat, err && err.message ? err.message : String(err));
  }
  checks.push(webhook);

  // 9. Rumen pool (warn)
  let pool;
  try {
    if (throwIn === 'rumen-pool') throw synth('rumen-pool');
    pool = await checkRumenPool(config, options);
  }
  catch (err) {
    const cat = classifyDbFailure(err);
    pool = warnCheck('rumen-pool', cat, err && err.message ? err.message : String(err));
  }
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

// Sprint 63 T3 §3.2 — clear the init-failed log-once memory so each test
// case starts fresh. Without this, the first test that exercises a null-db
// path would silence the log on subsequent tests in the same process.
function _resetInitLogged() {
  _initLoggedOnce.clear();
}

module.exports = {
  getFullHealth,
  REQUIRED_CHECKS,
  CATEGORIES,
  classifyHttpFailure,
  classifyDbFailure,
  _resetCache,
  _resetInitLogged,
};

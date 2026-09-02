// TermDeck Preflight Health Check
// Runs at startup to verify the entire memory stack is operational.
// Each check is independent — one failure does not block others.
//
// Exports:
//   runPreflight(config)       — run all checks, return result object
//   createHealthHandler(config) — Express route handler for GET /api/health

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Sprint 75 T2 (part C): endpoint-shape classifier — used to explain
// connect failures against the IPv6-only direct endpoint. Warn-only.
const { classifyDbEndpoint } = require('./setup/supabase-url');

// Cache preflight results for 60s
let _cachedResult = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

// Sprint 8K hotfix (2026-09-01): the Mnestra daemon's /healthz does a live
// Supabase aggregate, and on a thrashing host (8-panel sprint, PhysMem free
// <100 MB, load 100+) it answered in 2–15 s while the daemon itself was alive
// and writing. A 3 s probe turned "slow" into "unreachable" for BOTH mnestra
// checks at once — the stack widget sat at 5/7 for an hour on a healthy store
// (11,021 rows, last_write minutes old). Same class as the doctor's npm probe.
// 10 s is still a liveness bound; the 60 s result cache keeps the UI cheap.
const MNESTRA_PROBE_TIMEOUT_MS = Number(process.env.TERMDECK_MNESTRA_PROBE_TIMEOUT_MS) || 10_000;

// 2026-09-02: the 8K hotfix above raised the budget on ONE of the two
// "single dependency, several checks, tight budget" amplifiers in this file
// and left the other standing. The badge label is `passed/total`, so a
// dependency backing more than one check costs 2/7 the moment it is merely
// SLOW — which is how a demonstrably healthy stack reads "5/7" on a host
// under sprint load (load avg 30+, eight panels compiling). Two pairs:
//
//   A  mnestra_reachable + mnestra_has_memories — two GETs of the SAME
//      /healthz URL (the second one's own comment admitted the redundancy).
//   B  database_url + rumen_recent — two separate pg Pools opened in the
//      same tick against the same remote Postgres, each with its own 5 s
//      connect budget, so they time out as a group.
//
// Both are single-flight now: one probe per dependency per run, shared by
// every check that reads it, so a slow dependency costs one round-trip and
// the checks in a pair can never disagree about it. `health.js` already
// settled this principle for /api/health/full ("one root cause, not 6 RED
// rows"); this is the same rule applied to the 7-check badge surface.
const PG_PROBE_TIMEOUT_MS = Number(process.env.TERMDECK_PG_PROBE_TIMEOUT_MS) || 10_000;

// The shell check spawns a PTY and waits for one echo. On a loaded host the
// spawn alone outruns a 3 s budget — Sprint 63 already dropped `-l` for this
// reason but kept the 3 s. "Can $SHELL spawn a PTY at all?" is still
// answered yes when the answer arrives slowly.
const SHELL_PROBE_TIMEOUT_MS = Number(process.env.TERMDECK_SHELL_PROBE_TIMEOUT_MS) || 10_000;

// ---------------------------------------------------------------------------
// Single-flight Mnestra /healthz probe — one request per preflight run.
// ---------------------------------------------------------------------------

function mnestraHealthzUrl(config) {
  const rag = config.rag || {};
  return rag.mnestraWebhookUrl
    ? rag.mnestraWebhookUrl.replace(/\/mnestra\/?$/, '/healthz')
    : 'http://localhost:37778/healthz';
}

// A timeout is weak evidence of death — the daemon answers a live remote
// aggregate on /healthz and momentarily stalls under sprint load (its own log
// shows upstream 429s and statement timeouts). One retry, and ONLY for a
// timeout: ECONNREFUSED/ENOTFOUND is conclusive that nothing is listening, so
// retrying it just doubles the badge's latency to reach the right answer.
// Same distinction `health.js` draws between red:timeout and red:unreachable.
function isTimeoutish(err) {
  const code = err && err.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'TIMEOUT') return true;
  return /timeout/i.test((err && err.message) || '');
}

async function probeMnestra(config, httpGetFn) {
  const get = httpGetFn || httpGet;
  const url = mnestraHealthzUrl(config);
  let body;
  try {
    body = await get(url, MNESTRA_PROBE_TIMEOUT_MS);
  } catch (err) {
    if (!isTimeoutish(err)) throw err;
    body = await get(url, MNESTRA_PROBE_TIMEOUT_MS);
  }
  const data = tryParseJSON(body);
  const total = data && (data.store?.rows ?? data.total ?? data.memories ?? data.count ?? null);
  return { total: total == null ? null : Number(total) };
}

async function checkMnestra(probe) {
  const { total } = await probe;
  if (total != null) {
    return { name: 'mnestra_reachable', passed: true, detail: `${total.toLocaleString()} memories` };
  }
  // Got 200 but no count — still reachable
  return { name: 'mnestra_reachable', passed: true, detail: 'reachable (no memory count)' };
}

async function checkMnestraMemories(probe) {
  const { total } = await probe;
  if (total != null && total > 0) {
    return { name: 'mnestra_has_memories', passed: true, detail: `${total.toLocaleString()} memories loaded` };
  }
  if (total != null && total === 0) {
    return { name: 'mnestra_has_memories', passed: false, detail: 'Mnestra running but 0 memories — run `mnestra ingest`' };
  }
  return { name: 'mnestra_has_memories', passed: false, detail: 'could not determine memory count' };
}

// ---------------------------------------------------------------------------
// Single-flight Postgres handle — one Pool per preflight run, shared by
// database_url / rumen_recent / graph_health. Opening three of them in the
// same tick meant one loaded network path presented as three broken checks.
// ---------------------------------------------------------------------------

function openPgHandle(pgPoolFactory) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return { pool: null, reason: 'DATABASE_URL not set' };

  let pg;
  try { pg = require('pg'); } catch (err) { pg = null; }
  if (!pg && !pgPoolFactory) return { pool: null, reason: 'pg module not installed' };

  const factory = pgPoolFactory || ((opts) => new pg.Pool(opts));
  return {
    pool: factory({
      connectionString: dbUrl,
      max: 1,
      connectionTimeoutMillis: PG_PROBE_TIMEOUT_MS,
    }),
    reason: null,
  };
}

async function checkRumen(handle, dbResultPromise) {
  // Try to query rumen_jobs table via DATABASE_URL for last successful job
  if (!handle.pool) {
    return { name: 'rumen_recent', passed: false, detail: `${handle.reason} — cannot check Rumen jobs` };
  }

  // The connection is shared with database_url. If THAT check already found
  // the connection dead, this check has nothing independent to say — report
  // the root cause instead of a second, independent-looking red row.
  const dbResult = dbResultPromise ? await dbResultPromise.catch(() => null) : null;
  if (dbResult && dbResult.passed === false) {
    return {
      name: 'rumen_recent',
      passed: false,
      detail: 'not checked — database_url is the root cause (one dependency, not two failures)',
    };
  }

  const pool = handle.pool;
  {
    const res = await pool.query(
      `SELECT status, completed_at, insights_generated
       FROM rumen_jobs
       WHERE status = 'done'
       ORDER BY completed_at DESC
       LIMIT 1`
    );
    if (res.rows.length === 0) {
      return { name: 'rumen_recent', passed: false, detail: 'no completed Rumen jobs found' };
    }
    const row = res.rows[0];
    const completedAt = new Date(row.completed_at);
    const agoMs = Date.now() - completedAt.getTime();
    const agoMin = Math.round(agoMs / 60_000);
    const insights = row.insights_generated || 0;
    const recent = agoMs < 30 * 60_000; // within 30 minutes
    return {
      name: 'rumen_recent',
      passed: recent,
      detail: recent
        ? `last job ${agoMin}m ago, ${insights} insights`
        : `last job ${agoMin}m ago (stale — expected within 30m), ${insights} insights`,
    };
  }
}

async function checkDatabase(handle) {
  if (!handle.pool) {
    return { name: 'database_url', passed: false, detail: handle.reason };
  }

  const t0 = Date.now();
  const res = await handle.pool.query('SELECT 1 AS ok');
  const ms = Date.now() - t0;
  if (res.rows[0] && Number(res.rows[0].ok) === 1) {
    return { name: 'database_url', passed: true, detail: `connected in ${ms}ms` };
  }
  return { name: 'database_url', passed: false, detail: 'SELECT 1 returned unexpected result' };
}

// Sprint 38 / T3 — graph-health check. Returns:
//   pass : memory_relationships has rows AND last inferred_at < 48h ago
//   warn : has rows but last inference > 48h ago (T2 cron may have drifted)
//   fail : pg unreachable, table missing, or zero edges
//
// Reads `inferred_at` (T1's migration 009 column). Falls back to `created_at`
// for the 749 pre-T2 edges that have no inferred_at value yet, so the check
// doesn't perma-warn on the substrate that already exists.
async function checkGraphHealth(config, handle) {
  // Only meaningful when graph features are enabled. Treat as pass with a
  // descriptive detail so the banner doesn't FAIL on installs that haven't
  // opted into graph recall yet.
  const graphEnabled = config.rag?.graphRecall === true;
  if (!graphEnabled) {
    return { name: 'graph_health', passed: true, detail: 'graph recall disabled' };
  }

  if (!handle.pool) {
    return { name: 'graph_health', passed: false, detail: `${handle.reason} — cannot check graph` };
  }

  const pool = handle.pool;
  {
    // Single round-trip: edge count + last inference timestamp. coalesce on
    // inferred_at so the substrate's pre-T2 edges register their created_at
    // (otherwise max() returns NULL and the staleness check trips).
    const res = await pool.query(
      `SELECT
         count(*)::int AS edges,
         max(coalesce(inferred_at, created_at)) AS last_inferred_at
       FROM memory_relationships`
    );
    const row = res.rows[0] || {};
    const edges = Number(row.edges || 0);
    if (edges === 0) {
      return {
        name: 'graph_health', passed: false,
        detail: 'memory_relationships is empty — run T2 inference cron or seed edges manually',
      };
    }

    const last = row.last_inferred_at ? new Date(row.last_inferred_at) : null;
    if (!last) {
      return {
        name: 'graph_health', passed: true,
        detail: `${edges.toLocaleString()} edges, last inference timestamp unknown`,
      };
    }

    const agoMs = Date.now() - last.getTime();
    const agoH = (agoMs / 3_600_000).toFixed(1);
    const stale = agoMs > 48 * 3_600_000; // 48h cron drift threshold
    return {
      name: 'graph_health',
      passed: !stale,
      detail: stale
        ? `${edges.toLocaleString()} edges, last inference ${agoH}h ago (stale — expected within 48h)`
        : `${edges.toLocaleString()} edges, last inference ${agoH}h ago`,
    };
  }
}

async function checkProjectPaths(config) {
  const projects = config.projects || {};
  const names = Object.keys(projects);
  if (names.length === 0) {
    return { name: 'project_paths', passed: true, detail: 'no projects configured' };
  }

  let ok = 0;
  const missing = [];
  for (const name of names) {
    const p = projects[name];
    const resolved = (p.path || '').replace(/^~/, os.homedir());
    if (fs.existsSync(resolved)) {
      ok++;
    } else {
      missing.push(name);
    }
  }

  const total = names.length;
  if (missing.length === 0) {
    return { name: 'project_paths', passed: true, detail: `${ok}/${total} paths exist` };
  }
  return {
    name: 'project_paths',
    passed: false,
    detail: `${ok}/${total} paths exist — missing: ${missing.join(', ')}`,
  };
}

async function checkShellSanity() {
  const shell = process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shell);

  return new Promise((resolve) => {
    let ptyMod;
    try { ptyMod = require('@homebridge/node-pty-prebuilt-multiarch'); } catch (err) { ptyMod = null; }
    if (!ptyMod) {
      try { ptyMod = require('node-pty'); } catch (err) { ptyMod = null; }
    }
    if (!ptyMod) {
      resolve({ name: 'shell_sanity', passed: false, detail: 'node-pty not available' });
      return;
    }

    const t0 = Date.now();
    let output = '';
    let resolved = false;

    // Sprint 63 T3 §3.3 — drop `-l` (login mode). `-l` sources ~/.bash_profile
    // / ~/.zshrc and friends, which on heavy profiles (nvm, conda, plugin
    // managers — Brad's r730 has conda) routinely exceeds the timeout
    // budget below. A PTY-spawn health check answers "can $SHELL spawn a
    // PTY and emit output?" — not "does the user's interactive profile
    // complete fast?" Login-mode startup time is unrelated to PTY health.
    const proc = ptyMod.spawn(shell, ['-c', 'echo TERMDECK_OK'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env,
    });

    proc.onData((data) => {
      output += data;
      if (output.includes('TERMDECK_OK') && !resolved) {
        resolved = true;
        const ms = ((Date.now() - t0) / 1000).toFixed(1);
        proc.kill();
        resolve({ name: 'shell_sanity', passed: true, detail: `${shellName} OK in ${ms}s` });
      }
    });

    proc.onExit(({ exitCode }) => {
      if (!resolved) {
        resolved = true;
        const ms = ((Date.now() - t0) / 1000).toFixed(1);
        resolve({
          name: 'shell_sanity',
          passed: false,
          detail: `${shellName} exited ${exitCode} after ${ms}s without OK`,
        });
      }
    });

    // Liveness bound (env-tunable — see SHELL_PROBE_TIMEOUT_MS).
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch (err) { /* cleanup — process may already be dead */ }
        resolve({
          name: 'shell_sanity',
          passed: false,
          detail: `${shellName} timed out after ${Math.round(SHELL_PROBE_TIMEOUT_MS / 1000)}s`,
        });
      }
    }, SHELL_PROBE_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------------------
// HTTP helper (no external dependencies — uses built-in http)
// ---------------------------------------------------------------------------

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch (err) { return null; }
}

// ---------------------------------------------------------------------------
// Main preflight runner
// ---------------------------------------------------------------------------

// `deps` is a test seam only — production callers pass `config` alone.
//   deps.httpGet        (url, timeoutMs) => Promise<string>
//   deps.pgPoolFactory  (opts) => pool-like { query, end }
async function runPreflight(config, deps = {}) {
  // One probe per dependency, shared by every check that reads it. Two
  // checks of the same dependency must never cost two red rows for one
  // slow answer — that is the whole "5/7 on a healthy stack" failure.
  const mnestraProbe = probeMnestra(config, deps.httpGet);
  // Nobody may see an unhandled rejection before the two consumers attach.
  mnestraProbe.catch(() => {});

  const pgHandle = openPgHandle(deps.pgPoolFactory);

  const databasePromise = checkDatabase(pgHandle).catch((err) => {
    // Sprint 75 T2 (part C): a connect failure against the IPv6-only
    // direct endpoint (db.<project-ref>.supabase.co) on an IPv4-only
    // host presents as a timeout — name the likely cause in the detail.
    let detail = `connection failed — ${err.message}`;
    if (classifyDbEndpoint(process.env.DATABASE_URL).kind === 'direct') {
      detail += ' (DATABASE_URL is the IPv6-only db.<project-ref> direct endpoint — on IPv4-only hosts pg clients hang until a pool/connect timeout; use the Shared Pooler URL)';
    }
    return { name: 'database_url', passed: false, detail };
  });

  let checks;
  try {
    checks = await Promise.all([
      checkMnestra(mnestraProbe).catch((err) => ({
        name: 'mnestra_reachable', passed: false,
        detail: `unreachable — ${err.message}. Start with \`mnestra serve\``,
      })),
      checkMnestraMemories(mnestraProbe).catch((err) => ({
        name: 'mnestra_has_memories', passed: false,
        detail: `check failed — ${err.message}`,
      })),
      checkRumen(pgHandle, databasePromise).catch((err) => ({
        name: 'rumen_recent', passed: false,
        detail: `check failed — ${err.message}`,
      })),
      databasePromise,
      checkProjectPaths(config).catch((err) => ({
        name: 'project_paths', passed: false,
        detail: `check failed — ${err.message}`,
      })),
      checkShellSanity().catch((err) => ({
        name: 'shell_sanity', passed: false,
        detail: `check failed — ${err.message}`,
      })),
      checkGraphHealth(config, pgHandle).catch((err) => ({
        name: 'graph_health', passed: false,
        detail: `check failed — ${err.message}`,
      })),
    ]);
  } finally {
    if (pgHandle.pool) await pgHandle.pool.end().catch(() => {});
  }

  const result = {
    passed: checks.every((c) => c.passed),
    checks,
    timestamp: new Date().toISOString(),
  };

  _cachedResult = result;
  _cachedAt = Date.now();

  return result;
}

// ---------------------------------------------------------------------------
// Express route handler factory (GET /api/health)
//
// T3 or index.js wires this into the app:
//   const { createHealthHandler } = require('./preflight');
//   app.get('/api/health', createHealthHandler(config));
// ---------------------------------------------------------------------------

function createHealthHandler(config) {
  return async (_req, res) => {
    // Return cached result if fresh
    if (_cachedResult && (Date.now() - _cachedAt) < CACHE_TTL_MS) {
      return res.json(_cachedResult);
    }
    try {
      const result = await runPreflight(config);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// ---------------------------------------------------------------------------
// CLI banner printer
// ---------------------------------------------------------------------------

const REMEDIATION = {
  mnestra_reachable: 'Start Mnestra with `mnestra serve`',
  mnestra_has_memories: 'Run `mnestra ingest` to populate the memory store',
  rumen_recent: 'Check Rumen Edge Function deployment or run `termdeck init --rumen`',
  database_url: 'Set DATABASE_URL in ~/.termdeck/secrets.env (IPv4-only hosts: use the Shared Pooler URL)',
  project_paths: 'Fix paths in ~/.termdeck/config.yaml → projects',
  shell_sanity: 'Check $SHELL and your login profile (~/.zshrc or ~/.bashrc)',
  graph_health: 'Run T2 inference cron or apply migrations 009/010 to populate edges',
};

const CHECK_LABELS = {
  mnestra_reachable: 'Mnestra',
  mnestra_has_memories: 'Mnestra data',
  rumen_recent: 'Rumen',
  database_url: 'Database',
  project_paths: 'Project paths',
  shell_sanity: 'Shell',
  graph_health: 'Graph',
};

function printHealthBanner(result) {
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';

  for (const check of result.checks) {
    const label = (CHECK_LABELS[check.name] || check.name).padEnd(18, ' ');
    const dots = '.'.repeat(Math.max(1, 20 - label.length));
    if (check.passed) {
      console.log(`  ${green}✓${reset} ${dim}[health]${reset} ${label}${dim}${dots}${reset} ${green}OK${reset} ${dim}(${check.detail})${reset}`);
    } else {
      console.log(`  ${red}✗${reset} ${dim}[health]${reset} ${label}${dim}${dots}${reset} ${red}FAIL${reset} ${dim}(${check.detail})${reset}`);
      const hint = REMEDIATION[check.name];
      if (hint) {
        console.log(`           ${dim}→ ${hint}${reset}`);
      }
    }
  }

  const failCount = result.checks.filter((c) => !c.passed).length;
  if (failCount === 0) {
    console.log(`\n  ${green}${bold}All ${result.checks.length} health checks passed.${reset}\n`);
  } else {
    console.log(`\n  ${red}${bold}${failCount}/${result.checks.length} health checks failed.${reset} TermDeck will still run, but memory features may be degraded.\n`);
  }
}

// `_resetCache` and the budget constants are exported for tests only — the
// production surface is the three functions above.
function _resetCache() {
  _cachedResult = null;
  _cachedAt = 0;
}

module.exports = {
  runPreflight,
  createHealthHandler,
  printHealthBanner,
  _resetCache,
  _budgets: {
    get mnestraMs() { return MNESTRA_PROBE_TIMEOUT_MS; },
    get pgMs() { return PG_PROBE_TIMEOUT_MS; },
    get shellMs() { return SHELL_PROBE_TIMEOUT_MS; },
  },
};

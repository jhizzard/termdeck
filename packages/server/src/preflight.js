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

// Cache preflight results for 60s
let _cachedResult = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkMnestra(config) {
  const rag = config.rag || {};
  const url = rag.mnestraWebhookUrl
    ? rag.mnestraWebhookUrl.replace(/\/mnestra\/?$/, '/healthz')
    : 'http://localhost:37778/healthz';

  const body = await httpGet(url, 3000);
  const data = tryParseJSON(body);
  const total = data && (data.store?.rows ?? data.total ?? data.memories ?? data.count ?? null);
  if (total != null) {
    return { name: 'mnestra_reachable', passed: true, detail: `${Number(total).toLocaleString()} memories` };
  }
  // Got 200 but no count — still reachable
  return { name: 'mnestra_reachable', passed: true, detail: 'reachable (no memory count)' };
}

async function checkMnestraMemories(config) {
  // If Mnestra responded with a count in the reachable check we can skip
  // a second request — but since checks run independently we check the
  // memory_status endpoint separately.
  const rag = config.rag || {};
  const baseUrl = rag.mnestraWebhookUrl
    ? rag.mnestraWebhookUrl.replace(/\/mnestra\/?$/, '')
    : 'http://localhost:37778';

  const body = await httpGet(`${baseUrl}/healthz`, 3000);
  const data = tryParseJSON(body);
  const total = data && (data.store?.rows ?? data.total ?? data.memories ?? data.count ?? null);
  if (total != null && Number(total) > 0) {
    return { name: 'mnestra_has_memories', passed: true, detail: `${Number(total).toLocaleString()} memories loaded` };
  }
  if (total != null && Number(total) === 0) {
    return { name: 'mnestra_has_memories', passed: false, detail: 'Mnestra running but 0 memories — run `mnestra ingest`' };
  }
  return { name: 'mnestra_has_memories', passed: false, detail: 'could not determine memory count' };
}

async function checkRumen(config) {
  // Try to query rumen_jobs table via DATABASE_URL for last successful job
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { name: 'rumen_recent', passed: false, detail: 'DATABASE_URL not set — cannot check Rumen jobs' };
  }

  let pg;
  try { pg = require('pg'); } catch (err) { pg = null; }
  if (!pg) {
    return { name: 'rumen_recent', passed: false, detail: 'pg module not installed' };
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
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
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { name: 'database_url', passed: false, detail: 'DATABASE_URL not set' };
  }

  let pg;
  try { pg = require('pg'); } catch (err) { pg = null; }
  if (!pg) {
    return { name: 'database_url', passed: false, detail: 'pg module not installed' };
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  const t0 = Date.now();
  try {
    const res = await pool.query('SELECT 1 AS ok');
    const ms = Date.now() - t0;
    if (res.rows[0] && res.rows[0].ok === 1) {
      return { name: 'database_url', passed: true, detail: `connected in ${ms}ms` };
    }
    return { name: 'database_url', passed: false, detail: 'SELECT 1 returned unexpected result' };
  } finally {
    await pool.end().catch(() => {});
  }
}

// Sprint 38 / T3 — graph-health check. Returns:
//   pass : memory_relationships has rows AND last inferred_at < 48h ago
//   warn : has rows but last inference > 48h ago (T2 cron may have drifted)
//   fail : pg unreachable, table missing, or zero edges
//
// Reads `inferred_at` (T1's migration 009 column). Falls back to `created_at`
// for the 749 pre-T2 edges that have no inferred_at value yet, so the check
// doesn't perma-warn on the substrate that already exists.
async function checkGraphHealth(config) {
  // Only meaningful when graph features are enabled. Treat as pass with a
  // descriptive detail so the banner doesn't FAIL on installs that haven't
  // opted into graph recall yet.
  const graphEnabled = config.rag?.graphRecall === true;
  if (!graphEnabled) {
    return { name: 'graph_health', passed: true, detail: 'graph recall disabled' };
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { name: 'graph_health', passed: false, detail: 'DATABASE_URL not set — cannot check graph' };
  }

  let pg;
  try { pg = require('pg'); } catch (err) { pg = null; }
  if (!pg) {
    return { name: 'graph_health', passed: false, detail: 'pg module not installed' };
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
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
  } finally {
    await pool.end().catch(() => {});
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

    const proc = ptyMod.spawn(shell, ['-l', '-c', 'echo TERMDECK_OK'], {
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

    // 3s timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch (err) { /* cleanup — process may already be dead */ }
        resolve({ name: 'shell_sanity', passed: false, detail: `${shellName} timed out after 3s` });
      }
    }, 3000);
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

async function runPreflight(config) {
  const checks = await Promise.all([
    checkMnestra(config).catch((err) => ({
      name: 'mnestra_reachable', passed: false,
      detail: `unreachable — ${err.message}. Start with \`mnestra serve\``,
    })),
    checkMnestraMemories(config).catch((err) => ({
      name: 'mnestra_has_memories', passed: false,
      detail: `check failed — ${err.message}`,
    })),
    checkRumen(config).catch((err) => ({
      name: 'rumen_recent', passed: false,
      detail: `check failed — ${err.message}`,
    })),
    checkDatabase().catch((err) => ({
      name: 'database_url', passed: false,
      detail: `connection failed — ${err.message}`,
    })),
    checkProjectPaths(config).catch((err) => ({
      name: 'project_paths', passed: false,
      detail: `check failed — ${err.message}`,
    })),
    checkShellSanity().catch((err) => ({
      name: 'shell_sanity', passed: false,
      detail: `check failed — ${err.message}`,
    })),
    checkGraphHealth(config).catch((err) => ({
      name: 'graph_health', passed: false,
      detail: `check failed — ${err.message}`,
    })),
  ]);

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
  database_url: 'Set DATABASE_URL in ~/.termdeck/secrets.env',
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

module.exports = { runPreflight, createHealthHandler, printHealthBanner };

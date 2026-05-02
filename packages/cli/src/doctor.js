// `termdeck doctor` — Sprint 28 T2 + Sprint 35 T3.
//
// Two-section diagnostic:
//   Section 1 (Sprint 28) — npm version-check across the four stack packages,
//     comparing installed (`npm ls -g`) to the registry's `dist-tags.latest`.
//   Section 2 (Sprint 35) — Supabase schema state. Connects via DATABASE_URL
//     from ~/.termdeck/secrets.env and verifies the tables / columns / RPCs /
//     extensions that TermDeck + Mnestra + Rumen depend on.
//
// Read-only — no auto-fix. Each fail prints a remediation hint.
//
// Module contract:
//   module.exports = function doctor(argv): Promise<exitCode>
//     0 = all current and schema clean
//     1 = at least one update available OR at least one schema gap
//     2 = network/registry failure or DB-unreachable when --schema requested
//
// Flags:
//   --json        Emit a parseable JSON document (shape extended for Sprint 35:
//                 `{ exitCode, rows, schema? }` — `rows` retained for back-compat)
//   --no-color    Strip ANSI codes
//   --no-schema   Skip the Supabase schema section (used by tests + offline runs)
//
// Test seams (monkey-patchable):
//   _detectInstalled / _fetchLatest — npm probes (Sprint 28)
//   _runSchemaCheck — Supabase probe (Sprint 35) — tests stub to `{ skipped: true }`

const https = require('https');
const { spawn } = require('child_process');
const path = require('path');

const STACK_PACKAGES = [
  '@jhizzard/termdeck',
  '@jhizzard/mnestra',
  '@jhizzard/rumen',
  '@jhizzard/termdeck-stack',
];

const REGISTRY_TIMEOUT_MS = 5000;
const NPM_LS_TIMEOUT_MS = 8000;

const STATUS = {
  UP_TO_DATE: 'up to date',
  UPDATE: 'update available',
  NOT_INSTALLED: 'not installed',
  NETWORK_ERROR: 'network error',
};

function makeColors(enabled) {
  if (!enabled) {
    return { green: (s) => s, yellow: (s) => s, dim: (s) => s, bold: (s) => s };
  }
  return {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
  };
}

// Detect installed version via `npm ls -g <pkg> --depth=0 --json`. Returns
// the version string on success, or null on "not installed" / parse failure
// / npm-missing-from-PATH / timeout. Stderr noise (npm WARN lines) is
// silently dropped — those are not fatal.
async function _detectInstalled(pkg) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['ls', '-g', pkg, '--depth=0', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_err) {
      return resolve(null);
    }

    let stdout = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_e) { /* already gone */ }
    }, NPM_LS_TIMEOUT_MS);

    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', () => { /* discard npm WARNs */ });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => {
      clearTimeout(t);
      if (timedOut) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        const dep = parsed && parsed.dependencies && parsed.dependencies[pkg];
        if (dep && typeof dep.version === 'string') return resolve(dep.version);
        return resolve(null);
      } catch (_err) {
        return resolve(null);
      }
    });
  });
}

// Fetch the `latest` dist-tag for a package from the public npm registry.
// Returns the version string on success, or null on any failure (offline,
// non-200, malformed JSON, timeout). The caller treats null as a network
// error and bumps the exit code to 2.
async function _fetchLatest(pkg) {
  return new Promise((resolve) => {
    // Encode `@scope/name` as `%40scope%2Fname` per the registry's URL spec.
    const encoded = encodeURIComponent(pkg);
    const url = `https://registry.npmjs.org/-/package/${encoded}/dist-tags`;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let req;
    try {
      req = https.get(url, { timeout: REGISTRY_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done(null);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.latest === 'string') return done(parsed.latest);
            return done(null);
          } catch (_err) {
            return done(null);
          }
        });
        res.on('error', () => done(null));
      });
    } catch (_err) {
      return done(null);
    }
    req.on('timeout', () => {
      try { req.destroy(); } catch (_e) { /* already gone */ }
      done(null);
    });
    req.on('error', () => done(null));
  });
}

// Lightweight semver compare — only looks at the first three numeric segments,
// which is all dist-tags.latest ever needs. Returns -1, 0, or 1.
function _compareSemver(a, b) {
  const pa = String(a).split('.').map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function classifyRow(installed, latest) {
  if (latest === null) return STATUS.NETWORK_ERROR;
  if (installed === null) return STATUS.NOT_INSTALLED;
  return _compareSemver(installed, latest) < 0 ? STATUS.UPDATE : STATUS.UP_TO_DATE;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function renderTable(rows, c) {
  const out = [];
  out.push(c.bold('TermDeck stack — version check'));
  out.push('');
  out.push(`  ${pad('Package', 32)}${pad('Installed', 12)}${pad('Latest', 12)}Status`);
  out.push('  ' + '─'.repeat(63));
  for (const r of rows) {
    const installedDisplay = r.installed === null ? '(none)' : r.installed;
    const latestDisplay = r.latest === null ? '?' : r.latest;
    let statusDisplay = r.status;
    if (r.status === STATUS.UP_TO_DATE) statusDisplay = c.green(r.status);
    else if (r.status === STATUS.UPDATE) statusDisplay = c.yellow(r.status);
    else if (r.status === STATUS.NOT_INSTALLED) statusDisplay = c.dim(r.status);
    else if (r.status === STATUS.NETWORK_ERROR) statusDisplay = c.dim(r.status);
    out.push(`  ${pad(r.package, 32)}${pad(installedDisplay, 12)}${pad(latestDisplay, 12)}${statusDisplay}`);
  }
  return out.join('\n');
}

function renderFooter(rows, exitCode) {
  if (exitCode === 2) {
    const errors = rows.filter((r) => r.status === STATUS.NETWORK_ERROR).length;
    return `\n  Could not reach npm registry for ${errors} package${errors === 1 ? '' : 's'}. Try again later.`;
  }
  if (exitCode === 1) {
    const updates = rows.filter((r) => r.status === STATUS.UPDATE).length;
    return (
      `\n  ${updates} update${updates === 1 ? '' : 's'} available. ` +
      `Run: npx @jhizzard/termdeck-stack\n` +
      `  Or upgrade individually: npm install -g @jhizzard/termdeck@latest`
    );
  }
  return `\n  All packages up to date.`;
}

function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return {
    json: args.includes('--json'),
    noColor: args.includes('--no-color'),
    noSchema: args.includes('--no-schema'),
  };
}

// ── Sprint 35 T3: Supabase schema-check ────────────────────────────────────
//
// Connects via DATABASE_URL from ~/.termdeck/secrets.env and runs the schema
// invariants TermDeck + Mnestra + Rumen depend on. Read-only — no DDL.
//
// Returns `{ skipped, sections, passed, total, hasGaps, error? }` where
// `sections` is an ordered list of `{ name, checks: [{ label, status, hint? }] }`.
// `status` is one of 'pass' | 'fail'. A `skipped: true` result short-circuits
// rendering with an informational note.

const SCHEMA_QUERIES = {
  table: (name) =>
    `SELECT EXISTS(SELECT 1 FROM information_schema.tables ` +
    `WHERE table_schema = 'public' AND table_name = '${name}') AS ok`,
  column: (table, column) =>
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns ` +
    `WHERE table_schema = 'public' AND table_name = '${table}' ` +
    `AND column_name = '${column}') AS ok`,
  rpc: (name) =>
    `SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname = '${name}') AS ok`,
  extension: (name) =>
    `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = '${name}') AS ok`,
};

// pgvector ships under extname 'vector' on Supabase; some older installs
// or self-hosted boxes use 'pgvector' directly. Accept either.
async function checkPgVector(client) {
  try {
    const r = await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname IN ('vector', 'pgvector')) AS ok"
    );
    return r.rows && r.rows[0] && r.rows[0].ok === true;
  } catch (_e) {
    return false;
  }
}

async function probeSchema(client, sql) {
  try {
    const r = await client.query(sql);
    return r.rows && r.rows[0] && r.rows[0].ok === true;
  } catch (_e) {
    return false;
  }
}

async function _runSchemaCheck(opts = {}) {
  const optsObj = opts || {};
  // Lazy-require so users running version-check-only never load pg / fs.
  const fs = require('fs');
  const os = require('os');
  const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');
  let pgRunner;
  let dotenv;
  try {
    pgRunner = require(path.join(SETUP_DIR, 'pg-runner'));
    dotenv = require(path.join(SETUP_DIR, 'dotenv-io'));
  } catch (err) {
    return {
      skipped: true,
      reason: `setup helpers unavailable: ${err.message}`,
      sections: [], passed: 0, total: 0, hasGaps: false,
    };
  }

  const secretsPath = optsObj.secretsPath ||
    path.join(os.homedir(), '.termdeck', 'secrets.env');
  if (!fs.existsSync(secretsPath)) {
    return {
      skipped: true,
      reason: `~/.termdeck/secrets.env not found — run \`termdeck init --mnestra\` first`,
      sections: [], passed: 0, total: 0, hasGaps: false,
    };
  }
  const secrets = optsObj.secrets || dotenv.readSecrets(secretsPath);
  if (!secrets.DATABASE_URL) {
    return {
      skipped: true,
      reason: `DATABASE_URL not set in ${secretsPath}`,
      sections: [], passed: 0, total: 0, hasGaps: false,
    };
  }

  let client = optsObj._pgClient || null;
  let ownsClient = false;
  if (!client) {
    try {
      client = await pgRunner.connect(secrets.DATABASE_URL);
      ownsClient = true;
    } catch (err) {
      return {
        skipped: false,
        connectError: err.message,
        sections: [], passed: 0, total: 0, hasGaps: true,
      };
    }
  }

  const sections = [
    { name: 'Mnestra modern schema',  checks: [] },
    { name: 'Mnestra legacy schema',  checks: [] },
    { name: 'Transcript backup',      checks: [] },
    { name: 'Rumen schema',           checks: [] },
    { name: 'Postgres extensions',    checks: [] },
  ];

  try {
    // Mnestra modern
    const modern = sections[0].checks;
    for (const t of ['memory_items', 'memory_sessions', 'memory_relationships']) {
      modern.push({
        label: `${t} table`,
        status: (await probeSchema(client, SCHEMA_QUERIES.table(t))) ? 'pass' : 'fail',
        hint: `run: termdeck init --mnestra (applies migrations 001–007)`,
      });
    }
    modern.push({
      label: `memory_items.source_session_id column (v0.6.5+)`,
      status: (await probeSchema(client, SCHEMA_QUERIES.column('memory_items', 'source_session_id'))) ? 'pass' : 'fail',
      hint: `migration 007 adds it — run: npm cache clean --force && npm i -g @jhizzard/termdeck@latest && termdeck init --mnestra --yes`,
    });
    for (const fn of ['match_memories', 'search_memories', 'memory_status_aggregation']) {
      modern.push({
        label: `${fn}() RPC`,
        status: (await probeSchema(client, SCHEMA_QUERIES.rpc(fn))) ? 'pass' : 'fail',
        hint: `migration 005/006 creates it — re-run: termdeck init --mnestra --yes`,
      });
    }

    // Mnestra legacy (Sprint 35 T2 ships these via 008_legacy_rag_tables.sql)
    const legacy = sections[1].checks;
    for (const t of ['mnestra_session_memory', 'mnestra_project_memory', 'mnestra_developer_memory', 'mnestra_commands']) {
      legacy.push({
        label: `${t} table`,
        status: (await probeSchema(client, SCHEMA_QUERIES.table(t))) ? 'pass' : 'fail',
        hint: `run: termdeck init --mnestra --yes (applies migration 008 — Sprint 35)`,
      });
    }

    // Transcript
    sections[2].checks.push({
      label: `termdeck_transcripts table`,
      status: (await probeSchema(client, SCHEMA_QUERIES.table('termdeck_transcripts'))) ? 'pass' : 'fail',
      hint: `run: psql "$DATABASE_URL" -f config/transcript-migration.sql`,
    });

    // Rumen — table existence and timestamp column drift detection.
    // Migration 001 defines rumen_jobs.started_at (semantically the tick
    // start time) — NOT created_at. The other two tables use created_at.
    // Pre-0.16.1 doctor probed `created_at` for all three, which produced
    // a false-positive WARN on rumen_jobs and pointed users at a phantom
    // migration drift (Brad, 2026-05-02).
    const rumen = sections[3].checks;
    const RUMEN_TIME_COL = {
      rumen_jobs: 'started_at',
      rumen_insights: 'created_at',
      rumen_questions: 'created_at',
    };
    for (const t of ['rumen_jobs', 'rumen_insights', 'rumen_questions']) {
      const tableOk = await probeSchema(client, SCHEMA_QUERIES.table(t));
      rumen.push({
        label: `${t} table`,
        status: tableOk ? 'pass' : 'fail',
        hint: `run: termdeck init --rumen (applies rumen migration 001)`,
      });
      // Only check the column when the table exists — otherwise the column
      // line is redundant noise.
      if (tableOk) {
        const col = RUMEN_TIME_COL[t];
        rumen.push({
          label: `${t}.${col} column`,
          status: (await probeSchema(client, SCHEMA_QUERIES.column(t, col))) ? 'pass' : 'fail',
          hint: `column drift detected — re-run: termdeck init --rumen`,
        });
      }
    }

    // Extensions — pg_cron / pg_net / pgvector / pg_trgm / pgcrypto
    const exts = sections[4].checks;
    const dashboardHint = (() => {
      if (!secrets.SUPABASE_URL) return `enable in dashboard: Database → Extensions`;
      const m = String(secrets.SUPABASE_URL).match(/https:\/\/([a-z0-9-]+)\.supabase\.(co|in)/i);
      if (!m) return `enable in dashboard: Database → Extensions`;
      return `enable: https://supabase.com/dashboard/project/${m[1]}/database/extensions`;
    })();
    for (const ext of ['pg_cron', 'pg_net', 'pg_trgm', 'pgcrypto']) {
      exts.push({
        label: `${ext}`,
        status: (await probeSchema(client, SCHEMA_QUERIES.extension(ext))) ? 'pass' : 'fail',
        hint: dashboardHint,
      });
    }
    exts.push({
      label: `pgvector (extname: vector)`,
      status: (await checkPgVector(client)) ? 'pass' : 'fail',
      hint: dashboardHint,
    });
  } finally {
    if (ownsClient) {
      try { await client.end(); } catch (_e) { /* ignore */ }
    }
  }

  let passed = 0;
  let total = 0;
  for (const s of sections) {
    for (const c of s.checks) {
      total += 1;
      if (c.status === 'pass') passed += 1;
    }
  }
  return {
    skipped: false,
    sections,
    passed,
    total,
    hasGaps: passed < total,
  };
}

function renderSchemaResult(result, c) {
  const out = [];
  out.push('');
  out.push(c.bold('TermDeck stack — Supabase schema check'));
  out.push('');
  if (result.skipped) {
    out.push(`  ${c.dim(`(skipped) ${result.reason}`)}`);
    return out.join('\n');
  }
  if (result.connectError) {
    out.push(`  ${c.yellow('✗')} could not connect: ${result.connectError}`);
    out.push(`  ${c.dim('Check DATABASE_URL in ~/.termdeck/secrets.env, then re-run.')}`);
    return out.join('\n');
  }
  for (const section of result.sections) {
    out.push(`  ${c.bold(section.name)}`);
    if (section.checks.length === 0) {
      out.push(`    ${c.dim('(no checks ran)')}`);
      continue;
    }
    for (const check of section.checks) {
      if (check.status === 'pass') {
        out.push(`    ${c.green('✓')} ${check.label}`);
      } else {
        out.push(`    ${c.yellow('✗')} ${check.label}`);
        if (check.hint) {
          out.push(`        ${c.dim(check.hint)}`);
        }
      }
    }
    out.push('');
  }
  out.push(`  ${result.passed}/${result.total} schema checks passed`);
  return out.join('\n');
}

async function doctor(argv) {
  const opts = parseArgv(argv);

  // Resolve every package's installed + latest in parallel — independent
  // network/process calls, no reason to serialize.
  const rows = await Promise.all(
    STACK_PACKAGES.map(async (pkg) => {
      const [installed, latest] = await Promise.all([
        module.exports._detectInstalled(pkg),
        module.exports._fetchLatest(pkg),
      ]);
      return {
        package: pkg,
        installed,
        latest,
        status: classifyRow(installed, latest),
      };
    })
  );

  // Sprint 35 T3: schema check (skippable for tests / offline runs).
  let schema = null;
  if (!opts.noSchema) {
    try {
      schema = await module.exports._runSchemaCheck();
    } catch (err) {
      schema = {
        skipped: false,
        connectError: `unexpected error: ${err && err.message || err}`,
        sections: [], passed: 0, total: 0, hasGaps: true,
      };
    }
  }

  // Exit-code priority: any network failure → 2; any update available OR
  // schema gap → 1; else 0. Computed after all rows resolve so a single
  // transient failure doesn't mask real updates in stdout. A schema connect
  // error counts as 2 (same class as a registry fetch failure).
  let exitCode = 0;
  for (const r of rows) {
    if (r.status === STATUS.NETWORK_ERROR) {
      exitCode = 2;
      break;
    }
    if (r.status === STATUS.UPDATE && exitCode < 1) exitCode = 1;
  }
  if (schema && schema.connectError && exitCode < 2) exitCode = 2;
  if (schema && !schema.skipped && schema.hasGaps && exitCode < 1) exitCode = 1;

  if (opts.json) {
    const payload = { exitCode, rows };
    if (schema) payload.schema = schema;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return exitCode;
  }

  const colorEnabled = !opts.noColor && process.stdout.isTTY === true;
  const c = makeColors(colorEnabled);
  process.stdout.write(renderTable(rows, c) + '\n');
  process.stdout.write(renderFooter(rows, exitCode) + '\n');
  if (schema) {
    process.stdout.write(renderSchemaResult(schema, c) + '\n');
  }
  return exitCode;
}

module.exports = doctor;
module.exports._detectInstalled = _detectInstalled;
module.exports._fetchLatest = _fetchLatest;
module.exports._compareSemver = _compareSemver;
module.exports._runSchemaCheck = _runSchemaCheck;
module.exports.STACK_PACKAGES = STACK_PACKAGES;
module.exports.STATUS = STATUS;

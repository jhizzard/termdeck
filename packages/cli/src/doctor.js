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
//   --no-shims    Skip the standalone-shell capture section (it spawns each
//                 shim in dry-probe mode; skip in CI / on hosts without them)
//
// Test seams (monkey-patchable):
//   _detectInstalled / _fetchLatest — npm probes (Sprint 28)
//   _runSchemaCheck — Supabase probe (Sprint 35) — tests stub to `{ skipped: true }`

const https = require('https');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  // `red` added Sprint 68-REDUX T2: the shim section has three severities
  // (fail / warn / skip) and collapsing fail into the same yellow the warns
  // use would hide the one line that actually needs acting on.
  if (!enabled) {
    return { green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s };
  }
  return {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
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

// Sprint 58 T2 (Brad #4) — Mnestra-version probe used to gate the hybrid-
// search RPC name in `_runSchemaCheck`. Mnestra ≤ 0.3.x exposes
// `search_memories(...)`; Mnestra ≥ 0.4.0 renamed it to
// `memory_hybrid_search(...)`. Pre-fix doctor hard-coded `search_memories`,
// false-flagging RED on every install at Mnestra 0.4.0+. Reuses
// `_detectInstalled` (the same `npm ls -g` probe the version-check section
// already runs). Returns the installed version string or null if not
// detectable. Exposed as its own module export so unit tests can monkey-
// patch it independently of the rest of the doctor pipeline.
async function _detectMnestraVersion() {
  return module.exports._detectInstalled('@jhizzard/mnestra');
}

// Sprint 58 T2 (Brad #4) — RPC names to probe for the Mnestra hybrid-search
// function, gated on the installed Mnestra version.
//   ≥ 0.4.0       → ['memory_hybrid_search']
//   ≤ 0.3.x       → ['search_memories']
//   null/unknown  → ['memory_hybrid_search', 'search_memories'] (probe both;
//                    GREEN if either exists — graceful on offline / non-
//                    globally-installed cases).
function _selectHybridSearchRpcNames(mnestraVersion) {
  if (!mnestraVersion) return ['memory_hybrid_search', 'search_memories'];
  if (_compareSemver(mnestraVersion, '0.4.0') >= 0) return ['memory_hybrid_search'];
  return ['search_memories'];
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
  // Sprint 56 (T1 Cross-Cutting #2 Part A) — logical inversion fix. Pre-
  // Sprint-56 the footer always read "All packages up to date" on exit 0,
  // even when every row was NOT_INSTALLED. That's logically wrong: saying
  // "all up to date" when "all not installed" misleads the user into
  // thinking the stack is healthy. Distinguish the two states explicitly.
  const notInstalled = rows.filter((r) => r.status === STATUS.NOT_INSTALLED).length;
  if (notInstalled === rows.length && rows.length > 0) {
    return (
      `\n  No stack packages detected (${rows.length} of ${rows.length} not installed).\n` +
      `  To bootstrap the full stack: npx @jhizzard/termdeck-stack`
    );
  }
  if (notInstalled > 0) {
    return (
      `\n  ${notInstalled} of ${rows.length} stack packages not installed; the rest up to date.\n` +
      `  To install missing pieces: npx @jhizzard/termdeck-stack`
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
    noAgents: args.includes('--no-agents'),
    noShims: args.includes('--no-shims'),
    noBilling: args.includes('--no-billing'),
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
    // Sprint 75 T2 (part C): classify + warn BEFORE the connect attempt —
    // a direct-endpoint URL on an IPv4-only host doesn't fail fast, it
    // hangs until a pool timeout, so the warning must print first.
    // Warn-only; fail-soft if the helper is unavailable.
    try {
      const urlHelper = require(path.join(SETUP_DIR, 'supabase-url'));
      for (const line of urlHelper.directEndpointWarningLines(urlHelper.classifyDbEndpoint(secrets.DATABASE_URL))) {
        process.stdout.write(`  ${line}\n`);
      }
    } catch (_e) { /* warn-only — never block the doctor pass */ }
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
    modern.push({
      label: `match_memories() RPC`,
      status: (await probeSchema(client, SCHEMA_QUERIES.rpc('match_memories'))) ? 'pass' : 'fail',
      hint: `migration 005/006 creates it — re-run: termdeck init --mnestra --yes`,
    });

    // Sprint 58 T2 (Brad #4): version-gate the hybrid-search RPC name. The
    // function was renamed `search_memories` → `memory_hybrid_search` at
    // Mnestra 0.4.0. Pre-fix doctor probed only the legacy name, so every
    // install at Mnestra ≥ 0.4.0 reported false-RED here. The version is
    // passed in by `doctor()` (which already detected it for the version-
    // check table); when called standalone, we self-detect.
    const mnestraVersion = optsObj.mnestraVersion !== undefined
      ? optsObj.mnestraVersion
      : await module.exports._detectMnestraVersion();
    const hybridProbeNames = _selectHybridSearchRpcNames(mnestraVersion);
    const hybridProbeLabel = hybridProbeNames.length === 1
      ? `${hybridProbeNames[0]}() RPC`
      : `${hybridProbeNames.join(' or ')}() RPC`;
    let hybridOk = false;
    for (const name of hybridProbeNames) {
      if (await probeSchema(client, SCHEMA_QUERIES.rpc(name))) {
        hybridOk = true;
        break;
      }
    }
    modern.push({
      label: hybridProbeLabel,
      status: hybridOk ? 'pass' : 'fail',
      hint: mnestraVersion
        ? `Mnestra ${mnestraVersion} expects ${hybridProbeNames[0]}() — re-run: termdeck init --mnestra --yes`
        : `migration 005 (legacy) or 015+ (modern) creates it — re-run: termdeck init --mnestra --yes`,
    });

    modern.push({
      label: `memory_status_aggregation() RPC`,
      status: (await probeSchema(client, SCHEMA_QUERIES.rpc('memory_status_aggregation'))) ? 'pass' : 'fail',
      hint: `migration 005/006 creates it — re-run: termdeck init --mnestra --yes`,
    });

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
    out.push(`  ${c.dim('If this host is IPv4-only and the URL is the db.<project-ref> direct endpoint, that is the cause — switch to the Shared Pooler.')}`);
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

// ── Sprint 70 T2: agent-CLI auth-probe section ─────────────────────────────
//
// Surfaces each agent adapter's `checkAuth()` verdict in `termdeck doctor` so a
// misconfigured agent CLI is caught here instead of failing silently at panel
// spawn. The motivating case: Google ends Gemini's OAuth serving path on
// 2026-06-18, after which a Gemini CLI still set to `oauth-personal` stops
// working — `checkAuth()` reports that as `wrong-mode` and this section turns
// it into a doctor RED (exit 1) with a remediation hint.
//
// Only adapters that expose a `checkAuth` function participate (Gemini today;
// forward-compatible as Codex/Grok/agy add probes). Static-only (`live:false`)
// — no spawn / network, so the section never hangs or hits an API. The whole
// registry require is wrapped: on any load failure the section is skipped
// (never a crash, never a false RED). Monkey-patchable as
// `module.exports._runAgentAuthCheck`, the same seam pattern as
// `_runSchemaCheck`.
async function _runAgentAuthCheck(opts = {}) {
  let registry;
  try {
    registry = require(path.join(__dirname, '..', '..', 'server', 'src', 'agent-adapters'));
  } catch (err) {
    return {
      skipped: true,
      reason: `agent adapters unavailable: ${err && err.message || err}`,
      agents: [], passed: 0, total: 0, hasGaps: false,
    };
  }
  const adapters = Object.values((registry && registry.AGENT_ADAPTERS) || {})
    .filter((a) => a && typeof a.checkAuth === 'function');
  const agents = [];
  for (const a of adapters) {
    let v;
    try {
      // live:false → static checks only (env + settings.json); never spawns.
      v = await a.checkAuth({ live: false, ...opts });
    } catch (err) {
      v = { ok: false, state: 'error', detail: `probe threw: ${err && err.message || err}`, hint: '' };
    }
    agents.push({
      name: a.displayName || a.name,
      state: v.state,
      ok: v.ok === true,
      detail: v.detail || '',
      hint: v.hint || '',
    });
  }
  const passed = agents.filter((x) => x.ok).length;
  return { skipped: false, agents, passed, total: agents.length, hasGaps: passed < agents.length };
}

function renderAgentAuthResult(result, c) {
  const out = [];
  out.push('');
  out.push(c.bold('Agent CLI auth'));
  out.push('');
  if (result.skipped) {
    out.push(`  ${c.dim(`(skipped) ${result.reason}`)}`);
    return out.join('\n');
  }
  if (!result.agents || result.agents.length === 0) {
    out.push(`  ${c.dim('(no agent adapters expose an auth probe)')}`);
    return out.join('\n');
  }
  for (const a of result.agents) {
    if (a.ok) {
      out.push(`  ${c.green('✓')} ${a.name}: ${a.state}`);
    } else {
      out.push(`  ${c.yellow('✗')} ${a.name}: ${a.state}`);
      if (a.detail) out.push(`      ${c.dim(a.detail)}`);
      if (a.hint) out.push(`      ${c.dim(a.hint)}`);
    }
  }
  out.push('');
  out.push(`  ${result.passed}/${result.total} agent auth checks passed`);
  return out.join('\n');
}

// ── Sprint 68-REDUX T2: standalone-shell capture shim probes ───────────────
//
// The shims are PATH wrappers: install them wrong — or install them right and
// let a later PATH entry shadow them — and they do nothing at all, silently,
// forever. That is INSTALLER-PITFALLS Class I (silent no-op) with no
// background job to notice it, which makes this section the only detector we
// have. It answers four questions:
//
//   1. Is ~/.termdeck/shims actually ON $PATH? (an install the user never
//      opened a new shell for looks identical to a working one)
//   2. For each CLI, does `<name>` RESOLVE to our shim, or is an earlier PATH
//      entry shadowing it? (homebrew, nvm, ~/.local/bin all prepend)
//   3. Can each shim find the REAL binary behind it?
//   4. Does the recursion sentinel still abort a re-entry?
//
// SKIP ≠ FAIL, and the distinction is load-bearing: a machine with no `grok`
// installed is a correct machine. A missing real CLI is reported with its
// reason and never contributes to the exit code. Only genuine misconfiguration
// (not on PATH, shadowed, shim missing/not executable) is a gap.
//
// Fail-soft throughout: a shim that predates the `TERMDECK_SHIM_PROBE`
// contract, an unreadable file, a probe that times out — all WARN, never RED.
// This section never reports a problem it cannot substantiate.

const SHIM_NAMES = ['codex', 'grok', 'agy'];
const SHIM_PROBE_TIMEOUT_MS = 4000;

// Ordered list of executables named `name` on PATH, first match first — the
// same resolution order the shell itself uses. Pure + injectable so the tests
// never depend on the host's real PATH.
function _resolveOnPath(name, pathEnv, _fs = fs) {
  const dirs = String(pathEnv || '').split(path.delimiter).filter(Boolean);
  const seen = new Set();
  const hits = [];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const st = _fs.statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) hits.push(candidate);
    } catch (_) { /* not here */ }
  }
  return hits;
}

// True when $PATH contains the shims dir at all (any position).
function _pathContainsDir(pathEnv, dir) {
  return String(pathEnv || '').split(path.delimiter).filter(Boolean)
    .some((d) => path.resolve(d) === path.resolve(dir));
}

// Symlink-aware identity. A PATH entry that is a SYMLINK to our shim is the
// same file, not a shadow — comparing `path.resolve` alone would call that a
// hijack and send the user chasing a problem they don't have.
function _realpath(p, _fs = fs) {
  try { return _fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}

// Does this file carry T1's shim marker? Used to answer "did the shim resolve
// to ANOTHER shim?" — the exact condition T4-CODEX reproduced against the
// resolver on 2026-08-01. Whatever the resolver ends up doing, the doctor
// should be able to see that failure from the outside rather than trusting
// the thing under test to self-report.
const SHIM_MARKER_REGEX = /@termdeck\/shim\s+v\d+/;
function _looksLikeShim(filePath, _fs = fs) {
  try { return SHIM_MARKER_REGEX.test(_fs.readFileSync(filePath, 'utf8').slice(0, 4096)); }
  catch (_) { return false; }
}

async function _runShimCheck(opts = {}) {
  const _fs = opts._fs || fs;
  const _spawnSync = opts._spawnSync || spawnSync;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const shimsDir = opts.shimsDir || path.join(home, '.termdeck', 'shims');
  const names = opts.names || SHIM_NAMES;
  const checks = [];

  if (!_fs.existsSync(shimsDir)) {
    return {
      skipped: true,
      reason: `standalone-shell capture not installed (${shimsDir} absent) — run \`npx @jhizzard/termdeck-stack\` to add it`,
      checks: [], passed: 0, total: 0, hasGaps: false,
    };
  }

  // 0. The kill switch, FIRST because it outranks every other verdict.
  // `TERMDECK_SHIM_DISABLE` (shim-template.sh:144) makes every shim a
  // transparent `exec` — the CLI runs perfectly and nothing is ever captured.
  // Without this probe an operator asking "why is nothing landing in Mnestra?"
  // gets an all-green section, which is the worst possible answer. It is a
  // deliberate user choice, so WARN rather than FAIL — but it is stated before
  // anything else, because every check below it becomes moot.
  if (env.TERMDECK_SHIM_DISABLE) {
    checks.push({
      label: 'capture DISABLED by TERMDECK_SHIM_DISABLE',
      status: 'warn',
      hint: `TERMDECK_SHIM_DISABLE=${env.TERMDECK_SHIM_DISABLE} is set in this environment — the shims run your CLI transparently and capture NOTHING. Everything below may look healthy and still write nothing. Unset it (check your shell rc) to re-enable capture.`,
    });
  }

  // 1. PATH membership. Everything downstream is moot if this fails, but we
  // still run the per-CLI checks — "shim present but PATH not reloaded" and
  // "shim missing entirely" are different problems and the user deserves both.
  const onPath = _pathContainsDir(env.PATH, shimsDir);
  checks.push(onPath
    ? { label: `${shimsDir} on $PATH`, status: 'pass' }
    : {
      label: `${shimsDir} on $PATH`,
      status: 'fail',
      hint: 'open a new terminal (or `exec $SHELL -l`) — the PATH block is written to your rc file but this shell has not re-read it. If a new shell still fails, the fenced block is missing from your rc: re-run `npx @jhizzard/termdeck-stack`.',
    });

  // 2. The drain sibling. The shim resolves it as `$SHIM_DIR/drain.js` and,
  // when it is absent, still runs the CLI perfectly and writes nothing — the
  // exact silent no-op shape this section exists to catch. Nothing else in
  // the system would ever mention it.
  const drainPath = path.join(shimsDir, 'drain.js');
  checks.push(_fs.existsSync(drainPath)
    ? { label: 'drain.js present', status: 'pass' }
    : {
      label: 'drain.js present',
      status: 'fail',
      hint: `${drainPath} is missing — the shims will run your CLI normally but capture NOTHING. Re-run \`npx @jhizzard/termdeck-stack\` or \`termdeck init --mnestra\` to re-stage it.`,
    });

  // The redactor sibling. `script(1)` captures the RAW TERMINAL, so this is
  // what stands between a pasted credential and a cloud database. drain.js
  // degrades to a smaller built-in pattern set when it is absent — capture
  // still works, which is exactly why nothing else would ever tell you your
  // redaction quietly got weaker. WARN, not FAIL: the session is still being
  // captured and still being redacted, just less thoroughly.
  const redactPath = path.join(shimsDir, 'redact.js');
  checks.push(_fs.existsSync(redactPath)
    ? { label: 'redact.js present', status: 'pass' }
    : {
      label: 'redact.js present',
      status: 'warn',
      hint: `${redactPath} is missing — capture still runs, but falls back to weaker built-in redaction that does NOT catch database connection strings. Re-stage with \`npx @jhizzard/termdeck-stack\` or \`termdeck init --mnestra\`.`,
    });

  for (const name of names) {
    const shimPath = path.join(shimsDir, name);

    // 3. Shim file present + executable.
    let st = null;
    try { st = _fs.statSync(shimPath); } catch (_) { st = null; }
    if (!st) {
      checks.push({ label: `shim ${name}`, status: 'fail', hint: `${shimPath} is missing — re-run \`npx @jhizzard/termdeck-stack\` or \`termdeck init --mnestra\` to re-stage it.` });
      continue;
    }
    if (!(st.mode & 0o111)) {
      checks.push({ label: `shim ${name}`, status: 'fail', hint: `${shimPath} is not executable — \`chmod 755 ${shimPath}\`.` });
      continue;
    }

    // 4. PATH ORDER — does `name` resolve to OUR shim, or to something earlier?
    // This is the failure the whole section exists for: everything looks
    // installed, and a single earlier PATH entry means zero capture forever.
    const resolved = _resolveOnPath(name, env.PATH, _fs);
    if (onPath) {
      if (resolved.length === 0) {
        checks.push({ label: `${name} resolves to shim`, status: 'warn', hint: `no executable \`${name}\` found on $PATH at all, despite ${shimsDir} being on it — check for a stale PATH in this shell.` });
      } else if (_realpath(resolved[0], _fs) !== _realpath(shimPath, _fs)) {
        checks.push({
          label: `${name} resolves to shim`,
          status: 'fail',
          hint: `\`${name}\` resolves to ${resolved[0]}, which SHADOWS ${shimPath}. Standalone ${name} sessions are NOT being captured. Move ${shimsDir} earlier in $PATH — the installer's rc block must run after whatever adds ${path.dirname(resolved[0])}.`,
        });
      } else {
        checks.push({ label: `${name} resolves to shim`, status: 'pass' });
      }
    }

    // 5. Real-binary resolution, via the shim's own dry-probe mode.
    // Gated on the shim actually declaring TERMDECK_SHIM_PROBE: a shim from an
    // older build has no probe mode, and running it would launch the real CLI
    // interactively inside `termdeck doctor`. Read before you spawn.
    let declaresProbe = false;
    try { declaresProbe = _fs.readFileSync(shimPath, 'utf8').includes('TERMDECK_SHIM_PROBE'); }
    catch (_) { declaresProbe = false; }
    if (!declaresProbe) {
      checks.push({ label: `${name} → real binary`, status: 'warn', hint: `${shimPath} predates the TERMDECK_SHIM_PROBE contract; skipping the live probe. Re-stage the shims to get it.` });
      continue;
    }

    let probe;
    try {
      probe = _spawnSync(shimPath, [], {
        env: { ...env, TERMDECK_SHIM_PROBE: '1' },
        encoding: 'utf8',
        timeout: SHIM_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      probe = { error: err };
    }
    if (probe && probe.error) {
      checks.push({ label: `${name} → real binary`, status: 'warn', hint: `probe could not run: ${probe.error.message}` });
    } else if (probe.status === 0) {
      const resolvedBin = String(probe.stdout || '').trim().split('\n').pop().trim();
      if (resolvedBin && _looksLikeShim(resolvedBin, _fs)) {
        // The shim believes it found the real CLI, but what it found is another
        // TermDeck shim (a stale copy, a second install, a symlink chain).
        // Live, that either trips the recursion sentinel or never reaches the
        // real binary — and the probe alone would have called it healthy.
        checks.push({
          label: `${name} → real binary`,
          status: 'fail',
          hint: `the shim resolved \`${name}\` to ANOTHER TermDeck shim at ${resolvedBin}, not the real CLI. Standalone ${name} will abort instead of running. Remove the stale copy, or drop its directory from $PATH.`,
        });
      } else {
        checks.push({ label: `${name} → real binary`, status: 'pass', detail: resolvedBin || '(probe printed nothing)' });
      }
    } else if (probe.status === 127) {
      // The documented "no real CLI behind this shim" exit. Explicitly NOT a
      // failure — a fresh machine without grok installed is a correct machine.
      checks.push({ label: `${name} → real binary`, status: 'skip', hint: `no real \`${name}\` binary on $PATH behind the shim — nothing to capture, and nothing wrong. Install ${name} if you want its standalone sessions captured.` });
    } else {
      checks.push({ label: `${name} → real binary`, status: 'warn', hint: `probe exited ${probe.status === null ? 'on timeout' : probe.status}: ${String(probe.stderr || '').trim().slice(0, 200) || '(no stderr)'}` });
    }

    // 6. Recursion sentinel — a shim that re-enters itself is a fork bomb in
    // the user's shell, so verify the guard still bites. Expected exit 70.
    let sentinel;
    try {
      sentinel = _spawnSync(shimPath, [], {
        env: { ...env, TERMDECK_SHIM_PROBE: '1', TERMDECK_SHIM_ACTIVE: name },
        encoding: 'utf8',
        timeout: SHIM_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      sentinel = { error: err };
    }
    if (sentinel && !sentinel.error && sentinel.status === 70) {
      checks.push({ label: `${name} recursion sentinel`, status: 'pass' });
    } else {
      const got = sentinel && sentinel.error ? sentinel.error.message
        : `exit ${sentinel && sentinel.status === null ? 'timeout' : sentinel && sentinel.status}`;
      checks.push({ label: `${name} recursion sentinel`, status: 'warn', hint: `expected exit 70 with TERMDECK_SHIM_ACTIVE set, got ${got}.` });
    }
  }

  const scored = checks.filter((c) => c.status === 'pass' || c.status === 'fail');
  const passed = scored.filter((c) => c.status === 'pass').length;
  return {
    skipped: false,
    shimsDir,
    checks,
    passed,
    total: scored.length,
    // Only hard fails gate the exit code. Warns are informational; skips are
    // "this machine legitimately doesn't have that CLI".
    hasGaps: checks.some((c) => c.status === 'fail'),
  };
}

function renderShimResult(result, c) {
  const out = [];
  out.push('');
  out.push(c.bold('Standalone-shell capture'));
  out.push('');
  if (result.skipped) {
    out.push(`  ${c.dim(`(skipped) ${result.reason}`)}`);
    return out.join('\n');
  }
  for (const chk of result.checks) {
    if (chk.status === 'pass') {
      out.push(`  ${c.green('✓')} ${chk.label}${chk.detail ? c.dim(` — ${chk.detail}`) : ''}`);
    } else if (chk.status === 'skip') {
      out.push(`  ${c.dim('─')} ${c.dim(`${chk.label}: skipped`)}`);
      if (chk.hint) out.push(`      ${c.dim(chk.hint)}`);
    } else if (chk.status === 'warn') {
      out.push(`  ${c.yellow('!')} ${chk.label}`);
      if (chk.hint) out.push(`      ${c.dim(chk.hint)}`);
    } else {
      out.push(`  ${c.red('✗')} ${chk.label}`);
      if (chk.hint) out.push(`      ${c.dim(chk.hint)}`);
    }
  }
  out.push('');
  out.push(`  ${result.passed}/${result.total} shim checks passed`);
  return out.join('\n');
}

// ── Sprint 71 B-T2: panel-billing probe ────────────────────────────────────
//
// WHAT GOES WRONG. A Claude Code panel that inherits `ANTHROPIC_API_KEY` stops
// billing the operator's subscription login and starts consuming API credits —
// or, on some versions, halts at the interactive "use the detected API key?"
// prompt, which during an unattended overnight sprint is indistinguishable
// from a wedged panel. Neither failure announces itself: the panel looks
// normal, and the bill arrives later.
//
// TermDeck fences both inheritance routes in the server (the secrets.env merge
// via SECRETS_EXCLUDED_FROM_PTY, and the inherited process env via
// scrubSpawnEnv). This probe exists because those fences live in the RUNNING
// server, and the operator's shell can carry the key regardless — the probe
// answers "would a panel spawned right now inherit it?", which is the question
// the fences cannot answer about a server they are not inside of.
//
// Read-only: reads two files and this process's env. Never prints a key value.
const BILLING_KEY = 'ANTHROPIC_API_KEY';

function _readSecretsEnvKeys(_fs = fs, _os = os) {
  const p = path.join(_os.homedir(), '.termdeck', 'secrets.env');
  const out = new Set();
  try {
    for (const raw of _fs.readFileSync(p, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const v = m[2].trim();
      if (!v || (v.startsWith('${') && v.endsWith('}'))) continue;
      out.add(m[1]);
    }
  } catch (_e) { /* absent file is the normal pre-wizard state */ }
  return out;
}

async function _runBillingCheck(opts = {}) {
  const _fs = opts.fs || fs;
  const _os = opts.os || os;
  const env = opts.env || process.env;
  const checks = [];

  const inSecrets = _readSecretsEnvKeys(_fs, _os).has(BILLING_KEY);
  const inProcessEnv = typeof env[BILLING_KEY] === 'string' && env[BILLING_KEY].length > 0;
  const hatchOpen = env.TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY === '1';

  // secrets.env is the FENCED path — the key being present there is fine, and
  // saying so explicitly matters: an operator who sees a warning about a file
  // they were told to put the key in will "fix" it by deleting a key the
  // server-side consumers legitimately read.
  checks.push(inSecrets
    ? {
      label: `${BILLING_KEY} in ~/.termdeck/secrets.env`,
      status: 'pass',
      detail: 'present, and excluded from the panel env merge — this is fine',
    }
    : {
      label: `${BILLING_KEY} in ~/.termdeck/secrets.env`,
      status: 'skip',
      hint: 'not set. Nothing to leak from this path.',
    });

  // The process env is the path the server cannot fence for a shell it did not
  // launch from. This is the one worth warning about.
  if (!inProcessEnv) {
    checks.push({
      label: `${BILLING_KEY} in this shell's environment`,
      status: 'pass',
      detail: 'unset — a panel spawned from a server started here inherits nothing',
    });
  } else if (hatchOpen) {
    checks.push({
      label: `${BILLING_KEY} in this shell's environment`,
      status: 'warn',
      hint: 'set, AND TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY=1 is open, so panels WILL '
        + 'inherit it and bill API credits instead of your subscription. That is a '
        + 'deliberate configuration — unset the escape hatch if it was not.',
    });
  } else {
    checks.push({
      label: `${BILLING_KEY} in this shell's environment`,
      status: 'warn',
      hint: 'set. A TermDeck server launched from THIS shell passes it to every '
        + 'panel it spawns unless it is new enough to carry the spawn-env scrub '
        + '(Sprint 71+). Panels that inherit it bill API credits rather than your '
        + 'subscription login, or stall at the "use the detected API key?" prompt. '
        + `Fix: start the server from a shell without it — \`env -u ${BILLING_KEY} termdeck\` `
        + '— or upgrade. See INSTALLER-PITFALLS ledger #23.',
    });
  }

  const passed = checks.filter((c) => c.status === 'pass').length;
  return {
    skipped: false,
    checks,
    passed,
    total: checks.filter((c) => c.status !== 'skip').length,
    // Advisory only. A warn here is a configuration the operator may have
    // chosen; failing `doctor` over it would train people to ignore the exit
    // code, which costs more than this warning is worth.
    hasGaps: false,
  };
}

function renderBillingResult(result, c) {
  const out = [];
  out.push('');
  out.push(c.bold('Panel billing safety'));
  out.push('');
  if (result.skipped) {
    out.push(`  ${c.dim(`(skipped) ${result.reason}`)}`);
    return out.join('\n');
  }
  for (const chk of result.checks) {
    if (chk.status === 'pass') {
      out.push(`  ${c.green('✓')} ${chk.label}${chk.detail ? c.dim(` — ${chk.detail}`) : ''}`);
    } else if (chk.status === 'skip') {
      out.push(`  ${c.dim('─')} ${c.dim(`${chk.label}: not set`)}`);
    } else {
      out.push(`  ${c.yellow('!')} ${chk.label}`);
      if (chk.hint) out.push(`      ${c.dim(chk.hint)}`);
    }
  }
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
  // Sprint 58 T2 (Brad #4): pass the already-detected Mnestra version
  // through so `_runSchemaCheck` doesn't re-shell-out to `npm ls -g`. The
  // version-check section detected it a few lines up; reuse it.
  let schema = null;
  if (!opts.noSchema) {
    const mnestraRow = rows.find((r) => r.package === '@jhizzard/mnestra');
    const mnestraVersion = mnestraRow ? mnestraRow.installed : null;
    try {
      schema = await module.exports._runSchemaCheck({ mnestraVersion });
    } catch (err) {
      schema = {
        skipped: false,
        connectError: `unexpected error: ${err && err.message || err}`,
        sections: [], passed: 0, total: 0, hasGaps: true,
      };
    }
  }

  // Sprint 70 T2: agent-CLI auth probe (skippable for tests / hosts without
  // agent CLIs). Static-only by default — no spawn / network.
  let agents = null;
  if (!opts.noAgents) {
    try {
      agents = await module.exports._runAgentAuthCheck();
    } catch (err) {
      agents = {
        skipped: false,
        agents: [{ name: 'agent auth', state: 'error', ok: false,
          detail: `unexpected error: ${err && err.message || err}`, hint: '' }],
        passed: 0, total: 1, hasGaps: true,
      };
    }
  }

  // Sprint 68-REDUX T2: standalone-shell capture shims. Skippable via
  // --no-shims for offline/CI runs (it spawns the shims in dry-probe mode).
  let shims = null;
  if (!opts.noShims) {
    try {
      shims = await module.exports._runShimCheck();
    } catch (err) {
      shims = {
        skipped: false,
        checks: [{ label: 'shim probes', status: 'warn', hint: `unexpected error: ${err && err.message || err}` }],
        passed: 0, total: 0, hasGaps: false,
      };
    }
  }

  // Sprint 71 B-T2: panel-billing probe. Local + read-only, so it has no
  // offline/CI cost, but it is skippable for symmetry with the other sections.
  let billing = null;
  if (!opts.noBilling) {
    try {
      billing = await module.exports._runBillingCheck();
    } catch (err) {
      billing = {
        skipped: false,
        checks: [{ label: 'panel billing', status: 'warn', hint: `unexpected error: ${err && err.message || err}` }],
        passed: 0, total: 0, hasGaps: false,
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
  if (agents && !agents.skipped && agents.hasGaps && exitCode < 1) exitCode = 1;
  // A shim that is installed but shadowed / off-PATH captures nothing — a real
  // gap, same exit weight as a schema gap. Skips (no such CLI on this machine)
  // and warns never reach here: `hasGaps` counts hard fails only.
  if (shims && !shims.skipped && shims.hasGaps && exitCode < 1) exitCode = 1;

  if (opts.json) {
    const payload = { exitCode, rows };
    if (schema) payload.schema = schema;
    if (agents) payload.agents = agents;
    if (shims) payload.shims = shims;
    if (billing) payload.billing = billing;
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
  if (agents) {
    process.stdout.write(renderAgentAuthResult(agents, c) + '\n');
  }
  if (shims) {
    process.stdout.write(renderShimResult(shims, c) + '\n');
  }
  if (billing) {
    process.stdout.write(renderBillingResult(billing, c) + '\n');
  }
  return exitCode;
}

module.exports = doctor;
module.exports._detectInstalled = _detectInstalled;
module.exports._fetchLatest = _fetchLatest;
module.exports._compareSemver = _compareSemver;
module.exports._detectMnestraVersion = _detectMnestraVersion;
module.exports._selectHybridSearchRpcNames = _selectHybridSearchRpcNames;
module.exports._runSchemaCheck = _runSchemaCheck;
module.exports._runAgentAuthCheck = _runAgentAuthCheck;
// Sprint 68-REDUX T2 — standalone-shell shim probes.
module.exports._runShimCheck = _runShimCheck;
module.exports._resolveOnPath = _resolveOnPath;
module.exports._pathContainsDir = _pathContainsDir;
module.exports._looksLikeShim = _looksLikeShim;
module.exports._realpath = _realpath;
module.exports.renderShimResult = renderShimResult;
module.exports.SHIM_NAMES = SHIM_NAMES;
// Sprint 71 B-T2 — panel-billing probe.
module.exports._runBillingCheck = _runBillingCheck;
module.exports._readSecretsEnvKeys = _readSecretsEnvKeys;
module.exports.renderBillingResult = renderBillingResult;
module.exports.BILLING_KEY = BILLING_KEY;
module.exports.STACK_PACKAGES = STACK_PACKAGES;
module.exports.STATUS = STATUS;

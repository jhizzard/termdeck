#!/usr/bin/env node

// `termdeck init --rumen` — interactive wizard for deploying Rumen as a
// Supabase Edge Function + pg_cron schedule against the same Supabase
// project that holds the Mnestra store.
//
// Requirements checked at runtime:
//   - `supabase` CLI on PATH
//   - `deno` on PATH
//   - `~/.termdeck/secrets.env` with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY +
//     DATABASE_URL + ANTHROPIC_API_KEY populated (run `termdeck init --mnestra` first)
//   - OPENAI_API_KEY in secrets.env is OPTIONAL: when present, Rumen's Relate
//     phase uses semantic+keyword hybrid search via OpenAI text-embedding-3-large.
//     When absent, Rumen falls back to keyword-only matching.
//
// Steps:
//   1. Preflight: which supabase, which deno, read secrets.env
//   2. Derive project ref from SUPABASE_URL; confirm with user
//   3. supabase link --project-ref <ref>
//   4. Apply rumen migration 001 via pg
//   5. supabase functions deploy rumen-tick --no-verify-jwt
//   6. supabase secrets set DATABASE_URL=... ANTHROPIC_API_KEY=... [OPENAI_API_KEY=...]
//   7. Test the function with a manual POST (fetch)
//   8. Apply pg_cron schedule migration (002) with project ref substituted

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');
const {
  prompts,
  dotenv,
  supabaseUrl: urlHelper,
  migrations,
  pgRunner,
  preconditions
} = require(SETUP_DIR);

// Pinned fallback used only when the npm registry is unreachable. Bump this
// when you republish @jhizzard/rumen and can't (or won't) rely on `npm view`
// at deploy time. The wizard prefers the live registry answer — this value
// exists so a fully offline machine can still ship a working Edge Function.
const FALLBACK_RUMEN_VERSION = '0.3.4';

// Resolve the current published version of @jhizzard/rumen. Source of truth
// is the npm registry (because the Edge Function runtime pulls from there,
// not from local node_modules). On network failure we fall back to
// FALLBACK_RUMEN_VERSION and tell the user what happened — we don't silently
// deploy a bogus version.
function resolveRumenVersion() {
  const r = spawnSync('npm', ['view', '@jhizzard/rumen', 'version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  });
  if (r.status === 0) {
    const version = (r.stdout || '').trim();
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return { version, source: 'npm registry' };
    }
    return {
      version: FALLBACK_RUMEN_VERSION,
      source: 'pinned fallback',
      warning: `npm view returned unexpected output: ${JSON.stringify(version)}`
    };
  }
  const stderr = (r.stderr || '').trim();
  return {
    version: FALLBACK_RUMEN_VERSION,
    source: 'pinned fallback',
    warning: stderr
      ? `npm view failed: ${stderr.split('\n').pop()}`
      : `npm view failed (exit ${r.status === null ? 'timeout' : r.status}) — offline?`
  };
}

const HELP = [
  '',
  'TermDeck Rumen Setup',
  '',
  'Usage: termdeck init --rumen [flags]',
  '',
  'Flags:',
  '  --help            Print this message and exit',
  '  --yes             Skip the project-ref confirmation',
  '  --dry-run         Print what would run; touch nothing',
  '  --skip-schedule   Deploy the function but do not install the pg_cron schedule',
  '',
  'Requires: Supabase CLI and Deno already installed.',
  'Requires: `termdeck init --mnestra` has already run (needs secrets.env).',
  ''
].join('\n');

function parseFlags(argv) {
  const out = { help: false, yes: false, dryRun: false, skipSchedule: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-schedule') out.skipSchedule = true;
  }
  return out;
}

function printBanner() {
  process.stdout.write(`
TermDeck Rumen Setup
────────────────────

This wizard deploys Rumen as a Supabase Edge Function with a pg_cron schedule.
Requires: Supabase CLI + Deno already installed.

Press Ctrl+C at any time to cancel.

`);
}

function step(msg) { process.stdout.write(`→ ${msg}`); }
function ok(suffix = '') { process.stdout.write(` ✓${suffix ? ' ' + suffix : ''}\n`); }
function fail(err) { process.stdout.write(` ✗\n    ${err}\n`); }

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function preflight() {
  step('Checking for supabase CLI...');
  const sb = which('supabase');
  if (!sb) {
    fail('not found on PATH');
    process.stderr.write(
      '\nInstall it first:\n' +
      '  macOS:   brew install supabase/tap/supabase\n' +
      '  other:   https://supabase.com/docs/guides/local-development/cli/getting-started\n'
    );
    return null;
  }
  ok();

  step('Checking for deno...');
  const deno = which('deno');
  if (!deno) {
    fail('not found on PATH');
    process.stderr.write(
      '\nInstall it first:\n' +
      '  macOS:   brew install deno\n' +
      '  other:   https://deno.com/#installation\n'
    );
    return null;
  }
  ok();

  step('Reading Mnestra config from ~/.termdeck/secrets.env...');
  const secrets = dotenv.readSecrets();
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
  const missing = required.filter((k) => !secrets[k]);
  if (missing.length > 0) {
    fail(`missing keys: ${missing.join(', ')}`);
    process.stderr.write(
      '\nRun `termdeck init --mnestra` first — it writes the keys this wizard needs.\n'
    );
    return null;
  }
  ok();

  // Normalize DATABASE_URL for transaction-pooler usage (v0.6.6+). Users
  // whose ~/.termdeck/secrets.env was written by an earlier wizard version
  // may have a Shared Pooler URL without ?pgbouncer=true. The Edge Function
  // logs a warning when that's the case (Brad's 2026-04-26 report). Fix it
  // here in-memory before forwarding to `supabase secrets set` so the
  // Function gets a clean URL even on partial-upgrade installs. Direct
  // connections and session-mode pooler URLs are returned unchanged.
  const normalized = urlHelper.normalizeDatabaseUrl(secrets.DATABASE_URL);
  if (normalized.modified) {
    step('Detected transaction pooler URL — appending ?pgbouncer=true&connection_limit=1 for the Edge Function...');
    secrets.DATABASE_URL = normalized.url;
    ok();
  }

  // OPENAI_API_KEY is optional: when present, Rumen's Relate phase generates
  // real embeddings for semantic+keyword hybrid search. When absent, Rumen
  // falls back to keyword-only matching (still works, but loses cross-project
  // conceptual retrieval).
  if (!secrets.OPENAI_API_KEY) {
    process.stderr.write(
      '\n⚠  OPENAI_API_KEY is not set in ~/.termdeck/secrets.env.\n' +
      '   Rumen will run in keyword-only mode — for full cross-project conceptual\n' +
      '   retrieval, add OPENAI_API_KEY to secrets.env and re-run `termdeck init --rumen`.\n\n'
    );
  }

  return { supabaseBin: sb, denoBin: deno, secrets };
}

function deriveProjectRef(secrets) {
  const parsed = urlHelper.parseProjectUrl(secrets.SUPABASE_URL);
  if (!parsed.ok) {
    throw new Error(`SUPABASE_URL is not a valid Supabase project URL: ${parsed.error}`);
  }
  return parsed.projectRef;
}

// Shell out with inherited stdio so the user sees real-time supabase CLI
// output. Returns `{ ok, code }`.
function runShell(command, args, opts = {}) {
  const r = spawnSync(command, args, {
    stdio: 'inherit',
    encoding: 'utf-8',
    ...opts
  });
  return { ok: r.status === 0, code: r.status };
}

// Same but capture stdout for things we want to inspect programmatically.
function runShellCaptured(command, args, opts = {}) {
  const r = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...opts
  });
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Detect the "no access token" signature in `supabase link` stderr so the
// wizard can surface a path-aware hint instead of dumping raw CLI output at
// the user. Brad hit this on 2026-04-26 00:25 UTC on MobaXterm SSH after
// v0.6.3 unblocked init --mnestra: he had no SUPABASE_ACCESS_TOKEN env var
// and `supabase login` requires a browser, which his SSH session doesn't
// have. The actionable path on a non-desktop install is always a PAT from
// the dashboard — link() now points users straight at it.
function looksLikeMissingAccessToken(stderr) {
  if (!stderr) return false;
  return /Access token not provided/i.test(stderr) ||
    /SUPABASE_ACCESS_TOKEN environment variable/i.test(stderr);
}

function printAccessTokenHint() {
  process.stderr.write(
    '\nThe Supabase CLI needs a Personal Access Token to link your project.\n' +
    'On a desktop install you can run `supabase login`, but that opens a\n' +
    'browser, so SSH/headless users should use the env-var path instead:\n' +
    '\n' +
    '  1. Generate a token: https://supabase.com/dashboard/account/tokens\n' +
    '  2. Export it in your shell:\n' +
    '       export SUPABASE_ACCESS_TOKEN=sbp_...\n' +
    '  3. Re-run: termdeck init --rumen\n' +
    '\n' +
    'TermDeck does not store this token — it only lives in your shell\n' +
    'environment for the duration of the install.\n'
  );
}

async function link(projectRef, dryRun) {
  step(`Running: supabase link --project-ref ${projectRef}...`);
  if (dryRun) { ok('(dry-run)'); return true; }
  const r = runShellCaptured('supabase', ['link', '--project-ref', projectRef]);
  if (!r.ok) {
    fail(`supabase link failed (exit ${r.code})`);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    if (looksLikeMissingAccessToken(r.stderr)) printAccessTokenHint();
    return false;
  }
  ok();
  return true;
}

async function applyRumenTables(secrets, dryRun) {
  step('Applying rumen tables migration...');
  if (dryRun) { ok('(dry-run)'); return true; }
  const files = migrations.listRumenMigrations();
  const tableFile = files.find((f) => /001.*rumen_tables/.test(path.basename(f)));
  if (!tableFile) {
    fail('bundled 001_rumen_tables.sql is missing');
    return false;
  }
  let client;
  try {
    client = await pgRunner.connect(secrets.DATABASE_URL);
  } catch (err) {
    fail(err.message);
    return false;
  }
  try {
    const result = await pgRunner.applyFile(client, tableFile);
    if (!result.ok) { fail(result.error); return false; }
    ok(`(${result.elapsedMs}ms)`);
    return true;
  } finally {
    try { await client.end(); } catch (_err) { /* ignore */ }
  }
}

function deployFunction(rumenVersion, dryRun) {
  step('Running: supabase functions deploy rumen-tick --no-verify-jwt...');
  if (dryRun) { ok('(dry-run)'); return true; }

  // We need the supabase command to run against a repo layout with
  // `supabase/functions/rumen-tick/`. The TermDeck install does NOT include
  // a `supabase/` directory at the project root, so we stage a tiny working
  // directory under `os.tmpdir()` that mirrors what the CLI expects.
  const stage = stageRumenFunction(rumenVersion);
  if (!stage) {
    fail('could not stage rumen-tick function source');
    return false;
  }

  const r = runShell('supabase', ['functions', 'deploy', 'rumen-tick', '--no-verify-jwt'], {
    cwd: stage
  });
  if (!r.ok) { fail(`deploy failed (exit ${r.code})`); return false; }
  ok();
  return true;
}

// Create a staging directory containing:
//   <stage>/supabase/functions/rumen-tick/{index.ts, tsconfig.json}
// Also write a minimal `supabase/config.toml` so `supabase functions deploy`
// doesn't complain about a missing project root.
function stageRumenFunction(rumenVersion) {
  if (!rumenVersion || !/^\d+\.\d+\.\d+/.test(rumenVersion)) {
    throw new Error(`stageRumenFunction: invalid rumenVersion ${JSON.stringify(rumenVersion)}`);
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-rumen-stage-'));
  const functionSrc = migrations.rumenFunctionDir();
  if (!fs.existsSync(functionSrc)) return null;

  const dest = path.join(stage, 'supabase', 'functions', 'rumen-tick');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(functionSrc)) {
    const srcPath = path.join(functionSrc, f);
    const destPath = path.join(dest, f);
    // Substitute the version placeholder in the Deno entry point. Other files
    // in the directory (tsconfig.json, etc.) are copied verbatim.
    if (f === 'index.ts') {
      const raw = fs.readFileSync(srcPath, 'utf-8');
      if (!raw.includes('__RUMEN_VERSION__')) {
        throw new Error(
          `rumen-tick/index.ts is missing the __RUMEN_VERSION__ placeholder — ` +
          `has someone reintroduced a hardcoded version?`
        );
      }
      fs.writeFileSync(destPath, raw.replace(/__RUMEN_VERSION__/g, rumenVersion));
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  const configToml = `# staged by termdeck init --rumen
project_id = "termdeck-rumen-stage"

[functions.rumen-tick]
verify_jwt = false
`;
  fs.writeFileSync(path.join(stage, 'supabase', 'config.toml'), configToml);

  return stage;
}

function setFunctionSecrets(secrets, dryRun) {
  const haveOpenAI = Boolean(secrets.OPENAI_API_KEY);
  const label = haveOpenAI
    ? 'DATABASE_URL, ANTHROPIC_API_KEY, OPENAI_API_KEY'
    : 'DATABASE_URL, ANTHROPIC_API_KEY';
  step(`Setting function secrets (${label})...`);
  if (dryRun) { ok('(dry-run)'); return true; }
  const args = [
    'secrets', 'set',
    `DATABASE_URL=${secrets.DATABASE_URL}`,
    `ANTHROPIC_API_KEY=${secrets.ANTHROPIC_API_KEY}`
  ];
  if (haveOpenAI) {
    args.push(`OPENAI_API_KEY=${secrets.OPENAI_API_KEY}`);
  }
  const r = runShellCaptured('supabase', args);
  if (!r.ok) {
    fail(`secrets set failed (exit ${r.code})`);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    return false;
  }
  ok(haveOpenAI ? '(hybrid mode)' : '(keyword-only mode — OPENAI_API_KEY not set)');
  return true;
}

async function testFunction(projectRef, secrets, dryRun) {
  step('Testing function with a manual POST...');
  if (dryRun) { ok('(dry-run)'); return true; }

  const functionUrl = `https://${projectRef}.supabase.co/functions/v1/rumen-tick`;
  let response;
  try {
    response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secrets.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
  } catch (err) {
    fail(`network error: ${err.message}`);
    return false;
  }

  let body;
  try { body = await response.json(); } catch (_err) { body = {}; }

  if (response.status !== 200 || !body || body.ok !== true) {
    fail(`function returned ${response.status} — ${JSON.stringify(body).slice(0, 200)}`);
    process.stderr.write(
      '\nCheck the function logs in the Supabase dashboard: ' +
      `https://supabase.com/dashboard/project/${projectRef}/functions/rumen-tick\n`
    );
    return false;
  }

  const summary = body.summary || {};
  ok(`(job_id: ${summary.job_id || '?'}, extracted: ${summary.extracted ?? '?'}, surfaced: ${summary.insights_generated ?? summary.surfaced ?? '?'})`);
  return true;
}

async function applySchedule(projectRef, secrets, dryRun) {
  step('Applying pg_cron schedule (every 15 minutes)...');
  if (dryRun) { ok('(dry-run)'); return true; }

  const files = migrations.listRumenMigrations();
  const scheduleFile = files.find((f) => /002.*pg_cron/.test(path.basename(f)));
  if (!scheduleFile) { fail('bundled 002_pg_cron_schedule.sql is missing'); return false; }

  const raw = migrations.readFile(scheduleFile);
  // Substitute the project ref into the schedule body. The bundled migration
  // ships with the placeholder `<project-ref>` per Rumen's deploy docs; we
  // also accept `{{PROJECT_REF}}` for robustness.
  const substituted = raw
    .replace(/<project-ref>/g, projectRef)
    .replace(/\{\{PROJECT_REF\}\}/g, projectRef);

  // The shipped migration uses Supabase Vault (`vault.decrypted_secrets`) to
  // pull the service-role key. If the user hasn't stored the key in Vault the
  // cron call will fail. We leave that as a post-install step and print a
  // reminder below.

  let client;
  try {
    client = await pgRunner.connect(secrets.DATABASE_URL);
  } catch (err) {
    fail(err.message);
    return false;
  }
  try {
    // Run the substituted SQL directly rather than applying the original file.
    try {
      await pgRunner.run(client, substituted);
      ok();
      return true;
    } catch (err) {
      fail(err.message);
      process.stderr.write(
        '\nThe schedule SQL failed — the most common cause is that pg_cron or pg_net\n' +
        'is not enabled in the Supabase project. Enable them in Dashboard → Database\n' +
        '→ Extensions, then re-run `termdeck init --rumen --skip-schedule=false`.\n'
      );
      return false;
    }
  } finally {
    try { await client.end(); } catch (_err) { /* ignore */ }
  }
}

// Backfill SUPABASE_ACCESS_TOKEN into ~/.claude/mcp.json's Supabase MCP
// server entry. Background: the meta-installer (`@jhizzard/termdeck-stack`)
// writes `SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE'` as a literal
// placeholder when it wires the Supabase MCP entry. The user is expected
// to replace it after install. v0.6.4 unblocked the Rumen install path by
// telling users to `export SUPABASE_ACCESS_TOKEN=sbp_...` in their shell —
// but that token only got used for `supabase link`, never propagated into
// `~/.claude/mcp.json`. So Brad's Claude Code was talking to a Supabase
// MCP server with a placeholder token. He had to update the JSON file
// manually. Reported 2026-04-26 — Brad's quote: "the token hadn't been
// written to the Json file which we updated manually, but you may want
// to put that in the patch at some point."
//
// This helper closes the loop. Idempotent and conservative:
//   - Only runs if process.env.SUPABASE_ACCESS_TOKEN is set
//   - Only updates when the existing value is the literal placeholder
//     'SUPABASE_PAT_HERE' — preserves any real token the user already set
//   - No-op when ~/.claude/mcp.json doesn't exist (user never ran the
//     meta-installer's Tier 4) or when there's no `supabase` MCP entry
//   - No-op (with a soft warning) when the JSON is malformed
//   - Atomic write via tmp-and-rename; mode 0600 to match the file's
//     existing permissions (it already holds the placeholder)
//   - All other mcpServers entries preserved verbatim
//
// Returns one of: { status: 'updated', path }, { status: 'already-set', path },
//   { status: 'no-file' }, { status: 'no-supabase-entry', path },
//   { status: 'no-token-in-env' }, { status: 'malformed', path, error }.
function wireAccessTokenInMcpJson({ token, mcpJsonPath, _testFs } = {}) {
  const fsImpl = _testFs || fs;
  const tokenValue = token || process.env.SUPABASE_ACCESS_TOKEN;
  if (!tokenValue) return { status: 'no-token-in-env' };

  const targetPath = mcpJsonPath || path.join(os.homedir(), '.claude', 'mcp.json');
  if (!fsImpl.existsSync(targetPath)) return { status: 'no-file' };

  let raw;
  try {
    raw = fsImpl.readFileSync(targetPath, 'utf-8');
  } catch (err) {
    return { status: 'malformed', path: targetPath, error: err.message };
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return { status: 'malformed', path: targetPath, error: err.message };
  }

  const supabaseEntry = cfg && cfg.mcpServers && cfg.mcpServers.supabase;
  if (!supabaseEntry || typeof supabaseEntry !== 'object') {
    return { status: 'no-supabase-entry', path: targetPath };
  }

  supabaseEntry.env = supabaseEntry.env || {};
  const current = supabaseEntry.env.SUPABASE_ACCESS_TOKEN;
  if (current === tokenValue) return { status: 'already-set', path: targetPath };
  if (current && current !== 'SUPABASE_PAT_HERE') {
    // User has set a real token already — don't touch it.
    return { status: 'already-set', path: targetPath };
  }

  supabaseEntry.env.SUPABASE_ACCESS_TOKEN = tokenValue;

  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  fsImpl.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fsImpl.renameSync(tmpPath, targetPath);
  try { fsImpl.chmodSync(targetPath, 0o600); } catch (_e) { /* best-effort */ }

  return { status: 'updated', path: targetPath };
}

function printNextSteps(projectRef) {
  const functionUrl = `https://${projectRef}.supabase.co/functions/v1/rumen-tick`;
  const now = new Date();
  // Round up to the next 15-minute mark so the hint is accurate.
  const next = new Date(now.getTime());
  next.setUTCMinutes(Math.ceil((now.getUTCMinutes() + 1) / 15) * 15, 0, 0);
  process.stdout.write(`
Rumen is deployed.

Schedule: every 15 minutes via pg_cron
First scheduled run: ${next.toISOString().replace(/\.\d+Z$/, 'Z')}
Edge Function URL: ${functionUrl}

Next steps:
  1. Monitor:  psql "$DATABASE_URL" -c "SELECT * FROM rumen_jobs ORDER BY started_at DESC LIMIT 5"
  2. Store the service_role key in Supabase Vault as \`rumen_service_role_key\`
     so the cron call in migrations/002_pg_cron_schedule.sql can authenticate.
  3. Rumen insights flow back into Mnestra's memory_items via rumen_insights.
  4. TermDeck's Flashback will surface cross-project patterns automatically.
`);
}

async function main(argv) {
  const flags = parseFlags(argv || []);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  printBanner();

  const pf = preflight();
  if (!pf) return 2;
  const { secrets } = pf;

  let projectRef;
  try {
    projectRef = deriveProjectRef(secrets);
    process.stdout.write(`→ Deriving project ref from SUPABASE_URL... ✓ ${projectRef}\n`);
  } catch (err) {
    process.stderr.write(`\n[init --rumen] ${err.message}\n`);
    return 3;
  }

  if (!flags.yes) {
    const go = await prompts.confirm(`? Proceed with deploy to project ${projectRef}?`);
    if (!go) {
      process.stdout.write('Cancelled.\n');
      return 0;
    }
  }

  // v0.6.9: front-loaded precondition audit. Runs BEFORE link so we don't
  // create state (function deploy, function secrets, schedule SQL) that the
  // user would have to manually clean up if a precondition is missing. Every
  // gap is reported in one pass with actionable hints. The audit class — env
  // tokens, pg extensions, Vault secret — covers the v0.6.4 / v0.6.6 / v0.6.7
  // / v0.6.9-equivalent failure modes that previously surfaced one-per-patch.
  if (!flags.dryRun) {
    const audit = await preconditions.auditRumenPreconditions({ secrets, env: process.env });
    preconditions.printAuditReport(audit, 'rumen');
    if (!audit.ok) return 10;
  }

  if (!(await link(projectRef, flags.dryRun))) return 4;

  // Backfill SUPABASE_ACCESS_TOKEN into ~/.claude/mcp.json now that
  // `supabase link` succeeded (the token is verified-real). The
  // meta-installer wrote a literal 'SUPABASE_PAT_HERE' placeholder
  // there during Tier 4 install — this closes that loop.
  if (!flags.dryRun) {
    const r = wireAccessTokenInMcpJson();
    if (r.status === 'updated') {
      step('Backfilled SUPABASE_ACCESS_TOKEN into ~/.claude/mcp.json...');
      ok();
    } else if (r.status === 'malformed') {
      process.stderr.write(
        `\n  ! ${r.path} is not valid JSON — skipping token backfill (${r.error}).\n` +
        `    Update the supabase mcpServers entry manually if Claude Code's Supabase MCP is misbehaving.\n\n`
      );
    }
    // Other statuses (no-file, no-supabase-entry, no-token-in-env,
    // already-set) are silent — they're all expected paths.
  }

  if (!(await applyRumenTables(secrets, flags.dryRun))) return 5;

  step('Resolving @jhizzard/rumen version from npm registry...');
  const resolved = resolveRumenVersion();
  ok();
  process.stdout.write(`→ Using rumen version: ${resolved.version} (from ${resolved.source})\n`);
  if (resolved.warning) {
    process.stderr.write(`  ! ${resolved.warning}\n`);
    process.stderr.write(`  ! falling back to pinned FALLBACK_RUMEN_VERSION=${FALLBACK_RUMEN_VERSION}\n`);
  }

  if (!deployFunction(resolved.version, flags.dryRun)) return 6;
  if (!setFunctionSecrets(secrets, flags.dryRun)) return 7;
  if (!(await testFunction(projectRef, secrets, flags.dryRun))) return 8;
  if (!flags.skipSchedule) {
    if (!(await applySchedule(projectRef, secrets, flags.dryRun))) return 9;
    // v0.6.9: post-write outcome verification. Confirms cron.job has the
    // active rumen-tick row. Doesn't poll for the first 15-min tick — that's
    // too long for an interactive wizard — but tells the user the exact
    // query to run after waiting if they want firing-confirmation.
    if (!flags.dryRun) {
      const verify = await preconditions.verifyRumenOutcomes({ secrets });
      preconditions.printVerifyReport(verify, 'rumen');
      if (!verify.ok) return 11;
    }
  } else {
    process.stdout.write('→ Skipping pg_cron schedule (per --skip-schedule) ✓\n');
  }

  printNextSteps(projectRef);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      process.stderr.write(`\n[init --rumen] unexpected error: ${err && err.stack || err}\n`);
      process.exit(1);
    });
}

module.exports = main;
// Test surface — kept on the same export object so the regression suite can
// pin the access-token detection without spawning a real `supabase` binary.
module.exports._looksLikeMissingAccessToken = looksLikeMissingAccessToken;
module.exports._wireAccessTokenInMcpJson = wireAccessTokenInMcpJson;

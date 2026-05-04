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
//   5. supabase functions deploy rumen-tick AND graph-inference (Sprint 43 T3)
//      from a single staging dir with multi-function supabase/config.toml
//   6. supabase secrets set, ONE call per key (DATABASE_URL, ANTHROPIC_API_KEY,
//      [OPENAI_API_KEY], [GRAPH_LLM_CLASSIFY=1]) — per-secret to avoid the
//      v2.90.0 multi-arg drop documented in INSTALLER-PITFALLS.md Class J.
//   7. Test rumen-tick with a manual POST (graph-inference is cron-only)
//   8. Apply pg_cron schedule migrations 002 (rumen-tick) AND 003 (graph-inference)
//      with project ref substituted

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
  migrationTemplating,
  pgRunner,
  preconditions,
  auditUpgrade: auditUpgradeMod
} = require(SETUP_DIR);

const {
  CLAUDE_MCP_PATH_CANONICAL,
  readMcpServers,
  writeMcpServers,
} = require('./mcp-config');

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

// Sprint 51.5 T1 — schema-introspection audit-upgrade. Probes for missing
// mnestra schema artifacts AND missing rumen cron schedules. Runs before
// the existing init-rumen flow so the user sees what's about to be applied
// up front. Idempotent: a re-run on an up-to-date project reports
// "install up to date" and applies nothing.
//
// Brad's 2026-05-02 jizzard-brain report (INSTALLER-PITFALLS.md ledger #13)
// is the originating motivation: he upgraded npm packages but his database
// stayed frozen at first-kickstart because no installer code path diffed an
// existing install against the bundled migration set. After v1.0.1 ships,
// `npm install -g @jhizzard/termdeck@1.0.1 && termdeck init --rumen` will
// surface and apply every missing artifact in one pass.
//
// Errors are surfaced inline but do NOT abort the wizard — a single
// failing probe (e.g., pg_cron not enabled when probing for cron.job)
// shouldn't block the rest of the audit or the rest of the init flow.
async function runRumenAudit(projectRef, secrets, dryRun) {
  step('Audit-upgrade: probing for missing schema + cron artifacts...');
  if (dryRun) { ok('(dry-run)'); return true; }
  let client;
  try {
    client = await pgRunner.connect(secrets.DATABASE_URL);
  } catch (err) {
    fail(err.message);
    return false;
  }
  try {
    const result = await auditUpgradeMod.auditUpgrade({
      pgClient: client,
      projectRef
    });
    if (result.applied.length === 0 && result.errors.length === 0 && result.skipped.length === 0) {
      ok(`(install up to date — ${result.probed.length} probes all present)`);
      return true;
    }
    ok(`(probed ${result.probed.length}, applied ${result.applied.length}, skipped ${result.skipped.length})`);
    for (const name of result.applied) {
      process.stdout.write(`    ✓ applied ${name}\n`);
    }
    // Sprint 51.6 T3 — Bug D: surface skipped[] entries (functionSource
    // probes that detected drift but can't auto-redeploy from audit). The
    // wizard will redeploy below in the deployFunctions step, which fixes
    // the drift; this print just makes the diagnosis visible.
    for (const s of result.skipped) {
      process.stdout.write(`    ⊘ skipped ${s.name}: ${s.reason}\n`);
    }
    for (const e of result.errors) {
      process.stdout.write(`    ! ${e.name}: ${e.error}\n`);
    }
    return true;
  } catch (err) {
    fail(err.message);
    return true; // non-blocking
  } finally {
    try { await client.end(); } catch (_err) { /* ignore */ }
  }
}

// Sprint 43 T3: rumen-tick is the only function with a `__RUMEN_VERSION__`
// placeholder (its `npm:@jhizzard/rumen@<ver>` import is rewritten at deploy
// time). graph-inference pins its own deps (`npm:postgres@3.4.4`) and is
// copied verbatim. If a future function adds a placeholder, list it here.
const FUNCTIONS_WITH_VERSION_PLACEHOLDER = new Set(['rumen-tick']);

// Sprint 51.6 T3 — `projectRef` is required and passed explicitly to every
// `supabase functions deploy` invocation as `--project-ref <ref>`. Brad's
// 2026-05-03 jizzard-brain install hit Bug C: `supabase link --project-ref`
// runs successfully (audit-upgrade probes confirm the link is live), but a
// few subprocess calls later `supabase functions deploy` errors with
// `Cannot find project ref. Have you run supabase link?` because the link
// state persists per-cwd in supabase/config.toml and the staged-functions
// directory has none. Threading --project-ref through dodges link-state
// coupling entirely. The flag is supported by supabase CLI v1.x and v2.x.
function deployFunctions(rumenVersion, projectRef, dryRun) {
  if (!projectRef || typeof projectRef !== 'string') {
    fail('deployFunctions: projectRef is required (Sprint 51.6 T3 — explicit --project-ref to dodge subprocess link-state isolation)');
    return false;
  }
  const fnNames = migrations.listRumenFunctions();
  if (fnNames.length === 0) {
    fail('no Rumen Edge Function source found in bundled setup or @jhizzard/rumen package');
    return false;
  }

  step(`Staging ${fnNames.length} Edge Function(s) (${fnNames.join(', ')})...`);
  if (dryRun) { ok('(dry-run)'); return true; }

  // Stage all functions in one directory and one config.toml so a single
  // `supabase functions deploy <name>` invocation per function can share the
  // project root. This mirrors how a real Supabase repo is laid out.
  let stage;
  try {
    stage = stageRumenFunctions(rumenVersion);
  } catch (err) {
    fail(err.message);
    return false;
  }
  if (!stage) {
    fail('could not stage Rumen Edge Function source');
    return false;
  }
  ok();

  for (const name of fnNames) {
    // Sprint 51.6 T3 — `--project-ref <ref>` explicit, dodging supabase
    // link-state subprocess isolation (Bug C, Brad's 2026-05-03 install).
    step(`Running: supabase functions deploy ${name} --project-ref ${projectRef} --no-verify-jwt...`);
    const r = runShell('supabase', [
      'functions', 'deploy', name,
      '--project-ref', projectRef,
      '--no-verify-jwt',
    ], { cwd: stage });
    if (!r.ok) {
      fail(`deploy of ${name} failed (exit ${r.code})`);
      return false;
    }
    ok();
  }
  return true;
}

// Create a staging directory containing every bundled Rumen Edge Function:
//   <stage>/supabase/functions/<name>/{index.ts, tsconfig.json}
//   <stage>/supabase/config.toml  (one [functions.<name>] block per function)
//
// `__RUMEN_VERSION__` is substituted only in functions listed in
// FUNCTIONS_WITH_VERSION_PLACEHOLDER (currently just rumen-tick). Other
// files are copied verbatim. Returns the staging dir path or null if no
// function source could be located.
function stageRumenFunctions(rumenVersion) {
  if (!rumenVersion || !/^\d+\.\d+\.\d+/.test(rumenVersion)) {
    throw new Error(`stageRumenFunctions: invalid rumenVersion ${JSON.stringify(rumenVersion)}`);
  }
  const root = migrations.rumenFunctionsRoot();
  const fnNames = migrations.listRumenFunctions();
  if (fnNames.length === 0) return null;

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-rumen-stage-'));

  for (const name of fnNames) {
    const fnSrc = path.join(root, name);
    const fnDest = path.join(stage, 'supabase', 'functions', name);
    fs.mkdirSync(fnDest, { recursive: true });
    for (const f of fs.readdirSync(fnSrc)) {
      const srcPath = path.join(fnSrc, f);
      const destPath = path.join(fnDest, f);
      if (f === 'index.ts' && FUNCTIONS_WITH_VERSION_PLACEHOLDER.has(name)) {
        const raw = fs.readFileSync(srcPath, 'utf-8');
        if (!raw.includes('__RUMEN_VERSION__')) {
          throw new Error(
            `${name}/index.ts is missing the __RUMEN_VERSION__ placeholder — ` +
            `has someone reintroduced a hardcoded version? ` +
            `Re-run scripts/sync-rumen-functions.sh to repopulate the placeholder.`
          );
        }
        fs.writeFileSync(destPath, raw.replace(/__RUMEN_VERSION__/g, rumenVersion));
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  const fnBlocks = fnNames.map((name) => `[functions.${name}]\nverify_jwt = false\n`).join('\n');
  const configToml = `# staged by termdeck init --rumen
project_id = "termdeck-rumen-stage"

${fnBlocks}`;
  fs.writeFileSync(path.join(stage, 'supabase', 'config.toml'), configToml);

  return stage;
}

// Sprint 51.5 T3: per-secret CLI loop. Pre-Sprint-51.5 this issued a single
// `supabase secrets set KEY1=VAL1 KEY2=VAL2 ...` call with all keys as
// positional args. Brad's 2026-05-03 4-project install pass observed
// supabase CLI v2.90.0 silently dropping some args from a multi-arg call —
// even materializing stray entries from misparsed argv (his email landed as
// a secret name). Documented as INSTALLER-PITFALLS.md Class J. The
// deterministic fix is one CLI invocation per secret, exit code checked per
// call, stderr surfaced with the failing key name. Order is preserved for
// log readability (DATABASE_URL → ANTHROPIC_API_KEY → optional → optional).
function setFunctionSecrets(secrets, dryRun, opts = {}) {
  const orderedKeys = ['DATABASE_URL', 'ANTHROPIC_API_KEY'];
  if (secrets.OPENAI_API_KEY) orderedKeys.push('OPENAI_API_KEY');
  if (secrets.GRAPH_LLM_CLASSIFY === '1') orderedKeys.push('GRAPH_LLM_CLASSIFY');

  const haveOpenAI = Boolean(secrets.OPENAI_API_KEY);
  step(`Setting function secrets per-call (${orderedKeys.join(', ')})...`);
  if (dryRun) { ok('(dry-run)'); return true; }

  // Test surface: opts.runner is an optional injected function that mimics
  // runShellCaptured((bin, args) => { ok, code, stdout, stderr }). Production
  // path passes nothing and shells out to the real supabase CLI.
  const runner = (typeof opts.runner === 'function') ? opts.runner : runShellCaptured;

  for (const key of orderedKeys) {
    const value = secrets[key];
    if (value === undefined || value === null || value === '') {
      fail(`secret ${key} missing from in-memory secrets map — wizard wiring bug`);
      return false;
    }
    const r = runner('supabase', ['secrets', 'set', `${key}=${value}`]);
    if (!r || !r.ok) {
      fail(`supabase secrets set ${key} failed (exit ${r ? r.code : 'no-result'})`);
      if (r && r.stderr) process.stderr.write(r.stderr + '\n');
      return false;
    }
  }
  const llmTag = secrets.GRAPH_LLM_CLASSIFY === '1' ? ', graph LLM classify on' : '';
  ok(`${haveOpenAI ? '(hybrid mode' : '(keyword-only mode — OPENAI_API_KEY not set'}${llmTag})`);
  return true;
}

// Sprint 51.5 T3: Build a Supabase SQL-Editor deeplink that pre-fills the
// vault.create_secret() call for one secret. Used as the fallback when
// auto-apply via pgRunner can't write to vault.secrets (permission denied,
// missing extension, etc.) AND as the manual-fix surface in any wizard text
// that previously instructed users to "click Vault in the dashboard" — the
// Vault dashboard panel was quietly removed/relocated in current Supabase
// UIs (Brad 2026-05-03 takeaway #2; INSTALLER-PITFALLS.md Class B).
//
// vault.create_secret signature is `(secret text, name text [, description text])`
// — value-then-name. Both arguments are escaped as Postgres string literals
// (single-quote doubling). The full URL is roughly:
//   https://supabase.com/dashboard/project/<ref>/sql/new?content=<encoded SQL>
// Click → SQL Editor opens with the call pre-filled → user clicks Run.
function vaultSqlEditorUrl(projectRef, secretName, secretValue) {
  if (!projectRef || typeof projectRef !== 'string') {
    throw new Error('vaultSqlEditorUrl: projectRef is required');
  }
  const value = String(secretValue == null ? '' : secretValue).replace(/'/g, "''");
  const name = String(secretName == null ? '' : secretName).replace(/'/g, "''");
  const sql = `select vault.create_secret('${value}', '${name}');`;
  return `https://supabase.com/dashboard/project/${projectRef}/sql/new?content=${encodeURIComponent(sql)}`;
}

// Sprint 51.5 T3: Ensure the two Vault secrets the cron schedules need are
// present, auto-creating them via the user's pg connection when possible.
//
// Required:
//   - rumen_service_role_key            (used by 002_pg_cron_schedule.sql)
//   - graph_inference_service_role_key  (used by 003_graph_inference_schedule.sql)
//
// Both keys hold the same value (`secrets.SUPABASE_SERVICE_ROLE_KEY`). Brad's
// 2026-05-02 recovery on jizzard-brain literally cloned rumen → graph_inference
// in vault.
//
// Strategy:
//   1. Open a pg connection to DATABASE_URL (same path as applyRumenTables).
//   2. Probe vault.secrets for both names. (Reads vault.secrets, NOT
//      vault.decrypted_secrets — we don't need the decrypted value, just
//      presence.)
//   3. For any missing name, call `vault.create_secret($value, $name)`.
//   4. On per-secret failure (permission denied, etc.), surface a SQL-Editor
//      deeplink the user can click; do not fail the wizard hard — the
//      preconditions audit will catch a still-missing rumen_service_role_key
//      with its own hint, and the user has the actionable URL in front of
//      them either way.
//
// Returns `{ ok, created: [...], deeplinks: [{ name, url, error }] }`.
async function ensureVaultSecrets({ projectRef, secrets, dryRun, _pgClient }) {
  const required = [
    { name: 'rumen_service_role_key', value: secrets.SUPABASE_SERVICE_ROLE_KEY },
    { name: 'graph_inference_service_role_key', value: secrets.SUPABASE_SERVICE_ROLE_KEY }
  ];

  step('Ensuring Vault secrets (rumen_service_role_key, graph_inference_service_role_key)...');
  if (dryRun) { ok('(dry-run)'); return { ok: true, created: [], deeplinks: [] }; }

  if (!secrets.SUPABASE_SERVICE_ROLE_KEY) {
    fail('SUPABASE_SERVICE_ROLE_KEY missing from in-memory secrets — preflight should have rejected');
    return { ok: false, created: [], deeplinks: [], error: 'service-role-key-missing' };
  }

  let client = _pgClient;
  let ownsClient = false;
  if (!client) {
    try {
      client = await pgRunner.connect(secrets.DATABASE_URL);
      ownsClient = true;
    } catch (err) {
      fail(err.message);
      return { ok: false, created: [], deeplinks: [], error: 'pg-connect-failed' };
    }
  }

  let existing = new Set();
  try {
    const probe = await client.query(
      'SELECT name FROM vault.secrets WHERE name = ANY($1::text[])',
      [required.map((x) => x.name)]
    );
    existing = new Set((probe.rows || []).map((r) => r.name));
  } catch (err) {
    fail(`vault.secrets probe failed: ${err.message}`);
    if (ownsClient) { try { await client.end(); } catch (_e) { /* ignore */ } }
    // Emit deeplinks for both — user can click through manually.
    const deeplinks = required.map(({ name, value }) => ({
      name,
      url: vaultSqlEditorUrl(projectRef, name, value),
      error: err.message
    }));
    printVaultDeeplinks(deeplinks);
    return { ok: false, created: [], deeplinks, error: 'vault-probe-failed' };
  }

  const missing = required.filter((x) => !existing.has(x.name));
  if (missing.length === 0) {
    if (ownsClient) { try { await client.end(); } catch (_e) { /* ignore */ } }
    ok('(both already present)');
    return { ok: true, created: [], deeplinks: [] };
  }

  const created = [];
  const deeplinks = [];
  for (const { name, value } of missing) {
    try {
      await client.query('SELECT vault.create_secret($1, $2)', [value, name]);
      created.push(name);
    } catch (err) {
      deeplinks.push({
        name,
        url: vaultSqlEditorUrl(projectRef, name, value),
        error: err && err.message ? err.message : String(err)
      });
    }
  }
  if (ownsClient) { try { await client.end(); } catch (_e) { /* ignore */ } }

  if (deeplinks.length > 0) {
    fail(`auto-created ${created.length} of ${missing.length}; ${deeplinks.length} need a manual SQL Editor click`);
    printVaultDeeplinks(deeplinks);
    return { ok: false, created, deeplinks };
  }

  ok(`(created ${created.length}: ${created.map((n) => n).join(', ')})`);
  return { ok: true, created, deeplinks: [] };
}

function printVaultDeeplinks(deeplinks) {
  process.stderr.write(
    '\nThe Supabase Vault dashboard panel has been removed in current Supabase UIs.\n' +
    'Open each link below and click Run in SQL Editor to create the secret:\n\n'
  );
  for (const d of deeplinks) {
    process.stderr.write(`  ${d.name}\n    ${d.url}\n`);
    if (d.error) process.stderr.write(`    (auto-apply error: ${d.error})\n`);
    process.stderr.write('\n');
  }
}

// Sprint 51.5 T3: Install-time prompt for the GRAPH_LLM_CLASSIFY toggle.
//
// graph-inference (the daily cron Edge Function) defaults every new edge to
// `relates_to` unless GRAPH_LLM_CLASSIFY=1 AND ANTHROPIC_API_KEY are set as
// Edge Function secrets. Pre-Sprint-51.5, no install path covered this — the
// wizard set ANTHROPIC_API_KEY (already required) but never set
// GRAPH_LLM_CLASSIFY, leaving the LLM classifier off by default. This is
// INSTALLER-PITFALLS.md Class F (default-vs-runtime asymmetry — Joshua may
// or may not have set the flag manually; new installs definitely don't).
//
// Side-effect: mutates `secrets.GRAPH_LLM_CLASSIFY` to '1' on Y-path. The
// per-secret loop in setFunctionSecrets reads that key and pushes it into
// the supabase secrets set sequence. On N-path the key is left undefined
// and the loop skips it; the wizard prints the manual flip command so the
// user can opt in later without re-running the whole wizard.
//
// --yes accepts the default (Y). --dry-run reports the plan and assumes Y.
async function promptGraphLlmClassify({ secrets, flags }) {
  const explainer =
    '\nGraph edge classification\n' +
    '─────────────────────────\n' +
    'When enabled, the daily graph-inference cron uses Claude Haiku 4.5 to label\n' +
    'each new edge with a relationship type (supersedes, contradicts, elaborates,\n' +
    'caused_by, blocks, inspired_by, cross_project_link, relates_to).\n' +
    '\n' +
    'Cost: ~$0.003 per 1k edges classified (a typical project sees a few hundred\n' +
    'new edges per day). Disabled = every edge is typed "relates_to".\n\n';

  if (flags.dryRun) {
    process.stdout.write(explainer);
    process.stdout.write('? Enable AI-classified graph edges? [Y/n] (dry-run, defaulting Y)\n');
    secrets.GRAPH_LLM_CLASSIFY = '1';
    return { enabled: true, source: 'dry-run' };
  }
  if (flags.yes) {
    process.stdout.write(explainer);
    process.stdout.write('? Enable AI-classified graph edges? [Y/n] (--yes, defaulting Y)\n');
    secrets.GRAPH_LLM_CLASSIFY = '1';
    return { enabled: true, source: '--yes' };
  }

  process.stdout.write(explainer);
  const yes = await prompts.confirm('? Enable AI-classified graph edges?', { defaultYes: true });
  if (yes) {
    secrets.GRAPH_LLM_CLASSIFY = '1';
    process.stdout.write('  → Will set GRAPH_LLM_CLASSIFY=1 + ANTHROPIC_API_KEY in Edge Function secrets.\n\n');
    return { enabled: true, source: 'prompt' };
  }
  process.stdout.write(
    '  → GRAPH_LLM_CLASSIFY left unset. Edges will default to "relates_to".\n' +
    '    To enable later: supabase secrets set GRAPH_LLM_CLASSIFY=1\n\n'
  );
  return { enabled: false, source: 'prompt' };
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

// Sprint 42 T3: bundle of cron-schedule migrations whose `<project-ref>`
// placeholder must be substituted at apply-time. Both are idempotent
// (cron.unschedule + cron.schedule), so applying in sequence is safe even
// when one was already installed. Pre-Sprint 42, only 002 was applied —
// migration 003 (graph-inference-tick) shipped bundled but unsubstituted
// and unscheduled, which is part of why Sprint 38 close-out left the
// graph-inference cron disabled.
const SCHEDULE_MIGRATIONS = [
  { matcher: /002.*pg_cron/, label: '002_pg_cron_schedule (rumen-tick)' },
  { matcher: /003.*graph_inference/, label: '003_graph_inference_schedule (graph-inference-tick)' }
];

async function applySchedule(projectRef, secrets, dryRun) {
  step('Applying pg_cron schedules (rumen-tick + graph-inference-tick)...');
  if (dryRun) { ok('(dry-run)'); return true; }

  const files = migrations.listRumenMigrations();
  const planned = [];
  for (const { matcher, label } of SCHEDULE_MIGRATIONS) {
    const file = files.find((f) => matcher.test(path.basename(f)));
    if (!file) { fail(`bundled ${label} is missing`); return false; }
    planned.push({ file, label });
  }

  // Substitute the project ref into each schedule body. Both bundled
  // migrations ship with the `<project-ref>` placeholder per Rumen's
  // deploy docs; the helper also accepts `{{PROJECT_REF}}` for robustness
  // and refuses to ship an unsubstituted placeholder to the database.
  const substituted = [];
  try {
    for (const { file, label } of planned) {
      const raw = migrations.readFile(file);
      substituted.push({
        sql: migrationTemplating.applyTemplating(raw, { projectRef }),
        label
      });
    }
  } catch (err) {
    fail(err.message);
    return false;
  }

  // The shipped migrations use Supabase Vault (`vault.decrypted_secrets`)
  // to pull the service-role keys (`rumen_service_role_key` for 002 and
  // `graph_inference_service_role_key` for 003). If a key isn't stored in
  // Vault the corresponding cron call will fail at runtime. We leave that
  // as a post-install step and print a reminder below.

  let client;
  try {
    client = await pgRunner.connect(secrets.DATABASE_URL);
  } catch (err) {
    fail(err.message);
    return false;
  }
  try {
    for (const { sql, label } of substituted) {
      try {
        await pgRunner.run(client, sql);
      } catch (err) {
        fail(`${label}: ${err.message}`);
        process.stderr.write(
          '\nThe schedule SQL failed — the most common cause is that pg_cron or pg_net\n' +
          'is not enabled in the Supabase project. Enable them in Dashboard → Database\n' +
          '→ Extensions, then re-run `termdeck init --rumen --skip-schedule=false`.\n'
        );
        return false;
      }
    }
    ok();
    return true;
  } finally {
    try { await client.end(); } catch (_err) { /* ignore */ }
  }
}

// Backfill SUPABASE_ACCESS_TOKEN into ~/.claude.json's Supabase MCP
// server entry. Background: the meta-installer (`@jhizzard/termdeck-stack`)
// writes `SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE'` as a literal
// placeholder when it wires the Supabase MCP entry. The user is expected
// to replace it after install. v0.6.4 unblocked the Rumen install path by
// telling users to `export SUPABASE_ACCESS_TOKEN=sbp_...` in their shell —
// but that token only got used for `supabase link`, never propagated into
// the MCP config. So Brad's Claude Code was talking to a Supabase MCP
// server with a placeholder token. Reported 2026-04-26.
//
// Sprint 36 T2: default target moved from ~/.claude/mcp.json (legacy) to
// ~/.claude.json (canonical — what Claude Code v2.1.119+ actually reads).
// Internal write goes through writeMcpServers so the ~55 unrelated
// top-level keys Claude Code stores in ~/.claude.json (oauthAccount,
// projects, installMethod, …) are preserved byte-equivalent.
//
// Idempotent and conservative:
//   - Only runs if a token is provided via env or arg
//   - Only updates when the existing value is the literal placeholder
//     'SUPABASE_PAT_HERE' — preserves any real token the user already set
//   - No-op when the file doesn't exist or has no `supabase` entry
//   - No-op (with a soft warning) when the JSON is malformed
//   - Atomic write via tmp-and-rename; mode 0600
//   - All other mcpServers entries preserved verbatim
//
// Returns one of: { status: 'updated', path }, { status: 'already-set', path },
//   { status: 'no-file' }, { status: 'no-supabase-entry', path },
//   { status: 'no-token-in-env' }, { status: 'malformed', path, error }.
function wireAccessTokenInMcpJson({ token, mcpJsonPath, _testFs } = {}) {
  const fsImpl = _testFs || fs;
  const tokenValue = token || process.env.SUPABASE_ACCESS_TOKEN;
  if (!tokenValue) return { status: 'no-token-in-env' };

  const targetPath = mcpJsonPath || CLAUDE_MCP_PATH_CANONICAL;
  if (!fsImpl.existsSync(targetPath)) return { status: 'no-file' };

  const read = readMcpServers(targetPath);
  if (read.malformed) {
    return { status: 'malformed', path: targetPath, error: read.error };
  }

  const supabaseEntry = read.servers && read.servers.supabase;
  if (!supabaseEntry || typeof supabaseEntry !== 'object') {
    return { status: 'no-supabase-entry', path: targetPath };
  }

  supabaseEntry.env = supabaseEntry.env || {};
  const current = supabaseEntry.env.SUPABASE_ACCESS_TOKEN;
  if (current === tokenValue) return { status: 'already-set', path: targetPath };
  if (current && current !== 'SUPABASE_PAT_HERE') {
    return { status: 'already-set', path: targetPath };
  }

  supabaseEntry.env.SUPABASE_ACCESS_TOKEN = tokenValue;

  // writeMcpServers re-reads `targetPath` to preserve every top-level key
  // (oauthAccount, projects, installMethod, …) that Claude Code owns. Only
  // .mcpServers gets replaced with our mutated map.
  writeMcpServers(targetPath, read.servers);

  return { status: 'updated', path: targetPath };
}

function printNextSteps(projectRef, vaultResult, llmResult) {
  const rumenTickUrl = `https://${projectRef}.supabase.co/functions/v1/rumen-tick`;
  const graphInferenceUrl = `https://${projectRef}.supabase.co/functions/v1/graph-inference`;
  const now = new Date();
  // Round up to the next 15-minute mark so the hint is accurate.
  const next = new Date(now.getTime());
  next.setUTCMinutes(Math.ceil((now.getUTCMinutes() + 1) / 15) * 15, 0, 0);

  const vaultLine = (vaultResult && vaultResult.ok)
    ? '  Vault secrets: rumen_service_role_key + graph_inference_service_role_key in place.'
    : '  Vault secrets: open the SQL Editor URLs above and click Run for any deeplinks shown.';

  const llmLine = llmResult && llmResult.enabled
    ? '  Graph edges: classified by Claude Haiku 4.5 (GRAPH_LLM_CLASSIFY=1).'
    : '  Graph edges: untyped (relates_to). To enable: supabase secrets set GRAPH_LLM_CLASSIFY=1';

  process.stdout.write(`
Rumen is deployed.

Edge Functions:
  rumen-tick        every 15 min — first run: ${next.toISOString().replace(/\.\d+Z$/, 'Z')}
                    ${rumenTickUrl}
  graph-inference   daily at 03:00 UTC (Sprint 42 cron)
                    ${graphInferenceUrl}

Next steps:
${vaultLine}
${llmLine}
  Monitor rumen jobs: psql "$DATABASE_URL" -c "SELECT * FROM rumen_jobs ORDER BY started_at DESC LIMIT 5"
  Rumen insights flow back into Mnestra's memory_items via rumen_insights.
  graph-inference fills memory_relationships edges nightly (cosine similarity ≥ 0.85).
  TermDeck's Flashback will surface cross-project patterns automatically.
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

  // Sprint 51.5 T3: ensure both Vault secrets are present BEFORE the
  // precondition audit (which checks vault.decrypted_secrets for
  // rumen_service_role_key). Auto-applies via pgRunner; on permission
  // failure prints SQL-Editor deeplinks and lets the audit's own hint
  // catch the still-missing secret. The Vault dashboard panel was quietly
  // removed in current Supabase UIs (Brad 2026-05-03 takeaway #2;
  // INSTALLER-PITFALLS.md Class B), which is why we no longer instruct
  // users to "click Vault."
  let vaultResult = { ok: true, created: [], deeplinks: [] };
  if (!flags.dryRun) {
    vaultResult = await ensureVaultSecrets({ projectRef, secrets, dryRun: false });
    // Continue regardless — preconditions audit will catch a still-missing
    // secret with its own hint, and the user already has the deeplinks if
    // any auto-apply failed.
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

  // Backfill SUPABASE_ACCESS_TOKEN into ~/.claude.json now that
  // `supabase link` succeeded (the token is verified-real). The
  // meta-installer wrote a literal 'SUPABASE_PAT_HERE' placeholder
  // there during Tier 4 install — this closes that loop.
  if (!flags.dryRun) {
    const r = wireAccessTokenInMcpJson();
    if (r.status === 'updated') {
      step(`Backfilled SUPABASE_ACCESS_TOKEN into ${r.path}...`);
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

  // Sprint 51.5 T1 — audit-upgrade BEFORE the rest of the flow. Surfaces
  // and applies any drift between the bundled artifact set and what's
  // actually live on the user's project. Non-blocking on failure (probe
  // errors get logged inline; main flow continues).
  if (!flags.dryRun) {
    await runRumenAudit(projectRef, secrets, flags.dryRun);
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

  if (!deployFunctions(resolved.version, projectRef, flags.dryRun)) return 6;

  // Sprint 51.5 T3: install-time prompt for AI edge classification. Sets
  // secrets.GRAPH_LLM_CLASSIFY in-memory; the per-secret loop below picks
  // it up. On --yes / --dry-run defaults to enabled (Y).
  const llmResult = await promptGraphLlmClassify({ secrets, flags });

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

  printNextSteps(projectRef, vaultResult, llmResult);
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
// Sprint 43 T3: stage helper exposed so init-rumen-deploy.test.js can pin
// the multi-function staging contract without shelling out to `supabase`.
module.exports._stageRumenFunctions = stageRumenFunctions;
// Sprint 51.6 T3 — exported for tests/init-rumen-project-ref.test.js so the
// --project-ref invariant can be asserted without spawning a real shell.
module.exports._deployFunctions = deployFunctions;
// Sprint 51.5 T3: per-secret CLI loop, Vault SQL-Editor URL builder, and
// Vault-secret ensure helper exposed for tests/init-rumen-secrets-per-call,
// init-rumen-graph-llm, and init-rumen-vault-deeplinks.
module.exports._setFunctionSecrets = setFunctionSecrets;
module.exports._vaultSqlEditorUrl = vaultSqlEditorUrl;
module.exports._ensureVaultSecrets = ensureVaultSecrets;
module.exports._promptGraphLlmClassify = promptGraphLlmClassify;

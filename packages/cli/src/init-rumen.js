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
//
// Steps:
//   1. Preflight: which supabase, which deno, read secrets.env
//   2. Derive project ref from SUPABASE_URL; confirm with user
//   3. supabase link --project-ref <ref>
//   4. Apply rumen migration 001 via pg
//   5. supabase functions deploy rumen-tick --no-verify-jwt
//   6. supabase secrets set DATABASE_URL=... ANTHROPIC_API_KEY=...
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
  pgRunner
} = require(SETUP_DIR);

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

async function link(projectRef, dryRun) {
  step(`Running: supabase link --project-ref ${projectRef}...`);
  if (dryRun) { ok('(dry-run)'); return true; }
  const r = runShellCaptured('supabase', ['link', '--project-ref', projectRef]);
  if (!r.ok) {
    fail(`supabase link failed (exit ${r.code})`);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
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

function deployFunction(dryRun) {
  step('Running: supabase functions deploy rumen-tick --no-verify-jwt...');
  if (dryRun) { ok('(dry-run)'); return true; }

  // We need the supabase command to run against a repo layout with
  // `supabase/functions/rumen-tick/`. The TermDeck install does NOT include
  // a `supabase/` directory at the project root, so we stage a tiny working
  // directory under `os.tmpdir()` that mirrors what the CLI expects.
  const stage = stageRumenFunction();
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
function stageRumenFunction() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-rumen-stage-'));
  const functionSrc = migrations.rumenFunctionDir();
  if (!fs.existsSync(functionSrc)) return null;

  const dest = path.join(stage, 'supabase', 'functions', 'rumen-tick');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(functionSrc)) {
    fs.copyFileSync(path.join(functionSrc, f), path.join(dest, f));
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
  step('Setting function secrets (DATABASE_URL, ANTHROPIC_API_KEY)...');
  if (dryRun) { ok('(dry-run)'); return true; }
  const r = runShellCaptured('supabase', [
    'secrets', 'set',
    `DATABASE_URL=${secrets.DATABASE_URL}`,
    `ANTHROPIC_API_KEY=${secrets.ANTHROPIC_API_KEY}`
  ]);
  if (!r.ok) {
    fail(`secrets set failed (exit ${r.code})`);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    return false;
  }
  ok();
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

  if (!(await link(projectRef, flags.dryRun))) return 4;
  if (!(await applyRumenTables(secrets, flags.dryRun))) return 5;
  if (!deployFunction(flags.dryRun)) return 6;
  if (!setFunctionSecrets(secrets, flags.dryRun)) return 7;
  if (!(await testFunction(projectRef, secrets, flags.dryRun))) return 8;
  if (!flags.skipSchedule) {
    if (!(await applySchedule(projectRef, secrets, flags.dryRun))) return 9;
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

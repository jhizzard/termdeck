#!/usr/bin/env node

// `termdeck init --mnestra` — interactive wizard for TermDeck's Tier 2 memory
// layer. Wraps the six manual Mnestra setup steps into one command.
//
// Steps:
//   1. Collect Supabase URL, service_role key, direct DB URL, OpenAI + Anthropic keys
//      (or reuse the saved set in ~/.termdeck/secrets.env if present)
//   2. Persist ~/.termdeck/secrets.env immediately — merge-aware, preserves
//      existing values. Done BEFORE any database work so a later pg connect
//      or migration failure doesn't lose the user's typed-in keys.
//   3. Connect via `pg` using the direct URL
//   4. Apply all bundled Mnestra migrations in order (currently 17 — count
//      grows over time; audit-upgrade probes for any not yet applied and
//      runs them idempotently against existing installs)
//   5. Update ~/.termdeck/config.yaml — set rag.enabled: false (MCP-only
//      default; opt into TermDeck-side RAG via dashboard toggle) and point
//      at ${VAR} refs (only after migrations apply cleanly — otherwise the
//      server would try to use an incomplete schema on next startup)
//   6. Verify with a memory_status_aggregation() call
//
// Flags:
//   --help              Print usage and exit
//   --yes               Reuse saved secrets without re-prompting if a complete
//                       set is already on disk (otherwise the wizard asks
//                       interactively before reusing)
//   --reset             Ignore saved secrets and re-prompt for everything
//   --from-env          Skip every prompt; read all five secrets from the
//                       process environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//                       DATABASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY).
//                       Required for terminals that fight with our raw-mode
//                       secret prompt and for CI / scripted installs.
//   --dry-run           Print what the wizard would do; don't touch the DB or filesystem
//   --skip-verify       Skip the final memory_status_aggregation() check
//
// All control flow lives in this file. All prompts, file IO, and pg work
// delegate to packages/server/src/setup/**.

const path = require('path');
const fs = require('fs');

const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');
const {
  prompts,
  dotenv,
  yaml,
  supabaseUrl: urlHelper,
  migrations,
  pgRunner,
  preconditions,
  auditUpgrade: auditUpgradeMod
} = require(SETUP_DIR);

const HELP = [
  '',
  'TermDeck Mnestra Setup',
  '',
  'Usage: termdeck init --mnestra [flags]',
  '',
  'Flags:',
  '  --help            Print this message and exit',
  '  --yes             Reuse saved secrets without prompting (if a complete',
  '                    set is already on disk in ~/.termdeck/secrets.env)',
  '  --reset           Ignore saved secrets and re-prompt for everything',
  '  --from-env        Skip every prompt; read SUPABASE_URL,',
  '                    SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, OPENAI_API_KEY,',
  '                    ANTHROPIC_API_KEY from environment variables instead.',
  '                    Useful for terminals that fight with raw-mode secret',
  '                    prompts (MobaXterm SSH, some Windows shells) and for',
  '                    CI / scripted installs.',
  '  --dry-run         Print the plan without touching the database or filesystem',
  '  --skip-verify     Skip the final memory_status_aggregation() sanity call',
  '',
  'What this does:',
  '  1. Prompts for Supabase URL, service_role key, direct Postgres connection',
  '     string, OpenAI API key, and (optional) Anthropic API key — or reuses',
  '     saved values if a complete set already exists in secrets.env.',
  '  2. Writes ~/.termdeck/secrets.env IMMEDIATELY (merge-aware) so a later',
  '     pg connect or migration failure does not lose what you typed in.',
  '  3. Connects to Postgres and applies all bundled Mnestra schema + RPC migrations.',
  '  4. Updates ~/.termdeck/config.yaml — sets rag.enabled: false (MCP-only',
  '     default) and references ${VAR} keys for credentials.',
  '  5. Verifies the Mnestra store is reachable via memory_status_aggregation().',
  '',
  'Every secret stays on your machine. Nothing is ever printed once entered.',
  ''
].join('\n');

function parseFlags(argv) {
  const out = {
    help: false,
    yes: false,
    reset: false,
    fromEnv: false,
    dryRun: false,
    skipVerify: false
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--from-env') out.fromEnv = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-verify') out.skipVerify = true;
  }
  return out;
}

// Build inputs from process.env directly, skipping every askSecret prompt.
// Used by --from-env so callers on terminals that fight with our raw-mode
// secret prompt (Brad's MobaXterm SSH report 2026-04-25, fourth occurrence)
// can hand the wizard their secrets via env vars instead. Also makes the
// wizard scriptable for CI / one-shot installers. Returns the same shape
// as collectInputs() so the rest of main() doesn't care which path filled
// it. Throws with an actionable message when a required env var is missing
// or fails its shape check — `--from-env` is strict by design (no fallback
// to prompts), since callers using it have explicitly opted into the
// non-interactive path.
function inputsFromEnv() {
  const env = process.env;
  const missing = [];
  const required = {
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    DATABASE_URL: env.DATABASE_URL,
    OPENAI_API_KEY: env.OPENAI_API_KEY
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v || !v.trim()) missing.push(k);
  }
  if (missing.length > 0) {
    throw new Error(
      `--from-env is missing required environment variable(s): ${missing.join(', ')}.\n` +
      'Set every required key in your shell or pass them on the command line, e.g.:\n' +
      '  SUPABASE_URL=https://xyz.supabase.co \\\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \\\n' +
      '  DATABASE_URL=postgres://postgres.<ref>:<pw>@<pooler-host>:6543/postgres \\\n' +
      '  OPENAI_API_KEY=sk-proj-... \\\n' +
      '  ANTHROPIC_API_KEY=sk-ant-... \\\n' +
      '  termdeck init --mnestra --from-env'
    );
  }

  const projectUrl = urlHelper.parseProjectUrl(required.SUPABASE_URL);
  if (!projectUrl.ok) {
    throw new Error(`SUPABASE_URL is malformed: ${projectUrl.error}`);
  }

  const dbErr = urlHelper.looksLikePostgresUrl(required.DATABASE_URL);
  if (dbErr) throw new Error(`DATABASE_URL: ${dbErr}`);

  const srErr = urlHelper.looksLikeServiceRole(required.SUPABASE_SERVICE_ROLE_KEY);
  if (srErr) throw new Error(`SUPABASE_SERVICE_ROLE_KEY: ${srErr}`);

  const oaErr = urlHelper.looksLikeOpenAiKey(required.OPENAI_API_KEY);
  if (oaErr) throw new Error(`OPENAI_API_KEY: ${oaErr}`);

  const anthropicKey = (env.ANTHROPIC_API_KEY || '').trim() || null;
  if (anthropicKey) {
    const aErr = urlHelper.looksLikeAnthropicKey(anthropicKey);
    if (aErr) {
      process.stdout.write(`  (warning: ANTHROPIC_API_KEY ${aErr} — storing anyway)\n`);
    }
  }

  return {
    projectUrl,
    serviceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: required.DATABASE_URL,
    openaiKey: required.OPENAI_API_KEY,
    anthropicKey
  };
}

function printBanner() {
  process.stdout.write(`
TermDeck Mnestra Setup
─────────────────────

This wizard configures TermDeck's Tier 2 memory layer (Mnestra) by:
  1. Asking for your Supabase URL and service_role key
  2. Asking for a direct Postgres connection string
  3. Asking for an OpenAI API key (embeddings)
  4. Asking for an Anthropic API key (optional, summaries)
  5. Writing ~/.termdeck/secrets.env (before any database work, so a
     pg failure cannot lose what you typed in)
  6. Connecting to Postgres + applying all bundled SQL migrations
     (audit-upgrade detects + applies any missing on existing installs)
  7. Updating ~/.termdeck/config.yaml — rag.enabled: false (MCP-only
     default; toggle in dashboard later) with \${VAR} refs (only after
     migrations apply cleanly)
  8. Verifying the connection with a memory_status call

If you already have a complete ~/.termdeck/secrets.env, the wizard will
offer to reuse it (or pass --yes to skip the prompt and resume directly).
If your terminal fights with the secret prompt, set the five env vars and
pass --from-env to skip every prompt entirely.

Press Ctrl+C at any time to cancel.

`);
}

function step(msg) { process.stdout.write(`→ ${msg}`); }
function ok(suffix = '') { process.stdout.write(` ✓${suffix ? ' ' + suffix : ''}\n`); }
function fail(err) { process.stdout.write(` ✗\n    ${err}\n`); }

// Read whatever secrets are already on disk. Returns hydrated input shape if
// a complete set is present, or null if the user still needs to be prompted
// for at least one required value. Anthropic remains optional throughout.
function loadSavedSecrets() {
  const saved = dotenv.readSecrets();
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'OPENAI_API_KEY'];
  const present = required.filter((k) => saved[k]);
  if (present.length < required.length) {
    return { complete: false, present, saved };
  }
  const projectUrl = urlHelper.parseProjectUrl(saved.SUPABASE_URL);
  if (!projectUrl.ok) return { complete: false, present, saved };
  return {
    complete: true,
    present,
    saved,
    inputs: {
      projectUrl,
      serviceRoleKey: saved.SUPABASE_SERVICE_ROLE_KEY,
      databaseUrl: saved.DATABASE_URL,
      openaiKey: saved.OPENAI_API_KEY,
      anthropicKey: saved.ANTHROPIC_API_KEY || null
    }
  };
}

async function collectInputs({ yes, reset }) {
  // Resume path — Brad's case at 2026-04-25 17:50 ET ("If it got that far did
  // it write the correct secret.env? If so, can I manually do the next steps?").
  // If a complete set of secrets is already on disk, offer to reuse them so a
  // re-run after a pg connect failure does not require retyping everything.
  if (!reset) {
    const found = loadSavedSecrets();
    if (found.complete) {
      const ref = found.inputs.projectUrl.projectRef;
      const masked = urlHelper.maskSecret(found.inputs.databaseUrl);
      process.stdout.write(
        `Found saved secrets in ~/.termdeck/secrets.env (project ${ref}, db ${masked}).\n`
      );
      const reuse = yes ? true : await prompts.confirm('  Reuse saved secrets?', { defaultYes: true });
      if (reuse) {
        process.stdout.write('  Reusing saved secrets. Skipping prompts.\n\n');
        return found.inputs;
      }
      process.stdout.write('  Re-prompting.\n\n');
    } else if (found.present.length > 0) {
      process.stdout.write(
        `Note: ~/.termdeck/secrets.env has ${found.present.length}/4 required keys ` +
        `(${found.present.join(', ')}). Re-prompting for the rest.\n\n`
      );
    }
  }

  const projectUrlStr = await prompts.askRequired(
    '? Supabase Project URL (e.g. https://xyz.supabase.co)',
    {
      validate: (v) => {
        const parsed = urlHelper.parseProjectUrl(v);
        return parsed.ok ? null : parsed.error;
      }
    }
  );
  const projectUrl = urlHelper.parseProjectUrl(projectUrlStr);

  process.stdout.write('? Supabase service_role key (starts sb_secret_ or eyJ): ');
  const serviceRoleKey = await promptSecretWithValidation(
    urlHelper.looksLikeServiceRole
  );

  process.stdout.write(
    '? Direct Postgres connection string\n' +
    `  (Supabase dashboard → Project Settings → Database → Connection String → Transaction pooler)\n` +
    '  postgres://postgres.REF:PW@... '
  );
  const databaseUrl = await promptSecretWithValidation(urlHelper.looksLikePostgresUrl);

  process.stdout.write('? OpenAI API key (starts sk-proj- or sk-): ');
  const openaiKey = await promptSecretWithValidation(urlHelper.looksLikeOpenAiKey);

  process.stdout.write('? Anthropic API key (optional, for session summaries): ');
  const anthropicKeyRaw = await prompts.askSecret('');
  const anthropicKey = anthropicKeyRaw || null;
  if (anthropicKey) {
    const shapeErr = urlHelper.looksLikeAnthropicKey(anthropicKey);
    if (shapeErr) {
      process.stdout.write(`  (warning: ${shapeErr} — storing anyway)\n`);
    }
  }

  process.stdout.write('\n');

  return {
    projectUrl,
    serviceRoleKey,
    databaseUrl,
    openaiKey,
    anthropicKey
  };
}

// Wrapper that re-prompts on a shape mismatch instead of aborting. Max 3 tries.
async function promptSecretWithValidation(validator) {
  for (let i = 0; i < 3; i++) {
    const value = await prompts.askSecret('');
    if (!value) {
      process.stdout.write('  (required)\n? ');
      continue;
    }
    const err = validator(value);
    if (err) {
      process.stdout.write(`  (${err})\n? `);
      continue;
    }
    return value;
  }
  throw new Error('Too many invalid attempts — cancelling.');
}

async function applyMigrations(client, dryRun) {
  const files = migrations.listMnestraMigrations();
  if (files.length === 0) {
    throw new Error('No Mnestra migrations found. TermDeck install looks corrupted.');
  }

  for (const file of files) {
    const base = path.basename(file);
    step(`Applying migration ${base}...`);
    if (dryRun) { ok('(dry-run)'); continue; }
    const result = await pgRunner.applyFile(client, file);
    if (result.ok) {
      ok(`(${result.elapsedMs}ms)`);
    } else {
      fail(result.error);
      throw new Error(`Migration failed: ${base}`);
    }
  }
}

// Sprint 51.5 T1 — schema-introspection audit-upgrade. Runs AFTER the
// fresh-install applyMigrations() loop completes, but reports separately.
// On a Sprint-37-era project that pre-dated several mnestra migrations,
// applyMigrations now has the full bundled set (Sprint 51.5 synced 013-015
// from canonical engram), so this audit is mostly a belt-and-suspenders
// confirmation. It still surfaces drift if, e.g., the user manually
// dropped a column post-install. Mnestra-kind only — rumen cron probes
// reference vault secrets the user hasn't set up yet at this point. Run
// init-rumen for the rumen-side audit.
async function runMnestraAudit(client, projectRef, dryRun) {
  step('Audit-upgrade: probing for missing mnestra schema artifacts...');
  if (dryRun) { ok('(dry-run)'); return; }
  const probes = auditUpgradeMod.PROBES.filter((p) => p.kind === 'mnestra');
  let result;
  try {
    result = await auditUpgradeMod.auditUpgrade({
      pgClient: client,
      projectRef,
      probes
    });
  } catch (err) {
    fail(err.message);
    return;
  }
  if (result.applied.length === 0 && result.errors.length === 0) {
    ok(`(install up to date — ${result.probed.length} probes all present)`);
    return;
  }
  ok(`(probed ${result.probed.length}, applied ${result.applied.length})`);
  for (const name of result.applied) {
    process.stdout.write(`    ✓ applied ${name}\n`);
  }
  for (const e of result.errors) {
    process.stdout.write(`    ! ${e.name}: ${e.error}\n`);
  }
}

async function checkExistingStore(client) {
  step('Checking for existing memory_items table...');
  try {
    const result = await pgRunner.run(
      client,
      `SELECT COUNT(*)::bigint AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'memory_items'`
    );
    const exists = result.rows[0] && Number(result.rows[0].n) > 0;
    if (!exists) {
      ok('not found (will create)');
      return { exists: false, rows: 0 };
    }
    const countResult = await pgRunner.run(client, 'SELECT COUNT(*)::bigint AS n FROM memory_items');
    const rows = Number(countResult.rows[0].n);
    ok(`found (${rows.toLocaleString()} rows)`);
    return { exists: true, rows };
  } catch (err) {
    fail(err.message);
    throw err;
  }
}

async function verifyStatus(client) {
  step('Verifying memory_status_aggregation()...');
  try {
    const result = await pgRunner.run(client, 'SELECT * FROM memory_status_aggregation()');
    const row = result.rows && result.rows[0];
    if (!row) {
      fail('RPC returned no rows');
      return false;
    }
    const total = Number(row.total_active || 0);
    ok(`(${total.toLocaleString()} active memories found)`);
    return true;
  } catch (err) {
    fail(err.message);
    return false;
  }
}

// Persist secrets BEFORE any pg work so a connect/migration failure can't
// throw away what the user typed in. Brad's 2026-04-25 18:30 ET report
// ("It's killing before writing the file. Postgrep line not added to my
// existing file, so it wasn't changed") was caused by writeLocalConfig
// running AFTER applyMigrations — when migrations or pg connect failed,
// secrets.env was never updated. Splitting the writes lets secrets land
// on disk first; config.yaml only flips to rag.enabled=true once the
// schema is actually in place.
function writeSecretsFile(inputs, dryRun) {
  // Normalize transaction-pooler URLs by appending pgbouncer=true&
  // connection_limit=1 when missing. Brad's Rumen logs (2026-04-26)
  // surfaced the warning Supabase recommends: transaction-mode pooling
  // (port 6543) needs those params or PgBouncer can return prepared-
  // statement errors under load. Direct connections and session-mode
  // pooler URLs are returned unchanged. See setup/supabase-url.js.
  const normalized = urlHelper.normalizeDatabaseUrl(inputs.databaseUrl);
  if (normalized.modified) {
    step('Detected transaction pooler URL — appending ?pgbouncer=true&connection_limit=1...');
    ok();
  }

  step('Writing ~/.termdeck/secrets.env...');
  if (dryRun) { ok('(dry-run)'); return; }
  dotenv.writeSecrets({
    SUPABASE_URL: inputs.projectUrl.url,
    SUPABASE_SERVICE_ROLE_KEY: inputs.serviceRoleKey,
    DATABASE_URL: normalized.url,
    OPENAI_API_KEY: inputs.openaiKey,
    ...(inputs.anthropicKey ? { ANTHROPIC_API_KEY: inputs.anthropicKey } : {})
  });
  ok();
}

// MCP-only is the default starting v0.7.3. Mnestra's MCP server populates
// `memory_items` whenever an AI worker calls memory_remember / memory_recall,
// so the dashboard's Flashback queries work out of the box. The TermDeck-side
// RAG event tables (mnestra_session_memory / mnestra_project_memory /
// mnestra_developer_memory / mnestra_commands) stay off until the user opts
// in via the dashboard or by editing config.yaml. This matches Joshua's
// daily-driver setup and avoids the v0.7.2-and-earlier asymmetry that hit
// Brad's box on 2026-04-27 (default `enabled: true` against tables no init
// path created → 404 cascade → silent RAG drop).
function writeYamlConfig(dryRun) {
  process.stdout.write(
    '\nSetup mode: MCP-only (default)\n' +
    '  Mnestra MCP tools fill memory_items via memory_remember / memory_recall.\n' +
    '  TermDeck event tables (session / project / developer) stay OFF by default.\n' +
    '  Enable later: toggle in dashboard at http://localhost:3000/#config\n' +
    '  or set rag.enabled: true in ~/.termdeck/config.yaml.\n\n'
  );
  step('Updating ~/.termdeck/config.yaml (rag.enabled: false, MCP-only default)...');
  if (dryRun) { ok('(dry-run)'); return; }
  const r = yaml.updateRagConfig({
    enabled: false,
    supabaseUrl: '${SUPABASE_URL}',
    supabaseKey: '${SUPABASE_SERVICE_ROLE_KEY}',
    openaiApiKey: '${OPENAI_API_KEY}',
    anthropicApiKey: '${ANTHROPIC_API_KEY}'
  });
  if (r.backup) ok(`(backup: ${path.basename(r.backup)})`);
  else ok();
}

// Sprint 51.6 T3 — hook upgrade gap fix.
//
// Codex's Sprint 51.6 GAP at 20:11 ET surfaced this: the bundled session-end
// hook ships in `packages/stack-installer/assets/hooks/memory-session-end.js`,
// and `npm install -g @jhizzard/termdeck@latest` lands the new bundled file
// in node_modules — but `termdeck init --mnestra` never touched
// ~/.claude/hooks/memory-session-end.js. The user's daily-driver kept
// running the OLD installed copy forever. v1.0.2 closes that gap by adding
// this refresh step to init --mnestra. The version stamp in the bundled
// hook (// @termdeck/stack-installer-hook v<N>) gates the overwrite — only
// strictly-newer bundled stamps trigger a refresh, so a hand-edited
// installed file with v=current stays put.
//
// Backup is best-effort timestamped: `<dest>.bak.<YYYYMMDDhhmmss>`. Matches
// the pattern Joshua already had on disk from earlier stack-installer runs.
function refreshBundledHookIfNewer(opts = {}) {
  const dryRun = !!opts.dryRun;
  const HOME = require('os').homedir();
  const HOOK_DEST = opts.destPath || path.join(HOME, '.claude', 'hooks', 'memory-session-end.js');
  // Sprint 51.6 T4-CODEX audit 20:28 ET fix: bundled hook source must be on
  // a path that ships in @jhizzard/termdeck's npm tarball. Root package.json
  // includes `packages/stack-installer/assets/hooks/**` (added 51.6 T3) so
  // this path resolves both in the monorepo and in the published tarball.
  const HOOK_SOURCE = opts.sourcePath
    || path.join(__dirname, '..', '..', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js');
  const SIG_RE = /@termdeck\/stack-installer-hook\s+v(\d+)/;
  const TERMDECK_MARKERS = [
    /TermDeck session-end memory hook/,
    /@jhizzard\/termdeck-stack/,
    /Vendored into ~\/\.claude\/hooks\/memory-session-end\.js by @jhizzard/i,
  ];

  function readHead(p) {
    try { return fs.readFileSync(p, 'utf8').slice(0, 4096); }
    catch (_) { return null; }
  }
  function readVersion(p) {
    const head = readHead(p);
    if (!head) return null;
    const m = head.match(SIG_RE);
    return m ? parseInt(m[1], 10) : null;
  }
  function looksTermdeckManaged(p) {
    const head = readHead(p);
    if (!head) return false;
    return TERMDECK_MARKERS.some((m) => m.test(head));
  }

  if (!fs.existsSync(HOOK_SOURCE)) {
    return { status: 'no-bundled', message: 'bundled hook source not found' };
  }
  const bundled = readVersion(HOOK_SOURCE);
  if (bundled === null) {
    return { status: 'bundled-unsigned', message: 'bundled hook missing version stamp; skipping refresh' };
  }
  if (!fs.existsSync(HOOK_DEST)) {
    if (dryRun) return { status: 'would-install', bundled };
    fs.mkdirSync(path.dirname(HOOK_DEST), { recursive: true });
    fs.copyFileSync(HOOK_SOURCE, HOOK_DEST);
    fs.chmodSync(HOOK_DEST, 0o644);
    return { status: 'installed', bundled };
  }
  const installed = readVersion(HOOK_DEST);
  if (installed !== null && installed >= bundled) {
    return { status: 'up-to-date', installed, bundled };
  }
  // Sprint 51.6 T4-CODEX audit 20:23 ET safety gate: an unsigned installed
  // hook gets refreshed ONLY if it looks TermDeck-managed (carries one of
  // the docstring markers from a prior bundled cut). A genuinely custom
  // user hook with no TermDeck fingerprint stays put.
  if (installed === null && !looksTermdeckManaged(HOOK_DEST)) {
    return {
      status: 'custom-hook-preserved',
      message: 'installed hook lacks TermDeck-managed markers; keeping as-is. Re-run with --force-overwrite to bypass.',
      bundled,
    };
  }
  if (dryRun) return { status: 'would-refresh', from: installed, to: bundled };
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const backup = `${HOOK_DEST}.bak.${stamp}`;
  try { fs.copyFileSync(HOOK_DEST, backup); } catch (_) { /* best-effort */ }
  fs.copyFileSync(HOOK_SOURCE, HOOK_DEST);
  fs.chmodSync(HOOK_DEST, 0o644);
  return { status: 'refreshed', from: installed, to: bundled, backup };
}

function printNextSteps() {
  process.stdout.write(`
Mnestra is configured.

Setup mode: MCP-only (default) — TermDeck-side RAG event tables are off.
To enable session / project / developer memory tables, toggle in the dashboard
at http://localhost:3000/#config or set rag.enabled: true in
~/.termdeck/config.yaml and restart TermDeck.

Next steps:
  1. Restart TermDeck: termdeck
  2. Flashback will fire automatically on panel errors
  3. Use the "Ask about this terminal" input to query memories
  4. Want async learning? Run: termdeck init --rumen
`);
}

function printResumeHint() {
  process.stderr.write(
    '\nYour secrets are saved at ~/.termdeck/secrets.env.\n' +
    'To retry just the database step (no need to re-enter keys):\n' +
    '  termdeck init --mnestra --yes\n'
  );
}

async function main(argv) {
  const flags = parseFlags(argv || []);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  printBanner();

  let inputs;
  if (flags.fromEnv) {
    // Skip every interactive prompt — secrets come from process.env. Used
    // when the user's terminal fights with the raw-mode secret prompt
    // (Brad/MobaXterm SSH, 2026-04-25 fourth report) or when the wizard
    // is being driven from a CI/install script.
    process.stdout.write('Reading secrets from environment variables (--from-env).\n\n');
    try {
      inputs = inputsFromEnv();
    } catch (err) {
      process.stderr.write(`\n[init --mnestra] ${err.message}\n`);
      return 2;
    }
  } else {
    try {
      inputs = await collectInputs({ yes: flags.yes, reset: flags.reset });
    } catch (err) {
      process.stderr.write(`\n[init --mnestra] ${err.message}\n`);
      return 2;
    }
  }

  // Persist secrets BEFORE pg work. If the wizard dies past this point
  // (connect timeout, migration error, Ctrl-C), the saved file lets the
  // user re-run with --yes and skip straight to the database step.
  process.stdout.write('\n');
  try {
    writeSecretsFile(inputs, flags.dryRun);
  } catch (err) {
    fail(err.message);
    process.stderr.write(
      '\nFailed to write ~/.termdeck/secrets.env. Check the directory is writable.\n'
    );
    return 6;
  }

  step('Connecting to Supabase...');
  if (flags.dryRun) {
    ok('(dry-run, skipped)');
    await applyMigrations(null, true);
    writeYamlConfig(true);
    process.stdout.write('\nDry run complete. No changes were made.\n');
    return 0;
  }

  let client;
  try {
    client = await pgRunner.connect(inputs.databaseUrl);
    ok();
  } catch (err) {
    fail(err.message);
    process.stderr.write(
      '\nDouble-check the connection string from Supabase → Project Settings → Database → Connection String.\n'
    );
    printResumeHint();
    return 3;
  }

  try {
    await checkExistingStore(client);
    await applyMigrations(client, false);
    await runMnestraAudit(client, inputs.projectUrl.projectRef, false);
    writeYamlConfig(false);
    // Sprint 51.6 T3: refresh ~/.claude/hooks/memory-session-end.js when the
    // bundled hook's version stamp is newer than the installed copy. Closes
    // the upgrade gap where bundled fixes never reached users' machines via
    // the standard `npm install -g @jhizzard/termdeck@latest && termdeck
    // init --mnestra` path. Best-effort, timestamped backup, fail-soft.
    step('Refreshing ~/.claude/hooks/memory-session-end.js (if bundled is newer)...');
    try {
      const r = refreshBundledHookIfNewer({ dryRun: false });
      if (r.status === 'refreshed') {
        ok(`refreshed v${r.from ?? 0} → v${r.to} (backup: ${path.basename(r.backup)})`);
      } else if (r.status === 'installed') {
        ok(`installed v${r.bundled} (no prior copy)`);
      } else if (r.status === 'up-to-date') {
        ok(`up-to-date (v${r.installed})`);
      } else {
        ok(`(${r.status}${r.message ? ': ' + r.message : ''})`);
      }
    } catch (err) {
      // Don't abort init for a hook-refresh failure — log + continue.
      process.stdout.write(`    ! hook refresh failed: ${err.message} (continuing)\n`);
    }
    // v0.6.9: post-write outcome verification. Confirms each migration's
    // expected schema bits actually landed — including memory_items.
    // source_session_id (the v0.6.5 column whose absence cascaded into
    // Brad's Rumen failures). This is the test that, if it had existed
    // before v0.6.5, would have caught the silent-shadow saga at install
    // time instead of cron-tick time.
    if (!flags.skipVerify) {
      const verify = await preconditions.verifyMnestraOutcomes({ secrets: { DATABASE_URL: inputs.databaseUrl }, _pgClient: client });
      preconditions.printVerifyReport(verify, 'mnestra');
      if (!verify.ok) {
        printResumeHint();
        return 8;
      }
      const verified = await verifyStatus(client);
      if (!verified) {
        process.stdout.write(
          '\nMigrations applied, but memory_status_aggregation() is not responding yet.\n' +
          'This usually means the RPC was just created — give it a second and run:\n' +
          '  psql "$DATABASE_URL" -c "SELECT * FROM memory_status_aggregation();"\n'
        );
        return 4;
      }
    }
  } catch (err) {
    process.stderr.write(`\n[init --mnestra] ${err.message}\n`);
    printResumeHint();
    return 5;
  } finally {
    try { await client.end(); } catch (_err) { /* ignore */ }
  }

  printNextSteps();
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      process.stderr.write(`\n[init --mnestra] unexpected error: ${err && err.stack || err}\n`);
      process.exit(1);
    });
}

module.exports = main;
// Sprint 51.6 T3 — exported for tests/init-mnestra-hook-refresh.test.js.
module.exports.refreshBundledHookIfNewer = refreshBundledHookIfNewer;

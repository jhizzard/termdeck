#!/usr/bin/env node

// Sprint 64 T1 — Unified `termdeck init` top-level wizard orchestrator.
//
// Lifts the new-user install path from 15+ manual steps to "paste 2 credentials,
// click 3 buttons" via the Supabase MCP auto-provision path. The keystone
// before MacBook Air dogfood per docs/CONVERGENCE-PLAN.md.
//
// Two paths:
//
//   1) Manual (default): runs the existing init-mnestra interactive wizard
//      (paste Supabase URL, service_role key, DATABASE_URL, OpenAI key,
//      Anthropic key — same as today), then init-rumen, then doctor.
//
//   2) Auto (--auto or --mcp-supabase): drives the Supabase Management API
//      via the Supabase MCP server to provision a fresh project, apply all
//      migrations, deploy Edge Functions, create vault secrets, and apply
//      cron schedules — then runs the existing init-mnestra wizard in
//      --from-env mode for the local-side wiring (config.yaml, ~/.claude/hooks,
//      settings.json migration, pg verify), and best-effort init-rumen
//      (function secrets + test fire). MCP unavailable → falls through to
//      manual with a clear "MCP unavailable" log.
//
// Both paths land at the same end-state:
//   ~/.termdeck/secrets.env populated with Mnestra credentials
//   ~/.termdeck/config.yaml with rag.enabled: false (MCP-only default)
//   ~/.claude/hooks/memory-session-end.js refreshed to bundled version
//   ~/.claude/settings.json wired with SessionEnd hook
//   memory_status_aggregation() verified via DATABASE_URL
//   termdeck doctor green
//
// Flag reference:
//   --help              Print usage + exit
//   --auto              Use Supabase MCP auto-provision (creates new project)
//   --mcp-supabase      Alias for --auto
//   --reset             Drop any existing ~/.termdeck/secrets.env before starting
//   --from-env          Non-interactive: read every secret from env vars
//   --dry-run           Print the plan; touch nothing
//   --skip-rumen        After Mnestra, skip the Rumen init step (Tier 2 only)
//   --skip-doctor       Skip the final post-install doctor pass
//
// --auto path additional flags (or env equivalents):
//   --pat <token>       SUPABASE_ACCESS_TOKEN — Supabase Personal Access Token
//   --org-id <id>       Pick a specific org (auto-picks when only one is visible)
//   --project-name      New project's name (prompted if missing)
//   --region            Project region (default us-east-1)
//   --db-password       Auto-generated when omitted (32-char hex; stored in secrets.env)
//
// Per Sprint 64 PLANNING § Hardening rule #7 (Supabase RLS hygiene): the
// auto-provisioner runs `get_advisors` post-migration and blocks on any
// ERROR-severity advisor (RLS disabled, mutable search_path, etc.).
//
// Per Sprint 64 T1 FINDING-1.1A: `--auto` is the primary flag name with
// `--mcp-supabase` as a documented alias. Reasoning posted to STATUS.md.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const osDetect = require('./os-detect');
const mcpProvision = require('./mcp-supabase-provision');

const SETUP_DIR = path.join(__dirname, '..', '..', 'server', 'src', 'setup');
function loadSetupHelpers() {
  // Lazy-required to keep boot cost low on --help.
  return {
    prompts: require(path.join(SETUP_DIR, 'prompts')),
    dotenv: require(path.join(SETUP_DIR, 'dotenv-io')),
    supabaseUrl: require(path.join(SETUP_DIR, 'supabase-url')),
  };
}

const HELP = [
  '',
  'TermDeck unified setup',
  '',
  'Usage: termdeck init [--auto] [flags]',
  '',
  'Two paths:',
  '  Manual (default): interactive — paste Supabase + OpenAI/Anthropic credentials',
  '  Auto (--auto):    Supabase MCP auto-provision — creates a new project for you',
  '',
  'Common flags:',
  '  --help              Print this message and exit',
  '  --auto              Auto-provision via Supabase MCP (alias: --mcp-supabase)',
  '  --reset             Drop existing ~/.termdeck/secrets.env before starting',
  '  --from-env          Non-interactive: read every required secret from env vars',
  '  --dry-run           Print the plan; touch nothing',
  '  --skip-rumen        Stop after Mnestra (Tier 2 only)',
  '  --skip-doctor       Skip the final doctor pass',
  '',
  '--auto path additional flags (or env equivalents):',
  '  --pat <token>            SUPABASE_ACCESS_TOKEN — Supabase Personal Access Token',
  '  --org-id <id>            Pick a specific organization',
  '  --project-name <name>    New project name (prompted if missing)',
  '  --region <region>        Project region (default us-east-1)',
  '  --db-password <pwd>      Auto-generated when omitted',
  '',
  'Sub-mode wizards (callable independently for advanced users):',
  '  termdeck init --mnestra   Configure Tier 2 memory (Supabase + Mnestra)',
  '  termdeck init --rumen     Deploy Tier 3 async learning (Rumen)',
  '  termdeck init --project   Scaffold a new project with CLAUDE.md + orchestration docs',
  '',
  'Get a Personal Access Token at: https://supabase.com/dashboard/account/tokens',
  '',
].join('\n');

// Small helpers — same shape the existing wizards use so logs look identical.
function step(msg) { process.stdout.write(`→ ${msg}`); }
function ok(suffix = '') { process.stdout.write(` ✓${suffix ? ' ' + suffix : ''}\n`); }
function fail(err) { process.stdout.write(` ✗\n    ${err}\n`); }
function note(msg) { process.stdout.write(`  ${msg}\n`); }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }

function parseFlags(argv) {
  const out = {
    help: false,
    auto: false,
    reset: false,
    fromEnv: false,
    dryRun: false,
    skipRumen: false,
    skipDoctor: false,
    pat: null,
    orgId: null,
    projectName: null,
    region: null,
    dbPassword: null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--auto' || a === '--mcp-supabase') out.auto = true;
    else if (a === '--reset') out.reset = true;
    else if (a === '--from-env') out.fromEnv = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-rumen') out.skipRumen = true;
    else if (a === '--skip-doctor') out.skipDoctor = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--pat') { out.pat = argv[++i]; }
    else if (a === '--org-id') { out.orgId = argv[++i]; }
    else if (a === '--project-name') { out.projectName = argv[++i]; }
    else if (a === '--region') { out.region = argv[++i]; }
    else if (a === '--db-password') { out.dbPassword = argv[++i]; }
  }
  return out;
}

function generateDbPassword() {
  // 32 hex chars = 128 bits of entropy; well above Supabase's 12-char minimum.
  return crypto.randomBytes(16).toString('hex');
}

function defaultProjectName() {
  // termdeck-<8hex> — deterministic shape, unique enough across users.
  return `termdeck-${crypto.randomBytes(4).toString('hex')}`;
}

function printBanner(osInfo) {
  const distroLine = osInfo.family === 'macos'
    ? `macOS${osInfo.isAppleSilicon ? ' (Apple Silicon)' : ' (Intel)'}`
    : osInfo.family === 'docker'
      ? `Linux container (${osInfo.distro || 'unknown distro'})`
      : osInfo.family === 'linux'
        ? `Linux (${osInfo.distro || 'unknown distro'}${osInfo.version ? ' ' + osInfo.version : ''})`
        : 'Unknown platform';
  process.stdout.write(`
${bold('TermDeck unified setup')}
─────────────────────────

${dim('Platform: ' + distroLine + ', default shell: ' + osInfo.defaultShell)}

Press Ctrl+C at any time to cancel.

`);
}

function probeExistingInstall(homedir) {
  const secretsPath = path.join(homedir, '.termdeck', 'secrets.env');
  const configPath = path.join(homedir, '.termdeck', 'config.yaml');
  return {
    secretsPath,
    configPath,
    secretsExists: fs.existsSync(secretsPath),
    configExists: fs.existsSync(configPath),
  };
}

async function promptExistingInstallChoice({ prompts, existing }) {
  process.stdout.write(`Found existing install:\n`);
  if (existing.secretsExists) process.stdout.write(`  • ${existing.secretsPath}\n`);
  if (existing.configExists) process.stdout.write(`  • ${existing.configPath}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Options:\n  [1] Continue — re-use detected config\n  [2] Reset — drop and re-provision\n  [3] Cancel\n\n`);
  const choice = await prompts.askRequired('? Choose [1/2/3]', {
    validate: (v) => (/^[123]$/.test(v.trim()) ? null : 'enter 1, 2, or 3'),
  });
  const trimmed = choice.trim();
  if (trimmed === '1') return 'continue';
  if (trimmed === '2') return 'reset';
  return 'cancel';
}

function dropExistingSecrets(homedir) {
  const secretsPath = path.join(homedir, '.termdeck', 'secrets.env');
  if (fs.existsSync(secretsPath)) {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const backup = `${secretsPath}.bak.${stamp}`;
    try {
      fs.copyFileSync(secretsPath, backup);
      fs.unlinkSync(secretsPath);
      return backup;
    } catch (_e) { return null; }
  }
  return null;
}

// Run a sub-wizard (init-mnestra.js / init-rumen.js / doctor.js) in-process.
// Each exposes `module.exports = main` returning a Promise<exitCode>.
async function runSubWizard(scriptPath, argv) {
  const fn = require(scriptPath);
  const code = await fn(argv);
  return code || 0;
}

// ─────────────────────────────────────────────────────────────────────────
// --auto path.

async function collectAutoInputs({ flags, prompts, env }) {
  // PAT — flag → env → prompt
  let pat = flags.pat || env.SUPABASE_ACCESS_TOKEN || null;
  if (!pat && flags.fromEnv) {
    throw new Error('--from-env requires SUPABASE_ACCESS_TOKEN in process.env');
  }
  if (!pat) {
    process.stdout.write('? Supabase Personal Access Token (sbp_..., from https://supabase.com/dashboard/account/tokens): ');
    pat = await prompts.askSecret('');
    if (!pat) throw new Error('Supabase PAT is required for --auto path');
  }

  // Project name — flag → prompt
  let projectName = flags.projectName || null;
  if (!projectName) {
    const suggested = defaultProjectName();
    if (flags.fromEnv || flags.yes) {
      projectName = suggested;
    } else {
      const typed = await prompts.askRequired(`? New Supabase project name (default: ${suggested})`, {
        validate: () => null,
      });
      projectName = typed.trim() || suggested;
    }
  }

  // DB password — flag → auto-generate
  const dbPassword = flags.dbPassword || generateDbPassword();

  // OpenAI key — env → prompt (required)
  let openaiKey = env.OPENAI_API_KEY || null;
  if (!openaiKey && flags.fromEnv) {
    throw new Error('--from-env requires OPENAI_API_KEY in process.env');
  }
  if (!openaiKey) {
    process.stdout.write('? OpenAI API key (sk-... — required for embeddings): ');
    openaiKey = await prompts.askSecret('');
    if (!openaiKey) throw new Error('OpenAI API key is required');
  }

  // Anthropic key — env → prompt (optional for Mnestra; required for Rumen if Rumen enabled)
  let anthropicKey = env.ANTHROPIC_API_KEY || null;
  if (!anthropicKey && !flags.fromEnv && !flags.skipRumen) {
    process.stdout.write('? Anthropic API key (sk-ant-... — required for Rumen async learning; optional for Mnestra): ');
    anthropicKey = (await prompts.askSecret('')) || null;
  }

  return {
    pat,
    projectName,
    dbPassword,
    orgId: flags.orgId || env.SUPABASE_ORG_ID || null,
    region: flags.region || env.SUPABASE_REGION || 'us-east-1',
    openaiKey,
    anthropicKey,
  };
}

// Resolve @jhizzard/rumen version for the Edge Function deploy. Mirrors
// init-rumen.js#resolveRumenVersion shape (npm view → fallback). Spawn-sync
// based, ~1-2s on a fresh shell; cached for the duration of the call.
function resolveRumenVersion() {
  const { spawnSync } = require('child_process');
  const r = spawnSync('npm', ['view', '@jhizzard/rumen', 'version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  const FALLBACK = '0.5.3';
  if (r.status === 0) {
    const v = (r.stdout || '').trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  }
  return FALLBACK;
}

async function runAutoFlow({ flags, osInfo, prompts, dotenv, homedir }) {
  process.stdout.write(`${dim('Path: --auto (Supabase MCP provisioning)')}\n\n`);

  // Phase 1 — collect inputs.
  let inputs;
  try {
    inputs = await collectAutoInputs({ flags, prompts, env: process.env });
  } catch (err) {
    process.stderr.write(`\n[init --auto] ${err.message}\n`);
    return 2;
  }

  if (flags.dryRun) {
    step('Auto-provision plan (dry-run)');
    ok();
    note(`project name: ${inputs.projectName}`);
    note(`region: ${inputs.region}`);
    note(`org: ${inputs.orgId || '(autopicked from PAT-visible orgs)'}`);
    note(`db password: ${'*'.repeat(8)} (auto-generated, stored in secrets.env)`);
    note('Supabase MCP would: list orgs → create project → wait ready → apply migrations → vault secrets → deploy functions → cron → advisors');
    return 0;
  }

  // Phase 2 — drive provisionViaSupabaseMcp.
  const rumenVersion = resolveRumenVersion();
  step('Provisioning Supabase project via MCP server (this can take 60-120s)');
  process.stdout.write('\n');

  let provision;
  try {
    provision = await mcpProvision.provisionViaSupabaseMcp({
      pat: inputs.pat,
      projectName: inputs.projectName,
      dbPassword: inputs.dbPassword,
      orgId: inputs.orgId,
      region: inputs.region,
      rumenVersion,
      homedir,
      onPhase: (p) => {
        if (p.status === 'start') {
          process.stdout.write(`  ${dim('→ ' + p.phase + (p.detail ? ' (' + JSON.stringify(p.detail) + ')' : ''))}\n`);
        } else if (p.status === 'ok') {
          process.stdout.write(`  ${green('✓')} ${p.phase}${p.detail ? ' ' + dim(JSON.stringify(p.detail)) : ''}\n`);
        }
      },
    });
  } catch (err) {
    if (err.code === 'MCP_UNAVAILABLE') {
      process.stderr.write(`\n${yellow('[init --auto]')} Supabase MCP not installed — falling back to manual init-mnestra flow.\n`);
      process.stderr.write(`${dim('Install:  npm install -g @supabase/mcp-server-supabase')}\n\n`);
      return runManualFlow({ flags, osInfo, prompts, dotenv, homedir });
    }
    if (err.code === 'ORG_LIST_REQUIRED') {
      process.stderr.write(`\n${yellow('[init --auto]')} ${err.message}\n\n`);
      if (Array.isArray(err.orgs)) {
        process.stderr.write('Visible organizations:\n');
        for (const o of err.orgs) {
          process.stderr.write(`  ${o.id}  ${o.name}${o.plan ? ' (' + o.plan + ')' : ''}\n`);
        }
        process.stderr.write(`\nRe-run with: termdeck init --auto --org-id <id>\n`);
      }
      return 3;
    }
    if (err.code === 'ADVISOR_BLOCK') {
      process.stderr.write(`\n${yellow('[init --auto]')} ${err.message}\n`);
      if (Array.isArray(err.reds)) {
        for (const r of err.reds) {
          process.stderr.write(`  ${r.type}/${r.name || 'unknown'} — ${r.message || r.detail || ''}\n`);
        }
      }
      process.stderr.write(`\nFix the advisors above (likely a global RLS hygiene rule violation) and re-run.\n`);
      return 4;
    }
    process.stderr.write(`\n[init --auto] provisioning failed (${err.code || 'unknown'}): ${err.message}\n`);
    return 5;
  }

  // Phase 3 — write secrets.env. We pad with the user-provided OPENAI/ANTHROPIC
  // since those don't come from Supabase.
  //
  // Sprint 64 T4-CODEX AUDIT-RED 16:26 ET resolution: the Supabase
  // Personal Access Token (`inputs.pat`) is INTENTIONALLY NOT persisted to
  // ~/.termdeck/secrets.env. The PAT carries org-wide management-grade
  // privileges (create/delete projects, set vault secrets, deploy functions
  // across every project the user owns). `packages/server/src/index.js:1310`
  // merges every key in secrets.env into every spawned PTY's env via
  // `readTermdeckSecretsForPty()` — so persisting the PAT would broadcast
  // a manage-everything credential to every Codex/Claude/Gemini/Grok/shell
  // child. The PAT lives in process memory only for the duration of this
  // wizard run; the per-project credentials returned BY the MCP provision
  // call (SUPABASE_URL / SERVICE_ROLE_KEY / DATABASE_URL) are scoped to one
  // project and ARE persisted because the running stack needs them.
  // Re-running `termdeck init --auto --reset` re-prompts for the PAT (~90s
  // human cost on a wizard that runs rarely; vastly preferable to broadcasting
  // a PAT to every panel).
  step('Writing ~/.termdeck/secrets.env with provisioned credentials');
  try {
    dotenv.writeSecrets({
      SUPABASE_URL: provision.secrets.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: provision.secrets.SUPABASE_SERVICE_ROLE_KEY,
      ...(provision.secrets.SUPABASE_ANON_KEY ? { SUPABASE_ANON_KEY: provision.secrets.SUPABASE_ANON_KEY } : {}),
      DATABASE_URL: provision.secrets.DATABASE_URL,
      OPENAI_API_KEY: inputs.openaiKey,
      ...(inputs.anthropicKey ? { ANTHROPIC_API_KEY: inputs.anthropicKey } : {}),
      // NOTE: do NOT add SUPABASE_ACCESS_TOKEN here. See AUDIT-RED above.
    });
  } catch (err) {
    fail(err.message);
    return 6;
  }
  ok();

  process.stdout.write(`\n${bold('Provisioned project:')} ${provision.projectUrl}\n`);
  process.stdout.write(`${bold('Project ref:')} ${provision.projectRef}\n\n`);

  // Phase 4 — run init-mnestra --yes for local-side wiring.
  //
  // Sprint 64 T4-CODEX AUDIT-CONCERN 16:27 ET resolution: previously this
  // call passed `['--from-env', '--yes']`, but init-mnestra's `--from-env`
  // branch reads every secret from `process.env` directly (init-mnestra.js
  // around :119-182 `inputsFromEnv()`) and does NOT load secrets.env. The
  // auto-flow just wrote per-project secrets to ~/.termdeck/secrets.env
  // (Phase 3 above) but never exported them into process.env, so the chained
  // `--from-env` call would fail with "missing required environment
  // variable(s)". The fix: pass `['--yes']` only — init-mnestra's
  // `collectInputs({yes:true})` path loads secrets via `loadSavedSecrets()`
  // (init-mnestra.js around :243-268) and auto-confirms reuse when the saved
  // bag is complete. The freshly-written secrets.env is exactly what `--yes`
  // is designed to consume.
  process.stdout.write(`${dim('Wiring local Mnestra config...')}\n`);
  const mnestraCode = await runSubWizard(
    path.join(__dirname, 'init-mnestra.js'),
    ['--yes', ...(flags.dryRun ? ['--dry-run'] : [])]
  );
  if (mnestraCode !== 0) {
    process.stderr.write(`\n[init --auto] init-mnestra exited ${mnestraCode}; provisioned project credentials are saved in ~/.termdeck/secrets.env — re-run with --yes to retry locally.\n`);
    return 7;
  }

  // Phase 5 — run init-rumen --yes (best-effort).
  if (!flags.skipRumen) {
    if (!inputs.anthropicKey) {
      process.stderr.write(`${yellow('[init --auto]')} ANTHROPIC_API_KEY not provided — skipping Rumen Tier 3 setup.\n`);
      process.stderr.write(`${dim('To enable later: add ANTHROPIC_API_KEY to ~/.termdeck/secrets.env, then run: termdeck init --rumen --yes')}\n\n`);
    } else {
      process.stdout.write(`${dim('Wiring Rumen Tier 3 (best-effort — requires `supabase` CLI)...')}\n`);
      try {
        const rumenCode = await runSubWizard(
          path.join(__dirname, 'init-rumen.js'),
          ['--yes', ...(flags.dryRun ? ['--dry-run'] : [])]
        );
        if (rumenCode !== 0) {
          process.stderr.write(`${yellow('[init --auto]')} init-rumen exited ${rumenCode}; Mnestra is healthy, Rumen setup incomplete. To retry: termdeck init --rumen --yes\n`);
        }
      } catch (err) {
        process.stderr.write(`${yellow('[init --auto]')} init-rumen failed: ${err.message}\n`);
        process.stderr.write(`${dim('Mnestra is healthy. To retry Rumen: termdeck init --rumen --yes')}\n\n`);
      }
    }
  }

  // Phase 6 — doctor.
  if (!flags.skipDoctor) {
    process.stdout.write(`\n${dim('Running termdeck doctor...')}\n`);
    try {
      await runSubWizard(path.join(__dirname, 'doctor.js'), []);
    } catch (err) {
      process.stderr.write(`${yellow('[init --auto]')} doctor failed: ${err.message} (non-blocking)\n`);
    }
  }

  // Phase 7 — final ready message.
  printReadyMessage({ projectUrl: provision.projectUrl, rumenSkipped: flags.skipRumen || !inputs.anthropicKey });
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// Manual path.

async function runManualFlow({ flags, osInfo, prompts, dotenv, homedir }) {
  process.stdout.write(`${dim('Path: manual (interactive credential paste)')}\n\n`);

  if (flags.dryRun) {
    step('Manual flow plan (dry-run)');
    ok();
    note('init-mnestra --dry-run would prompt for: Supabase URL, service_role key, DATABASE_URL, OpenAI, Anthropic');
    note('init-rumen --dry-run would prompt for: confirm project ref + deploy functions + apply cron');
    note('doctor --no-schema would version-check the four stack packages');
    return 0;
  }

  // Forward flags to init-mnestra. --reset already dropped secrets.env (above);
  // --from-env makes init-mnestra read everything from process.env.
  const mnestraArgs = [];
  if (flags.fromEnv) mnestraArgs.push('--from-env');
  if (flags.yes) mnestraArgs.push('--yes');
  const mnestraCode = await runSubWizard(path.join(__dirname, 'init-mnestra.js'), mnestraArgs);
  if (mnestraCode !== 0) {
    process.stderr.write(`\n[init] init-mnestra exited ${mnestraCode}\n`);
    return mnestraCode;
  }

  if (!flags.skipRumen) {
    const rumenArgs = [];
    if (flags.yes) rumenArgs.push('--yes');
    try {
      const rumenCode = await runSubWizard(path.join(__dirname, 'init-rumen.js'), rumenArgs);
      if (rumenCode !== 0) {
        process.stderr.write(`${yellow('[init]')} init-rumen exited ${rumenCode}; Mnestra is healthy. To retry: termdeck init --rumen --yes\n`);
      }
    } catch (err) {
      process.stderr.write(`${yellow('[init]')} init-rumen failed: ${err.message}\n`);
      process.stderr.write(`${dim('Mnestra is healthy. To retry: termdeck init --rumen --yes')}\n`);
    }
  }

  if (!flags.skipDoctor) {
    process.stdout.write(`\n${dim('Running termdeck doctor...')}\n`);
    try {
      await runSubWizard(path.join(__dirname, 'doctor.js'), []);
    } catch (err) {
      process.stderr.write(`${yellow('[init]')} doctor failed: ${err.message} (non-blocking)\n`);
    }
  }

  printReadyMessage({ projectUrl: null, rumenSkipped: flags.skipRumen });
  return 0;
}

function printReadyMessage({ projectUrl, rumenSkipped }) {
  process.stdout.write(`\n${green('TermDeck is ready.')}\n\n`);
  if (projectUrl) {
    process.stdout.write(`Supabase dashboard: ${projectUrl}\n`);
  }
  process.stdout.write(`Next steps:\n`);
  process.stdout.write(`  1. Start TermDeck:  ${bold('termdeck')}\n`);
  process.stdout.write(`  2. Dashboard:       http://localhost:3000\n`);
  if (rumenSkipped) {
    process.stdout.write(`  3. Enable Tier 3 (Rumen async learning) later: ${bold('termdeck init --rumen --yes')}\n`);
  }
  process.stdout.write(`\n`);
}

// ─────────────────────────────────────────────────────────────────────────
// Entrypoint.

async function main(argv) {
  const flags = parseFlags(argv || []);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const homedir = os.homedir();
  const osInfo = osDetect.detectOS();
  printBanner(osInfo);

  const setup = loadSetupHelpers();
  const { prompts, dotenv } = setup;

  // Existing install gate. --reset and --from-env bypass the prompt.
  if (!flags.reset && !flags.fromEnv && !flags.dryRun) {
    const existing = probeExistingInstall(homedir);
    if (existing.secretsExists || existing.configExists) {
      const choice = await promptExistingInstallChoice({ prompts, existing });
      if (choice === 'cancel') {
        process.stdout.write('Cancelled.\n');
        return 0;
      }
      if (choice === 'reset') flags.reset = true;
    }
  }

  if (flags.reset && !flags.dryRun) {
    const backup = dropExistingSecrets(homedir);
    if (backup) {
      note(`(backed up existing secrets.env to ${path.basename(backup)})`);
    }
  }

  if (flags.auto) {
    return runAutoFlow({ flags, osInfo, prompts, dotenv, homedir });
  }
  return runManualFlow({ flags, osInfo, prompts, dotenv, homedir });
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      process.stderr.write(`\n[init] unexpected error: ${err && err.stack || err}\n`);
      process.exit(1);
    });
}

module.exports = main;
// Test surface — exposed so tests can pin individual phases without
// spawning the whole wizard.
module.exports.parseFlags = parseFlags;
module.exports.generateDbPassword = generateDbPassword;
module.exports.defaultProjectName = defaultProjectName;
module.exports.probeExistingInstall = probeExistingInstall;
module.exports.collectAutoInputs = collectAutoInputs;
module.exports.runAutoFlow = runAutoFlow;
module.exports.runManualFlow = runManualFlow;
module.exports.HELP = HELP;

#!/usr/bin/env node

// TermDeck CLI launcher
// Usage:
//   termdeck [--port 3000] [--no-open]
//   termdeck init --mnestra [flags]   # Tier 2 memory setup (wired to init-mnestra.js)
//   termdeck init --rumen  [flags]   # Tier 3 async learning deploy
//
// Note (Sprint 3): the `--mnestra` flag name matches the current init-mnestra.js
// filename. When the main orchestrator completes the Mnestra → Mnestra rename
// sweep over this repo, both the flag name and the filename should flip to
// `--mnestra` / `init-mnestra.js` together.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execSync, spawn } = require('child_process');

// Sprint 59 — Brad #1 nohup-secrets bootstrap.
//
// Brad's environment: `nohup termdeck --no-stack ...` from a shell that has
// NOT sourced ~/.termdeck/secrets.env. In-process `setenv()` (which Node's
// loadSecretsEnv() uses) updates libc's `environ` pointer but does NOT
// propagate to /proc/<pid>/environ on Linux glibc — the kernel reads from
// the env_start..env_end memory range fixed at execve() time, and new keys
// added via setenv() get heap-allocated outside that range. A probe that
// introspects /proc therefore sees the empty initial env.
//
// Fix: when launched in non-TTY mode (nohup detaches stdin/stdout/stderr)
// AND secrets.env exists with at least one key not already in process.env,
// spawn a detached child node with the merged env and exit the parent. The
// child's /proc/<pid>/environ contains the merged keys because spawn() goes
// through fork+execve(), which sets the kernel env range with the new env.
//
// Guards (must ALL be true to spawn-and-exit):
//   1. __TERMDECK_BOOTSTRAPPED env marker absent (we're the original entry,
//      not the re-execed child).
//   2. argv[0] is NOT a subcommand we hand off (`init`, `forge`, `doctor`,
//      `stack`). Those subcommands have their own env-loading paths
//      (init's --from-env, doctor's dotenv-io reader, stack's loadSecrets)
//      and run interactively under piped stdio in tests / CI. Brad's bug
//      is specifically the default server-launch path; bootstrap there.
//   3. neither stdout nor stderr is a TTY (interactive `termdeck` keeps the
//      legacy in-process loadSecretsEnv path so Ctrl+C / signal handling /
//      user-visible boot output stay attached to the user's terminal).
//   4. argv does NOT include --service or --non-interactive (T2 owns those
//      flags for systemd Type=simple; that path runs in foreground so
//      systemd's cgroup-tracked main process stays alive).
//   5. ~/.termdeck/secrets.env exists.
//   6. parsing the file yields at least one key that is NOT already in
//      process.env (don't clobber pre-set shell vars; user env wins).
function maybeBootstrapAndDetach() {
  if (process.env.__TERMDECK_BOOTSTRAPPED === '1') {
    delete process.env.__TERMDECK_BOOTSTRAPPED;
    return false;
  }
  const argv = process.argv.slice(2);
  const SKIP_SUBCOMMANDS = new Set(['init', 'forge', 'doctor', 'stack']);
  if (argv.length > 0 && SKIP_SUBCOMMANDS.has(argv[0])) return false;
  if (process.stdout.isTTY || process.stderr.isTTY) return false;
  const argvSet = new Set(argv);
  if (argvSet.has('--service') || argvSet.has('--non-interactive')) return false;
  const secretsPath = path.join(os.homedir(), '.termdeck', 'secrets.env');
  if (!fs.existsSync(secretsPath)) return false;

  let raw;
  try { raw = fs.readFileSync(secretsPath, 'utf-8'); }
  catch (_e) { return false; }

  const merged = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    }
    // Sprint 59 T4-CODEX residual fix: file value fills when parent env is undefined
    // OR empty string (Brad's actual failure shape includes parent env present-but-blank,
    // not only missing entirely). Non-empty parent env still wins.
    if (process.env[key] === undefined || process.env[key] === '') merged[key] = val;
  }
  if (Object.keys(merged).length === 0) return false;

  const env = { ...process.env, ...merged, __TERMDECK_BOOTSTRAPPED: '1' };
  const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
  // Parent exits immediately. The fixture's TD_PID points at the parent
  // process; once the parent dies, /proc/<TD_PID>/environ becomes unreadable
  // and the fixture's pgrep fallback finds the child (which has the merged
  // env in its /proc/<pid>/environ via execve). The child keeps running.
  process.exit(0);
}

maybeBootstrapAndDetach();

// Sprint 35 T4: stale-port reclaim. If the target port is held by a previous
// TermDeck instance (crash, runaway, prior `termdeck` left orphaned), kill it
// and continue. If it's held by something else, print a clear error and exit
// instead of letting `server.listen()` throw a generic EADDRINUSE.
// Lifted from scripts/start.sh:127–154 so npm-installed users (who never see
// start.sh) get the same recovery behavior.
function reclaimStalePort(port) {
  let pids = [];
  try {
    const out = execSync(`lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' });
    pids = out.split(/\s+/).filter(Boolean);
  } catch (_e) {
    // lsof exits 1 when no PIDs match — empty case, not an error.
    pids = [];
  }
  if (pids.length === 0) {
    // Linux fallback for systems without lsof
    try {
      const out = execSync(`fuser -n tcp ${port} 2>/dev/null`, { encoding: 'utf8' });
      pids = out.split(/\s+/).filter((s) => /^\d+$/.test(s));
    } catch (_e) { pids = []; }
  }
  if (pids.length === 0) return;

  let isTermDeck = false;
  for (const pid of pids) {
    try {
      const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' });
      if (/packages\/cli\/src\/index\.js/.test(cmd) || /termdeck/i.test(cmd)) {
        isTermDeck = true;
        break;
      }
    } catch (_e) { /* PID gone between lsof and ps — ignore */ }
  }

  if (isTermDeck) {
    // Liveness probe — never kill a TermDeck that's actively serving requests.
    // A responsive /api/sessions means it's the orchestrator's live server, and
    // killing it cascades to every child PTY. This was the actual root cause of
    // four Sprint 36 server-kill incidents on 2026-04-27 (a sibling reclaimPort
    // in stack.js had the same flaw and was already patched; this twin in the
    // CLI entry was missed). Mirror of stack.js:isTermDeckLive.
    let alreadyLive = false;
    try {
      const probe = execSync(`curl -sf -m 1.5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}/api/sessions 2>/dev/null`, { encoding: 'utf8' });
      if (probe.trim() === '200') alreadyLive = true;
    } catch (_e) { /* curl missing or non-200 → treat as stale */ }

    if (alreadyLive) {
      console.log(`  \x1b[2m[port] :${port} held by live TermDeck (PIDs: ${pids.join(' ')}) — not killing. Use --port <other> for a second instance.\x1b[0m`);
      process.exit(0); // graceful exit; don't try to bind a port that's already serving
    }

    console.log(`  \x1b[2m[port] Reclaiming :${port} from stale TermDeck (PIDs: ${pids.join(' ')})\x1b[0m`);
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch (_e) {}
    }
    try { execSync('sleep 1'); } catch (_e) {}
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10), 'SIGKILL'); } catch (_e) {}
    }
  } else {
    console.error(`\n  \x1b[31m✗ Port ${port} is in use by a non-TermDeck process (PIDs: ${pids.join(' ')})\x1b[0m`);
    console.error(`  \x1b[2mTry a different port: termdeck --port ${port + 1}\x1b[0m\n`);
    process.exit(1);
  }
}

// Sprint 35 T4: transcript-table-missing hint. If DATABASE_URL is set and
// psql is on PATH, probe for termdeck_transcripts. Fire-and-forget so a slow
// network round-trip to Supabase never blocks boot. Lifted from
// scripts/start.sh:309–313.
function checkTranscriptTableHint(databaseUrl) {
  if (!databaseUrl) return;
  try { execSync('command -v psql', { stdio: 'ignore' }); } catch (_e) { return; }
  exec('psql "$DATABASE_URL" -c "SELECT 1 FROM termdeck_transcripts LIMIT 0"', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 5000,
  }, (err) => {
    if (err) {
      console.log(`  \x1b[33m[hint]\x1b[0m Transcript backup table missing. Run: \x1b[1mtermdeck doctor\x1b[0m (or psql $DATABASE_URL -f config/transcript-migration.sql)`);
    }
  });
}

// Parse CLI args
const args = process.argv.slice(2);

// Sprint 56 (T1 Cell 18) — `--version` / `-v` handler. Pre-Sprint-56 the
// flag was silently ignored: the CLI fell through to the launcher's stack
// boot path and never printed a version. Now mirror the convention every
// CLI in the world honors: print the package version and exit 0. Done
// BEFORE the `init` dispatch so `termdeck --version init --mnestra`
// (nonsensical but unambiguous) still terminates with the version.
if (args.includes('--version') || args.includes('-v')) {
  const pkg = require(path.join(__dirname, '..', '..', '..', 'package.json'));
  process.stdout.write(`@jhizzard/termdeck v${pkg.version}\n`);
  process.exit(0);
}

// Subcommand dispatch — handle `termdeck init [--mnestra|--rumen|--project|--auto|--mcp-supabase]`
// before falling through to the default launcher's flag parsing. The `require`
// of init-*.js is lazy so users running the normal `termdeck` command never
// pay the cost of loading pg / supabase helpers at startup.
//
// Sprint 64 T1: added the no-subflag default (`termdeck init` with no mode
// argument or with `--auto` / `--mcp-supabase`) routing to the new
// `init.js` top-level orchestrator. The orchestrator runs init-mnestra
// then init-rumen with a unified UX. `--auto` drives MCP-mediated
// auto-provisioning. Existing modes (--mnestra / --rumen / --project)
// stay callable independently for advanced users + CI fixtures.
if (args[0] === 'init') {
  const mode = args[1];
  const rest = args.slice(2);

  // Sprint 37 T2 + Sprint 64 T1: refuse explicit-mode-mixing. The dispatch picks
  // args[1] as the single mode flag, but a user who writes `init --project foo --mnestra`
  // probably intended only one of those. Surface the conflict instead of
  // silently picking the first. The `--auto` / `--mcp-supabase` flags are
  // NOT in this list — they're handled by init.js (the orchestrator) and
  // can co-exist with init.js's own flag set.
  const MODES = ['--project', '--mnestra', '--rumen'];
  const presentModes = MODES.filter((m) => args.slice(1).includes(m));
  if (presentModes.length > 1) {
    console.error(`[cli] init: pass only one of ${MODES.join(' | ')}; got ${presentModes.join(' + ')}`);
    process.exit(1);
  }

  const run = (modPath, argv) => {
    const fn = require(modPath);
    return fn(argv).then((code) => process.exit(code || 0));
  };
  if (mode === '--mnestra') {
    run(path.join(__dirname, 'init-mnestra.js'), rest).catch((err) => {
      console.error('[cli] init --mnestra failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  if (mode === '--rumen') {
    run(path.join(__dirname, 'init-rumen.js'), rest).catch((err) => {
      console.error('[cli] init --rumen failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  if (mode === '--project') {
    // init-project takes the project name as its first positional arg, plus
    // optional --dry-run / --force flags. Pass `rest` straight through.
    run(path.join(__dirname, 'init-project.js'), rest).catch((err) => {
      console.error('[cli] init --project failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }

  // Sprint 64 T1: default (no mode) OR `--auto` / `--mcp-supabase` → route to
  // the unified orchestrator at init.js. It runs init-mnestra + init-rumen +
  // doctor with a single progress UX. Forward ALL post-`init` args (mode
  // arg included so init.js parses --auto / --mcp-supabase itself).
  const orchestratorArgs = args.slice(1);
  if (mode === undefined || mode === '--auto' || mode === '--mcp-supabase'
      || (typeof mode === 'string' && mode.startsWith('-') && mode !== '-h')) {
    // The leading-dash check catches things like `--help`, `--reset`,
    // `--from-env`, `--dry-run` etc. — those are init.js orchestrator flags,
    // not unknown sub-modes. Route to init.js with them intact.
    run(path.join(__dirname, 'init.js'), orchestratorArgs).catch((err) => {
      console.error('[cli] init failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  // `-h` alone after `init` → orchestrator help
  if (mode === '-h') {
    run(path.join(__dirname, 'init.js'), ['--help']).catch((err) => {
      console.error('[cli] init failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  console.error('Usage: termdeck init [--auto] | --mnestra | --rumen | --project <name>');
  console.error('  termdeck init                       Unified setup (Mnestra + Rumen + doctor)');
  console.error('  termdeck init --auto                Auto-provision via Supabase MCP (alias: --mcp-supabase)');
  console.error('  termdeck init --mnestra             Configure Tier 2 memory (Supabase + Mnestra)');
  console.error('  termdeck init --rumen               Deploy Tier 3 async learning (Rumen)');
  console.error('  termdeck init --project <name>      Scaffold a new project with CLAUDE.md + orchestration docs');
  console.error('  termdeck init --help                Show full flag reference');
  process.exit(1);
}

// `termdeck forge` — Sprint 20 SkillForge preview. Autonomously generates
// Claude Code skills from Mnestra memories. Lazy-loaded so the launcher
// startup path stays unaffected.
if (args[0] === 'forge') {
  const forge = require(path.join(__dirname, 'forge.js'));
  forge(args.slice(1)).then((code) => process.exit(code || 0)).catch((err) => {
    console.error('[cli] forge failed:', err && err.stack || err);
    process.exit(1);
  });
  return;
}

// `termdeck stack` — full-stack launcher (Node port of scripts/start.sh).
// Boots Mnestra (if installed + autoStart: true), checks Rumen, then
// starts TermDeck. Lives in the npm package so users who installed via
// `npm install -g @jhizzard/termdeck` don't need to clone the repo to
// get the start.sh experience.
if (args[0] === 'stack') {
  const stack = require(path.join(__dirname, 'stack.js'));
  stack(args.slice(1)).then((code) => process.exit(code || 0)).catch((err) => {
    console.error('[cli] stack failed:', err && err.stack || err);
    process.exit(1);
  });
  return;
}

// `termdeck doctor` — Sprint 28: version-check the whole stack.
if (args[0] === 'doctor') {
  const doctor = require(path.join(__dirname, 'doctor.js'));
  doctor(args.slice(1)).then((code) => process.exit(code || 0)).catch((err) => {
    console.error('[cli] doctor failed:', err && err.stack || err);
    process.exit(2);
  });
  return;
}

// Sprint 24: when `termdeck` is invoked with no subcommand AND a configured
// stack is detected, route through stack.js so users don't have to remember
// the `stack` subcommand. `--no-stack` is the explicit opt-out.
const { shouldAutoOrchestrate } = require(path.join(__dirname, 'auto-orchestrate.js'));

const KNOWN_SUBCOMMANDS = new Set(['init', 'forge', 'stack', 'doctor']);
const noStackIdx = args.indexOf('--no-stack');
const noStackRequested = noStackIdx !== -1;
if (noStackRequested) args.splice(noStackIdx, 1); // strip before flag parsing

// Sprint 59 T2 — Brad #7: --service / --non-interactive flag for systemd
// Type=simple deployment. When set, the launcher must (a) skip browser
// auto-open (no DISPLAY in service contexts), (b) bypass the auto-orchestrate
// child-spawn detour so ExecStart=/usr/local/bin/termdeck --service blocks
// for the lifetime of the server (Type=simple sees an active foreground
// process), (c) be tolerated everywhere `--no-stack` is. Strip both aliases
// repeatedly so duplicates don't survive into the flag-parsing loop.
let serviceMode = false;
while (true) {
  const idx = args.findIndex((a) => a === '--service' || a === '--non-interactive');
  if (idx === -1) break;
  serviceMode = true;
  args.splice(idx, 1);
}

const wantsHelp = args.includes('--help') || args.includes('-h');

if (!KNOWN_SUBCOMMANDS.has(args[0]) && !noStackRequested && !serviceMode && !wantsHelp && shouldAutoOrchestrate()) {
  const stack = require(path.join(__dirname, 'stack.js'));
  stack(args).then((code) => process.exit(code || 0)).catch((err) => {
    console.error('[cli] auto-stack failed:', err && err.stack || err);
    process.exit(1);
  });
  return;
}

const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    flags.port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--no-open') {
    flags.noOpen = true;
  } else if (args[i] === '--session-logs') {
    flags.sessionLogs = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
  TermDeck - Web-based terminal multiplexer

  Usage:
    termdeck                    Auto-orchestrate stack if configured, else Tier-1-only
    termdeck stack              Force boot Mnestra + check Rumen + start TermDeck
    termdeck --no-stack         Skip orchestrator (force Tier-1-only boot)
    termdeck --service          Non-interactive foreground mode for systemd Type=simple
                                (alias: --non-interactive; implies --no-stack + --no-open)
    termdeck --port 8080        Start on custom port
    termdeck --no-open          Don't auto-open browser
    termdeck --session-logs     Write per-session markdown logs to ~/.termdeck/sessions/
    termdeck init --mnestra     Configure Tier 2 memory (Supabase + Mnestra)
    termdeck init --rumen       Deploy Tier 3 async learning (Rumen)
    termdeck init --project NAME  Scaffold a new project with CLAUDE.md + orchestration docs (--dry-run, --force)
    termdeck forge              Generate Claude skills from memories (experimental)
    termdeck doctor             Diagnose stack — npm versions + Supabase schema (use --no-schema to skip the DB probe)

  Keyboard shortcuts (in browser):
    Ctrl+Shift+N                Focus prompt bar
    Ctrl+Shift+1-6              Switch layout (1x1 → 4x2)
    Ctrl+Shift+] / [            Next / previous terminal
    Escape                      Exit focus/half mode

  Config:
    ~/.termdeck/config.yaml     Server + project + RAG configuration
    ~/.termdeck/secrets.env     API keys (OpenAI, Anthropic, Supabase)
    ~/.termdeck/termdeck.db     Session history (SQLite)
`);
    process.exit(0);
  }
}

// Load and start server
const { createServer, loadConfig } = require(path.join(__dirname, '..', '..', 'server', 'src', 'index.js'));
const { runPreflight, printHealthBanner } = require(path.join(__dirname, '..', '..', 'server', 'src', 'preflight'));

// Flag-driven env vars must be set BEFORE loadConfig() so any module that
// reads process.env at require-time sees them.
if (flags.sessionLogs) {
  process.env.TERMDECK_SESSION_LOGS = '1';
}

// Sprint 59 T2 — Brad #7: --service implies --no-open. The browser auto-open
// path runs `xdg-open` / `open` which has no meaning under systemd (no
// DISPLAY) and would just dump a non-fatal error to stderr/journalctl every
// boot. Honoring serviceMode here is in addition to the auto-orchestrate
// bypass above — a user could pass `--no-stack --service` and we still want
// noOpen to win.
if (serviceMode) {
  flags.noOpen = true;
}

// First-run detection (Sprint 19 T3): surface a one-line hint pointing at
// the setup wizard when no config.yaml exists yet. Check happens before
// loadConfig() so the message reflects on-disk state, not defaults.
const firstRun = !fs.existsSync(path.join(os.homedir(), '.termdeck', 'config.yaml'));

const config = loadConfig();
if (flags.port) config.port = flags.port;
else if (process.env.TERMDECK_PORT) config.port = parseInt(process.env.TERMDECK_PORT, 10);
if (flags.sessionLogs) {
  config.sessionLogs = { ...(config.sessionLogs || {}), enabled: true };
  console.log('[cli] session logs enabled — writing to ~/.termdeck/sessions/ on panel exit');
}

const { server } = createServer(config);
const port = config.port || 3000;
const host = config.host || '127.0.0.1';
const url = `http://${host}:${port}`;

// Sprint 35 T4: reclaim the port if a previous TermDeck is squatting on it,
// or hard-stop with a useful hint if a non-TermDeck process holds it. Runs
// before server.listen() so EADDRINUSE never bubbles up.
reclaimStalePort(port);

// Bind guardrail: refuse non-loopback without auth token
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(host)) {
  const authToken = config.auth?.token || process.env.TERMDECK_AUTH_TOKEN;
  if (!authToken) {
    console.error('[security] Refusing to bind to ' + host + ' without auth.token set.');
    console.error('[security] Set auth.token in ~/.termdeck/config.yaml or TERMDECK_AUTH_TOKEN env var.');
    console.error('[security] To bind locally only, set host: 127.0.0.1 in config.yaml');
    process.exit(1);
  }
}

// Sprint 25 T4: non-blocking nudge when RAG is configured but the Supabase MCP
// (T1's `@supabase/mcp-server-supabase` detection) isn't installed. Lazy-loads
// T1's module so Tier 1 users with no RAG never pay the require cost. Silent
// when RAG is off, when the MCP is detected, when the MCP config (canonical
// ~/.claude.json or legacy ~/.claude/mcp.json) already declares a `supabase`
// server, or when anything below throws.
//
// Sprint 36 T2: read order is canonical → legacy. Claude Code v2.1.119+ reads
// only the canonical file; the legacy fallback covers users who haven't yet
// migrated and pinned other tooling to the old path.
async function checkSupabaseMcpHint(cfg) {
  if (!cfg || !cfg.rag || cfg.rag.enabled !== true) return null;
  try {
    const { CLAUDE_MCP_PATH_CANONICAL, CLAUDE_MCP_PATH_LEGACY, readMcpServers } = require('./mcp-config');
    for (const candidate of [CLAUDE_MCP_PATH_CANONICAL, CLAUDE_MCP_PATH_LEGACY]) {
      const read = readMcpServers(candidate);
      if (read.servers && read.servers.supabase) return null;
    }
    const { detectMcp } = require(path.join(__dirname, '..', '..', 'server', 'src', 'setup', 'supabase-mcp.js'));
    const result = await detectMcp();
    if (result && result.available) return null;
    return 'Supabase MCP not installed — wizard auto-fill unavailable. Install with: npx @jhizzard/termdeck-stack --tier 4';
  } catch (_e) {
    return null;
  }
}

server.listen(port, host, async () => {
  // Box inner width is 38 (count of ═ between ╔ and ╗). Center the title
  // dynamically so the right border stays aligned regardless of version length.
  const innerWidth = 38;
  const version = require(path.join(__dirname, '..', '..', '..', 'package.json')).version;
  const title = `TermDeck v${version}`;
  const leftPad = Math.max(0, Math.floor((innerWidth - title.length) / 2));
  const titleLine = ' '.repeat(leftPad) + title + ' '.repeat(Math.max(0, innerWidth - leftPad - title.length));

  console.log(`
  ╔══════════════════════════════════════╗
  ║${titleLine}║
  ╠══════════════════════════════════════╣
  ║  ${url.padEnd(34)}  ║
  ║                                      ║
  ║  Ctrl+C to stop                      ║
  ╚══════════════════════════════════════╝
  `);

  // Sprint 35 T4: RAG state line. Always-visible indicator of what mode the
  // user is in — MCP-only (the new default after Sprint 35 T1) or full RAG
  // writing to mnestra_*_memory tables. Dim line, single sentence.
  if (config.rag && config.rag.enabled === true) {
    console.log(`  \x1b[2mRAG: on — events syncing to mnestra_session_memory / mnestra_project_memory / mnestra_developer_memory\x1b[0m\n`);
  } else {
    console.log(`  \x1b[2mRAG: off (MCP-only mode) — toggle in dashboard at ${url}/#config to enable session/project/developer memory tables\x1b[0m\n`);
  }

  if (firstRun) {
    console.log("  First run detected. Open http://localhost:3000 and click 'config' to set up.\n");
  }

  // Sprint 35 T4: probe Supabase for the transcript backup table; print a
  // hint if it's missing. Non-blocking — the result lands after the banner.
  checkTranscriptTableHint(process.env.DATABASE_URL || (config.rag && config.rag.databaseUrl));

  // Run preflight health checks (non-blocking — warn but don't prevent startup)
  runPreflight(config).then((result) => {
    printHealthBanner(result);
  }).catch((err) => {
    console.error(`  \x1b[31m[health] Preflight failed: ${err.message}\x1b[0m\n`);
  });

  // Sprint 28 T3: fire-and-forget update-check banner. Lazy-required so users
  // who never start the server don't pay the require cost. Errors are swallowed
  // inside the module; never blocks startup. Double-protected (try/catch around
  // the require + swallowed .catch on the promise) so a missing or broken T3
  // module can never break startup.
  try {
    const { checkAndPrintHint } = require(path.join(__dirname, 'update-check.js'));
    checkAndPrintHint(config).catch(() => { /* swallowed inside the module too */ });
  } catch (_e) { /* never block startup on a hint module load failure */ }

  // Sprint 25 T4: Supabase MCP install nudge — runs alongside (not inside)
  // runPreflight. Silent unless RAG is on AND the MCP is missing AND the
  // user hasn't already declared it in ~/.claude/mcp.json.
  checkSupabaseMcpHint(config).then((msg) => {
    if (msg) console.log(`  \x1b[33m[hint]\x1b[0m ${msg}`);
  }).catch(() => { /* silent */ });

  // Skip auto-open in Codespaces/CI (port forwarding handles it)
  const isCodespaces = !!process.env.CODESPACES || !!process.env.GITHUB_CODESPACE_TOKEN;
  const isCI = !!process.env.CI;

  if (!flags.noOpen && !isCodespaces && !isCI) {
    try {
      const { platform } = require('os');
      const cmd = platform() === 'darwin' ? 'open'
        : platform() === 'win32' ? 'start'
        : 'xdg-open';
      execSync(`${cmd} ${url}`, { stdio: 'ignore' });
    } catch (err) {
      console.error('[cli] auto-open browser failed:', err.message);
      console.log(`  Open ${url} in your browser\n`);
    }
  } else if (isCodespaces) {
    console.log(`  Codespaces detected — use the Ports tab to open the browser\n`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down TermDeck...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
});

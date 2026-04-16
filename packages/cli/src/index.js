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
const { execSync } = require('child_process');

// Parse CLI args
const args = process.argv.slice(2);

// Subcommand dispatch — handle `termdeck init --mnestra|--rumen` before
// falling through to the default launcher's flag parsing. The `require` of
// init-*.js is lazy so users running the normal `termdeck` command never pay
// the cost of loading pg / supabase helpers at startup.
if (args[0] === 'init') {
  const mode = args[1];
  const rest = args.slice(2);
  const run = (modPath) => {
    const fn = require(modPath);
    return fn(rest).then((code) => process.exit(code || 0));
  };
  if (mode === '--mnestra') {
    run(path.join(__dirname, 'init-mnestra.js')).catch((err) => {
      console.error('[cli] init --mnestra failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  if (mode === '--rumen') {
    run(path.join(__dirname, 'init-rumen.js')).catch((err) => {
      console.error('[cli] init --rumen failed:', err && err.stack || err);
      process.exit(1);
    });
    return;
  }
  console.error('Usage: termdeck init --mnestra | --rumen');
  console.error('  termdeck init --mnestra   Configure Tier 2 memory (Supabase + Mnestra)');
  console.error('  termdeck init --rumen    Deploy Tier 3 async learning (Rumen)');
  process.exit(1);
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
    termdeck                    Start with defaults (port 3000)
    termdeck --port 8080        Start on custom port
    termdeck --no-open          Don't auto-open browser
    termdeck --session-logs     Write per-session markdown logs to ~/.termdeck/sessions/
    termdeck init --mnestra      Configure Tier 2 memory (Supabase + Mnestra)
    termdeck init --rumen       Deploy Tier 3 async learning (Rumen)

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

const config = loadConfig();
if (flags.port) config.port = flags.port;
if (flags.sessionLogs) {
  config.sessionLogs = { ...(config.sessionLogs || {}), enabled: true };
  console.log('[cli] session logs enabled — writing to ~/.termdeck/sessions/ on panel exit');
}

const { server } = createServer(config);
const port = config.port || 3000;
const host = config.host || '127.0.0.1';
const url = `http://${host}:${port}`;

server.listen(port, host, async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║            TermDeck v0.2.0           ║
  ╠══════════════════════════════════════╣
  ║  ${url.padEnd(34)}  ║
  ║                                      ║
  ║  Ctrl+C to stop                      ║
  ╚══════════════════════════════════════╝
  `);

  // Run preflight health checks (non-blocking — warn but don't prevent startup)
  runPreflight(config).then((result) => {
    printHealthBanner(result);
  }).catch((err) => {
    console.error(`  \x1b[31m[health] Preflight failed: ${err.message}\x1b[0m\n`);
  });

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

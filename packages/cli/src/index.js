#!/usr/bin/env node

// TermDeck CLI launcher
// Usage: termdeck [--port 3000] [--no-open]

const path = require('path');
const { execSync } = require('child_process');

// Parse CLI args
const args = process.argv.slice(2);
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

  Keyboard shortcuts (in browser):
    Ctrl+Shift+N                Focus prompt bar
    Ctrl+Shift+1-6              Switch layout (1x1 → 4x2)
    Ctrl+Shift+] / [            Next / previous terminal
    Escape                      Exit focus/half mode

  Config:
    ~/.termdeck/config.yaml     Server + project + RAG configuration
    ~/.termdeck/termdeck.db     Session history (SQLite)
`);
    process.exit(0);
  }
}

// Load and start server
const { createServer, loadConfig } = require(path.join(__dirname, '..', '..', 'server', 'src', 'index.js'));

const config = loadConfig();
if (flags.port) config.port = flags.port;
if (flags.sessionLogs) {
  config.sessionLogs = { ...(config.sessionLogs || {}), enabled: true };
}

const { server } = createServer(config);
const port = config.port || 3000;
const host = config.host || '127.0.0.1';
const url = `http://${host}:${port}`;

server.listen(port, host, async () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║            TermDeck v0.1.0           ║
  ╠══════════════════════════════════════╣
  ║  ${url.padEnd(36)} ║
  ║                                      ║
  ║  Ctrl+C to stop                      ║
  ╚══════════════════════════════════════╝
  `);

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

#!/usr/bin/env node

// @jhizzard/termdeck-stack launcher subcommands — Sprint 48 T4.
//
// Ports the canonical `scripts/start.sh` flow into a globally-installable
// JS entry point so users who installed via `npm i -g @jhizzard/termdeck-stack`
// can boot the full stack without cloning the repo.
//
// Public API:
//   startStack(opts)   → boots mnestra (if installed) + termdeck, writes pidfile.
//   stopStack(opts)    → reads pidfile, SIGTERMs each pid, removes pidfile.
//   statusStack(opts)  → probes health endpoints + reports component state.
//
// All three are async and accept an `opts` object whose shape is documented
// inline. Each one writes step-line output to stdout in the same aesthetic
// as scripts/start.sh — the user-facing UX is intentionally familiar.
//
// Dependency injection: each function takes an optional `_deps` field on
// opts so unit tests can stub spawn/fetch/fs without monkey-patching.
// Default deps wire to the real Node built-ins.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child_process = require('node:child_process');

const HOME = os.homedir();
const TERMDECK_DIR = path.join(HOME, '.termdeck');
const SECRETS_PATH = path.join(TERMDECK_DIR, 'secrets.env');
const CONFIG_PATH = path.join(TERMDECK_DIR, 'config.yaml');
const PID_PATH = path.join(TERMDECK_DIR, 'stack.pid');
const MNESTRA_LOG_PATH = '/tmp/termdeck-mnestra.log';
const TERMDECK_LOG_PATH = '/tmp/termdeck-server.log';

const DEFAULT_PORT = 3000;
const DEFAULT_MNESTRA_PORT = 37778;
const HEALTH_TIMEOUT_MS = 1000;
const HEALTH_RETRIES = 10;

const ANSI = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};

// Parses ~/.termdeck/secrets.env into a plain object. Same contract as
// stack-installer/src/index.js#readTermdeckSecrets — duplicated here rather
// than imported because launcher.js is a distinct entry point and circular
// requires complicate the subcommand-dispatch flow in index.js.
function readSecrets(filePath = SECRETS_PATH, _fs = fs) {
  try {
    const text = _fs.readFileSync(filePath, 'utf8');
    const out = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      if (v.startsWith('${') && v.endsWith('}')) continue;
      out[m[1]] = v;
    }
    return out;
  } catch (_err) {
    return {};
  }
}

// Resolves a binary on PATH. Returns the absolute path or null. Uses
// `which` so the launcher behaves identically across darwin/linux without
// shelling out to bash. Falls back to checking spawn output exit code.
function whichBinary(name, _spawnSync = child_process.spawnSync) {
  const r = _spawnSync('which', [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout) {
    const trimmed = r.stdout.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Resolves mnestra invocation: prefers global binary, falls back to the
// ~/Documents/Graciella/engram dev checkout (matches scripts/start.sh).
function resolveMnestraInvocation(_deps = {}) {
  const which = _deps.whichBinary || whichBinary;
  const _fs = _deps.fs || fs;
  const onPath = which('mnestra');
  if (onPath) return { command: 'mnestra', args: ['serve'], origin: 'path' };
  const devCheckout = path.join(HOME, 'Documents', 'Graciella', 'engram', 'dist', 'mcp-server', 'index.js');
  if (_fs.existsSync(devCheckout)) {
    return { command: 'node', args: [devCheckout, 'serve'], origin: 'dev-checkout' };
  }
  return null;
}

function step(stepLabel, label, status, detail) {
  const colors = { OK: ANSI.green, WARN: ANSI.yellow, SKIP: ANSI.dim, FAIL: ANSI.red, BOOT: ANSI.green };
  const tag = `${colors[status] || ''}${status}${ANSI.reset}`;
  const dots = '.'.repeat(Math.max(3, 52 - `Step ${stepLabel}: ${label} `.length));
  const out = `Step ${stepLabel}: ${label} ${ANSI.dim}${dots}${ANSI.reset} ${tag}${detail ? `  ${ANSI.dim}${detail}${ANSI.reset}` : ''}\n`;
  process.stdout.write(out);
}

async function probeHealth(url, _fetch = globalThis.fetch) {
  try {
    const res = await _fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json().catch(() => ({}));
    return { ok: true, body: json };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function waitForHealth(url, retries = HEALTH_RETRIES, _fetch = globalThis.fetch) {
  for (let i = 0; i < retries; i++) {
    const r = await probeHealth(url, _fetch);
    if (r.ok) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, error: 'timeout' };
}

function ensureFirstRunConfig(_fs = fs) {
  if (_fs.existsSync(CONFIG_PATH)) return false;
  _fs.mkdirSync(TERMDECK_DIR, { recursive: true });
  const minimal = [
    '# TermDeck config (auto-generated on first run by termdeck-stack start)',
    '# Full reference: config/config.example.yaml in the TermDeck repo.',
    '',
    `port: ${DEFAULT_PORT}`,
    'host: 127.0.0.1',
    'shell: /bin/zsh',
    '',
    'defaultTheme: tokyo-night',
    '',
    'mnestra:',
    '  autoStart: true',
    '',
    'projects:',
    '',
    'rag:',
    '  enabled: false',
    '  syncIntervalMs: 10000',
    '',
    'sessionLogs:',
    '  enabled: false',
    ''
  ].join('\n');
  _fs.writeFileSync(CONFIG_PATH, minimal);
  return true;
}

// Sprint 49 T4 — walk up from the resolved `termdeck` binary to find the
// installed `@jhizzard/termdeck` package root and require its agent-adapter
// registry + mcp-autowire helper. The installer is a zero-dep package (no
// `dependencies` field in package.json) so we cannot require these by package
// name; instead we resolve by absolute path. Works for both global installs
// (`/usr/local/lib/node_modules/@jhizzard/termdeck/...`) and dev checkouts
// where the binary symlinks back into the source tree. Returns null when the
// adapter tree isn't reachable — caller skips auto-wire with a warning.
function loadTermdeckExports(termdeckBinary, _fs = fs) {
  if (!termdeckBinary) return null;
  let realPath;
  try { realPath = _fs.realpathSync(termdeckBinary); }
  catch (_) { return null; }
  let dir = path.dirname(realPath);
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (_fs.existsSync(pkgPath)) {
      let pkg;
      try { pkg = JSON.parse(_fs.readFileSync(pkgPath, 'utf8')); }
      catch (_) { pkg = null; }
      if (pkg && pkg.name === '@jhizzard/termdeck') {
        const adaptersPath = path.join(dir, 'packages/server/src/agent-adapters');
        const autowirePath = path.join(dir, 'packages/server/src/mcp-autowire.js');
        if (_fs.existsSync(adaptersPath) && _fs.existsSync(autowirePath)) {
          try {
            const adaptersMod = require(adaptersPath);
            const autowireMod = require(autowirePath);
            return {
              adapters: adaptersMod.AGENT_ADAPTERS,
              ensureMnestraBlock: autowireMod.ensureMnestraBlock,
              packageRoot: dir,
            };
          } catch (_) { return null; }
        }
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Sprint 49 T4 — iterates an adapter registry (record or array) and calls
// `ensureMnestraBlock(adapter, opts)` for each adapter that declares a non-null
// `mcpConfig`. Adapters with `mcpConfig: null` (Claude — user-managed via
// `claude mcp add`) are skipped without invoking the helper. Helper exceptions
// on a single adapter don't abort the loop — they're captured under
// `errored[]` so the launcher can continue with the remaining adapters and
// surface diagnostics in the step line.
//
// Returns { wired: string[], unchanged: string[], skipped: string[],
//           errored: { name, error }[] } — caller renders a one-line summary.
// Idempotent: a second call against an already-wired environment shifts every
// adapter from `wired` to `unchanged` because the helper's per-shape
// detect-existing branches return `{ unchanged: true }` on no-op writes.
function autowireMcp(adapters, ensureMnestraBlockFn, opts = {}) {
  const summary = { wired: [], unchanged: [], skipped: [], errored: [] };
  if (!adapters || typeof ensureMnestraBlockFn !== 'function') return summary;
  const list = Array.isArray(adapters) ? adapters : Object.values(adapters);
  for (const adapter of list) {
    const name = (adapter && adapter.name) || '<unknown>';
    if (!adapter || !adapter.mcpConfig) {
      summary.skipped.push(name);
      continue;
    }
    let result;
    try {
      result = ensureMnestraBlockFn(adapter, opts);
    } catch (err) {
      summary.errored.push({ name, error: err && err.message ? err.message : String(err) });
      continue;
    }
    if (result && result.wrote) summary.wired.push(name);
    else if (result && result.unchanged) summary.unchanged.push(name);
    else summary.skipped.push(name);
  }
  return summary;
}

function spawnDetached(command, args, logPath, env, _spawn = child_process.spawn, _fs = fs) {
  // open() the log file then pass the fd to spawn so the child inherits a
  // real disk-backed stdout/stderr. Close our handle after spawn so we
  // don't keep an extra fd open.
  const fd = _fs.openSync(logPath, 'a');
  try {
    const child = _spawn(command, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    });
    child.unref();
    return child;
  } finally {
    try { _fs.closeSync(fd); } catch (_e) { /* best effort */ }
  }
}

async function startStack(opts = {}) {
  const _deps = opts._deps || {};
  const _fs = _deps.fs || fs;
  const _spawn = _deps.spawn || child_process.spawn;
  const _fetch = _deps.fetch || globalThis.fetch;
  const port = opts.port || parseInt(process.env.TERMDECK_PORT || '', 10) || DEFAULT_PORT;
  const mnestraPort = opts.mnestraPort || parseInt(process.env.MNESTRA_PORT || '', 10) || DEFAULT_MNESTRA_PORT;

  process.stdout.write(`\n${ANSI.bold}TermDeck Stack Launcher${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}─────────────────────────────────────────────${ANSI.reset}\n\n`);

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) {
    process.stdout.write(`  ${ANSI.red}✗ Node ${process.version} detected — TermDeck requires Node 18+.${ANSI.reset}\n`);
    return { ok: false, reason: 'node-too-old' };
  }

  if (ensureFirstRunConfig(_fs)) {
    process.stdout.write(`  ${ANSI.blue}ⓘ${ANSI.reset} First run — created ${CONFIG_PATH}\n\n`);
  }

  // Step 1: secrets
  const secrets = readSecrets(SECRETS_PATH, _fs);
  const secretCount = Object.keys(secrets).length;
  if (secretCount === 0) {
    step('1/4', 'Loading secrets', 'WARN', `(no readable keys in ${SECRETS_PATH} — run \`npx @jhizzard/termdeck-stack\` to set up)`);
  } else {
    step('1/4', 'Loading secrets', 'OK', `(${secretCount} keys from ${SECRETS_PATH})`);
  }

  // Resolve binaries.
  const termdeckBinary = (_deps.whichBinary || whichBinary)('termdeck', _deps.spawnSync || child_process.spawnSync);
  if (!termdeckBinary) {
    process.stdout.write(`  ${ANSI.red}✗${ANSI.reset} \`termdeck\` not on PATH — install with: ${ANSI.green}npm i -g @jhizzard/termdeck${ANSI.reset}\n`);
    return { ok: false, reason: 'termdeck-missing' };
  }
  const mnestraInvocation = resolveMnestraInvocation({ ..._deps, fs: _fs, whichBinary: _deps.whichBinary });

  // Step 2: auto-wire MCP for non-Claude adapters (Sprint 49 T4)
  let autowireSummary = null;
  if (opts.noWire) {
    step('2/4', 'Auto-wiring MCP', 'SKIP', '(--no-wire)');
  } else {
    const termdeckExports = (_deps.termdeckExports !== undefined)
      ? _deps.termdeckExports
      : loadTermdeckExports(termdeckBinary, _fs);
    if (!termdeckExports) {
      step('2/4', 'Auto-wiring MCP', 'WARN', '(@jhizzard/termdeck adapter tree not resolvable — skipping)');
    } else {
      autowireSummary = autowireMcp(
        termdeckExports.adapters,
        termdeckExports.ensureMnestraBlock,
        { secrets },
      );
      const parts = [];
      for (const name of autowireSummary.wired) parts.push(`${name} (wrote)`);
      for (const name of autowireSummary.unchanged) parts.push(`${name} (unchanged)`);
      for (const e of autowireSummary.errored) parts.push(`${e.name} (error: ${e.error})`);
      if (autowireSummary.wired.length === 0 && autowireSummary.unchanged.length === 0 && autowireSummary.errored.length === 0) {
        step('2/4', 'Auto-wiring MCP', 'SKIP', '(no adapters declare mcpConfig)');
      } else if (autowireSummary.errored.length > 0 && autowireSummary.wired.length === 0 && autowireSummary.unchanged.length === 0) {
        step('2/4', 'Auto-wiring MCP', 'FAIL', parts.join(', '));
      } else {
        step('2/4', 'Auto-wiring MCP', 'OK', parts.join(', '));
      }
    }
  }

  // Step 3: mnestra
  const childEnv = { ...process.env, ...secrets };
  let mnestraPid = null;
  if (!mnestraInvocation) {
    step('3/4', 'Starting Mnestra', 'SKIP', '(not installed — npm i -g @jhizzard/mnestra)');
  } else if (!secrets.SUPABASE_URL || !secrets.SUPABASE_SERVICE_ROLE_KEY) {
    step('3/4', 'Starting Mnestra', 'WARN', '(SUPABASE_URL / SERVICE_ROLE_KEY missing — run wizard)');
  } else {
    const child = spawnDetached(mnestraInvocation.command, mnestraInvocation.args, MNESTRA_LOG_PATH, childEnv, _spawn, _fs);
    mnestraPid = child.pid;
    const health = await waitForHealth(`http://127.0.0.1:${mnestraPort}/healthz`, HEALTH_RETRIES, _fetch);
    if (health.ok) {
      const rows = (health.body && health.body.store && health.body.store.rows) || 0;
      step('3/4', 'Starting Mnestra', 'OK', `(:${mnestraPort}, ${rows} memories)`);
    } else {
      step('3/4', 'Starting Mnestra', 'FAIL', `(no /healthz response — see ${MNESTRA_LOG_PATH})`);
    }
  }

  // Step 4: termdeck
  const termdeckChild = spawnDetached(termdeckBinary, ['--port', String(port), '--no-stack'], TERMDECK_LOG_PATH, childEnv, _spawn, _fs);
  const termdeckHealth = await waitForHealth(`http://127.0.0.1:${port}/api/health`, HEALTH_RETRIES, _fetch);
  if (termdeckHealth.ok) {
    step('4/4', 'Starting TermDeck', 'OK', `(:${port})`);
  } else {
    step('4/4', 'Starting TermDeck', 'FAIL', `(no /api/health response — see ${TERMDECK_LOG_PATH})`);
  }

  const pidRecord = {
    mnestraPid,
    termdeckPid: termdeckChild.pid,
    port,
    mnestraPort,
    startedAt: new Date().toISOString(),
  };
  _fs.writeFileSync(PID_PATH, JSON.stringify(pidRecord, null, 2) + '\n');

  process.stdout.write(`\n  ${ANSI.bold}Open:${ANSI.reset} ${ANSI.green}http://127.0.0.1:${port}${ANSI.reset}\n`);
  process.stdout.write(`  ${ANSI.dim}Stop with: termdeck-stack stop${ANSI.reset}\n\n`);
  return { ok: true, ...pidRecord };
}

function tryKill(pid, signal, _process = process) {
  try { _process.kill(pid, signal); return true; }
  catch (_err) { return false; }
}

async function stopStack(opts = {}) {
  const _deps = opts._deps || {};
  const _fs = _deps.fs || fs;
  const _process = _deps.process || process;

  if (!_fs.existsSync(PID_PATH)) {
    process.stdout.write(`  ${ANSI.dim}No ${PID_PATH} — stack not started by this launcher.${ANSI.reset}\n`);
    return { ok: false, reason: 'no-pidfile' };
  }
  let record;
  try { record = JSON.parse(_fs.readFileSync(PID_PATH, 'utf8')); }
  catch (err) {
    process.stdout.write(`  ${ANSI.red}✗${ANSI.reset} ${PID_PATH} is malformed: ${err.message}\n`);
    return { ok: false, reason: 'malformed-pidfile' };
  }

  const stopped = [];
  for (const [name, pid] of [['termdeck', record.termdeckPid], ['mnestra', record.mnestraPid]]) {
    if (!pid) continue;
    if (tryKill(pid, 'SIGTERM', _process)) {
      stopped.push({ name, pid, signal: 'SIGTERM' });
      process.stdout.write(`  ${ANSI.green}✓${ANSI.reset} ${name} (pid ${pid}) signalled SIGTERM\n`);
    } else {
      process.stdout.write(`  ${ANSI.dim}─${ANSI.reset} ${name} (pid ${pid}) already gone\n`);
    }
  }
  // Brief grace period, then SIGKILL stragglers.
  await new Promise((res) => setTimeout(res, 500));
  for (const entry of stopped) {
    if (tryKill(entry.pid, 0, _process)) {
      tryKill(entry.pid, 'SIGKILL', _process);
      process.stdout.write(`  ${ANSI.yellow}!${ANSI.reset} ${entry.name} (pid ${entry.pid}) needed SIGKILL\n`);
    }
  }

  try { _fs.unlinkSync(PID_PATH); } catch (_e) { /* already gone */ }
  return { ok: true, stopped };
}

async function statusStack(opts = {}) {
  const _deps = opts._deps || {};
  const _fs = _deps.fs || fs;
  const _fetch = _deps.fetch || globalThis.fetch;

  process.stdout.write(`\n${ANSI.bold}TermDeck Stack Status${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}─────────────────────────────────────────────${ANSI.reset}\n\n`);

  let record = null;
  if (_fs.existsSync(PID_PATH)) {
    try { record = JSON.parse(_fs.readFileSync(PID_PATH, 'utf8')); }
    catch (_e) { record = null; }
  }
  const port = (record && record.port) || DEFAULT_PORT;
  const mnestraPort = (record && record.mnestraPort) || DEFAULT_MNESTRA_PORT;

  const td = await probeHealth(`http://127.0.0.1:${port}/api/health`, _fetch);
  step('1/2', 'TermDeck health', td.ok ? 'OK' : 'FAIL', td.ok ? `(:${port})` : `(:${port} not responding)`);

  const mn = await probeHealth(`http://127.0.0.1:${mnestraPort}/healthz`, _fetch);
  if (mn.ok) {
    const rows = (mn.body && mn.body.store && mn.body.store.rows) || 0;
    step('2/2', 'Mnestra health', 'OK', `(:${mnestraPort}, ${rows} memories)`);
  } else {
    step('2/2', 'Mnestra health', 'WARN', `(:${mnestraPort} not responding)`);
  }

  if (record) {
    process.stdout.write(`\n  ${ANSI.dim}Pidfile: ${PID_PATH} (started ${record.startedAt})${ANSI.reset}\n`);
  } else {
    process.stdout.write(`\n  ${ANSI.dim}No pidfile — stack may have been started outside the launcher.${ANSI.reset}\n`);
  }
  process.stdout.write('\n');
  return { ok: td.ok, termdeck: td, mnestra: mn, record };
}

module.exports = {
  startStack,
  stopStack,
  statusStack,
  // Test hooks — exposed so unit tests can drive the helpers without
  // spawning real processes.
  _readSecrets: readSecrets,
  _whichBinary: whichBinary,
  _resolveMnestraInvocation: resolveMnestraInvocation,
  _ensureFirstRunConfig: ensureFirstRunConfig,
  _probeHealth: probeHealth,
  _spawnDetached: spawnDetached,
  _autowireMcp: autowireMcp,
  _loadTermdeckExports: loadTermdeckExports,
  PID_PATH,
  SECRETS_PATH,
  CONFIG_PATH,
  DEFAULT_PORT,
  DEFAULT_MNESTRA_PORT,
};

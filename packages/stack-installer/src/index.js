#!/usr/bin/env node

// @jhizzard/termdeck-stack — one-command installer for the TermDeck
// developer memory stack.
//
// Usage:
//   npx @jhizzard/termdeck-stack          interactive wizard
//   npx @jhizzard/termdeck-stack --tier 4 unattended (1|2|3|4)
//   npx @jhizzard/termdeck-stack --dry-run print plan, don't install
//
// The wizard:
//   1. Prints the four-layer overview so the user understands what
//      they're agreeing to.
//   2. Detects which pieces are already installed.
//   3. Asks (or accepts via --tier) which layers to install.
//   4. Runs `npm install -g` for missing pieces.
//   5. Merges entries into ~/.claude/mcp.json for Mnestra and
//      Supabase MCP — preserving any existing entries.
//   6. Prints next steps.
//
// Zero runtime deps beyond Node built-ins; readline/promises handles
// the prompt without bringing in inquirer or prompts as a dep.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawn, spawnSync } = require('node:child_process');

const mcpConfigLib = require('./mcp-config');
const {
  CLAUDE_MCP_PATH_CANONICAL,
  CLAUDE_MCP_PATH_LEGACY,
  readMcpServers,
  mergeMcpServers,
  writeMcpServers,
  migrateLegacyIfPresent,
} = mcpConfigLib;

const ANSI = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', dim: '\x1b[2m', bold: '\x1b[1m',
  reset: '\x1b[0m',
};

const HOME = os.homedir();
const MCP_CONFIG = CLAUDE_MCP_PATH_CANONICAL;
const SETTINGS_JSON = path.join(HOME, '.claude', 'settings.json');
const HOOK_DEST_DIR = path.join(HOME, '.claude', 'hooks');
const HOOK_DEST = path.join(HOOK_DEST_DIR, 'memory-session-end.js');
const HOOK_SOURCE = path.join(__dirname, '..', 'assets', 'hooks', 'memory-session-end.js');
const HOOK_COMMAND = 'node ~/.claude/hooks/memory-session-end.js';
const HOOK_TIMEOUT_SECONDS = 30;
const SECRETS_PATH = path.join(HOME, '.termdeck', 'secrets.env');

// Read ~/.termdeck/secrets.env into a plain object. Returns {} if the file
// is absent or unreadable. Used to populate the mnestra MCP env block with
// concrete values — Claude Code does NOT shell-expand `${VAR}` references
// in MCP env, so writing placeholders results in mnestra receiving the
// literal string `${SUPABASE_URL}` and Supabase rejecting it as an invalid
// URL. Writing concrete values is the only thing that works.
function readTermdeckSecrets() {
  try {
    const text = fs.readFileSync(SECRETS_PATH, 'utf8');
    const out = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    return out;
  } catch (_err) {
    return {};
  }
}

const LAYERS = [
  {
    tier: 1,
    pkg: '@jhizzard/termdeck',
    bin: 'termdeck',
    label: 'TermDeck',
    role: 'Browser terminal multiplexer with metadata overlays, panel theming, and Flashback recall toasts. Tier-1 ready out of the box.',
    required: true,
  },
  {
    tier: 2,
    pkg: '@jhizzard/mnestra',
    bin: 'mnestra',
    label: 'Mnestra',
    role: 'pgvector memory store + MCP server. Lights up Flashback in TermDeck and provides memory_recall / memory_remember tools to Claude Code, Cursor, and Windsurf.',
  },
  {
    tier: 3,
    pkg: '@jhizzard/rumen',
    bin: null, // no global bin — used as library + tsx scripts
    label: 'Rumen',
    role: 'Async learning loop. Synthesizes insights across projects on a Supabase Edge Function cron. Surfaces patterns Flashback alone wouldn\'t catch.',
  },
  {
    tier: 4,
    pkg: '@supabase/mcp-server-supabase',
    bin: 'mcp-server-supabase',
    label: 'Supabase MCP',
    role: 'MCP server that lets the TermDeck setup wizard provision your Supabase project automatically — replaces the 4-credential paste step with a project picker.',
  },
];

// ── Args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { tier: null, dryRun: false, help: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tier' && argv[i + 1]) { out.tier = parseInt(argv[++i], 10); continue; }
    if (a.startsWith('--tier=')) { out.tier = parseInt(a.split('=')[1], 10); continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`
  termdeck-stack — install and run the TermDeck developer memory stack

  Subcommands:
    termdeck-stack start          Boot the full stack (TermDeck + Mnestra)
    termdeck-stack stop           Stop the running stack
    termdeck-stack status         Print stack health

  Install:
    npx @jhizzard/termdeck-stack          Interactive wizard
    npx @jhizzard/termdeck-stack --tier 4 Unattended install (1|2|3|4)
    npx @jhizzard/termdeck-stack --dry-run Print plan, don't install
    npx @jhizzard/termdeck-stack --yes    Accept all prompts (combine with --tier)

  Tiers:
    1  TermDeck only
    2  TermDeck + Mnestra (Flashback works)
    3  + Rumen (async learning)
    4  + Supabase MCP (one-click setup wizard)
`);
}

// ── Pretty output helpers ───────────────────────────────────────────

function box(title) {
  const inner = 65;
  const padded = ` ${title} `.padEnd(inner);
  process.stdout.write(`${ANSI.bold}╔${'═'.repeat(inner)}╗${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.bold}║${padded}║${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.bold}╚${'═'.repeat(inner)}╝${ANSI.reset}\n\n`);
}

function rule() {
  process.stdout.write(`${ANSI.dim}${'─'.repeat(67)}${ANSI.reset}\n`);
}

function statusLine(emoji, label, detail) {
  const padded = label.padEnd(38);
  process.stdout.write(`  ${emoji} ${padded}${ANSI.dim}${detail || ''}${ANSI.reset}\n`);
}

// ── Detection ───────────────────────────────────────────────────────

function nodeVersion() {
  return process.version.slice(1); // strip leading 'v'
}

function npmVersion() {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function detectGlobalPackage(pkg) {
  // `npm ls -g <pkg> --depth=0 --json` — robust across npm versions.
  const r = spawnSync('npm', ['ls', '-g', pkg, '--depth=0', '--json'], { encoding: 'utf8' });
  if (!r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const found = parsed.dependencies && parsed.dependencies[pkg];
    if (found && found.version) return found.version;
  } catch (_e) { /* fall through */ }
  return null;
}

function detectAll() {
  const node = nodeVersion();
  const npm = npmVersion();
  const layers = LAYERS.map((l) => ({
    ...l,
    installedVersion: detectGlobalPackage(l.pkg),
  }));
  return { node, npm, layers };
}

// ── Layered overview ────────────────────────────────────────────────

function printOverview() {
  process.stdout.write(`${ANSI.cyan}The TermDeck stack is four packages that compose into a "stateless${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.cyan}LLM, persistent everything else" memory layer for terminal work:${ANSI.reset}\n\n`);

  for (const l of LAYERS) {
    const tag = l.required ? `${ANSI.bold}required${ANSI.reset}` : 'optional';
    process.stdout.write(`  ${ANSI.bold}Layer ${l.tier} (${tag})${ANSI.reset}\n`);
    process.stdout.write(`    ${ANSI.green}${l.pkg}${ANSI.reset}\n`);

    // Word-wrap the role to ~62 cols, indented.
    const words = l.role.split(/\s+/);
    let line = '    ';
    for (const w of words) {
      if (line.length + w.length + 1 > 64) {
        process.stdout.write(`${ANSI.dim}${line}${ANSI.reset}\n`);
        line = '    ' + w;
      } else {
        line += (line.endsWith('    ') ? '' : ' ') + w;
      }
    }
    if (line.trim().length > 0) process.stdout.write(`${ANSI.dim}${line}${ANSI.reset}\n`);
    process.stdout.write('\n');
  }
}

function printDetectionTable(detection) {
  process.stdout.write(`${ANSI.bold}Detecting what's already on this machine...${ANSI.reset}\n\n`);

  if (detection.node) statusLine(`${ANSI.green}✓${ANSI.reset}`, 'Node', `v${detection.node}`);
  else statusLine(`${ANSI.red}✗${ANSI.reset}`, 'Node', 'not detected — install Node 18+ first');

  if (detection.npm) statusLine(`${ANSI.green}✓${ANSI.reset}`, 'npm', detection.npm);
  else statusLine(`${ANSI.red}✗${ANSI.reset}`, 'npm', 'not detected');

  process.stdout.write('\n');

  for (const l of detection.layers) {
    if (l.installedVersion) {
      statusLine(`${ANSI.green}✓${ANSI.reset}`, l.pkg, `v${l.installedVersion} already installed`);
    } else {
      statusLine(`${ANSI.dim}─${ANSI.reset}`, l.pkg, 'not installed');
    }
  }
  process.stdout.write('\n');
}

// ── Tier prompt ─────────────────────────────────────────────────────

async function promptTier({ defaultTier }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`${ANSI.bold}Which tier would you like to install?${ANSI.reset}\n`);
  process.stdout.write(`  1) TermDeck only\n`);
  process.stdout.write(`  2) + Mnestra            ${ANSI.dim}(Flashback works)${ANSI.reset}\n`);
  process.stdout.write(`  3) + Rumen              ${ANSI.dim}(async learning across projects)${ANSI.reset}\n`);
  process.stdout.write(`  4) + Supabase MCP       ${ANSI.dim}(one-click setup wizard)${ANSI.reset}\n\n`);
  while (true) {
    const ans = (await rl.question(`  Choice [default ${defaultTier}]: `)).trim();
    if (ans === '') { rl.close(); return defaultTier; }
    const n = parseInt(ans, 10);
    if (n >= 1 && n <= 4) { rl.close(); return n; }
    process.stdout.write(`  ${ANSI.red}Please enter 1, 2, 3, or 4.${ANSI.reset}\n`);
  }
}

// ── Install ─────────────────────────────────────────────────────────

function npmInstallGlobal(pkg) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', pkg], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function installLayers(plan, opts) {
  process.stdout.write(`\n${ANSI.bold}Installing ${plan.length} package${plan.length === 1 ? '' : 's'}...${ANSI.reset}\n\n`);
  let failures = 0;
  for (let i = 0; i < plan.length; i++) {
    const l = plan[i];
    process.stdout.write(`${ANSI.bold}[${i + 1}/${plan.length}] ${l.pkg}${ANSI.reset}\n`);
    if (opts.dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would run: npm install -g ${l.pkg}`);
      continue;
    }
    const ok = await npmInstallGlobal(l.pkg);
    if (ok) statusLine(`${ANSI.green}✓${ANSI.reset}`, l.pkg, 'installed');
    else { statusLine(`${ANSI.red}✗${ANSI.reset}`, l.pkg, 'install failed (continuing)'); failures++; }
    process.stdout.write('\n');
  }
  return failures;
}

// ── ~/.claude.json wiring ───────────────────────────────────────────
//
// Sprint 36 T2: writes go to ~/.claude.json (the path Claude Code v2.1.119+
// actually reads). On install, any entries living in the legacy
// ~/.claude/mcp.json are merged forward — the legacy file is left in place
// so users who pin other tooling to it keep working.

function wireMcpEntries(plan, opts) {
  if (opts.dryRun) {
    process.stdout.write(`${ANSI.bold}Would wire ${MCP_CONFIG} (dry-run skipped)${ANSI.reset}\n\n`);
    return;
  }

  // Step 1: forward-migrate any legacy entries, current always wins.
  const migration = migrateLegacyIfPresent({ canonicalPath: MCP_CONFIG, legacyPath: CLAUDE_MCP_PATH_LEGACY });

  // Step 2: re-read the canonical file (may have just been written by the
  // migration) and apply our additions.
  const current = readMcpServers(MCP_CONFIG);
  if (current.malformed) {
    process.stdout.write(
      `${ANSI.red}✗${ANSI.reset} ${MCP_CONFIG} is malformed (${current.error || 'parse error'}); ` +
      `not modified — fix the JSON and re-run.\n\n`
    );
    return;
  }
  const servers = { ...current.servers };
  const installedTiers = new Set(plan.map((l) => l.tier));
  const additions = [];
  const keptExisting = [];

  if (installedTiers.has(2) && !servers.mnestra) {
    // Claude Code does NOT expand `${VAR}` in MCP env — placeholders pass
    // through literally and mnestra rejects them as an invalid SUPABASE_URL.
    // Read concrete values from ~/.termdeck/secrets.env. Missing keys fall
    // back to process.env (the installer was launched from the user's shell,
    // which may export them); if still empty, leave the key out so mnestra's
    // own secrets.env fallback gets a chance to load it.
    const secrets = readTermdeckSecrets();
    const env = {};
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
      const v = secrets[key] || process.env[key] || '';
      if (v) env[key] = v;
    }
    servers.mnestra = {
      type: 'stdio',
      command: 'mnestra',
      env,
    };
    additions.push('mnestra');
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      process.stdout.write(
        `${ANSI.yellow}!${ANSI.reset} mnestra MCP added with incomplete env — ` +
        `set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ${SECRETS_PATH} ` +
        `or via \`claude mcp remove mnestra -s user\` followed by ` +
        `\`claude mcp add mnestra -s user -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... -e OPENAI_API_KEY=... -- mnestra\`.\n`
      );
    }
  } else if (servers.mnestra) {
    // Repair pass: existing entry from a buggy installer (≤ 0.4.11) used
    // `${VAR}` placeholders that Claude Code never expands. If we detect
    // those, swap in concrete values from secrets.env / process.env.
    const env = { ...(servers.mnestra.env || {}) };
    let repaired = false;
    const secrets = readTermdeckSecrets();
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY']) {
      const cur = env[key];
      const looksLikePlaceholder = typeof cur === 'string'
        && cur.startsWith('${') && cur.endsWith('}');
      if (looksLikePlaceholder || cur === '') {
        const v = secrets[key] || process.env[key] || '';
        if (v) {
          env[key] = v;
          repaired = true;
        } else if (looksLikePlaceholder) {
          delete env[key];
          repaired = true;
        }
      }
    }
    if (repaired) {
      servers.mnestra = { ...servers.mnestra, env };
      additions.push('mnestra (env repaired)');
    } else {
      keptExisting.push('mnestra');
    }
  }

  if (installedTiers.has(4) && !servers.supabase) {
    servers.supabase = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase@latest'],
      env: {
        SUPABASE_ACCESS_TOKEN: 'SUPABASE_PAT_HERE',
      },
    };
    additions.push('supabase');
  } else if (servers.supabase) {
    keptExisting.push('supabase');
  }

  const migrated = (migration && migration.migrated) || [];
  if (additions.length === 0 && keptExisting.length === 0 && migrated.length === 0) return;

  process.stdout.write(`${ANSI.bold}Wiring ${MCP_CONFIG}...${ANSI.reset}\n`);
  if (migrated.length > 0) {
    statusLine(
      `${ANSI.cyan}↑${ANSI.reset}`,
      `migrated ${migrated.length} entr${migrated.length === 1 ? 'y' : 'ies'} from legacy`,
      `${migrated.join(', ')} (legacy ${CLAUDE_MCP_PATH_LEGACY} left in place)`,
    );
  }
  for (const name of additions) statusLine(`${ANSI.green}+${ANSI.reset}`, `${name} entry`, 'added');
  for (const name of keptExisting) statusLine(`${ANSI.dim}=${ANSI.reset}`, `${name} entry`, 'already present, kept as-is');
  if (additions.length > 0) writeMcpServers(MCP_CONFIG, servers);
  process.stdout.write('\n');
}

// Test hook — exposed so unit tests can drive the merge primitives without
// spawning a full installer. Not part of the public CLI surface.
const _mcpInternals = {
  readMcpServers,
  mergeMcpServers,
  writeMcpServers,
  migrateLegacyIfPresent,
};

// ── Session-end hook bundling ───────────────────────────────────────

// Returns true if the given hook-entry's `command` string references our
// session-end hook file. Substring match is robust to `~` vs `$HOME` vs
// absolute paths.
function _isSessionEndHookEntry(entry) {
  return entry && typeof entry.command === 'string'
    && entry.command.includes('memory-session-end.js');
}

// Pure: merges our SessionEnd entry into the given settings object. Idempotent.
// Returns { settings, status } where status is 'already-installed', 'installed',
// or 'migrated-from-stop' (when an old `Stop` entry pointing at our hook is
// detected and moved over to `SessionEnd`). Mutates the input.
//
// Why SessionEnd, not Stop: the `Stop` event fires after every assistant turn,
// so a Stop-registered session-summary hook embeds + INSERTs the same growing
// transcript dozens of times per session. The `SessionEnd` event fires once
// per Claude Code session close (`/exit`, Ctrl+D, terminal close, kill) — the
// correct semantics for "summarize this session." Sprint 48 close-out moved
// the registration; the migration branch below heals existing installs from
// `@jhizzard/termdeck-stack@<=0.5.0` that wired the hook under `Stop`.
function _mergeSessionEndHookEntry(settings, opts = {}) {
  const command = opts.command || HOOK_COMMAND;
  const timeout = opts.timeout != null ? opts.timeout : HOOK_TIMEOUT_SECONDS;
  const entry = { type: 'command', command, timeout };

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  // Migrate any pre-Sprint-48 Stop registration of OUR hook to SessionEnd.
  // We only touch entries that match `_isSessionEndHookEntry` — any unrelated
  // Stop hooks the user has are preserved verbatim.
  let migrated = false;
  if (Array.isArray(settings.hooks.Stop)) {
    for (const group of settings.hooks.Stop) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((e) => !_isSessionEndHookEntry(e));
      if (group.hooks.length !== before) migrated = true;
    }
    settings.hooks.Stop = settings.hooks.Stop.filter(
      (g) => g && Array.isArray(g.hooks) && g.hooks.length > 0
    );
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  }

  if (!Array.isArray(settings.hooks.SessionEnd)) settings.hooks.SessionEnd = [];

  for (const group of settings.hooks.SessionEnd) {
    if (!group || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some(_isSessionEndHookEntry)) {
      return { settings, status: migrated ? 'migrated-from-stop' : 'already-installed' };
    }
  }

  const emptyMatcher = settings.hooks.SessionEnd.find(
    (g) => g && g.matcher === '' && Array.isArray(g.hooks)
  );
  if (emptyMatcher) {
    emptyMatcher.hooks.push(entry);
  } else {
    settings.hooks.SessionEnd.push({ matcher: '', hooks: [entry] });
  }
  return { settings, status: migrated ? 'migrated-from-stop' : 'installed' };
}

function _readSettingsJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return { settings: {}, status: 'no-file' };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.trim() === '') return { settings: {}, status: 'empty' };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: {}, status: 'malformed', error: 'top-level must be an object' };
    }
    return { settings: parsed, status: 'ok' };
  } catch (e) {
    return { settings: {}, status: 'malformed', error: e.message };
  }
}

function _writeSettingsJson(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// Compares two file contents byte-for-byte. Returns 'identical', 'different',
// or 'missing-dest'.
function _compareHookFiles(srcPath, destPath) {
  if (!fs.existsSync(destPath)) return 'missing-dest';
  const a = fs.readFileSync(srcPath);
  const b = fs.readFileSync(destPath);
  return a.equals(b) ? 'identical' : 'different';
}

async function promptYesNo({ question, defaultYes = true }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? '(Y/n)' : '(y/N)';
  const ans = (await rl.question(`  ${question} ${suffix} `)).trim().toLowerCase();
  rl.close();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

// Orchestrator: prompt → file copy → settings.json merge.
// Exposed so tests can drive it with explicit paths and a stub prompt.
async function installSessionEndHook(opts = {}) {
  const dryRun = !!opts.dryRun;
  const sourcePath = opts.sourcePath || HOOK_SOURCE;
  const destPath = opts.destPath || HOOK_DEST;
  const settingsPath = opts.settingsPath || SETTINGS_JSON;
  // promptInstall: () => Promise<boolean>; defaults to Y.
  // promptOverwrite: () => Promise<boolean>; defaults to N.
  const promptInstall = opts.promptInstall
    || (() => promptYesNo({ question: "Install TermDeck's session-end memory hook?", defaultYes: true }));
  const promptOverwrite = opts.promptOverwrite
    || (() => promptYesNo({
      question: `Existing hook found at ${destPath}. Overwrite?`,
      defaultYes: false,
    }));

  rule();
  process.stdout.write(`${ANSI.bold}Session-end memory hook${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}  Fires on every Claude Code session close to summarize the session into Mnestra.${ANSI.reset}\n\n`);

  const userWantsInstall = opts.assumeYes ? true
    : opts.assumeNo ? false
    : await promptInstall();

  if (!userWantsInstall) {
    statusLine(`${ANSI.dim}─${ANSI.reset}`, 'session-end hook', 'skipped (user declined)');
    process.stdout.write('\n');
    return { fileStatus: 'declined', settingsStatus: 'declined' };
  }

  // 1. File copy.
  let fileStatus;
  const cmp = _compareHookFiles(sourcePath, destPath);
  if (cmp === 'missing-dest') {
    if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would copy hook to ${destPath}`);
      fileStatus = 'would-copy';
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, 0o644);
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'hook file', `copied to ${destPath}`);
      fileStatus = 'copied';
    }
  } else if (cmp === 'identical') {
    statusLine(`${ANSI.dim}=${ANSI.reset}`, 'hook file', 'already present, identical contents');
    fileStatus = 'already-current';
  } else {
    // different
    const overwrite = opts.assumeYes ? false // --yes preserves existing on overwrite
      : opts.forceOverwrite ? true
      : await promptOverwrite();
    if (!overwrite) {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'hook file', `existing kept (differs from vendored copy)`);
      fileStatus = 'kept-existing';
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would overwrite ${destPath}`);
      fileStatus = 'would-overwrite';
    } else {
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, 0o644);
      statusLine(`${ANSI.green}↻${ANSI.reset}`, 'hook file', `overwrote ${destPath}`);
      fileStatus = 'overwritten';
    }
  }

  // 2. Settings.json merge.
  const read = _readSettingsJson(settingsPath);
  let settingsStatus;
  if (read.status === 'malformed') {
    statusLine(`${ANSI.red}✗${ANSI.reset}`, 'settings.json', `malformed (${read.error}); not modified`);
    settingsStatus = 'malformed';
  } else {
    const merged = _mergeSessionEndHookEntry(read.settings);
    if (merged.status === 'already-installed') {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'settings.json SessionEnd hook', 'already installed');
      settingsStatus = 'already-installed';
    } else if (merged.status === 'migrated-from-stop') {
      if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would migrate Stop hook → SessionEnd in ${settingsPath}`);
        settingsStatus = 'would-migrate';
      } else {
        _writeSettingsJson(settingsPath, merged.settings);
        statusLine(`${ANSI.green}↻${ANSI.reset}`, 'settings.json SessionEnd hook', 'migrated from Stop (was firing on every turn)');
        settingsStatus = 'migrated';
      }
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would merge SessionEnd hook into ${settingsPath}`);
      settingsStatus = 'would-install';
    } else {
      _writeSettingsJson(settingsPath, merged.settings);
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'settings.json SessionEnd hook', 'merged');
      settingsStatus = 'installed';
    }
  }

  process.stdout.write('\n');
  if (!dryRun && (fileStatus === 'copied' || settingsStatus === 'installed')) {
    process.stdout.write(`  ${ANSI.dim}Hook installed at ${destPath}.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}It runs on every Claude Code session close to summarize the session into Mnestra.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}See assets/hooks/README.md in @jhizzard/termdeck-stack for details.${ANSI.reset}\n\n`);
  }

  return { fileStatus, settingsStatus };
}

// ── Next steps ──────────────────────────────────────────────────────

function printNextSteps(plan, opts) {
  rule();
  process.stdout.write(`${ANSI.bold}${ANSI.green}Stack installed.${ANSI.reset}\n\n`);

  const tiers = new Set(plan.map((l) => l.tier));
  let stepNum = 1;

  if (tiers.has(4)) {
    process.stdout.write(`  ${ANSI.bold}${stepNum++}.${ANSI.reset} Mint a Supabase Personal Access Token at:\n`);
    process.stdout.write(`     ${ANSI.cyan}https://supabase.com/dashboard/account/tokens${ANSI.reset}\n`);
    process.stdout.write(`     Then edit ${ANSI.dim}${MCP_CONFIG}${ANSI.reset} and replace ${ANSI.yellow}SUPABASE_PAT_HERE${ANSI.reset}.\n\n`);
  }

  if (tiers.has(2) && !tiers.has(4)) {
    process.stdout.write(`  ${ANSI.bold}${stepNum++}.${ANSI.reset} Configure Tier 2 (Mnestra) credentials. Two options:\n`);
    process.stdout.write(`     • In-browser: run ${ANSI.green}termdeck${ANSI.reset}, click ${ANSI.bold}config${ANSI.reset}, paste credentials in the wizard\n`);
    process.stdout.write(`     • CLI: ${ANSI.green}termdeck init --mnestra${ANSI.reset}\n\n`);
  }

  if (tiers.has(3)) {
    process.stdout.write(`  ${ANSI.bold}${stepNum++}.${ANSI.reset} Deploy Rumen to your Supabase project:\n`);
    process.stdout.write(`     ${ANSI.green}termdeck init --rumen${ANSI.reset}\n\n`);
  }

  process.stdout.write(`  ${ANSI.bold}${stepNum++}.${ANSI.reset} Start the stack:\n`);
  process.stdout.write(`     ${ANSI.green}termdeck${ANSI.reset}\n`);
  if (tiers.has(2)) {
    process.stdout.write(`     ${ANSI.dim}(auto-orchestrates Mnestra and surfaces Rumen status from v0.5.0)${ANSI.reset}\n`);
  }
  process.stdout.write('\n');

  if (opts.dryRun) {
    process.stdout.write(`  ${ANSI.yellow}(--dry-run was set; nothing was actually installed.)${ANSI.reset}\n\n`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

// Sprint 48 T4: persistent launcher subcommands. Short-circuits before the
// wizard so `npx @jhizzard/termdeck-stack start` (and stop|status) boots the
// stack without running the install flow. Bare invocation still falls through
// to the wizard for backwards compat.
async function _maybeRunSubcommand(argv) {
  const sub = argv[0];
  if (sub !== 'start' && sub !== 'stop' && sub !== 'status') return null;
  // Lazy-require so the wizard path doesn't pay the launcher's load cost.
  const launcher = require('./launcher');
  if (sub === 'start') {
    const result = await launcher.startStack({ /* opts could parse argv flags later */ });
    return result.ok === false ? 1 : 0;
  }
  if (sub === 'stop') {
    const result = await launcher.stopStack({});
    return result.ok ? 0 : 1;
  }
  // status — exits non-zero if termdeck isn't healthy so scripts can branch on it.
  const result = await launcher.statusStack({});
  return result.ok ? 0 : 1;
}

async function main(argv) {
  const subResult = await _maybeRunSubcommand(argv);
  if (subResult !== null) return subResult;

  const args = parseArgs(argv);
  if (args.help) { printHelp(); return 0; }

  process.stdout.write('\n');
  box('TermDeck Stack Installer');

  printOverview();
  rule();
  process.stdout.write('\n');

  const detection = detectAll();
  printDetectionTable(detection);

  if (!detection.node) {
    process.stdout.write(`${ANSI.red}Node 18+ is required. Install Node and re-run this script.${ANSI.reset}\n`);
    return 1;
  }
  if (!detection.npm) {
    process.stdout.write(`${ANSI.red}npm is required. Install npm and re-run this script.${ANSI.reset}\n`);
    return 1;
  }

  let tier = args.tier;
  if (!tier) {
    if (args.yes) tier = 4;
    else tier = await promptTier({ defaultTier: 4 });
  }
  if (tier < 1 || tier > 4) {
    process.stdout.write(`${ANSI.red}Invalid tier ${tier}. Must be 1, 2, 3, or 4.${ANSI.reset}\n`);
    return 1;
  }

  const wantedLayers = detection.layers.filter((l) => l.tier <= tier);
  const missingLayers = wantedLayers.filter((l) => !l.installedVersion);

  process.stdout.write(`${ANSI.bold}Plan:${ANSI.reset} install tier ${tier} `);
  if (missingLayers.length === 0) {
    process.stdout.write(`${ANSI.green}— all layers already present.${ANSI.reset}\n\n`);
  } else {
    process.stdout.write(`${ANSI.dim}(${missingLayers.length} of ${wantedLayers.length} layer${wantedLayers.length === 1 ? '' : 's'} missing)${ANSI.reset}\n\n`);
    for (const l of missingLayers) statusLine(`${ANSI.cyan}+${ANSI.reset}`, l.pkg, l.role.split('. ')[0] + '.');
    process.stdout.write('\n');
  }

  let failures = 0;
  if (missingLayers.length > 0) failures = await installLayers(missingLayers, { dryRun: args.dryRun });

  // Wire MCP entries even when nothing was installed — covers the
  // "already had everything but never set up Claude Code MCP" case.
  wireMcpEntries(wantedLayers, { dryRun: args.dryRun });

  // Bundle the session-end memory hook (default-on, opt-in via prompt).
  // --yes accepts the install but preserves any existing differing hook.
  await installSessionEndHook({
    dryRun: args.dryRun,
    assumeYes: args.yes,
  });

  printNextSteps(wantedLayers, { dryRun: args.dryRun });

  if (failures > 0) {
    process.stdout.write(`${ANSI.yellow}${failures} package${failures === 1 ? '' : 's'} failed to install — re-run after fixing the underlying npm issue.${ANSI.reset}\n\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`[termdeck-stack] failed: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = main;
module.exports._maybeRunSubcommand = _maybeRunSubcommand;
module.exports._mergeSessionEndHookEntry = _mergeSessionEndHookEntry;
module.exports._readSettingsJson = _readSettingsJson;
module.exports._writeSettingsJson = _writeSettingsJson;
module.exports._isSessionEndHookEntry = _isSessionEndHookEntry;
module.exports._compareHookFiles = _compareHookFiles;
module.exports.installSessionEndHook = installSessionEndHook;
module.exports.HOOK_COMMAND = HOOK_COMMAND;
module.exports.HOOK_TIMEOUT_SECONDS = HOOK_TIMEOUT_SECONDS;
module.exports.HOOK_SOURCE = HOOK_SOURCE;
module.exports._mcpInternals = _mcpInternals;
module.exports.MCP_CONFIG_PATH = MCP_CONFIG;
module.exports.CLAUDE_MCP_PATH_CANONICAL = CLAUDE_MCP_PATH_CANONICAL;
module.exports.CLAUDE_MCP_PATH_LEGACY = CLAUDE_MCP_PATH_LEGACY;

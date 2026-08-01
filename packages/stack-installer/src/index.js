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
const crypto = require('node:crypto');
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

// Sprint 75 T2 — hook commands are written into ~/.claude/settings.json with
// ABSOLUTE paths. The pre-1.10 literal `node ~/.claude/hooks/...` shape relied
// on shell tilde expansion — it worked on macOS/Linux only by luck of how the
// harness invokes hook commands, and is a hard break on Windows (audit item 4).
// Computed at CALL time (not require time) from os.homedir() so a process that
// re-points HOME (tests, sandboxed installs) gets the right path. The path is
// double-quoted so a home dir containing spaces (`/Users/First Last/`) still
// produces a command the harness shell can execute. Lockstep twin lives in
// packages/cli/src/init-mnestra.js (`_hookCommandFor`) — INSTALLER-PITFALLS
// Class N: change both or neither.
function _hookCommandFor(filename) {
  return `node "${path.join(os.homedir(), '.claude', 'hooks', filename)}"`;
}

// True when an entry's command still carries the legacy tilde shape and
// should be rewritten to the absolute form.
function _isTildeHookCommand(command) {
  return typeof command === 'string' && command.includes('~/');
}

const HOOK_COMMAND = _hookCommandFor('memory-session-end.js');
const HOOK_TIMEOUT_SECONDS = 30;

// Sprint 64 T3 — PreCompact hook (Investigation 2 of
// docs/CRITICAL-READ-FIRST-2026-05-07.md). Fires BEFORE Claude Code compacts
// context, capturing session state into Mnestra under
// source_type='pre_compact_snapshot'. Lives alongside the SessionEnd hook in
// ~/.claude/hooks/ and re-uses memory-session-end.js helpers via the Sprint 38
// module-export contract.
const PRECOMPACT_HOOK_DEST = path.join(HOOK_DEST_DIR, 'memory-pre-compact.js');
const PRECOMPACT_HOOK_SOURCE = path.join(__dirname, '..', 'assets', 'hooks', 'memory-pre-compact.js');
const PRECOMPACT_HOOK_COMMAND = _hookCommandFor('memory-pre-compact.js');
const PRECOMPACT_HOOK_TIMEOUT_SECONDS = 30;

// Sprint 81 T3 — PreToolUse deny gates (ULTRAPLAN §6 advise→gate). Two
// self-contained fail-soft hooks that can DENY a Bash tool call. Registry-
// driven: each enforces ONLY when its doctrine rule is promoted to
// enforcement.surface='preToolUse-deny'/max_severity='block' (inert — allow
// everything — until then), so installing them is always safe. Live alongside
// the SessionEnd/PreCompact hooks in ~/.claude/hooks/; wired under
// hooks.PreToolUse with matcher 'Bash'.
const PRETOOLUSE_HOOK_TIMEOUT_SECONDS = 20; // gates may spawn git + `npm view`
const PRETOOLUSE_GATE_FILES = [
  'gate-publish-before-push.js',
  'gate-migration-without-rls.js',
];
const PRETOOLUSE_GATE_SOURCES = PRETOOLUSE_GATE_FILES.map(
  (f) => path.join(__dirname, '..', 'assets', 'hooks', f)
);
const PRETOOLUSE_GATE_DESTS = PRETOOLUSE_GATE_FILES.map(
  (f) => path.join(HOOK_DEST_DIR, f)
);

const SECRETS_PATH = path.join(HOME, '.termdeck', 'secrets.env');

// Sprint 78 T1 — doctrine registry vendoring. A READ-ONLY copy of the doctrine
// registry (audience:'all' + active entries only, baked at publish) lands at
// ~/.claude/doctrine/registry.shipped.jsonl so Brad has an inspectable
// artifact. This is NOT a loader read-path: the loader (doctrine/index.js)
// reads the registry package-relative, and doctrine/ ships in @jhizzard/termdeck
// via the files whitelist, so the loader is always co-located with its own
// registry. The shipped copy is purely inspectable + refresh-gated on a
// FULL-FILE content hash.
const DOCTRINE_DEST_DIR = path.join(HOME, '.claude', 'doctrine');
const DOCTRINE_SHIPPED_DEST = path.join(DOCTRINE_DEST_DIR, 'registry.shipped.jsonl');
const DOCTRINE_SHIPPED_SOURCE = path.join(__dirname, '..', 'assets', 'doctrine', 'registry.shipped.jsonl');

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
    termdeck-stack uninstall      Tear down all TermDeck-attributable state

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
  // Command computed at call time (Sprint 75 T2) — see _hookCommandFor.
  const command = opts.command || _hookCommandFor('memory-session-end.js');
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

  // Sprint 75 T2 — rewrite a stale literal-`~` command (written by installers
  // ≤ v1.9.x) to the absolute form. The "already wired?" predicate matches by
  // hook FILENAME substring, so without this rewrite a legacy entry would be
  // reported already-installed and keep its `~` forever. Idempotent: absolute
  // commands (and user-custom commands without `~/`) are never touched.
  let tildeMigrated = false;
  for (const group of settings.hooks.SessionEnd) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const e of group.hooks) {
      if (_isSessionEndHookEntry(e) && _isTildeHookCommand(e.command)) {
        e.command = command;
        tildeMigrated = true;
      }
    }
  }

  for (const group of settings.hooks.SessionEnd) {
    if (!group || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some(_isSessionEndHookEntry)) {
      const status = tildeMigrated ? 'migrated-tilde-path'
        : migrated ? 'migrated-from-stop'
        : 'already-installed';
      return { settings, status };
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

// Sprint 64 T3 — PreCompact entry detection + merge. Parallel to the SessionEnd
// helpers above, with the key difference that PreCompact didn't exist before
// this sprint so there's no Stop-style migration branch. Idempotent.
function _isPreCompactHookEntry(entry) {
  return entry && typeof entry.command === 'string'
    && entry.command.includes('memory-pre-compact.js');
}

// Pure: merges our PreCompact entry into the given settings object. Returns
// { settings, status } where status is 'already-installed' or 'installed'.
// Mutates the input. matcher='*' is the documented wildcard for PreCompact —
// fires on both auto-compact (token-limit-driven) AND manual /compact triggers.
function _mergePreCompactHookEntry(settings, opts = {}) {
  // Command computed at call time (Sprint 75 T2) — see _hookCommandFor.
  const command = opts.command || _hookCommandFor('memory-pre-compact.js');
  const timeout = opts.timeout != null ? opts.timeout : PRECOMPACT_HOOK_TIMEOUT_SECONDS;
  const entry = { type: 'command', command, timeout };

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreCompact)) settings.hooks.PreCompact = [];

  // Sprint 75 T2 — same stale literal-`~` rewrite as the SessionEnd merge.
  let tildeMigrated = false;
  for (const group of settings.hooks.PreCompact) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const e of group.hooks) {
      if (_isPreCompactHookEntry(e) && _isTildeHookCommand(e.command)) {
        e.command = command;
        tildeMigrated = true;
      }
    }
  }

  for (const group of settings.hooks.PreCompact) {
    if (!group || !Array.isArray(group.hooks)) continue;
    if (group.hooks.some(_isPreCompactHookEntry)) {
      return { settings, status: tildeMigrated ? 'migrated-tilde-path' : 'already-installed' };
    }
  }

  // Append to a `*`-matcher group if present (covers both auto + manual); else
  // create one. Hand-edited groups with specific matchers (e.g. matcher: 'auto')
  // are left intact — a future user-installed hook gating on a specific trigger
  // coexists with our wildcard group rather than getting overwritten.
  const wildcardGroup = settings.hooks.PreCompact.find(
    (g) => g && g.matcher === '*' && Array.isArray(g.hooks)
  );
  if (wildcardGroup) {
    wildcardGroup.hooks.push(entry);
  } else {
    settings.hooks.PreCompact.push({ matcher: '*', hooks: [entry] });
  }
  return { settings, status: 'installed' };
}

// Sprint 81 T3 — PreToolUse gate entry detection + merge. Parallel to the
// PreCompact helpers, but registers TWO commands (the two gate files) under a
// single 'Bash'-matcher group, and is idempotent per-gate (a partial install
// with only one gate present gets the other added, not a duplicate). No legacy
// migration branch (PreToolUse gates are new in Sprint 81).
function _isPreToolUseHookEntry(entry) {
  return entry && typeof entry.command === 'string'
    && PRETOOLUSE_GATE_FILES.some((f) => entry.command.includes(f));
}

// Pure: ensures each gate command is present under a 'Bash'-matcher group in
// the settings object. Mutates the input. Returns { settings, status } where
// status ∈ 'already-installed' | 'installed' | 'migrated-tilde-path'.
function _mergePreToolUseHookEntry(settings, opts = {}) {
  const files = opts.files || PRETOOLUSE_GATE_FILES;
  const commandFor = opts.commandFor || _hookCommandFor;
  const timeout = opts.timeout != null ? opts.timeout : PRETOOLUSE_HOOK_TIMEOUT_SECONDS;
  const matcher = opts.matcher || 'Bash';

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  // Rewrite any stale literal-`~` command for OUR gates to the absolute form
  // (same reasoning as the SessionEnd/PreCompact tilde rewrite).
  let tildeMigrated = false;
  for (const group of settings.hooks.PreToolUse) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const e of group.hooks) {
      if (_isPreToolUseHookEntry(e) && _isTildeHookCommand(e.command)) {
        const f = files.find((ff) => e.command.includes(ff));
        if (f) { e.command = commandFor(f); tildeMigrated = true; }
      }
    }
  }

  // Which gate files are already wired (anywhere, any matcher)?
  const present = new Set();
  for (const group of settings.hooks.PreToolUse) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (const e of group.hooks) {
      if (!_isPreToolUseHookEntry(e)) continue;
      const f = files.find((ff) => e.command.includes(ff));
      if (f) present.add(f);
    }
  }

  const missing = files.filter((f) => !present.has(f));
  if (!missing.length) {
    return { settings, status: tildeMigrated ? 'migrated-tilde-path' : 'already-installed' };
  }

  // Append the missing gate commands into a 'Bash'-matcher group (reuse one if
  // present; a user's hand-edited group with a different matcher is left intact).
  let bashGroup = settings.hooks.PreToolUse.find(
    (g) => g && g.matcher === matcher && Array.isArray(g.hooks)
  );
  if (!bashGroup) {
    bashGroup = { matcher, hooks: [] };
    settings.hooks.PreToolUse.push(bashGroup);
  }
  for (const f of missing) {
    bashGroup.hooks.push({ type: 'command', command: commandFor(f), timeout });
  }
  return { settings, status: tildeMigrated ? 'migrated-tilde-path' : 'installed' };
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

// Sprint 51.6 T3 — version-aware overwrite gate. The bundled hook carries a
// `// @termdeck/stack-installer-hook v<N>` marker; bumping <N> means "the
// next install should overwrite a stale copy on the user's machine even
// under --yes." Without this, --yes preserved the existing hook (the safe
// default for hand-edited files) and never landed bundled fixes — the gap
// Codex surfaced in Sprint 51.6 (item #2 of the 5-part fix).
const HOOK_SIGNATURE_REGEX = /@termdeck\/stack-installer-hook\s+v(\d+)/;

function _readHookSignatureVersion(filepath) {
  try {
    const head = fs.readFileSync(filepath, 'utf8').slice(0, 4096);
    const m = head.match(HOOK_SIGNATURE_REGEX);
    return m ? parseInt(m[1], 10) : null;
  } catch (_) { return null; }
}

// Sprint 51.6 T4-CODEX audit 20:23 ET — safety gate: only auto-overwrite an
// unsigned installed hook when it was clearly TermDeck-managed (carries one
// of the docstring markers from a prior bundled cut). A genuinely custom
// user hook with no TermDeck fingerprint stays put under --yes; the user
// gets prompted (interactive) or must `--force-overwrite`. Markers are
// matched in the first 4KB so a long custom file with TermDeck mentions
// in the body doesn't false-positive.
const TERMDECK_MANAGED_MARKERS = [
  /TermDeck session-end memory hook/,
  /@jhizzard\/termdeck-stack/,
  /Vendored into ~\/\.claude\/hooks\/memory-session-end\.js by @jhizzard/i,
];

function _looksTermdeckManaged(filepath) {
  try {
    const head = fs.readFileSync(filepath, 'utf8').slice(0, 4096);
    return TERMDECK_MANAGED_MARKERS.some((m) => m.test(head));
  } catch (_) { return false; }
}

// Returns true when the bundled hook's version stamp is strictly newer than
// the installed one (or the installed file is unsigned BUT visibly TermDeck-
// managed — older installs pre-Sprint-51.6 had no marker, treat them as v0).
// Returns false when the bundled hook itself is unsigned (safety: a missing
// source marker means "don't auto-overwrite") OR the installed file is
// unsigned and looks like a custom user hook (no TermDeck fingerprint).
// Used to gate --yes overwrite under installSessionEndHook.
function _hookSignatureUpgradeAvailable(sourcePath, destPath) {
  const bundled = _readHookSignatureVersion(sourcePath);
  if (bundled === null) return false; // bundled unsigned — never auto-overwrite
  const installed = _readHookSignatureVersion(destPath);
  if (installed === null) {
    // Installed has no version stamp. Only auto-overwrite if it looks
    // TermDeck-managed; otherwise preserve as a possible user-custom hook.
    return _looksTermdeckManaged(destPath);
  }
  return bundled > installed;
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
    // different. Sprint 51.6 T3: under --yes, consult the version stamp —
    // a strictly newer bundled stamp (or an unsigned existing file) means
    // we should refresh; same-or-older stamp keeps existing. This closes
    // the upgrade gap where bundled fixes never reached users' machines.
    const overwrite = opts.assumeYes
      ? _hookSignatureUpgradeAvailable(sourcePath, destPath)
      : opts.forceOverwrite ? true
      : await promptOverwrite();
    if (!overwrite) {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'hook file', `existing kept (differs from vendored copy)`);
      fileStatus = 'kept-existing';
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would overwrite ${destPath}`);
      fileStatus = 'would-overwrite';
    } else {
      // Sprint 51.6 T3: timestamped backup before overwrite so a hand-
      // edited PROJECT_MAP or comment is recoverable. Matches the pattern
      // ~/.claude/hooks/memory-session-end.js.bak.<YYYYMMDDhhmmss> Joshua
      // already had on disk from prior installs.
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      try { fs.copyFileSync(destPath, `${destPath}.bak.${stamp}`); } catch (_) { /* best-effort */ }
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
    } else if (merged.status === 'migrated-tilde-path') {
      // Sprint 75 T2 — legacy `node ~/.claude/...` command rewritten absolute.
      if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would rewrite legacy ~ hook command to absolute path in ${settingsPath}`);
        settingsStatus = 'would-migrate-tilde';
      } else {
        _writeSettingsJson(settingsPath, merged.settings);
        statusLine(`${ANSI.green}↻${ANSI.reset}`, 'settings.json SessionEnd hook', 'rewrote legacy ~ command to absolute path');
        settingsStatus = 'migrated-tilde';
      }
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

// Sprint 64 T3 — install the PreCompact hook. Closes Investigation 2 of
// docs/CRITICAL-READ-FIRST-2026-05-07.md ("auto-commit on context compaction-
// near"). Mirrors installSessionEndHook closely but simpler: PreCompact is
// new in Sprint 64 so there's no Stop→SessionEnd-style legacy migration.
//
// File copy and settings.json merge are independent — a file-copy failure
// doesn't suppress the settings merge, and vice versa. Both errors fail-soft.
async function installPreCompactHook(opts = {}) {
  const dryRun = !!opts.dryRun;
  const sourcePath = opts.sourcePath || PRECOMPACT_HOOK_SOURCE;
  const destPath = opts.destPath || PRECOMPACT_HOOK_DEST;
  const settingsPath = opts.settingsPath || SETTINGS_JSON;
  const promptInstall = opts.promptInstall
    || (() => promptYesNo({ question: "Install TermDeck's PreCompact memory hook? (captures session state before Claude compacts)", defaultYes: true }));
  const promptOverwrite = opts.promptOverwrite
    || (() => promptYesNo({
      question: `Existing pre-compact hook found at ${destPath}. Overwrite?`,
      defaultYes: false,
    }));

  rule();
  process.stdout.write(`${ANSI.bold}PreCompact memory hook${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}  Fires before Claude Code compacts conversation context, capturing the in-flight session state into Mnestra so long sessions don't leak findings on auto-compact.${ANSI.reset}\n\n`);

  const userWantsInstall = opts.assumeYes ? true
    : opts.assumeNo ? false
    : await promptInstall();

  if (!userWantsInstall) {
    statusLine(`${ANSI.dim}─${ANSI.reset}`, 'pre-compact hook', 'skipped (user declined)');
    process.stdout.write('\n');
    return { fileStatus: 'declined', settingsStatus: 'declined' };
  }

  // 1. File copy. Reuses the version-stamp gate so future bumps of
  // `@termdeck/stack-installer-hook v<N>` in the bundled file trigger an
  // overwrite on `--yes` without prompting. A genuinely custom user file
  // (unsigned, no TermDeck markers) is preserved — but in practice nobody
  // has one of these on disk pre-Sprint-64 because PreCompact is new.
  let fileStatus;
  const cmp = _compareHookFiles(sourcePath, destPath);
  if (cmp === 'missing-dest') {
    if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would copy pre-compact hook to ${destPath}`);
      fileStatus = 'would-copy';
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, 0o644);
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'pre-compact hook file', `copied to ${destPath}`);
      fileStatus = 'copied';
    }
  } else if (cmp === 'identical') {
    statusLine(`${ANSI.dim}=${ANSI.reset}`, 'pre-compact hook file', 'already present, identical contents');
    fileStatus = 'already-current';
  } else {
    const overwrite = opts.assumeYes
      ? _hookSignatureUpgradeAvailable(sourcePath, destPath)
      : opts.forceOverwrite ? true
      : await promptOverwrite();
    if (!overwrite) {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'pre-compact hook file', `existing kept (differs from vendored copy)`);
      fileStatus = 'kept-existing';
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would overwrite ${destPath}`);
      fileStatus = 'would-overwrite';
    } else {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      try { fs.copyFileSync(destPath, `${destPath}.bak.${stamp}`); } catch (_) { /* best-effort */ }
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, 0o644);
      statusLine(`${ANSI.green}↻${ANSI.reset}`, 'pre-compact hook file', `overwrote ${destPath}`);
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
    const merged = _mergePreCompactHookEntry(read.settings);
    if (merged.status === 'already-installed') {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'settings.json PreCompact hook', 'already installed');
      settingsStatus = 'already-installed';
    } else if (merged.status === 'migrated-tilde-path') {
      // Sprint 75 T2 — legacy `node ~/.claude/...` command rewritten absolute.
      if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would rewrite legacy ~ pre-compact command to absolute path in ${settingsPath}`);
        settingsStatus = 'would-migrate-tilde';
      } else {
        _writeSettingsJson(settingsPath, merged.settings);
        statusLine(`${ANSI.green}↻${ANSI.reset}`, 'settings.json PreCompact hook', 'rewrote legacy ~ command to absolute path');
        settingsStatus = 'migrated-tilde';
      }
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would merge PreCompact hook into ${settingsPath}`);
      settingsStatus = 'would-install';
    } else {
      _writeSettingsJson(settingsPath, merged.settings);
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'settings.json PreCompact hook', 'merged');
      settingsStatus = 'installed';
    }
  }

  process.stdout.write('\n');
  if (!dryRun && (fileStatus === 'copied' || settingsStatus === 'installed')) {
    process.stdout.write(`  ${ANSI.dim}PreCompact hook installed at ${destPath}.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}It runs before Claude Code compacts context, writing a pre_compact_snapshot row to Mnestra.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}Sprint 64 / Investigation 2 / docs/CRITICAL-READ-FIRST-2026-05-07.md.${ANSI.reset}\n\n`);
  }

  return { fileStatus, settingsStatus };
}

// Sprint 81 T3 — install the two PreToolUse deny gates (advise→gate). Mirrors
// installPreCompactHook: version-stamp-gated file copy (per gate) + a single
// settings merge under hooks.PreToolUse matcher 'Bash'. File copy and settings
// merge are independent; both fail-soft. The gates are inert until their
// doctrine rule is promoted to preToolUse-deny, so installing them changes
// nothing until the operator opts in via `doctrine promote <rule>`.
async function installPreToolUseHook(opts = {}) {
  const dryRun = !!opts.dryRun;
  const sources = opts.sources || PRETOOLUSE_GATE_SOURCES;
  const dests = opts.dests || PRETOOLUSE_GATE_DESTS;
  const settingsPath = opts.settingsPath || SETTINGS_JSON;
  const promptInstall = opts.promptInstall
    || (() => promptYesNo({ question: "Install TermDeck's PreToolUse enforcement gates? (publish-before-push + migration-RLS; stay inert until you promote them)", defaultYes: true }));

  rule();
  process.stdout.write(`${ANSI.bold}PreToolUse enforcement gates${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}  Two fail-soft Bash gates — publish-before-push and migration-without-RLS. Registry-driven: they allow everything until you run \`doctrine promote <rule>\`, so installing them is safe and changes nothing until you opt in.${ANSI.reset}\n\n`);

  const userWantsInstall = opts.assumeYes ? true
    : opts.assumeNo ? false
    : await promptInstall();

  if (!userWantsInstall) {
    statusLine(`${ANSI.dim}─${ANSI.reset}`, 'PreToolUse gates', 'skipped (user declined)');
    process.stdout.write('\n');
    return { fileStatuses: sources.map(() => 'declined'), settingsStatus: 'declined' };
  }

  // 1. File copy — one per gate, each through the version-stamp gate.
  const fileStatuses = [];
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = sources[i];
    const destPath = dests[i];
    const label = path.basename(destPath);
    if (!fs.existsSync(sourcePath)) {
      statusLine(`${ANSI.yellow}!${ANSI.reset}`, label, 'skipped (bundled source missing)');
      fileStatuses.push('no-bundled-asset');
      continue;
    }
    const cmp = _compareHookFiles(sourcePath, destPath);
    if (cmp === 'missing-dest') {
      if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would copy ${label} to ${destPath}`);
        fileStatuses.push('would-copy');
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(sourcePath, destPath);
        fs.chmodSync(destPath, 0o644);
        statusLine(`${ANSI.green}+${ANSI.reset}`, `${label} file`, `copied to ${destPath}`);
        fileStatuses.push('copied');
      }
    } else if (cmp === 'identical') {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, `${label} file`, 'already present, identical contents');
      fileStatuses.push('already-current');
    } else {
      const overwrite = opts.assumeYes
        ? _hookSignatureUpgradeAvailable(sourcePath, destPath)
        : opts.forceOverwrite ? true
        : await promptYesNo({ question: `Existing ${label} found at ${destPath}. Overwrite?`, defaultYes: false });
      if (!overwrite) {
        statusLine(`${ANSI.dim}=${ANSI.reset}`, `${label} file`, 'existing kept (differs from vendored copy)');
        fileStatuses.push('kept-existing');
      } else if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would overwrite ${destPath}`);
        fileStatuses.push('would-overwrite');
      } else {
        const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
        try { fs.copyFileSync(destPath, `${destPath}.bak.${stamp}`); } catch (_) { /* best-effort */ }
        fs.copyFileSync(sourcePath, destPath);
        fs.chmodSync(destPath, 0o644);
        statusLine(`${ANSI.green}↻${ANSI.reset}`, `${label} file`, `overwrote ${destPath}`);
        fileStatuses.push('overwritten');
      }
    }
  }

  // 2. Settings.json merge (both gate commands, matcher 'Bash').
  const read = _readSettingsJson(settingsPath);
  let settingsStatus;
  if (read.status === 'malformed') {
    statusLine(`${ANSI.red}✗${ANSI.reset}`, 'settings.json', `malformed (${read.error}); not modified`);
    settingsStatus = 'malformed';
  } else {
    const merged = _mergePreToolUseHookEntry(read.settings);
    if (merged.status === 'already-installed') {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'settings.json PreToolUse gates', 'already installed');
      settingsStatus = 'already-installed';
    } else if (merged.status === 'migrated-tilde-path') {
      if (dryRun) {
        statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would rewrite legacy ~ gate command to absolute path in ${settingsPath}`);
        settingsStatus = 'would-migrate-tilde';
      } else {
        _writeSettingsJson(settingsPath, merged.settings);
        statusLine(`${ANSI.green}↻${ANSI.reset}`, 'settings.json PreToolUse gates', 'rewrote legacy ~ command to absolute path');
        settingsStatus = 'migrated-tilde';
      }
    } else if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would merge PreToolUse gates into ${settingsPath}`);
      settingsStatus = 'would-install';
    } else {
      _writeSettingsJson(settingsPath, merged.settings);
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'settings.json PreToolUse gates', 'merged');
      settingsStatus = 'installed';
    }
  }

  process.stdout.write('\n');
  if (!dryRun && (fileStatuses.includes('copied') || settingsStatus === 'installed')) {
    process.stdout.write(`  ${ANSI.dim}PreToolUse gates installed. They stay INERT (allow everything) until you run \`doctrine promote publish-before-push\` / \`doctrine promote rls-five-gates\`.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}Sprint 81 / ULTRAPLAN §6 advise→gate.${ANSI.reset}\n\n`);
  }

  return { fileStatuses, settingsStatus };
}

// ── Doctrine registry (Sprint 78 T1) ──────────────────────────────────
//
// CRITICAL — FULL-FILE stamp, NOT the 4KB-head stamp. `_readHookSignatureVersion`
// above reads `slice(0, 4096)` + `HOOK_SIGNATURE_REGEX` — that is the exact stamp
// that failed in Sprint 51.6 (a file whose marker/content sits past the first
// 4KB is mis-graded, so bundled fixes never land). The doctrine copy on Brad's
// machine is READ-ONLY (he never hand-edits it), so the refresh gate is a plain
// full-file sha256 compare: any drift ⇒ refresh from the bundled copy. No
// version-number bookkeeping to forget; the content hash IS the stamp. This
// avoids the INSTALLER-PITFALLS 4KB-head failure class by construction.

function _fileSha256(filepath) {
  // FULL file read — never a 4KB-head slice.
  try { return crypto.createHash('sha256').update(fs.readFileSync(filepath)).digest('hex'); }
  catch (_) { return null; }
}

// Read-only refresh model: refresh when dest is missing OR its full-file hash
// differs from the bundled copy. Returns true ⇒ refresh needed.
function _doctrineRefreshNeeded(sourcePath, destPath) {
  const srcHash = _fileSha256(sourcePath);
  if (srcHash == null) return false; // bundled asset missing — nothing to vendor
  return _fileSha256(destPath) !== srcHash;
}

// Install / refresh the read-only doctrine registry copy. Promptless (the file
// is TermDeck-managed read-only; Brad never edits it, so there is no hand-edit
// to preserve). Fail-soft: any error logs a status line + returns, never throws
// into the installer flow.
function installDoctrineRegistry(opts = {}) {
  const dryRun = !!opts.dryRun;
  const sourcePath = opts.sourcePath || DOCTRINE_SHIPPED_SOURCE;
  const destPath = opts.destPath || DOCTRINE_SHIPPED_DEST;
  try {
    if (!fs.existsSync(sourcePath)) return { status: 'no-bundled-asset' };
    if (!_doctrineRefreshNeeded(sourcePath, destPath)) {
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'doctrine registry', 'already current (read-only)');
      return { status: 'already-current' };
    }
    if (dryRun) {
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would refresh read-only doctrine registry at ${destPath}`);
      return { status: 'would-refresh' };
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    // The dest is 0o444 after a prior install — make it writable for the
    // overwrite, then re-lock read-only.
    try { if (fs.existsSync(destPath)) fs.chmodSync(destPath, 0o644); } catch (_) { /* best-effort */ }
    fs.copyFileSync(sourcePath, destPath);
    try { fs.chmodSync(destPath, 0o444); } catch (_) { /* best-effort */ }
    statusLine(`${ANSI.green}↻${ANSI.reset}`, 'doctrine registry', `refreshed read-only copy at ${destPath}`);
    return { status: 'refreshed' };
  } catch (err) {
    statusLine(`${ANSI.yellow}!${ANSI.reset}`, 'doctrine registry', `skipped (fail-soft: ${err && err.message})`);
    return { status: 'error', error: err && err.message };
  }
}

// ── Standalone-shell capture shims (Sprint 68-REDUX, T2) ──────────────
//
// Claude Code panels get memory capture from the SessionEnd + PreCompact
// hooks above; non-Claude panels get it from the server's periodic-capture
// timer. A Codex / Grok / Antigravity CLI run in a PLAIN terminal — no
// TermDeck panel, no native hook surface — was the last dark cell.
//
// The mechanism (T1 owns the shim bodies; this file owns getting them onto
// the user's machine): one wrapper per CLI at ~/.termdeck/shims/<name>,
// with that directory PREPENDED to PATH via a marker-fenced block in the
// user's shell rc. The shim runs the real binary under a PTY, tees the
// transcript, and drains it through the existing bundled
// memory-session-end.js on exit.
//
// Failure classes this section is written against (INSTALLER-PITFALLS):
//   B — the rc file we write is chosen from $SHELL, never hardcoded, and an
//       rc dialect we cannot write safely (fish) is a LOUD SKIP, not a write.
//   E — zero developer-private paths; every path is derived from os.homedir().
//   H — the bundled source dir is resolved package-relative and its absence
//       is reported, never assumed; `files` whitelists carry assets/shims/**.
//   I — installed-but-never-fires is the enemy: the PATH block, the "open a
//       new shell" notice, and the doctor probes all exist for that reason.
//   N — {shim files, PATH fence} are ONE lockstep unit. Any path that stages
//       shims also reconciles the fence; neither ships without the other.

const SHIM_NAMES = ['codex', 'grok', 'agy'];
const SHIM_SOURCE_DIR = path.join(__dirname, '..', 'assets', 'shims');

// T1's shim is ONE file installed under THREE names — it derives its agent
// from its own basename (`AGENT="$(basename "$0")"`), so all three installed
// copies are byte-identical and the install is cp+chmod ×3. `drain.js` is a
// REQUIRED sibling, not an optional extra: the shim resolves it as
// `$SHIM_DIR/drain.js` and, when it is absent, the capture silently degrades
// to "ran the CLI, wrote nothing" — Class I with no other symptom. It ships
// 0644 on purpose: the shims dir is on PATH and only the three wrappers have
// any business being executable there.
// `redact.js` is a byte-identical vendored copy of `packages/mcp-bridge/src/
// redact.js` (node-builtins only, so it vendors cleanly). It is NOT optional
// polish: `script(1)` captures the RAW TERMINAL, so a pasted key, an `export
// SUPABASE_SERVICE_ROLE_KEY=…`, or an auth screen would otherwise be written
// verbatim to a cloud database. drain.js falls back to a small built-in
// pattern set when the sibling is missing — that fallback misses connection
// strings and entropy-based detection, which T4-CODEX demonstrated at
// 2026-08-01 15:58 ET by leaking a full `postgresql://user:pass@host/db` URI
// through the drain. Staging it is what makes the drain's own docstring true.
// VENDORED-COPY LOCKSTEP (Class N): re-copy from the canonical file whenever
// it changes; T3 should pin it the way `init-bridge.test.js` pins the
// supervise assets.
const SHIM_TEMPLATE_FILE = 'shim-template.sh';
const SHIM_SUPPORT_FILES = [
  { src: 'drain.js', dest: 'drain.js', mode: 0o644 },
  { src: 'redact.js', dest: 'redact.js', mode: 0o644 },
];

function _shimManifest(names) {
  return [
    ...(names || SHIM_NAMES).map((n) => ({ src: SHIM_TEMPLATE_FILE, dest: n, mode: 0o755, kind: 'shim' })),
    ...SHIM_SUPPORT_FILES.map((f) => ({ src: f.src, dest: f.dest, mode: f.mode, kind: 'support' })),
  ];
}

// Marker fence. The literal text is a CONTRACT shared with uninstall.js (which
// deliberately re-declares it rather than requiring this module — a partial
// install must still be uninstallable). Change here ⇒ change there.
const SHIM_FENCE_START = '# >>> termdeck shims >>>';
const SHIM_FENCE_END = '# <<< termdeck shims <<<';

// $HOME-relative on purpose: the rc file is portable across machines (Brad
// syncs dotfiles), and an absolute /Users/<someone> path in a synced .zshrc
// is a Class E footgun waiting to happen.
const SHIM_PATH_EXPORT = 'export PATH="$HOME/.termdeck/shims:$PATH"';

function _shimDestDir(home) { return path.join(home || os.homedir(), '.termdeck', 'shims'); }
function _shimBackupDir(home) { return path.join(home || os.homedir(), '.termdeck', 'shim-backups'); }
function _shimTranscriptsDir(home) { return path.join(home || os.homedir(), '.termdeck', 'standalone-transcripts'); }

// The exact text we write between the fences. Comparing a live rc block
// against this string is how "already current" vs "drifted" is decided, so
// every byte here is load-bearing — including the comment lines.
function _shimPathBlock() {
  return [
    SHIM_FENCE_START,
    '# Added by @jhizzard/termdeck-stack — standalone-shell memory capture.',
    '# Remove with `termdeck-stack uninstall`, or delete this fenced block.',
    SHIM_PATH_EXPORT,
    SHIM_FENCE_END,
  ].join('\n');
}

// Which rc file gets the PATH block. Derived from $SHELL — NEVER hardcoded to
// zsh even though that is what the dev fleet runs (Class F: the developer's
// shell is not the user's shell).
//
// - zsh   → ~/.zshrc            (read by every interactive zsh)
// - bash  → ~/.bashrc           (+ a darwin advisory: macOS Terminal starts
//                                LOGIN bash, which reads ~/.bash_profile and
//                                only reaches .bashrc if that file sources it.
//                                We advise; we do NOT silently edit a second
//                                file — one fence, one owner.)
// - fish  → UNSUPPORTED, loud skip. `export PATH=...` is not fish syntax; a
//           POSIX line in config.fish breaks the user's shell on next login.
//           Manual `fish_add_path` instruction instead.
// - other/absent → unsupported, loud skip with manual instructions.
// macOS bash: Terminal.app opens a LOGIN shell, and a login bash reads the
// FIRST existing of ~/.bash_profile, ~/.bash_login, ~/.profile — never
// ~/.bashrc directly. So writing our fence to .bashrc only works if that login
// file sources .bashrc. Two ways to lose:
//   (a) the login file exists and does not source .bashrc, or
//   (b) NO login file exists at all — .bashrc is then never read in a new
//       Terminal window, and the install looks perfect while doing nothing.
// (b) was T4-CODEX's 15:38 ET AUDIT-FAIL: the first cut only warned on (a).
// We advise rather than write a second file — one fence, one owner; silently
// editing a file the user didn't expect us in is worse than a loud sentence.
function _darwinBashAdvisory(home) {
  const candidates = ['.bash_profile', '.bash_login', '.profile'].map((n) => path.join(home, n));
  const loginFile = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (!loginFile) {
    return `macOS Terminal starts a LOGIN shell, and none of ~/.bash_profile, ~/.bash_login or ~/.profile exists — so ~/.bashrc (where the PATH block goes) is never read. Create ~/.bash_profile containing \`source ~/.bashrc\`, or the shims will not be on PATH in new terminals.`;
  }
  let sourcesBashrc = false;
  try { sourcesBashrc = /(^|\n)\s*(\.|source)\s+[^\n]*\.bashrc/.test(fs.readFileSync(loginFile, 'utf8')); }
  catch (_) { sourcesBashrc = false; }
  if (sourcesBashrc) return null;
  return `${loginFile} is what macOS's LOGIN bash reads, and it does not source ~/.bashrc — add \`source ~/.bashrc\` to it (or copy the fenced block there), or the shims will not be on PATH in new terminals.`;
}

function _detectRcTarget(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const raw = typeof env.SHELL === 'string' ? env.SHELL.trim() : '';
  const shell = raw ? path.basename(raw) : '';

  if (shell === 'zsh') {
    return { shell, supported: true, rcPath: path.join(home, '.zshrc'), advisory: null };
  }
  if (shell === 'bash') {
    return {
      shell, supported: true, rcPath: path.join(home, '.bashrc'),
      advisory: platform === 'darwin' ? _darwinBashAdvisory(home) : null,
    };
  }
  if (shell === 'fish') {
    return {
      shell, supported: false, rcPath: null, advisory: null,
      reason: 'fish does not use `export PATH=...`; writing a POSIX line into config.fish would break your shell',
      manual: `fish_add_path ${path.join('$HOME', '.termdeck', 'shims')}`,
    };
  }
  return {
    shell: shell || '(unset)', supported: false, rcPath: null, advisory: null,
    reason: shell ? `unrecognized login shell "${shell}"` : '$SHELL is not set',
    manual: `${SHIM_PATH_EXPORT}   # add to your shell's startup file`,
  };
}

// Locate our fence(s) in an rc file's text. Pure — takes text, returns line
// indices. Deliberately trims each line before comparing so an indented or
// trailing-whitespace copy of the marker is still recognised (users reindent).
function _scanRcFences(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === SHIM_FENCE_START) starts.push(i);
    else if (t === SHIM_FENCE_END) ends.push(i);
  });
  return { lines, starts, ends };
}

// Classify the rc file's current relationship to our block.
//   absent    — no markers at all; safe to append
//   current   — exactly one well-formed block, byte-identical to what we ship
//   drift     — exactly one well-formed block whose body differs
//   malformed — anything else (duplicate fences, orphaned marker, inverted
//               order). NEVER auto-repaired: we do not know which of two
//               blocks is ours, and guessing means mangling a file the user
//               has to log in through. Abort loudly, tell them where to look.
function _rcBlockState(text) {
  const { lines, starts, ends } = _scanRcFences(text);
  if (starts.length === 0 && ends.length === 0) return { status: 'absent' };
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return {
      status: 'malformed',
      detail: `${starts.length} "${SHIM_FENCE_START}" marker(s) and ${ends.length} "${SHIM_FENCE_END}" marker(s)`
        + (starts.length === 1 && ends.length === 1 ? ' (end marker precedes start marker)' : ''),
      startLines: starts.map((i) => i + 1),
      endLines: ends.map((i) => i + 1),
    };
  }
  const body = lines.slice(starts[0], ends[0] + 1).join('\n');
  // POSITION IS PART OF CORRECTNESS, not just content. A byte-perfect block
  // sitting above someone's `export PATH="/usr/local/bin:$PATH"` loses the
  // race and captures nothing — identical symptom to not being installed at
  // all. So "current" requires both the right bytes AND nothing but blank
  // lines after it. Anything else is drift, and drift gets relocated to EOF.
  // (T4-CODEX 15:38 ET AUDIT-FAIL: in-place refresh preserved a losing
  // position and still reported success.)
  const trailing = lines.slice(ends[0] + 1).every((l) => l.trim() === '');
  const bodyMatches = body === _shimPathBlock();
  return {
    status: bodyMatches && trailing ? 'current' : 'drift',
    driftKind: bodyMatches ? 'position' : (trailing ? 'content' : 'content+position'),
    start: starts[0], end: ends[0], body,
  };
}

// Insert-or-update our block. APPENDS at end of file when absent — deliberate:
// `export PATH="$HOME/.termdeck/shims:$PATH"` only wins if it runs AFTER every
// other PATH mutation in the rc (nvm, pyenv, homebrew shellenv all prepend).
// A block at the top of .zshrc loses the race and the shims never resolve —
// installed-but-never-fires, Class I.
function _upsertRcBlock(text) {
  const state = _rcBlockState(text);
  const block = _shimPathBlock();
  if (state.status === 'malformed') return { status: 'malformed', detail: state.detail, text: String(text == null ? '' : text) };
  if (state.status === 'current') return { status: 'current', text: String(text == null ? '' : text) };
  // Drift is repaired by EXCISE-THEN-APPEND, never edit-in-place: a refreshed
  // block that stays where it was keeps whatever PATH entries follow it, and
  // the user is told "refreshed" while still being shadowed.
  const existing = String(text == null ? '' : text);
  let base = existing;
  if (state.status === 'drift') {
    const { lines } = _scanRcFences(existing);
    let from = state.start;
    if (from > 0 && lines[from - 1].trim() === '') from -= 1;
    base = lines.slice(0, from).concat(lines.slice(state.end + 1)).join('\n');
  }
  // OUR BLOCK INHERITS THE FILE'S NEWLINE CONVENTION. A file that ended
  // without a trailing newline gets a block that also ends without one.
  // This is not cosmetics — it is what makes uninstall reversible. Once we
  // normalize, "the user's file ended with \n" and "it didn't" become the same
  // on-disk state, and uninstall cannot know which to restore. Letting the
  // fence carry that one bit makes the round-trip exact in BOTH directions.
  // (T4-CODEX 15:59 ET correctly falsified the earlier broad byte-identical
  // claim on exactly this edge.) A brand-new/empty file gets the newline —
  // POSIX text files end with one.
  const endsWithNewline = existing === '' ? true : /\n$/.test(existing);
  const tail = endsWithNewline ? '\n' : '';
  const trimmed = base.replace(/\n+$/, '');
  const text2 = trimmed.trim() === '' ? `${block}${tail}` : `${trimmed}\n\n${block}${tail}`;
  return { status: state.status === 'drift' ? 'updated' : 'installed', text: text2 };
}

// Remove our block. Also drops ONE immediately-preceding blank line — the
// separator `_upsertRcBlock` inserted — so an install→uninstall round-trip on
// a newline-terminated rc file returns it byte-identical.
function _removeRcBlock(text) {
  const state = _rcBlockState(text);
  const existing = String(text == null ? '' : text);
  if (state.status === 'absent') return { status: 'absent', text: existing };
  if (state.status === 'malformed') return { status: 'malformed', detail: state.detail, text: existing };
  const { lines } = _scanRcFences(existing);
  let from = state.start;
  if (from > 0 && lines[from - 1].trim() === '') from -= 1;
  const kept = lines.slice(0, from).concat(lines.slice(state.end + 1));
  let next = kept.join('\n');
  // Mirror of the install rule above: restore the file's original newline
  // convention rather than imposing one.
  const endsWithNewline = /\n$/.test(existing);
  if (next.trim() === '') next = '';
  else if (endsWithNewline) { if (!next.endsWith('\n')) next += '\n'; }
  else next = next.replace(/\n+$/, '');
  return { status: 'removed', text: next };
}

// Atomic rc write with a timestamped backup. Mode is carried over from the
// existing file so we never widen permissions on someone's rc.
function _writeRcFile(rcPath, text, opts = {}) {
  const stamp = (opts.stamp || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14));
  let backup = null;
  let mode = 0o644;
  if (fs.existsSync(rcPath)) {
    try { mode = fs.statSync(rcPath).mode & 0o777; } catch (_) { /* default */ }
    backup = `${rcPath}.bak.${stamp}`;
    try { fs.copyFileSync(rcPath, backup); } catch (_) { backup = null; }
  }
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const tmp = `${rcPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, rcPath);
  return { backup };
}

// Copy the shim manifest into ~/.termdeck/shims/. Refresh gate is a FULL-FILE
// content compare, not the 4KB-head version stamp — same reasoning as the
// doctrine registry above: a stamp that lives past the first 4KB is silently
// mis-graded (the Sprint 51.6 failure), and shims are TermDeck-managed files
// with no hand-edit contract to preserve. Any drift ⇒ back up, overwrite.
//
// Backups land in ~/.termdeck/shim-backups/ (NOT in the shims dir) and are
// written non-executable: the shims dir is on PATH, and a stray executable
// `codex.bak.20260801…` sitting in a PATH directory is exactly the kind of
// footgun this whole section exists to avoid.
//
// Shared, pure-ish primitive: a lockstep twin lives in
// packages/cli/src/init-mnestra.js (`_stageShimFiles`) because the published
// @jhizzard/termdeck tarball ships assets/ but NOT stack-installer/src/, so
// the wizard cannot require() across the package boundary at runtime.
// INSTALLER-PITFALLS Class N — change both or neither.
function _stageShimFiles(opts = {}) {
  const sourceDir = opts.sourceDir || SHIM_SOURCE_DIR;
  const destDir = opts.destDir || _shimDestDir(opts.home);
  const backupDir = opts.backupDir || _shimBackupDir(opts.home);
  const dryRun = !!opts.dryRun;
  const stamp = opts.stamp || new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const manifest = _shimManifest(opts.names);
  const results = [];

  // Heal the directory mode FIRST, unconditionally — before any per-file
  // status decision. On an idempotent re-run where every file is already
  // byte-current, the per-file loop short-circuits, so a 0755 shims dir (umask,
  // a dir someone else created, a restore) would keep its wide mode forever
  // while the installer reported "already current". T4-CODEX 15:38 ET.
  if (!dryRun && manifest.some((e) => fs.existsSync(path.join(sourceDir, e.src)))) {
    try {
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(destDir, 0o700);
    } catch (_) { /* best-effort; per-file writes below surface any real problem */ }
  }

  for (const entry of manifest) {
    const name = entry.dest;
    const src = path.join(sourceDir, entry.src);
    const dest = path.join(destDir, entry.dest);
    if (!fs.existsSync(src)) { results.push({ name, kind: entry.kind, status: 'no-bundled-asset' }); continue; }
    try {
      const srcBuf = fs.readFileSync(src);
      if (!fs.existsSync(dest)) {
        if (dryRun) { results.push({ name, kind: entry.kind, status: 'would-install' }); continue; }
        fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, srcBuf, { mode: entry.mode });
        fs.chmodSync(dest, entry.mode);
        results.push({ name, kind: entry.kind, status: 'installed', dest });
        continue;
      }
      if (fs.readFileSync(dest).equals(srcBuf)) {
        // Re-assert the mode even on a content no-op: a shim that lost +x
        // (rsync'd dotfiles, a restore from backup, a umask surprise) is a
        // shim that never fires, and the content compare would never notice.
        if (!dryRun) { try { fs.chmodSync(dest, entry.mode); } catch (_) { /* best-effort */ } }
        results.push({ name, kind: entry.kind, status: 'already-current', dest });
        continue;
      }
      if (dryRun) { results.push({ name, kind: entry.kind, status: 'would-refresh' }); continue; }
      let backup = null;
      try {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        backup = path.join(backupDir, `${name}.bak.${stamp}`);
        fs.copyFileSync(dest, backup);
        fs.chmodSync(backup, 0o644);
      } catch (_) { backup = null; }
      fs.writeFileSync(dest, srcBuf, { mode: entry.mode });
      fs.chmodSync(dest, entry.mode);
      results.push({ name, kind: entry.kind, status: 'refreshed', dest, backup });
    } catch (err) {
      results.push({ name, kind: entry.kind, status: 'error', error: err && err.message });
    }
  }
  return results;
}

// Reconcile the PATH fence. Returns a status + the rc target it acted on.
// Never throws: an rc we cannot parse or write is reported, not forced.
function _ensureRcPathBlock(opts = {}) {
  const dryRun = !!opts.dryRun;
  const target = opts.target || _detectRcTarget(opts);
  if (!target.supported) {
    return { status: 'unsupported-shell', target };
  }
  let existing = '';
  try { existing = fs.existsSync(target.rcPath) ? fs.readFileSync(target.rcPath, 'utf8') : ''; }
  catch (err) { return { status: 'unreadable', target, error: err && err.message }; }

  const up = _upsertRcBlock(existing);
  if (up.status === 'malformed') return { status: 'malformed', target, detail: up.detail };
  if (up.status === 'current') return { status: 'already-current', target };
  if (dryRun) return { status: up.status === 'updated' ? 'would-update' : 'would-install', target };
  try {
    const { backup } = _writeRcFile(target.rcPath, up.text, { stamp: opts.stamp });
    return { status: up.status, target, backup };
  } catch (err) {
    return { status: 'error', target, error: err && err.message };
  }
}

// Sprint 68-REDUX T2 — install the standalone-shell capture shims. Same
// consent shape as installPreCompactHook: one informed prompt, default-on,
// `--yes` accepts, `--no`/decline is honoured and leaves the rc untouched.
// The prompt names the rc file explicitly because this is the first thing
// TermDeck installs that edits the user's shell startup.
async function installShellShims(opts = {}) {
  const dryRun = !!opts.dryRun;
  const home = opts.home || os.homedir();
  const sourceDir = opts.sourceDir || SHIM_SOURCE_DIR;
  const destDir = opts.destDir || _shimDestDir(home);
  const names = opts.names || SHIM_NAMES;
  const target = opts.target || _detectRcTarget({ ...opts, home });

  rule();
  process.stdout.write(`${ANSI.bold}Standalone-shell memory capture${ANSI.reset}\n`);
  process.stdout.write(`${ANSI.dim}  Wrappers for ${names.join(', ')} at ~/.termdeck/shims/, prepended to PATH. A Codex/Grok/Antigravity session you run in a plain terminal — outside a TermDeck panel — gets captured into Mnestra the same way a panel does. Inside a panel the wrapper steps aside, so nothing is ever captured twice.${ANSI.reset}\n`);
  if (target.supported) {
    process.stdout.write(`${ANSI.dim}  This appends a fenced block to ${target.rcPath} (backed up first; \`termdeck-stack uninstall\` removes it).${ANSI.reset}\n\n`);
  } else {
    process.stdout.write(`${ANSI.dim}  Your shell (${target.shell}) needs a manual PATH line — the wrappers install either way and we print the exact line.${ANSI.reset}\n\n`);
  }

  // Bundled assets absent (older tarball, or a `files` whitelist that forgot
  // assets/shims/** — Class H) — report and return. Never half-install.
  if (!fs.existsSync(sourceDir)) {
    statusLine(`${ANSI.yellow}!${ANSI.reset}`, 'shell shims', 'skipped (no bundled shim assets in this build)');
    process.stdout.write('\n');
    return { fileStatuses: [], pathStatus: 'no-bundled-asset', target };
  }

  const promptInstall = opts.promptInstall
    || (() => promptYesNo({ question: 'Install the standalone-shell capture wrappers (adds ~/.termdeck/shims to PATH)?', defaultYes: true }));
  const userWantsInstall = opts.assumeYes ? true
    : opts.assumeNo ? false
    : await promptInstall();

  if (!userWantsInstall) {
    statusLine(`${ANSI.dim}─${ANSI.reset}`, 'shell shims', 'skipped (user declined)');
    process.stdout.write('\n');
    return { fileStatuses: names.map((name) => ({ name, status: 'declined' })), pathStatus: 'declined', target };
  }

  // 1. Shim files.
  const fileStatuses = _stageShimFiles({ sourceDir, destDir, names, dryRun, home, stamp: opts.stamp });
  for (const r of fileStatuses) {
    const label = r.kind === 'support' ? r.name : `shim ${r.name}`;
    if (r.status === 'installed') statusLine(`${ANSI.green}+${ANSI.reset}`, label, `installed at ${r.dest}`);
    else if (r.status === 'refreshed') statusLine(`${ANSI.green}↻${ANSI.reset}`, label, `refreshed${r.backup ? ` (backup: ${path.basename(r.backup)})` : ''}`);
    else if (r.status === 'already-current') statusLine(`${ANSI.dim}=${ANSI.reset}`, label, 'already current');
    else if (r.status === 'would-install') statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would install ${label}`);
    else if (r.status === 'would-refresh') statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would refresh ${label}`);
    else if (r.status === 'no-bundled-asset') statusLine(`${ANSI.yellow}!${ANSI.reset}`, label, 'skipped (not in this build)');
    else statusLine(`${ANSI.red}✗${ANSI.reset}`, label, `failed: ${r.error}`);
  }

  // 2. PATH fence. Lockstep with (1) — Class N: a shim on disk with no PATH
  // entry is installed-but-never-fires.
  const pathResult = _ensureRcPathBlock({ dryRun, target, stamp: opts.stamp });
  const staged = fileStatuses.some((r) => r.status === 'installed' || r.status === 'refreshed' || r.status === 'already-current');
  switch (pathResult.status) {
    case 'installed':
      statusLine(`${ANSI.green}+${ANSI.reset}`, 'PATH block', `added to ${target.rcPath}${pathResult.backup ? ` (backup: ${path.basename(pathResult.backup)})` : ''}`);
      break;
    case 'updated':
      statusLine(`${ANSI.green}↻${ANSI.reset}`, 'PATH block', `refreshed in ${target.rcPath}${pathResult.backup ? ` (backup: ${path.basename(pathResult.backup)})` : ''}`);
      break;
    case 'already-current':
      statusLine(`${ANSI.dim}=${ANSI.reset}`, 'PATH block', `already present in ${target.rcPath}`);
      break;
    case 'would-install':
    case 'would-update':
      statusLine(`${ANSI.yellow}↩${ANSI.reset}`, '(dry-run)', `would write the PATH block to ${target.rcPath}`);
      break;
    case 'malformed':
      statusLine(`${ANSI.red}✗${ANSI.reset}`, 'PATH block', `${target.rcPath} has ${pathResult.detail}; NOT modified`);
      process.stdout.write(`  ${ANSI.yellow}Fix by hand:${ANSI.reset} delete every "${SHIM_FENCE_START}" … "${SHIM_FENCE_END}" block from ${target.rcPath}, then re-run this installer.\n`);
      break;
    case 'unsupported-shell':
      statusLine(`${ANSI.yellow}!${ANSI.reset}`, 'PATH block', `not written — ${target.reason}`);
      process.stdout.write(`  ${ANSI.yellow}Add this to your shell's startup file yourself:${ANSI.reset} ${ANSI.bold}${target.manual}${ANSI.reset}\n`);
      break;
    case 'unreadable':
      statusLine(`${ANSI.red}✗${ANSI.reset}`, 'PATH block', `could not read ${target.rcPath}: ${pathResult.error}`);
      break;
    default:
      statusLine(`${ANSI.red}✗${ANSI.reset}`, 'PATH block', `failed: ${pathResult.error || pathResult.status}`);
  }
  if (target.advisory) {
    process.stdout.write(`  ${ANSI.yellow}Note:${ANSI.reset} ${target.advisory}\n`);
  }

  process.stdout.write('\n');
  if (!dryRun && staged && (pathResult.status === 'installed' || pathResult.status === 'updated')) {
    // Class I — the single most likely way this silently does nothing is the
    // user never re-reading their rc. Say it explicitly, every time.
    process.stdout.write(`  ${ANSI.bold}Open a new terminal${ANSI.reset} ${ANSI.dim}(or run \`exec $SHELL -l\`) for the shims to take effect — the PATH change does not apply to this shell.${ANSI.reset}\n`);
    process.stdout.write(`  ${ANSI.dim}Verify any time with \`termdeck doctor\`. Transcripts are kept at ~/.termdeck/standalone-transcripts/.${ANSI.reset}\n\n`);
  }

  return { fileStatuses, pathStatus: pathResult.status, pathBackup: pathResult.backup || null, target };
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
  if (sub !== 'start' && sub !== 'stop' && sub !== 'status' && sub !== 'uninstall') return null;
  if (sub === 'uninstall') {
    // Sprint 61 T1 — tear down all TermDeck-attributable state. Lazy-require so
    // the wizard / launcher paths don't pay the uninstall module's load cost.
    const uninstallMod = require('./uninstall');
    const result = await uninstallMod.uninstall({ argv: argv.slice(1) });
    return result.exitCode || 0;
  }
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

  // Sprint 64 T3 — bundle the PreCompact memory hook (Investigation 2 closure).
  // Same prompt UX as SessionEnd: default-on, opt-out via prompt; --yes
  // accepts the install. The two hooks coexist — SessionEnd captures on
  // /exit, PreCompact captures before context compaction.
  await installPreCompactHook({
    dryRun: args.dryRun,
    assumeYes: args.yes,
  });

  // Sprint 81 T3 — bundle the two PreToolUse deny gates (advise→gate). Same
  // default-on/opt-out UX; the gates are inert until their doctrine rule is
  // promoted, so installing them is safe and changes nothing until opt-in.
  await installPreToolUseHook({
    dryRun: args.dryRun,
    assumeYes: args.yes,
  });

  // Sprint 68-REDUX T2 — standalone-shell capture shims. Closes the last
  // capture dark cell: a Codex/Grok/agy CLI run in a plain terminal, outside
  // any TermDeck panel. Same default-on/opt-out consent shape as the hooks
  // above, but the prompt names the rc file it will edit — this is the only
  // thing in the installer that touches the user's shell startup.
  await installShellShims({
    dryRun: args.dryRun,
    assumeYes: args.yes,
  });

  // Sprint 78 T1 — vendor the read-only doctrine registry copy (audience:'all'
  // + active entries, baked at publish) so Brad has an inspectable artifact.
  // Promptless; full-file-hash refresh gate; fail-soft (never aborts install).
  installDoctrineRegistry({ dryRun: args.dryRun });

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
// Sprint 51.6 T3 — version-aware hook refresh helpers. Exported so init-mnestra
// (and tests) can gate refresh decisions on the same logic the installer uses.
module.exports._readHookSignatureVersion = _readHookSignatureVersion;
module.exports._hookSignatureUpgradeAvailable = _hookSignatureUpgradeAvailable;
module.exports.HOOK_SIGNATURE_REGEX = HOOK_SIGNATURE_REGEX;
module.exports.installSessionEndHook = installSessionEndHook;
module.exports.HOOK_COMMAND = HOOK_COMMAND;
// Sprint 75 T2 — absolute-path hook-command builders (lockstep twin in
// packages/cli/src/init-mnestra.js; exported for tests).
module.exports._hookCommandFor = _hookCommandFor;
module.exports._isTildeHookCommand = _isTildeHookCommand;
module.exports.HOOK_SOURCE = HOOK_SOURCE;
module.exports.HOOK_DEST = HOOK_DEST;
module.exports.HOOK_TIMEOUT_SECONDS = HOOK_TIMEOUT_SECONDS;
module.exports.HOOK_SOURCE = HOOK_SOURCE;
// Sprint 64 T3 — PreCompact hook (Investigation 2 closure) exports.
module.exports.installPreCompactHook = installPreCompactHook;
module.exports.installDoctrineRegistry = installDoctrineRegistry;
module.exports._fileSha256 = _fileSha256;
module.exports._doctrineRefreshNeeded = _doctrineRefreshNeeded;
module.exports.DOCTRINE_SHIPPED_SOURCE = DOCTRINE_SHIPPED_SOURCE;
module.exports.DOCTRINE_SHIPPED_DEST = DOCTRINE_SHIPPED_DEST;
module.exports._isPreCompactHookEntry = _isPreCompactHookEntry;
module.exports._mergePreCompactHookEntry = _mergePreCompactHookEntry;
module.exports.PRECOMPACT_HOOK_COMMAND = PRECOMPACT_HOOK_COMMAND;
module.exports.PRECOMPACT_HOOK_SOURCE = PRECOMPACT_HOOK_SOURCE;
module.exports.PRECOMPACT_HOOK_DEST = PRECOMPACT_HOOK_DEST;
module.exports.PRECOMPACT_HOOK_TIMEOUT_SECONDS = PRECOMPACT_HOOK_TIMEOUT_SECONDS;
// Sprint 81 T3 — PreToolUse deny gates (advise→gate) exports.
module.exports.installPreToolUseHook = installPreToolUseHook;
module.exports._isPreToolUseHookEntry = _isPreToolUseHookEntry;
module.exports._mergePreToolUseHookEntry = _mergePreToolUseHookEntry;
module.exports.PRETOOLUSE_GATE_FILES = PRETOOLUSE_GATE_FILES;
module.exports.PRETOOLUSE_GATE_SOURCES = PRETOOLUSE_GATE_SOURCES;
module.exports.PRETOOLUSE_GATE_DESTS = PRETOOLUSE_GATE_DESTS;
module.exports.PRETOOLUSE_HOOK_TIMEOUT_SECONDS = PRETOOLUSE_HOOK_TIMEOUT_SECONDS;
// Sprint 68-REDUX T2 — standalone-shell shim surface.
module.exports.installShellShims = installShellShims;
module.exports._stageShimFiles = _stageShimFiles;
module.exports._ensureRcPathBlock = _ensureRcPathBlock;
module.exports._detectRcTarget = _detectRcTarget;
module.exports._shimPathBlock = _shimPathBlock;
module.exports._scanRcFences = _scanRcFences;
module.exports._rcBlockState = _rcBlockState;
module.exports._upsertRcBlock = _upsertRcBlock;
module.exports._removeRcBlock = _removeRcBlock;
module.exports._writeRcFile = _writeRcFile;
module.exports._shimDestDir = _shimDestDir;
module.exports._shimBackupDir = _shimBackupDir;
module.exports._shimTranscriptsDir = _shimTranscriptsDir;
module.exports._shimManifest = _shimManifest;
module.exports.SHIM_NAMES = SHIM_NAMES;
module.exports.SHIM_TEMPLATE_FILE = SHIM_TEMPLATE_FILE;
module.exports.SHIM_SUPPORT_FILES = SHIM_SUPPORT_FILES;
module.exports.SHIM_SOURCE_DIR = SHIM_SOURCE_DIR;
module.exports.SHIM_FENCE_START = SHIM_FENCE_START;
module.exports.SHIM_FENCE_END = SHIM_FENCE_END;
module.exports.SHIM_PATH_EXPORT = SHIM_PATH_EXPORT;

module.exports._mcpInternals = _mcpInternals;
module.exports.MCP_CONFIG_PATH = MCP_CONFIG;
module.exports.CLAUDE_MCP_PATH_CANONICAL = CLAUDE_MCP_PATH_CANONICAL;
module.exports.CLAUDE_MCP_PATH_LEGACY = CLAUDE_MCP_PATH_LEGACY;

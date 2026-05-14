#!/usr/bin/env node

// @jhizzard/termdeck-stack — uninstall command (Sprint 61, T1).
//
// Removes everything `termdeck-stack` (and `npx @jhizzard/termdeck-stack`)
// adds to a user's machine — surgically, idempotently, OS-aware. Does NOT
// touch the user's Supabase project or schemas unless --purge-supabase is
// explicitly passed and the user types the project ref to confirm.
//
// Public entry: `async function uninstall(opts) -> { ok, exitCode, summary }`.
//
// All side-effecting steps go through dependency-injection hooks on `opts`
// (`_fs`, `_spawnSync`, `_promptYesNo`, `_promptInputMatching`, `_now`) so
// the test suite can drive each step against a tempdir as fake $HOME without
// monkey-patching `os.homedir()` or shelling to real `launchctl` / `psql`.
//
// Steps run in this order (each independent: try/catch into a summary entry,
// one missing prior step never blocks a later one):
//
//   1. Pre-flight detection + summary + confirmation prompt (skip on --yes).
//   2. ~/.termdeck/ directory                              (preserve secrets.env* with --keep-secrets).
//   3. ~/.claude.json mnestra MCP entry                    (atomic surgical splice; abort on malformed).
//   4. ~/.claude/settings.json Stop+SessionEnd hook entry  (atomic surgical splice; abort on malformed).
//   5. ~/.claude/hooks/memory-session-end.js               (rename to .bak.<dashed-ISO>).
//   6. LaunchAgents on darwin                              (launchctl unload, then rm).
//   7. systemd user units on linux                         (systemctl --user disable --now, then rm).
//   8. --purge-supabase                                    (two-step prompt: confirm + type project ref).
//   9. Final notice with `npm uninstall -g …` hint.
//
// Idempotency contract (per the lane brief):
//   - Empty $HOME (no install state) → exit 0, "nothing to uninstall".
//   - Already-uninstalled state      → exit 0, "already uninstalled" (we
//                                     detect this by presence of a sibling
//                                     `~/.claude/hooks/memory-session-end.js
//                                     .bak.*` from a prior uninstall).
//   - Malformed ~/.claude.json       → exit !=0, file bit-exact, others
//                                     skipped (pre-flight validation aborts
//                                     BEFORE any destructive step runs —
//                                     including --purge-supabase).

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const child_process = require('node:child_process');

const ANSI = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};

// Substring match on hook-entry .command — robust to ~ vs $HOME vs absolute
// paths. Same shape as the install-side `_isSessionEndHookEntry` in
// stack-installer/src/index.js, deliberately duplicated here so the uninstall
// path has no cross-module require risk on partial installs.
function _isSessionEndHookEntry(entry) {
  return entry && typeof entry.command === 'string'
    && entry.command.includes('memory-session-end.js');
}

// Sprint 64 T3 — PreCompact entry predicate (Investigation 2 closure). Used
// alongside _isSessionEndHookEntry to splice both hook kinds during uninstall.
function _isPreCompactHookEntry(entry) {
  return entry && typeof entry.command === 'string'
    && entry.command.includes('memory-pre-compact.js');
}

function _isAnyTermdeckHookEntry(entry) {
  return _isSessionEndHookEntry(entry) || _isPreCompactHookEntry(entry);
}

// ── Args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    dryRun: false,
    yes: false,
    keepSecrets: false,
    purgeSupabase: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--keep-secrets') { out.keepSecrets = true; continue; }
    if (a === '--purge-supabase') { out.purgeSupabase = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
  }
  return out;
}

function printHelp(out = process.stdout) {
  out.write(`
  termdeck-stack uninstall — tear down all TermDeck-attributable state

  Usage:
    termdeck-stack uninstall [options]

  Options:
    --dry-run          Print what would be removed; no changes
    --purge-supabase   Also drop Mnestra/Rumen schemas from the linked
                       Supabase project. BANNED unless explicitly
                       confirmed. Two-step prompt: first asks, then
                       requires the project ref typed for confirmation.
    --keep-secrets     Preserve ~/.termdeck/secrets.env (default: prompt;
                       in --yes / CI mode, secrets are removed).
    --yes, -y          Skip all confirmations (CI mode).
    --help, -h         Print usage.

  What gets removed (default):
    1. ~/.termdeck/                                   (entire directory)
    2. ~/.claude.json mnestra MCP entry               (surgical splice)
    3. ~/.claude/settings.json SessionEnd/Stop hook   (surgical splice)
    4. ~/.claude/hooks/memory-session-end.js          (renamed to .bak.<timestamp>)
    5. LaunchAgents (macOS) or systemd units (Linux)  (unload + remove)

  What is NEVER removed without an explicit flag:
    - Your Supabase project (data preservation)
    - The Mnestra/Rumen schemas inside the Supabase project
    - Other MCP entries in ~/.claude.json
    - Other hooks in ~/.claude/hooks/
    - Other event wirings in ~/.claude/settings.json

`);
}

// ── Helpers ─────────────────────────────────────────────────────────

function _formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Walk a directory and sum bytes. Used purely for the pre-flight summary.
// Best-effort — any IO error short-circuits to 0 rather than aborting the run.
function _approxSize(_fs, dir) {
  try {
    const stat = _fs.statSync(dir);
    if (!stat.isDirectory()) return stat.size || 0;
    let total = 0;
    for (const entry of _fs.readdirSync(dir, { withFileTypes: true })) {
      const sub = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += _approxSize(_fs, sub);
        else total += _fs.statSync(sub).size || 0;
      } catch (_) { /* skip unreadable entries */ }
    }
    return total;
  } catch (_) { return 0; }
}

// Atomic JSON write: temp file + rename. Used for both ~/.claude.json and
// ~/.claude/settings.json. Mirrors the pattern in mcp-config.js / index.js.
function _atomicWriteJson(_fs, filePath, value, mode) {
  _fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  _fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: mode || 0o600 });
  _fs.renameSync(tmp, filePath);
}

// Parse a `KEY=VALUE` env file. Mirrors the install-side `readTermdeckSecrets`
// and `readSecrets` parsers (deliberately self-contained — no cross-module
// require so a partial install state can still parse what's left).
function _parseEnvFile(_fs, filePath) {
  try {
    const text = _fs.readFileSync(filePath, 'utf8');
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
  } catch (_) { return {}; }
}

// Canonical ISO-8601 timestamp for the hook backup suffix. Format:
// `2026-05-07T22:48:00.000Z` — exactly what `Date.prototype.toISOString()`
// returns. Brief mandates ISO-8601-regex matching (T4-CODEX 18:46 ET concern);
// POSIX filesystems handle colons in filenames without issue.
function _isoStamp(_now) {
  const d = (_now || (() => new Date()))();
  return d.toISOString();
}

// Default interactive yes/no prompt — only invoked when neither --yes nor a
// test stub is provided. Returns a boolean.
async function _defaultPromptYesNo(question, defaultYes = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? '(Y/n)' : '(y/N)';
  const ans = (await rl.question(`  ${question} ${suffix} `)).trim().toLowerCase();
  rl.close();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

// Default interactive "type X to confirm" prompt — only invoked for
// --purge-supabase. Returns true iff the user types the expected literal.
async function _defaultPromptInputMatching(question, expected) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`  ${question} `)).trim();
  rl.close();
  return ans === expected;
}

// ── Detection ───────────────────────────────────────────────────────

// Pure: returns the resolved set of paths under the given fake-or-real $HOME
// for a given platform. Centralized so every step uses the same shapes and
// the test fixtures know exactly what to populate.
function _resolvePaths(home, platform) {
  return {
    home,
    platform,
    termdeckDir: path.join(home, '.termdeck'),
    secretsEnv: path.join(home, '.termdeck', 'secrets.env'),
    claudeJson: path.join(home, '.claude.json'),
    settingsJson: path.join(home, '.claude', 'settings.json'),
    hookFile: path.join(home, '.claude', 'hooks', 'memory-session-end.js'),
    // Sprint 64 T3 — PreCompact hook destination (Investigation 2 closure).
    preCompactHookFile: path.join(home, '.claude', 'hooks', 'memory-pre-compact.js'),
    launchAgentsDir: path.join(home, 'Library', 'LaunchAgents'),
    launchAgentGlob: 'com.jhizzard.termdeck.', // prefix match against .plist files
    systemdUnit: path.join(home, '.config', 'systemd', 'user', 'termdeck.service'),
  };
}

function _claudeJsonHasMnestraEntry(_fs, claudeJson) {
  if (!_fs.existsSync(claudeJson)) return false;
  let parsed;
  try { parsed = JSON.parse(_fs.readFileSync(claudeJson, 'utf8') || '{}'); }
  catch (_) { return false; }
  return !!(parsed && parsed.mcpServers && parsed.mcpServers.mnestra);
}

function _settingsJsonHasOurHook(_fs, settingsJson) {
  if (!_fs.existsSync(settingsJson)) return false;
  let parsed;
  try { parsed = JSON.parse(_fs.readFileSync(settingsJson, 'utf8') || '{}'); }
  catch (_) { return false; }
  if (!parsed || !parsed.hooks) return false;
  // Sprint 64 T3 — also probe PreCompact wiring (Investigation 2 closure).
  for (const event of ['Stop', 'SessionEnd', 'PreCompact']) {
    const arr = parsed.hooks[event];
    if (!Array.isArray(arr)) continue;
    for (const elem of arr) {
      if (!elem) continue;
      // Canonical Claude-Code group shape: { matcher, hooks: [{ type, command }] }
      if (Array.isArray(elem.hooks) && elem.hooks.some(_isAnyTermdeckHookEntry)) return true;
      // Legacy / hand-edited flat shape: { type, command } directly in array.
      // T3 (Sprint 61 18:50 ET) found that real-world fixtures use this
      // alternative shape, and our uninstall must handle both.
      if (_isAnyTermdeckHookEntry(elem)) return true;
    }
  }
  return false;
}

function _findLaunchAgents(_fs, dir, prefix) {
  try {
    return _fs.readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.plist'))
      .map((n) => path.join(dir, n));
  } catch (_) { return []; }
}

// Look for prior-uninstall residue: `memory-session-end.js.bak.*` siblings of
// the canonical hook destination. Used to distinguish "never installed" (no
// bak files, so we say "nothing to uninstall") from "already uninstalled" (at
// least one bak file from a prior run, so we say "already uninstalled"). The
// distinction is required by the T1 brief idempotency contract — T4-CODEX
// 18:46 ET concern.
function _findHookBakFiles(_fs, hookFile) {
  try {
    const dir = path.dirname(hookFile);
    const baseName = path.basename(hookFile);
    return _fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${baseName}.bak.`))
      .map((n) => path.join(dir, n));
  } catch (_) { return []; }
}

function _detectInstallState(_fs, paths) {
  const launchAgents = paths.platform === 'darwin'
    ? _findLaunchAgents(_fs, paths.launchAgentsDir, paths.launchAgentGlob)
    : [];
  const systemdActive = paths.platform === 'linux' && _fs.existsSync(paths.systemdUnit);
  return {
    hasTermdeckDir: _fs.existsSync(paths.termdeckDir),
    hasMnestraMcpEntry: _claudeJsonHasMnestraEntry(_fs, paths.claudeJson),
    hasOurHookInSettings: _settingsJsonHasOurHook(_fs, paths.settingsJson),
    hasHookFile: _fs.existsSync(paths.hookFile),
    hookBakFiles: _findHookBakFiles(_fs, paths.hookFile),
    // Sprint 64 T3 — PreCompact hook file detection (Investigation 2 closure).
    hasPreCompactHookFile: _fs.existsSync(paths.preCompactHookFile),
    preCompactHookBakFiles: _findHookBakFiles(_fs, paths.preCompactHookFile),
    launchAgents,
    systemdActive,
  };
}

// Pre-flight validation. Runs BEFORE any destructive step. If `~/.claude.json`
// exists but is malformed, abort hard — never run --purge-supabase, never
// remove ~/.termdeck, never splice settings.json. T4-CODEX 18:48 ET concern:
// previously the malformed-claude.json fatal step was discovered only after
// destructive steps had already run, risking a partial destructive uninstall
// on exactly the path documented as abort.
function _preflightValidate(_fs, paths) {
  if (_fs.existsSync(paths.claudeJson)) {
    let raw;
    try { raw = _fs.readFileSync(paths.claudeJson, 'utf8'); }
    catch (e) {
      return {
        ok: false,
        fatal: { name: 'claude-json-mcp', status: 'error', detail: `unreadable: ${e.message}`, fatal: true },
      };
    }
    if (raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('top-level must be an object');
        }
      } catch (e) {
        return {
          ok: false,
          fatal: {
            name: 'claude-json-mcp',
            status: 'malformed',
            fatal: true,
            detail: `${paths.claudeJson} is malformed (${e.message}); not modified — fix the JSON and re-run. NO destructive steps were executed.`,
          },
        };
      }
    }
  }
  return { ok: true };
}

function _isFullyClean(state) {
  return !state.hasTermdeckDir
    && !state.hasMnestraMcpEntry
    && !state.hasOurHookInSettings
    && !state.hasHookFile
    // Sprint 64 T3 — fully-clean predicate now also covers the PreCompact hook.
    && !state.hasPreCompactHookFile
    && state.launchAgents.length === 0
    && !state.systemdActive;
}

// ── Steps ───────────────────────────────────────────────────────────

// Step 2: ~/.termdeck/. Honors --keep-secrets. Idempotent — missing dir is OK.
function _stepRemoveTermdeckDir(_fs, paths, opts) {
  const out = { name: 'termdeck-dir', status: 'pending', detail: '' };
  if (!_fs.existsSync(paths.termdeckDir)) {
    out.status = 'skipped'; out.detail = 'not present';
    return out;
  }
  if (opts.dryRun) {
    out.status = 'would-remove';
    out.detail = `would remove ${paths.termdeckDir} (${_formatBytes(_approxSize(_fs, paths.termdeckDir))})`;
    return out;
  }
  try {
    if (opts.keepSecrets) {
      // Snapshot any `secrets.env*` files into memory, nuke the dir, restore.
      const preserved = [];
      for (const entry of _fs.readdirSync(paths.termdeckDir)) {
        if (entry === 'secrets.env' || entry.startsWith('secrets.env.bak.')) {
          preserved.push({ name: entry, body: _fs.readFileSync(path.join(paths.termdeckDir, entry)) });
        }
      }
      _fs.rmSync(paths.termdeckDir, { recursive: true, force: true });
      _fs.mkdirSync(paths.termdeckDir, { recursive: true });
      for (const f of preserved) {
        _fs.writeFileSync(path.join(paths.termdeckDir, f.name), f.body, { mode: 0o600 });
      }
      out.status = 'preserved-secrets';
      out.detail = `removed ${paths.termdeckDir}, preserved ${preserved.length} secrets file(s)`;
    } else {
      _fs.rmSync(paths.termdeckDir, { recursive: true, force: true });
      out.status = 'removed';
      out.detail = `removed ${paths.termdeckDir}`;
    }
  } catch (e) {
    out.status = 'error'; out.detail = `${e && e.message ? e.message : e}`;
  }
  return out;
}

// Step 3: ~/.claude.json mnestra MCP entry. Surgical splice. Atomic write.
// Aborts hard (and signals the caller) on malformed JSON: the file is preserved
// bit-exact rather than overwritten with our best guess.
function _stepSpliceClaudeJson(_fs, paths, opts) {
  const out = { name: 'claude-json-mcp', status: 'pending', detail: '', fatal: false };
  if (!_fs.existsSync(paths.claudeJson)) {
    out.status = 'skipped'; out.detail = 'not present';
    return out;
  }
  let raw;
  try { raw = _fs.readFileSync(paths.claudeJson, 'utf8'); }
  catch (e) {
    out.status = 'error'; out.detail = `unreadable: ${e.message}`;
    return out;
  }
  let parsed;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level must be an object');
    }
  } catch (e) {
    out.status = 'malformed';
    out.fatal = true;
    out.detail = `${paths.claudeJson} is malformed (${e.message}); not modified — fix the JSON and re-run.`;
    return out;
  }
  const servers = (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers))
    ? parsed.mcpServers : null;
  if (!servers || !servers.mnestra) {
    out.status = 'skipped'; out.detail = 'no mnestra MCP entry present';
    return out;
  }
  if (opts.dryRun) {
    out.status = 'would-splice';
    out.detail = `would splice mcpServers.mnestra from ${paths.claudeJson}`;
    return out;
  }
  delete servers.mnestra;
  // Preserve every other top-level key (permissions, env, anything else)
  // because we wrote `parsed` not `{ mcpServers: servers }`.
  parsed.mcpServers = servers;
  try {
    _atomicWriteJson(_fs, paths.claudeJson, parsed, 0o600);
    out.status = 'spliced';
    const remaining = Object.keys(servers);
    out.detail = remaining.length === 0
      ? 'removed mnestra (no other MCP entries remained)'
      : `removed mnestra (preserved: ${remaining.join(', ')})`;
  } catch (e) {
    out.status = 'error'; out.detail = `write failed: ${e.message}`;
  }
  return out;
}

// Step 4: ~/.claude/settings.json. Splice both Stop and SessionEnd entries
// pointing at our hook. Preserve other event wirings + other entries inside
// SessionEnd/Stop. Delete keys that become empty.
function _stepSpliceSettingsJson(_fs, paths, opts) {
  const out = { name: 'settings-json-hooks', status: 'pending', detail: '', fatal: false };
  if (!_fs.existsSync(paths.settingsJson)) {
    out.status = 'skipped'; out.detail = 'not present';
    return out;
  }
  let raw;
  try { raw = _fs.readFileSync(paths.settingsJson, 'utf8'); }
  catch (e) {
    out.status = 'error'; out.detail = `unreadable: ${e.message}`;
    return out;
  }
  let parsed;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level must be an object');
    }
  } catch (e) {
    out.status = 'malformed';
    out.fatal = false; // unlike claude.json, we keep going for partial recovery
    out.detail = `${paths.settingsJson} is malformed (${e.message}); not modified.`;
    return out;
  }
  if (!parsed.hooks || typeof parsed.hooks !== 'object') {
    out.status = 'skipped'; out.detail = 'no hooks section in settings.json';
    return out;
  }
  let removedCount = 0;
  // Sprint 64 T3 — added 'PreCompact' to the event-name list and switched the
  // predicate to `_isAnyTermdeckHookEntry` so a single splice pass also strips
  // PreCompact wirings (Investigation 2 closure).
  for (const event of ['Stop', 'SessionEnd', 'PreCompact']) {
    const arr = parsed.hooks[event];
    if (!Array.isArray(arr)) continue;
    // Two shapes coexist in the wild (T3 finding 2026-05-07 18:50 ET):
    //   1. Canonical group shape: { matcher, hooks: [{ type, command }, ...] }
    //   2. Flat shape:             { type, command, timeout? } directly in arr
    // We splice both. For canonical groups, filter the inner `hooks` array;
    // empty groups get pruned post-pass. For flat entries, the array element
    // itself is the candidate.
    for (const elem of arr) {
      if (elem && Array.isArray(elem.hooks)) {
        const before = elem.hooks.length;
        elem.hooks = elem.hooks.filter((e) => !_isAnyTermdeckHookEntry(e));
        removedCount += before - elem.hooks.length;
      }
    }
    const next = [];
    for (const elem of arr) {
      if (!elem) continue;
      // Drop flat entries that match our hook.
      if (_isAnyTermdeckHookEntry(elem) && !Array.isArray(elem.hooks)) {
        removedCount += 1;
        continue;
      }
      // Drop now-empty canonical groups (would otherwise stay as `{ matcher, hooks: [] }`).
      if (Array.isArray(elem.hooks) && elem.hooks.length === 0) continue;
      next.push(elem);
    }
    parsed.hooks[event] = next;
    if (parsed.hooks[event].length === 0) delete parsed.hooks[event];
  }
  if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
  if (removedCount === 0) {
    out.status = 'skipped'; out.detail = 'no entries pointed at our hook';
    return out;
  }
  if (opts.dryRun) {
    out.status = 'would-splice';
    out.detail = `would remove ${removedCount} hook entr${removedCount === 1 ? 'y' : 'ies'} from ${paths.settingsJson}`;
    return out;
  }
  try {
    _atomicWriteJson(_fs, paths.settingsJson, parsed, 0o600);
    out.status = 'spliced';
    out.detail = `removed ${removedCount} hook entr${removedCount === 1 ? 'y' : 'ies'}; other event wirings preserved`;
  } catch (e) {
    out.status = 'error'; out.detail = `write failed: ${e.message}`;
  }
  return out;
}

// Step 5: rename the bundled hook file to .bak.<dashed-ISO>. Don't hard-delete:
// the user may have customized, and the backup is cheap.
function _stepBackupHookFile(_fs, paths, opts) {
  const out = { name: 'hook-file-backup', status: 'pending', detail: '' };
  if (!_fs.existsSync(paths.hookFile)) {
    out.status = 'skipped'; out.detail = 'not present';
    return out;
  }
  const stamp = _isoStamp(opts._now);
  const bakPath = `${paths.hookFile}.bak.${stamp}`;
  if (opts.dryRun) {
    out.status = 'would-rename';
    out.detail = `would rename ${paths.hookFile} → ${bakPath}`;
    return out;
  }
  try {
    _fs.renameSync(paths.hookFile, bakPath);
    out.status = 'renamed';
    out.detail = `${paths.hookFile} → ${bakPath}`;
  } catch (e) {
    out.status = 'error'; out.detail = `rename failed: ${e.message}`;
  }
  return out;
}

// Sprint 64 T3 — same shape as _stepBackupHookFile but targets the PreCompact
// hook file (Investigation 2 closure). Independent of the SessionEnd backup —
// either file's absence/presence is OK; both are renamed-not-deleted so user
// customizations are recoverable.
function _stepBackupPreCompactHookFile(_fs, paths, opts) {
  const out = { name: 'pre-compact-hook-file-backup', status: 'pending', detail: '' };
  if (!_fs.existsSync(paths.preCompactHookFile)) {
    out.status = 'skipped'; out.detail = 'not present';
    return out;
  }
  const stamp = _isoStamp(opts._now);
  const bakPath = `${paths.preCompactHookFile}.bak.${stamp}`;
  if (opts.dryRun) {
    out.status = 'would-rename';
    out.detail = `would rename ${paths.preCompactHookFile} → ${bakPath}`;
    return out;
  }
  try {
    _fs.renameSync(paths.preCompactHookFile, bakPath);
    out.status = 'renamed';
    out.detail = `${paths.preCompactHookFile} → ${bakPath}`;
  } catch (e) {
    out.status = 'error'; out.detail = `rename failed: ${e.message}`;
  }
  return out;
}

// Step 6 (darwin only): LaunchAgents — `launchctl unload` BEFORE `rm`. The
// unload call's exit code is non-fatal: the agent may not be loaded in the
// current session, especially in tests.
function _stepRemoveLaunchAgents(_fs, _spawnSync, paths, opts) {
  const out = { name: 'launch-agents', status: 'pending', detail: '', actions: [] };
  if (paths.platform !== 'darwin') {
    out.status = 'skipped'; out.detail = `not darwin (got ${paths.platform})`;
    return out;
  }
  const matches = _findLaunchAgents(_fs, paths.launchAgentsDir, paths.launchAgentGlob);
  if (matches.length === 0) {
    out.status = 'skipped'; out.detail = 'no com.jhizzard.termdeck.* plist found';
    return out;
  }
  if (opts.dryRun) {
    out.status = 'would-remove';
    out.detail = `would unload + remove ${matches.length} plist(s): ${matches.map((p) => path.basename(p)).join(', ')}`;
    return out;
  }
  let failures = 0;
  for (const plist of matches) {
    try {
      out.actions.push({ kind: 'unload', target: plist });
      _spawnSync('launchctl', ['unload', plist], { encoding: 'utf8' });
    } catch (_) { /* non-fatal */ }
    try {
      out.actions.push({ kind: 'rm', target: plist });
      _fs.unlinkSync(plist);
    } catch (e) { failures++; out.actions.push({ kind: 'rm-failed', target: plist, error: e.message }); }
  }
  if (failures > 0) {
    out.status = 'partial';
    out.detail = `unloaded ${matches.length} plist(s); ${failures} could not be removed`;
  } else {
    out.status = 'removed';
    out.detail = `unloaded + removed ${matches.length} plist(s)`;
  }
  return out;
}

// Step 7 (linux only): systemd user unit — disable + stop, then rm. The
// system-scope `/etc/systemd/system/termdeck.service` requires sudo; we surface
// a hint rather than attempting it.
function _stepRemoveSystemdUnit(_fs, _spawnSync, paths, opts) {
  const out = { name: 'systemd-unit', status: 'pending', detail: '', actions: [] };
  if (paths.platform !== 'linux') {
    out.status = 'skipped'; out.detail = `not linux (got ${paths.platform})`;
    return out;
  }
  if (!_fs.existsSync(paths.systemdUnit)) {
    out.status = 'skipped'; out.detail = 'no user-scope termdeck.service unit found';
    return out;
  }
  if (opts.dryRun) {
    out.status = 'would-remove';
    out.detail = `would systemctl --user disable --now + remove ${paths.systemdUnit}`;
    return out;
  }
  try {
    out.actions.push({ kind: 'systemctl-disable', target: paths.systemdUnit });
    _spawnSync('systemctl', ['--user', 'disable', '--now', 'termdeck.service'], { encoding: 'utf8' });
  } catch (_) { /* non-fatal */ }
  try {
    out.actions.push({ kind: 'rm', target: paths.systemdUnit });
    _fs.unlinkSync(paths.systemdUnit);
    out.status = 'removed';
    out.detail = `disabled + removed ${paths.systemdUnit}`;
  } catch (e) {
    out.status = 'error';
    out.detail = `rm failed: ${e.message}`;
  }
  return out;
}

// Step 8: --purge-supabase. Two-step prompt. Reads SUPABASE_DB_URL from
// secrets.env BEFORE step 2 has a chance to delete the directory (this step
// is invoked from the orchestrator BEFORE _stepRemoveTermdeckDir even though
// the spec lists supabase-purge as a later step in user-facing summary). On
// confirm: if `psql` is on PATH, run a DROP TABLE / DROP FUNCTION CASCADE on
// the Mnestra/Rumen object set; otherwise print the SQL block for the user
// to run manually via Supabase MCP / psql.
// Broader DROP block (T4-CODEX 18:46 ET concern: brief requires `rumen_*`
// tables/functions/types — implementation must enumerate ALL three kinds).
// Implemented as a PL/pgSQL DO block so a single statement covers an unbounded
// set of `rumen_*` and Mnestra-named objects. Idempotent: every drop is
// IF EXISTS / CASCADE.
function _buildPurgeSql(ref) {
  return `-- TermDeck/Mnestra/Rumen purge (--purge-supabase) for project ${ref}
-- Drops every public-schema object whose name starts with mnestra_, memory_,
-- rumen_, or matches the canonical bundled-table list. Idempotent and CASCADE.

DROP TABLE IF EXISTS public.memory_relationships CASCADE;
DROP TABLE IF EXISTS public.memory_items CASCADE;
DROP TABLE IF EXISTS public.memory_sessions CASCADE;
DROP TABLE IF EXISTS public.mnestra_migrations CASCADE;

DO $$
DECLARE r RECORD;
BEGIN
  -- All rumen_* tables.
  FOR r IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'rumen\\_%' ESCAPE '\\'
  LOOP
    EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;

  -- All rumen_* and mnestra_* and memory_* functions (covers SECURITY DEFINER
  -- doctor functions, search RPCs, graph helpers).
  FOR r IN
    SELECT p.proname,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'rumen\\_%' ESCAPE '\\'
         OR p.proname LIKE 'mnestra\\_%' ESCAPE '\\'
         OR p.proname LIKE 'memory\\_%' ESCAPE '\\')
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS public.' || quote_ident(r.proname)
            || '(' || r.args || ') CASCADE';
  END LOOP;

  -- All rumen_* and mnestra_* types (enums, composites).
  FOR r IN
    SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
       AND (t.typname LIKE 'rumen\\_%' ESCAPE '\\'
         OR t.typname LIKE 'mnestra\\_%' ESCAPE '\\')
  LOOP
    EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
  END LOOP;
END $$;
`;
}

async function _stepPurgeSupabase(_fs, _spawnSync, _promptYesNo, _promptInputMatching, paths, opts) {
  const out = { name: 'purge-supabase', status: 'pending', detail: '' };
  if (!opts.purgeSupabase) {
    out.status = 'skipped'; out.detail = 'flag not set';
    return out;
  }
  // Read secrets BEFORE the dir-removal step lands. Caller orchestrates the
  // ordering — this function does not delete the dir itself.
  const secrets = _parseEnvFile(_fs, paths.secretsEnv);
  const dbUrl = secrets.SUPABASE_DB_URL || secrets.DATABASE_URL || '';
  const url = secrets.SUPABASE_URL || '';
  const ref = url ? (url.match(/^https?:\/\/([a-z0-9]+)\./) || [])[1] || '' : '';
  if (!ref) {
    out.status = 'skipped';
    out.detail = 'cannot resolve project ref from secrets.env (SUPABASE_URL missing) — refusing to drop schemas blind';
    return out;
  }
  // T4-CODEX 18:46 ET concern: dry-run must NOT prompt for destructive
  // confirmation — it should just print what *would* happen. Short-circuit
  // BEFORE any prompt.
  if (opts.dryRun) {
    out.status = 'would-purge';
    out.detail = `would run DROP block against ${ref} (Mnestra + Rumen + memory_ tables/functions/types, IF EXISTS / CASCADE)`;
    return out;
  }
  const ok1 = await _promptYesNo(
    `--purge-supabase will DROP Mnestra/Rumen schemas from project ${ref}. Continue?`,
    false,
  );
  if (!ok1) {
    out.status = 'skipped'; out.detail = 'user declined first prompt';
    return out;
  }
  const ok2 = await _promptInputMatching(
    `Type the project ref (${ref}) to confirm drop:`,
    ref,
  );
  if (!ok2) {
    out.status = 'skipped'; out.detail = 'project ref did not match — aborted';
    return out;
  }
  const sql = _buildPurgeSql(ref);
  if (!dbUrl) {
    out.status = 'sql-printed';
    out.detail = `SUPABASE_DB_URL missing — printing SQL for you to run via Supabase SQL editor or psql:\n${sql}`;
    return out;
  }
  // Look for psql on PATH. Zero-runtime-dep package — we cannot ship `pg`.
  const psqlCheck = _spawnSync('which', ['psql'], { encoding: 'utf8' });
  if (psqlCheck.status !== 0 || !(psqlCheck.stdout || '').trim()) {
    out.status = 'sql-printed';
    out.detail = `psql not on PATH — printing SQL for you to run via Supabase SQL editor:\n${sql}`;
    return out;
  }
  const r = _spawnSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status === 0) {
    out.status = 'purged';
    out.detail = `dropped Mnestra/Rumen schemas + functions + types in project ${ref}`;
  } else {
    out.status = 'error';
    out.detail = `psql exit ${r.status}: ${r.stderr || ''}`;
  }
  return out;
}

// ── Orchestrator ────────────────────────────────────────────────────

function _printPreflight(out, state, paths, opts) {
  const lines = [];
  lines.push(`${ANSI.bold}TermDeck Stack Uninstall — pre-flight${ANSI.reset}`);
  lines.push(`${ANSI.dim}─────────────────────────────────────────────${ANSI.reset}`);
  if (state.hasTermdeckDir) {
    const sz = _formatBytes(_approxSize(opts._fs || fs, paths.termdeckDir));
    lines.push(`  ${ANSI.cyan}•${ANSI.reset} ${paths.termdeckDir} ${ANSI.dim}(${sz})${ANSI.reset}${opts.keepSecrets ? ' [secrets preserved]' : ''}`);
  }
  if (state.hasMnestraMcpEntry) lines.push(`  ${ANSI.cyan}•${ANSI.reset} mcpServers.mnestra in ${paths.claudeJson} ${ANSI.dim}(surgical splice — other entries preserved)${ANSI.reset}`);
  if (state.hasOurHookInSettings) lines.push(`  ${ANSI.cyan}•${ANSI.reset} hooks.{Stop,SessionEnd} entries in ${paths.settingsJson} ${ANSI.dim}(surgical splice — other entries preserved)${ANSI.reset}`);
  if (state.hasHookFile) lines.push(`  ${ANSI.cyan}•${ANSI.reset} ${paths.hookFile} ${ANSI.dim}(renamed to .bak.<timestamp>, not deleted)${ANSI.reset}`);
  if (state.hasPreCompactHookFile) lines.push(`  ${ANSI.cyan}•${ANSI.reset} ${paths.preCompactHookFile} ${ANSI.dim}(renamed to .bak.<timestamp>, not deleted)${ANSI.reset}`);
  for (const p of state.launchAgents) lines.push(`  ${ANSI.cyan}•${ANSI.reset} ${p} ${ANSI.dim}(launchctl unload + rm)${ANSI.reset}`);
  if (state.systemdActive) lines.push(`  ${ANSI.cyan}•${ANSI.reset} ${paths.systemdUnit} ${ANSI.dim}(systemctl --user disable --now + rm)${ANSI.reset}`);
  if (opts.purgeSupabase) lines.push(`  ${ANSI.red}•${ANSI.reset} ${ANSI.bold}--purge-supabase: will DROP Mnestra/Rumen tables in your Supabase project${ANSI.reset}`);
  lines.push('');
  out.write(lines.join('\n') + '\n');
}

function _printSummaryLine(out, step) {
  const verbColor = {
    removed: ANSI.green, spliced: ANSI.green, renamed: ANSI.green,
    'preserved-secrets': ANSI.green, purged: ANSI.green,
    skipped: ANSI.dim,
    'would-remove': ANSI.yellow, 'would-splice': ANSI.yellow,
    'would-rename': ANSI.yellow, 'would-purge': ANSI.yellow,
    'sql-printed': ANSI.yellow, partial: ANSI.yellow,
    error: ANSI.red, malformed: ANSI.red,
  };
  const color = verbColor[step.status] || ANSI.dim;
  out.write(`  ${color}${step.status.padEnd(20)}${ANSI.reset} ${step.name.padEnd(22)} ${ANSI.dim}${step.detail || ''}${ANSI.reset}\n`);
}

async function uninstall(opts = {}) {
  const _fs = opts._fs || fs;
  const _spawnSync = opts._spawnSync || child_process.spawnSync;
  const _promptYesNo = opts._promptYesNo || _defaultPromptYesNo;
  const _promptInputMatching = opts._promptInputMatching || _defaultPromptInputMatching;
  const out = opts._stdout || process.stdout;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;

  const args = opts.argv ? parseArgs(opts.argv) : {
    dryRun: !!opts.dryRun, yes: !!opts.yes,
    keepSecrets: !!opts.keepSecrets, purgeSupabase: !!opts.purgeSupabase, help: false,
  };
  if (args.help) {
    printHelp(out);
    return { ok: true, exitCode: 0, summary: { steps: [], state: null }, args };
  }

  const paths = _resolvePaths(home, platform);
  const state = _detectInstallState(_fs, paths);
  const summary = { steps: [], state, paths, args, idempotencyState: null };

  if (_isFullyClean(state) && !args.purgeSupabase) {
    out.write(`\n${ANSI.bold}TermDeck Stack Uninstall${ANSI.reset}\n`);
    out.write(`${ANSI.dim}─────────────────────────────────────────────${ANSI.reset}\n\n`);
    // T4-CODEX 18:46 ET concern: distinguish "never installed" from "already
    // uninstalled". Prior-uninstall residue (a `.bak.*` of our hook) is the
    // signal that an uninstall has run before — message changes accordingly.
    if (state.hookBakFiles && state.hookBakFiles.length > 0) {
      summary.idempotencyState = 'already-uninstalled';
      out.write(`  ${ANSI.dim}─${ANSI.reset} ${ANSI.dim}already uninstalled (no live TermDeck state; ${state.hookBakFiles.length} prior-uninstall .bak file${state.hookBakFiles.length === 1 ? '' : 's'} retained for safety)${ANSI.reset}\n\n`);
    } else {
      summary.idempotencyState = 'nothing-to-uninstall';
      out.write(`  ${ANSI.dim}─${ANSI.reset} ${ANSI.dim}nothing to uninstall (no TermDeck-attributable state found)${ANSI.reset}\n\n`);
    }
    return { ok: true, exitCode: 0, summary };
  }

  // T4-CODEX 18:48 ET concern: pre-flight validation aborts BEFORE any
  // destructive step runs. If `~/.claude.json` is malformed, we never reach
  // --purge-supabase, never remove `~/.termdeck/`, never splice settings.json.
  const preflight = _preflightValidate(_fs, paths);
  if (!preflight.ok) {
    summary.steps = [preflight.fatal];
    summary.preflightAborted = true;
    out.write('\n');
    _printSummaryLine(out, preflight.fatal);
    out.write(`\n${ANSI.red}Uninstall aborted at pre-flight (${preflight.fatal.name}): ${preflight.fatal.detail}${ANSI.reset}\n`);
    out.write(`${ANSI.dim}NO destructive steps were executed; --purge-supabase, ~/.termdeck/, settings.json splice all skipped.${ANSI.reset}\n\n`);
    return { ok: false, exitCode: 1, summary };
  }

  out.write('\n');
  _printPreflight(out, state, paths, { ...args, _fs });

  // Effective keep-secrets: --keep-secrets flag wins; otherwise interactive
  // prompts (T4-CODEX 18:46 ET concern); otherwise --yes/CI mode removes
  // secrets as the safe default per the brief.
  let effectiveKeepSecrets = !!args.keepSecrets;
  if (!args.keepSecrets && !args.yes && _fs.existsSync(paths.secretsEnv)) {
    effectiveKeepSecrets = await _promptYesNo(
      `Preserve ${paths.secretsEnv} (and any secrets.env.bak.* siblings)?`,
      true,
    );
  }

  if (!args.yes) {
    const proceed = await _promptYesNo('Proceed with uninstall?', false);
    if (!proceed) {
      out.write(`  ${ANSI.dim}Aborted by user.${ANSI.reset}\n\n`);
      return { ok: true, exitCode: 0, summary, aborted: true };
    }
  }

  out.write(`${ANSI.bold}Removing...${ANSI.reset}\n`);

  // Step 8 (purge-supabase) MUST run before step 2 (termdeck-dir) so we can
  // read SUPABASE_DB_URL from secrets.env. We reorder internally for that.
  const stepArgs = { ...args, keepSecrets: effectiveKeepSecrets, _now: opts._now };
  const steps = [];
  if (args.purgeSupabase) {
    const r = await _stepPurgeSupabase(_fs, _spawnSync, _promptYesNo, _promptInputMatching, paths, stepArgs);
    steps.push(r); _printSummaryLine(out, r);
  }
  for (const fn of [
    (o) => _stepRemoveTermdeckDir(_fs, paths, o),
    (o) => _stepSpliceClaudeJson(_fs, paths, o),
    (o) => _stepSpliceSettingsJson(_fs, paths, o),
    (o) => _stepBackupHookFile(_fs, paths, o),
    // Sprint 64 T3 — PreCompact hook backup step (Investigation 2 closure).
    // Runs after the SessionEnd backup so a clean install with both hooks
    // present produces .bak siblings for both files with a consistent stamp.
    (o) => _stepBackupPreCompactHookFile(_fs, paths, o),
    (o) => _stepRemoveLaunchAgents(_fs, _spawnSync, paths, o),
    (o) => _stepRemoveSystemdUnit(_fs, _spawnSync, paths, o),
  ]) {
    let r;
    try {
      r = fn(stepArgs);
    } catch (e) {
      r = { name: 'unknown', status: 'error', detail: e && e.message ? e.message : String(e) };
    }
    steps.push(r);
    _printSummaryLine(out, r);
  }
  summary.steps = steps;

  // Determine exit code: any fatal step → 1. Pre-flight validation already
  // covers the most-likely fatal (malformed claude.json), so this catches
  // any future fatal-tagged step that lands without a separate pre-flight gate.
  const fatal = steps.find((s) => s && s.fatal);
  const exitCode = fatal ? 1 : 0;
  const ok = !fatal;

  out.write('\n');
  if (fatal) {
    out.write(`${ANSI.red}Uninstall encountered a fatal step (${fatal.name}): ${fatal.detail}${ANSI.reset}\n`);
  } else if (args.dryRun) {
    out.write(`${ANSI.yellow}(--dry-run was set; nothing was actually removed.)${ANSI.reset}\n`);
  } else {
    out.write(`${ANSI.green}Uninstalled.${ANSI.reset} Run \`${ANSI.bold}npm uninstall -g @jhizzard/termdeck @jhizzard/termdeck-stack${ANSI.reset}\` to remove the npm packages.\n`);
    out.write(`${ANSI.dim}(The script can't safely uninstall its own bin while running.)${ANSI.reset}\n`);
  }
  out.write('\n');

  return { ok, exitCode, summary };
}

// ── CLI ─────────────────────────────────────────────────────────────

if (require.main === module) {
  uninstall({ argv: process.argv.slice(2) })
    .then((r) => process.exit(r.exitCode || 0))
    .catch((err) => {
      process.stderr.write(`[termdeck-stack uninstall] failed: ${err && err.stack || err}\n`);
      process.exit(1);
    });
}

module.exports = {
  uninstall,
  printHelp,
  parseArgs,
  // Test hooks — exposed so unit tests can drive primitives without a full run.
  _isSessionEndHookEntry,
  // Sprint 64 T3 — PreCompact uninstall surface (Investigation 2 closure).
  _isPreCompactHookEntry,
  _isAnyTermdeckHookEntry,
  _stepBackupPreCompactHookFile,
  _resolvePaths,
  _detectInstallState,
  _isFullyClean,
  _preflightValidate,
  _stepRemoveTermdeckDir,
  _stepSpliceClaudeJson,
  _stepSpliceSettingsJson,
  _stepBackupHookFile,
  _stepRemoveLaunchAgents,
  _stepRemoveSystemdUnit,
  _stepPurgeSupabase,
  _claudeJsonHasMnestraEntry,
  _settingsJsonHasOurHook,
  _findLaunchAgents,
  _findHookBakFiles,
  _isoStamp,
  _parseEnvFile,
  _atomicWriteJson,
  _buildPurgeSql,
};

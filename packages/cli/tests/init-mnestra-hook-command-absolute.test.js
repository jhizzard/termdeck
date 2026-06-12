// Sprint 75 T2 (part D) — literal-`~` hook-command elimination, init-mnestra copy.
//
// Mirror of packages/stack-installer/tests/hook-command-absolute.test.js for
// the wizard's hoisted copy of the settings.json wiring logic (the hoist
// exists because the published @jhizzard/termdeck tarball ships only
// stack-installer's assets/, not its src/ — ledger #16). This is the REFRESH
// path: `termdeck init --mnestra` re-runs `migrateSettingsJsonHookEntry` +
// `migrateSettingsJsonPreCompactEntry` on every wizard pass, so THIS is the
// surface that heals existing installs' legacy `~` commands in the field.
//
// Lockstep (INSTALLER-PITFALLS Class N): semantics must match the
// stack-installer copy; the cross-package pin lives in both suites.
//
// Run: node --test packages/cli/tests/init-mnestra-hook-command-absolute.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const initMnestra = require('../src/init-mnestra.js');
const installer = require('../../stack-installer/src/index.js');

const {
  _hookCommandFor,
  _isTildeHookCommand,
  _mergeSessionEndHookEntry,
  _mergePreCompactHookEntry,
  migrateSettingsJsonHookEntry,
  migrateSettingsJsonPreCompactEntry,
  HOOK_COMMAND,
} = initMnestra;

const PRECOMPACT_HOOK_COMMAND = _hookCommandFor('memory-pre-compact.js');
const LEGACY_SE = 'node ~/.claude/hooks/memory-session-end.js';
const LEGACY_PC = 'node ~/.claude/hooks/memory-pre-compact.js';

function allHookCommands(settings) {
  const out = [];
  for (const groups of Object.values(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      for (const e of g.hooks) {
        if (e && typeof e.command === 'string') out.push(e.command);
      }
    }
  }
  return out;
}

function writeSettings(dir, settings) {
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return p;
}

// ── command shape ──────────────────────────────────────────────────────────

test('wizard hook commands are absolute, quoted, tilde-free', () => {
  assert.equal(HOOK_COMMAND, `node "${path.join(os.homedir(), '.claude', 'hooks', 'memory-session-end.js')}"`);
  assert.equal(PRECOMPACT_HOOK_COMMAND, `node "${path.join(os.homedir(), '.claude', 'hooks', 'memory-pre-compact.js')}"`);
  assert.ok(!HOOK_COMMAND.includes('~/'));
  assert.ok(!PRECOMPACT_HOOK_COMMAND.includes('~/'));
});

test('_hookCommandFor quotes a spaced home dir (computed at call time from HOME)', () => {
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = '/Users/First Last';
    assert.equal(
      _hookCommandFor('memory-session-end.js'),
      'node "/Users/First Last/.claude/hooks/memory-session-end.js"'
    );
  } finally {
    process.env.HOME = savedHome;
  }
});

// ── refresh path: migrateSettingsJsonHookEntry against a legacy file ───────

test('refresh migrates a legacy ~ SessionEnd command on disk; second run is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-tilde-'));
  try {
    const settingsPath = writeSettings(dir, {
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }] },
    });

    const r1 = migrateSettingsJsonHookEntry({ settingsPath });
    assert.equal(r1.status, 'migrated-tilde-path');
    assert.match(r1.backup || '', /\.bak\.\d{14}$/, 'backup taken before the rewrite');
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
    assert.equal(onDisk.hooks.SessionEnd[0].hooks.length, 1, 'rewritten in place, not duplicated');

    const r2 = migrateSettingsJsonHookEntry({ settingsPath });
    assert.equal(r2.status, 'already-installed');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), onDisk, 'idempotent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refresh migrates a legacy ~ PreCompact command on disk; second run is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-tilde-pc-'));
  try {
    const settingsPath = writeSettings(dir, {
      hooks: { PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }] },
    });

    const r1 = migrateSettingsJsonPreCompactEntry({ settingsPath });
    assert.equal(r1.status, 'migrated-tilde-path');
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk.hooks.PreCompact[0].hooks[0].command, PRECOMPACT_HOOK_COMMAND);

    const r2 = migrateSettingsJsonPreCompactEntry({ settingsPath });
    assert.equal(r2.status, 'already-installed');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), onDisk, 'idempotent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refresh dry-run reports would-migrated-tilde-path without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-tilde-dry-'));
  try {
    const settingsPath = writeSettings(dir, {
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }] },
    });
    const before = fs.readFileSync(settingsPath, 'utf8');

    const r = migrateSettingsJsonHookEntry({ settingsPath, dryRun: true });
    assert.equal(r.status, 'would-migrated-tilde-path');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'dry-run must not write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── fresh install + full-object scan ───────────────────────────────────────

test('fresh install writes absolute commands — full settings object scan finds no ~/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-fresh-'));
  try {
    const settingsPath = path.join(dir, 'settings.json'); // no file → fresh install
    assert.equal(migrateSettingsJsonHookEntry({ settingsPath }).status, 'installed');
    assert.equal(migrateSettingsJsonPreCompactEntry({ settingsPath }).status, 'installed');

    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cmds = allHookCommands(onDisk);
    assert.equal(cmds.length, 2);
    for (const c of cmds) assert.ok(!c.includes('~/'), `installer wrote a ~ command: ${c}`);
    assert.equal(onDisk.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
    assert.equal(onDisk.hooks.PreCompact[0].hooks[0].command, PRECOMPACT_HOOK_COMMAND);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mixed legacy state (both hooks ~, plus unrelated hooks) → both migrated, others untouched, no ~ remains', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-mixed-'));
  try {
    const settingsPath = writeSettings(dir, {
      permissions: { allow: ['Bash(git status)'] },
      hooks: {
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }],
        PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo before' }] }],
      },
    });
    assert.equal(migrateSettingsJsonHookEntry({ settingsPath }).status, 'migrated-tilde-path');
    assert.equal(migrateSettingsJsonPreCompactEntry({ settingsPath }).status, 'migrated-tilde-path');

    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const c of allHookCommands(onDisk)) {
      assert.ok(!c.includes('~/'), `~ survived the migration: ${c}`);
    }
    assert.equal(onDisk.hooks.PreToolUse[0].hooks[0].command, 'echo before', 'unrelated hook untouched');
    assert.deepEqual(onDisk.permissions, { allow: ['Bash(git status)'] }, 'unrelated keys untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('user-custom absolute command pointing at our hook is preserved (migration targets ~ only)', () => {
  const custom = '/opt/node22/bin/node /custom/place/memory-session-end.js';
  const settings = {
    hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: custom, timeout: 30 }] }] },
  };
  assert.equal(_mergeSessionEndHookEntry(settings).status, 'already-installed');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, custom);
});

// ── lockstep with packages/stack-installer/src/index.js (Class N) ──────────

test('lockstep: init-mnestra and stack-installer build byte-identical commands and tilde predicates', () => {
  for (const file of ['memory-session-end.js', 'memory-pre-compact.js']) {
    assert.equal(_hookCommandFor(file), installer._hookCommandFor(file));
  }
  for (const probe of [LEGACY_SE, LEGACY_PC, HOOK_COMMAND, '', undefined]) {
    assert.equal(_isTildeHookCommand(probe), installer._isTildeHookCommand(probe));
  }
  assert.equal(HOOK_COMMAND, installer.HOOK_COMMAND);
  assert.equal(PRECOMPACT_HOOK_COMMAND, installer.PRECOMPACT_HOOK_COMMAND);
  // Merge-level lockstep on the migration status itself.
  const mk = () => ({
    hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }] },
  });
  assert.equal(_mergeSessionEndHookEntry(mk()).status, installer._mergeSessionEndHookEntry(mk()).status);
  const mkPc = () => ({
    hooks: { PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }] },
  });
  assert.equal(_mergePreCompactHookEntry(mkPc()).status, installer._mergePreCompactHookEntry(mkPc()).status);
});

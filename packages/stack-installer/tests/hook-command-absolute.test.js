// Sprint 75 T2 (part D) — literal-`~` hook-command elimination, stack-installer copy.
//
// Installers ≤ v1.9.x wrote `node ~/.claude/hooks/memory-session-end.js` (and
// the pre-compact twin) into ~/.claude/settings.json hook entries. `~` is not
// a shell — it only expanded because of how the harness happened to invoke
// hook commands on macOS/Linux, and it is a hard break on Windows (audit
// item 4). The fix: commands are built at call time from os.homedir(), with
// the path double-quoted so a home dir containing spaces still executes.
//
// Migration invariant under test: an EXISTING settings.json entry carrying
// the legacy `~` shape must be rewritten to the absolute form by the same
// "is the hook already wired?" pass — the filename-substring predicate would
// otherwise report it already-installed and leave the `~` in place forever.
// Both directions covered: legacy → migrated; already-absolute → untouched
// (idempotent, run twice → no further change).
//
// Lockstep (INSTALLER-PITFALLS Class N): packages/cli/src/init-mnestra.js
// carries a mirrored copy of this logic; its mirrored suite lives at
// packages/cli/tests/init-mnestra-hook-command-absolute.test.js, and the
// cross-package lockstep pin lives in BOTH files.
//
// Run: node --test packages/stack-installer/tests/hook-command-absolute.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const installer = require('../src/index.js');
const initMnestra = require('../../cli/src/init-mnestra.js');

const {
  _hookCommandFor,
  _isTildeHookCommand,
  _mergeSessionEndHookEntry,
  _mergePreCompactHookEntry,
  HOOK_COMMAND,
  PRECOMPACT_HOOK_COMMAND,
} = installer;

const LEGACY_SE = 'node ~/.claude/hooks/memory-session-end.js';
const LEGACY_PC = 'node ~/.claude/hooks/memory-pre-compact.js';

// Every hook command in a settings object, across all event types/groups.
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

// ── command shape ──────────────────────────────────────────────────────────

test('hook commands are absolute, quoted, and tilde-free', () => {
  for (const [cmd, file] of [
    [HOOK_COMMAND, 'memory-session-end.js'],
    [PRECOMPACT_HOOK_COMMAND, 'memory-pre-compact.js'],
  ]) {
    const expected = `node "${path.join(os.homedir(), '.claude', 'hooks', file)}"`;
    assert.equal(cmd, expected);
    assert.ok(!cmd.includes('~/'), `no literal ~ in: ${cmd}`);
    assert.ok(path.isAbsolute(cmd.match(/"(.+)"/)[1]), 'embedded path is absolute');
  }
});

test('_hookCommandFor respects HOME at call time and quotes spaced paths shell-executably', () => {
  const spacedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'First Last '));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = spacedHome;
    const cmd = _hookCommandFor('memory-session-end.js');
    assert.equal(cmd, `node "${path.join(spacedHome, '.claude', 'hooks', 'memory-session-end.js')}"`);

    // Prove the quoting actually survives a shell: plant a script at the
    // spaced path whose execution leaves a marker file, run the command
    // through `sh -c` exactly as a hook harness would.
    const hookDir = path.join(spacedHome, '.claude', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    const marker = path.join(spacedHome, 'ran.txt');
    fs.writeFileSync(
      path.join(hookDir, 'memory-session-end.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok');\n`,
      'utf8'
    );
    execFileSync('/bin/sh', ['-c', cmd], { stdio: 'ignore' });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'ok', 'spaced-home command executed via sh -c');
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(spacedHome, { recursive: true, force: true });
  }
});

test('_isTildeHookCommand: legacy shapes detected, absolute and non-string left alone', () => {
  assert.equal(_isTildeHookCommand(LEGACY_SE), true);
  assert.equal(_isTildeHookCommand(LEGACY_PC), true);
  assert.equal(_isTildeHookCommand(HOOK_COMMAND), false);
  assert.equal(_isTildeHookCommand(undefined), false);
  assert.equal(_isTildeHookCommand(42), false);
});

// ── fresh install ──────────────────────────────────────────────────────────

test('fresh merge writes the absolute command — no ~ anywhere in the settings object', () => {
  const settings = {};
  assert.equal(_mergeSessionEndHookEntry(settings).status, 'installed');
  assert.equal(_mergePreCompactHookEntry(settings).status, 'installed');
  const cmds = allHookCommands(settings);
  assert.equal(cmds.length, 2);
  for (const c of cmds) assert.ok(!c.includes('~/'), `fresh install must not write ~: ${c}`);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].command, PRECOMPACT_HOOK_COMMAND);
});

// ── legacy → migrated ──────────────────────────────────────────────────────

test('legacy ~ SessionEnd entry is rewritten absolute with status migrated-tilde-path', () => {
  const settings = {
    hooks: {
      SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'migrated-tilde-path');
  assert.equal(settings.hooks.SessionEnd.length, 1, 'no duplicate group');
  assert.equal(settings.hooks.SessionEnd[0].hooks.length, 1, 'no duplicate entry');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('legacy ~ PreCompact entry is rewritten absolute with status migrated-tilde-path', () => {
  const settings = {
    hooks: {
      PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }],
    },
  };
  const { status } = _mergePreCompactHookEntry(settings);
  assert.equal(status, 'migrated-tilde-path');
  assert.equal(settings.hooks.PreCompact.length, 1);
  assert.equal(settings.hooks.PreCompact[0].hooks.length, 1);
  assert.equal(settings.hooks.PreCompact[0].hooks[0].command, PRECOMPACT_HOOK_COMMAND);
});

test('legacy Stop wiring with ~ command migrates to SessionEnd with the absolute command', () => {
  // The Brad ledger-#16 starting state, now with the tilde dimension: the
  // Stop entry is removed and the re-added SessionEnd entry must carry the
  // NEW absolute command, never the legacy string.
  const settings = {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'migrated-from-stop');
  assert.equal(settings.hooks.Stop, undefined, 'Stop group removed');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
  for (const c of allHookCommands(settings)) assert.ok(!c.includes('~/'));
});

// ── already-absolute → no-op, idempotent ──────────────────────────────────

test('already-absolute entry is a no-op; second run makes no further change', () => {
  const settings = {};
  _mergeSessionEndHookEntry(settings);
  _mergePreCompactHookEntry(settings);
  const snapshot = JSON.stringify(settings);

  assert.equal(_mergeSessionEndHookEntry(settings).status, 'already-installed');
  assert.equal(_mergePreCompactHookEntry(settings).status, 'already-installed');
  assert.equal(JSON.stringify(settings), snapshot, 'no mutation on re-run');
});

test('migration itself is idempotent: legacy → migrated → already-installed', () => {
  const settings = {
    hooks: {
      SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }],
      PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }],
    },
  };
  assert.equal(_mergeSessionEndHookEntry(settings).status, 'migrated-tilde-path');
  assert.equal(_mergePreCompactHookEntry(settings).status, 'migrated-tilde-path');
  const snapshot = JSON.stringify(settings);
  assert.equal(_mergeSessionEndHookEntry(settings).status, 'already-installed');
  assert.equal(_mergePreCompactHookEntry(settings).status, 'already-installed');
  assert.equal(JSON.stringify(settings), snapshot, 'second pass changes nothing');
});

test('user-custom command WITHOUT ~ pointing at our hook file is preserved verbatim', () => {
  // A deliberate wrapper (env vars, different node) must not be clobbered —
  // the migration only targets the legacy tilde shape.
  const custom = 'MNESTRA_DEBUG=1 /opt/node22/bin/node /custom/place/memory-session-end.js';
  const settings = {
    hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: custom, timeout: 30 }] }] },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'already-installed');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, custom);
});

// ── end-to-end through installSessionEndHook / installPreCompactHook ──────

test('installSessionEndHook migrates a legacy ~ settings.json on disk (then no-ops on re-run)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilde-mig-'));
  try {
    const sourcePath = path.join(dir, 'bundled-hook.js');
    const destPath = path.join(dir, 'installed-hook.js');
    fs.writeFileSync(sourcePath, '// bundled hook body\n', 'utf8');
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }] },
    }, null, 2), 'utf8');

    const r1 = await installer.installSessionEndHook({ sourcePath, destPath, settingsPath, assumeYes: true });
    assert.equal(r1.settingsStatus, 'migrated-tilde');
    const onDisk1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk1.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
    assert.ok(!JSON.stringify(allHookCommands(onDisk1)).includes('~/'));

    const r2 = await installer.installSessionEndHook({ sourcePath, destPath, settingsPath, assumeYes: true });
    assert.equal(r2.settingsStatus, 'already-installed');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), onDisk1, 'second run rewrites nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installPreCompactHook migrates a legacy ~ settings.json on disk (then no-ops on re-run)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilde-mig-pc-'));
  try {
    const sourcePath = path.join(dir, 'bundled-pc.js');
    const destPath = path.join(dir, 'installed-pc.js');
    fs.writeFileSync(sourcePath, '// bundled pre-compact body\n', 'utf8');
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreCompact: [{ matcher: '*', hooks: [{ type: 'command', command: LEGACY_PC, timeout: 30 }] }] },
    }, null, 2), 'utf8');

    const r1 = await installer.installPreCompactHook({ sourcePath, destPath, settingsPath, assumeYes: true });
    assert.equal(r1.settingsStatus, 'migrated-tilde');
    const onDisk1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(onDisk1.hooks.PreCompact[0].hooks[0].command, PRECOMPACT_HOOK_COMMAND);

    const r2 = await installer.installPreCompactHook({ sourcePath, destPath, settingsPath, assumeYes: true });
    assert.equal(r2.settingsStatus, 'already-installed');
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), onDisk1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dry-run reports would-migrate-tilde and leaves the legacy file untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilde-dry-'));
  try {
    const sourcePath = path.join(dir, 'bundled-hook.js');
    fs.writeFileSync(sourcePath, '// bundled\n', 'utf8');
    const settingsPath = path.join(dir, 'settings.json');
    const before = JSON.stringify({
      hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: LEGACY_SE, timeout: 30 }] }] },
    }, null, 2);
    fs.writeFileSync(settingsPath, before, 'utf8');

    const r = await installer.installSessionEndHook({
      sourcePath, destPath: path.join(dir, 'installed.js'), settingsPath, assumeYes: true, dryRun: true,
    });
    assert.equal(r.settingsStatus, 'would-migrate-tilde');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'dry-run must not write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── lockstep with packages/cli/src/init-mnestra.js (Class N) ───────────────

test('lockstep: stack-installer and init-mnestra build byte-identical commands and tilde predicates', () => {
  for (const file of ['memory-session-end.js', 'memory-pre-compact.js']) {
    assert.equal(_hookCommandFor(file), initMnestra._hookCommandFor(file));
  }
  for (const probe of [LEGACY_SE, LEGACY_PC, HOOK_COMMAND, '', undefined]) {
    assert.equal(_isTildeHookCommand(probe), initMnestra._isTildeHookCommand(probe));
  }
  assert.equal(HOOK_COMMAND, initMnestra.HOOK_COMMAND);
});

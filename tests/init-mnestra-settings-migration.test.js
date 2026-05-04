// Sprint 51.8 — settings.json hook event mapping migration regression suite.
//
// Closes Brad's 2026-05-04 jizzard-brain bug (v1.0.3 follow-up). Sprint 51.7
// fixed the Class M wire-up bug so the v2 hook FILE always lands on disk via
// `runHookRefresh()`, but the settings.json half of the wiring (Stop →
// SessionEnd migration) stayed behind in `installSessionEndHook` over in
// stack-installer/src/index.js — never invoked from the Mnestra wizard. Net:
// users whose settings.json was written by `@jhizzard/termdeck-stack@<=0.5.0`
// (anyone who first ran `termdeck init --mnestra` on v1.0.0/v1.0.1) got the
// v2 hook FILE post-1.0.3 but the file stayed wired under `Stop`. v2 doesn't
// gate by event type, so Stop wiring fires on every assistant turn and
// writes N `session_summary` rows in `memory_items` per session.
//
// This suite pins the Sprint 51.8 fix: a hoisted `_mergeSessionEndHookEntry`
// + `migrateSettingsJsonHookEntry` in `packages/cli/src/init-mnestra.js`,
// idempotent, fail-soft, and called immediately after `runHookRefresh()` in
// the wizard's main flow. The hoisted merge primitive mirrors the
// well-tested same-named function in stack-installer/src/index.js — these
// tests focus on the migrate orchestrator (read → merge → backup → write)
// since the merge primitive is independently covered by
// `tests/stack-installer-hook-merge.test.js`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const initMnestra = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-mnestra.js'));

const {
  migrateSettingsJsonHookEntry,
  _mergeSessionEndHookEntry,
  _isSessionEndHookEntry,
  HOOK_COMMAND,
  HOOK_TIMEOUT_SECONDS,
} = initMnestra;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tdck-settings-migration-'));
}

function writeSettings(dir, body) {
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  return p;
}

function readSettings(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Sanity: hoisted primitives match stack-installer behavior ────────────

test('_isSessionEndHookEntry recognizes our hook by command substring', () => {
  assert.equal(_isSessionEndHookEntry({ command: 'node ~/.claude/hooks/memory-session-end.js' }), true);
  assert.equal(_isSessionEndHookEntry({ command: 'node /Users/x/.claude/hooks/memory-session-end.js' }), true);
  assert.equal(_isSessionEndHookEntry({ command: 'node $HOME/.claude/hooks/memory-session-end.js' }), true);
});

test('_isSessionEndHookEntry rejects unrelated entries and bad input', () => {
  assert.ok(!_isSessionEndHookEntry({ command: 'node ~/.claude/hooks/other-hook.js' }));
  assert.ok(!_isSessionEndHookEntry({}));
  assert.ok(!_isSessionEndHookEntry(null));
  assert.ok(!_isSessionEndHookEntry(undefined));
});

test('hoisted HOOK_COMMAND + HOOK_TIMEOUT_SECONDS match stack-installer', () => {
  // Cross-verify by requiring stack-installer and comparing.
  const stackInstaller = require(path.join(repoRoot, 'packages', 'stack-installer', 'src', 'index.js'));
  if (stackInstaller.HOOK_COMMAND) assert.equal(HOOK_COMMAND, stackInstaller.HOOK_COMMAND);
  if (stackInstaller.HOOK_TIMEOUT_SECONDS) assert.equal(HOOK_TIMEOUT_SECONDS, stackInstaller.HOOK_TIMEOUT_SECONDS);
  // Either way: shape is correct.
  assert.equal(HOOK_COMMAND, 'node ~/.claude/hooks/memory-session-end.js');
  assert.equal(HOOK_TIMEOUT_SECONDS, 30);
});

// ── Brad's canonical repro (the whole reason this sprint exists) ─────────

test("BRAD: Stop-wired settings.json migrates to SessionEnd, status='migrated-from-stop', backup written", () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    hooks: {
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] },
      ],
    },
  });

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'migrated-from-stop');
  assert.ok(r.backup, 'backup path must be returned');
  assert.ok(fs.existsSync(r.backup), 'backup file must exist on disk');
  assert.match(path.basename(r.backup), /\.bak\.\d{14}$/);

  const after = readSettings(sp);
  // Stop key fully gone (was the only entry).
  assert.equal(after.hooks.Stop, undefined);
  // SessionEnd has our entry.
  assert.ok(Array.isArray(after.hooks.SessionEnd));
  assert.equal(after.hooks.SessionEnd.length, 1);
  const grp = after.hooks.SessionEnd[0];
  assert.equal(grp.matcher, '');
  assert.equal(grp.hooks.length, 1);
  assert.equal(grp.hooks[0].type, 'command');
  assert.equal(grp.hooks[0].command, HOOK_COMMAND);
  assert.equal(grp.hooks[0].timeout, HOOK_TIMEOUT_SECONDS);

  // Backup contains the original (Stop-wired) shape.
  const backupContents = JSON.parse(fs.readFileSync(r.backup, 'utf8'));
  assert.ok(Array.isArray(backupContents.hooks.Stop));
  assert.equal(backupContents.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);
});

// ── Already-correct installs are no-ops (idempotent) ─────────────────────

test('SessionEnd-wired settings.json is no-op, status=already-installed, no backup, no rewrite', () => {
  const dir = freshTmpDir();
  const original = {
    hooks: {
      SessionEnd: [
        { matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] },
      ],
    },
  };
  const sp = writeSettings(dir, original);
  const mtimeBefore = fs.statSync(sp).mtimeMs;

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'already-installed');
  assert.equal(r.backup, undefined);
  // File should not have been rewritten (mtime unchanged).
  assert.equal(fs.statSync(sp).mtimeMs, mtimeBefore);
  // No backup files in the directory.
  const dirEntries = fs.readdirSync(dir);
  assert.deepEqual(dirEntries.filter((f) => f.includes('.bak.')), []);
});

test('migrateSettingsJsonHookEntry is idempotent — second run on migrated install no-ops', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] },
  });
  const r1 = migrateSettingsJsonHookEntry({ settingsPath: sp });
  assert.equal(r1.status, 'migrated-from-stop');

  // Snapshot post-first-run, then run again.
  const after1 = fs.readFileSync(sp, 'utf8');
  const r2 = migrateSettingsJsonHookEntry({ settingsPath: sp });
  assert.equal(r2.status, 'already-installed');
  // File content unchanged byte-for-byte.
  assert.equal(fs.readFileSync(sp, 'utf8'), after1);
  // No second backup created.
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  assert.equal(backups.length, 1, 'exactly one backup from the first migration run');
});

// ── Fresh installs (no prior settings.json) ──────────────────────────────

test('no-file path: brand-new user gets SessionEnd entry installed, no backup', () => {
  const dir = freshTmpDir();
  const sp = path.join(dir, 'settings.json'); // does not exist

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'installed');
  assert.equal(r.backup, null);
  assert.ok(fs.existsSync(sp));
  const after = readSettings(sp);
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('empty settings.json gets SessionEnd entry installed', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, '');

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'installed');
  const after = readSettings(sp);
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('settings.json with unrelated keys preserves them while installing SessionEnd', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    theme: 'dark',
    permissions: { allow: ['Read', 'Write'] },
  });

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'installed');
  const after = readSettings(sp);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions.allow, ['Read', 'Write']);
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

// ── Mixed cases: user has unrelated Stop hooks + our hook in Stop ────────

test('MIXED: unrelated Stop hooks are preserved; our entry is stripped and migrated', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'node ~/.claude/hooks/some-other-user-hook.js', timeout: 10 },
            { type: 'command', command: HOOK_COMMAND, timeout: 30 },
          ],
        },
      ],
    },
  });

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'migrated-from-stop');
  const after = readSettings(sp);
  // Stop retains the unrelated user hook.
  assert.ok(Array.isArray(after.hooks.Stop));
  assert.equal(after.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop[0].hooks.length, 1);
  assert.match(after.hooks.Stop[0].hooks[0].command, /some-other-user-hook\.js/);
  // Our hook moved to SessionEnd.
  assert.equal(after.hooks.SessionEnd.length, 1);
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test("SessionEnd with another user's hook + our hook in Stop: still migrate ours into the existing SessionEnd group", () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }],
      SessionEnd: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/users-own-session-end.js', timeout: 5 }],
        },
      ],
    },
  });

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'migrated-from-stop');
  const after = readSettings(sp);
  assert.equal(after.hooks.Stop, undefined);
  // SessionEnd's empty-matcher group now has both: user's own + ours.
  assert.equal(after.hooks.SessionEnd.length, 1);
  assert.equal(after.hooks.SessionEnd[0].hooks.length, 2);
  const commands = after.hooks.SessionEnd[0].hooks.map((h) => h.command);
  assert.ok(commands.some((c) => c.includes('users-own-session-end.js')));
  assert.ok(commands.some((c) => c.includes('memory-session-end.js')));
});

// ── Dry-run truthfulness ─────────────────────────────────────────────────

test('dry-run on Stop-wired install reports would-migrated-from-stop without writing', () => {
  const dir = freshTmpDir();
  const original = {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] },
  };
  const sp = writeSettings(dir, original);
  const mtimeBefore = fs.statSync(sp).mtimeMs;

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp, dryRun: true });

  assert.equal(r.status, 'would-migrated-from-stop');
  assert.equal(fs.statSync(sp).mtimeMs, mtimeBefore, 'file unchanged on dry-run');
  // No backup produced.
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.bak.'));
  assert.equal(backups.length, 0);
});

test('dry-run on already-correct install reports already-installed (not would-installed)', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, {
    hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] },
  });

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp, dryRun: true });

  assert.equal(r.status, 'already-installed');
});

test('dry-run on no-file install reports would-installed', () => {
  const dir = freshTmpDir();
  const sp = path.join(dir, 'settings.json');

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp, dryRun: true });

  assert.equal(r.status, 'would-installed');
  assert.ok(!fs.existsSync(sp), 'no file written on dry-run');
});

// ── Failure modes ────────────────────────────────────────────────────────

test('malformed settings.json returns status=malformed without throwing', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, '{ this is not json');

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'malformed');
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  // Original file untouched.
  assert.equal(fs.readFileSync(sp, 'utf8'), '{ this is not json');
});

test('settings.json with non-object top-level returns status=malformed', () => {
  const dir = freshTmpDir();
  const sp = writeSettings(dir, '[1, 2, 3]');

  const r = migrateSettingsJsonHookEntry({ settingsPath: sp });

  assert.equal(r.status, 'malformed');
});

// ── End-to-end: hoisted merge matches stack-installer's merge ────────────

test('cross-package parity: hoisted _mergeSessionEndHookEntry behaves identically to stack-installer copy', () => {
  // Drive the same input through both, assert identical outputs. Pins
  // the hoist as a true 1:1 copy across future maintenance.
  const stackInstaller = require(path.join(repoRoot, 'packages', 'stack-installer', 'src', 'index.js'));

  const inputs = [
    { hooks: {} },
    { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] } },
    { hooks: { SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }] }] } },
    { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/other.js', timeout: 1 }] }] } },
    { theme: 'dark' },
  ];

  for (const input of inputs) {
    const a = JSON.parse(JSON.stringify(input));
    const b = JSON.parse(JSON.stringify(input));
    const ra = _mergeSessionEndHookEntry(a);
    const rb = stackInstaller._mergeSessionEndHookEntry(b);
    assert.equal(ra.status, rb.status);
    assert.deepEqual(a, b);
  }
});

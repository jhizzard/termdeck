// Sprint 81 T3 — PreToolUse gate installer wiring fences.
//
// Covers the installer trio (installPreToolUseHook / _mergePreToolUseHookEntry /
// _isPreToolUseHookEntry) in packages/stack-installer/src/index.js AND the
// hoisted twins + migrateSettingsJsonPreToolUseEntry in
// packages/cli/src/init-mnestra.js — asserting Class-N lockstep parity (the two
// merge primitives must be byte-for-byte equivalent on identical inputs).
//
// Run: node --test packages/stack-installer/tests/pretooluse-gate-install.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installer = require('../src/index.js');
const initMnestra = require('../../cli/src/init-mnestra.js');

const GATE_FILES = installer.PRETOOLUSE_GATE_FILES;

function mkTmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function rmTmp(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } }

function bashGroup(settings) {
  return (settings.hooks.PreToolUse || []).find((g) => g.matcher === 'Bash');
}
function commands(group) { return (group ? group.hooks : []).map((h) => h.command); }

// ── _isPreToolUseHookEntry ───────────────────────────────────────────────────

test('_isPreToolUseHookEntry recognizes gate commands, rejects others', () => {
  assert.equal(installer._isPreToolUseHookEntry({ command: 'node "/x/gate-publish-before-push.js"' }), true);
  assert.equal(installer._isPreToolUseHookEntry({ command: 'node "/x/gate-migration-without-rls.js"' }), true);
  // falsy (not necessarily === false — the merge uses it in boolean context)
  assert.ok(!installer._isPreToolUseHookEntry({ command: 'node "/x/memory-session-end.js"' }));
  assert.ok(!installer._isPreToolUseHookEntry({ command: 'some other hook' }));
  assert.ok(!installer._isPreToolUseHookEntry({}));
  assert.ok(!installer._isPreToolUseHookEntry(null));
});

// ── _mergePreToolUseHookEntry ────────────────────────────────────────────────

test('merge: fresh install adds both gates under one Bash group', () => {
  const s = {};
  const r = installer._mergePreToolUseHookEntry(s);
  assert.equal(r.status, 'installed');
  const g = bashGroup(r.settings);
  assert.ok(g, 'a Bash-matcher group exists');
  assert.equal(g.hooks.length, 2);
  assert.ok(commands(g).some((c) => c.includes('gate-publish-before-push.js')));
  assert.ok(commands(g).some((c) => c.includes('gate-migration-without-rls.js')));
  assert.ok(g.hooks.every((h) => h.type === 'command' && typeof h.timeout === 'number'));
});

test('merge: idempotent (already-installed on second call, no dupes)', () => {
  const s = {};
  installer._mergePreToolUseHookEntry(s);
  const r2 = installer._mergePreToolUseHookEntry(s);
  assert.equal(r2.status, 'already-installed');
  assert.equal(bashGroup(s).hooks.length, 2, 'no duplicate entries');
});

test('merge: partial install re-adds only the missing gate', () => {
  const s = {};
  installer._mergePreToolUseHookEntry(s);
  bashGroup(s).hooks.pop(); // remove the second gate
  const r = installer._mergePreToolUseHookEntry(s);
  assert.equal(r.status, 'installed');
  assert.equal(bashGroup(s).hooks.length, 2);
});

test('merge: coexists with a user hook under a different matcher (adds a new Bash group)', () => {
  const s = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node /user/own.js' }] }] } };
  const r = installer._mergePreToolUseHookEntry(s);
  assert.equal(r.status, 'installed');
  const writeGroup = s.hooks.PreToolUse.find((g) => g.matcher === 'Write');
  assert.ok(writeGroup && writeGroup.hooks.length === 1, "user's Write group is preserved");
  assert.equal(bashGroup(s).hooks.length, 2, 'our gates land in a Bash group');
});

test('merge: appends into a user-owned Bash group without clobbering the user hook', () => {
  const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /user/bash-guard.js' }] }] } };
  const r = installer._mergePreToolUseHookEntry(s);
  assert.equal(r.status, 'installed');
  const g = bashGroup(s);
  assert.equal(g.hooks.length, 3, "user's hook + our 2 gates");
  assert.ok(commands(g).includes('node /user/bash-guard.js'), "user's hook preserved");
});

test('merge: rewrites a legacy ~ gate command to the absolute path', () => {
  const legacy = 'node ~/.claude/hooks/gate-publish-before-push.js';
  const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: legacy }] }] } };
  const r = installer._mergePreToolUseHookEntry(s);
  assert.equal(r.status, 'migrated-tilde-path');
  const g = bashGroup(s);
  assert.ok(!commands(g).some((c) => c.includes('~/')), 'no tilde command remains');
  assert.equal(g.hooks.length, 2, 'the other gate was also added');
});

// ── Class-N lockstep parity ──────────────────────────────────────────────────

test('installer + init-mnestra _mergePreToolUseHookEntry are byte-identical on the same input', () => {
  const a = {}; const b = {};
  installer._mergePreToolUseHookEntry(a);
  initMnestra._mergePreToolUseHookEntry(b);
  assert.deepEqual(a, b, 'the two hoisted twins produce identical settings (Class N)');
  assert.deepEqual(installer.PRETOOLUSE_GATE_FILES, initMnestra.PRETOOLUSE_GATE_FILES);
});

// ── installPreToolUseHook (file vendoring + settings merge) ───────────────────

async function withHome(fn) {
  const home = mkTmp('td-ptu-home-');
  try {
    const dests = GATE_FILES.map((f) => path.join(home, '.claude', 'hooks', f));
    const settingsPath = path.join(home, '.claude', 'settings.json');
    return await fn({ home, dests, settingsPath });
  } finally { rmTmp(home); }
}

test('installPreToolUseHook: fresh install copies both gates + merges settings', async () => {
  await withHome(async ({ dests, settingsPath }) => {
    const r = await installer.installPreToolUseHook({ assumeYes: true, dests, settingsPath });
    assert.deepEqual(r.fileStatuses, ['copied', 'copied']);
    assert.equal(r.settingsStatus, 'installed');
    for (const d of dests) assert.ok(fs.existsSync(d), `${path.basename(d)} vendored`);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const g = (settings.hooks.PreToolUse || []).find((x) => x.matcher === 'Bash');
    assert.equal(g.hooks.length, 2);
  });
});

test('installPreToolUseHook: idempotent second run (files identical, settings already-installed)', async () => {
  await withHome(async ({ dests, settingsPath }) => {
    await installer.installPreToolUseHook({ assumeYes: true, dests, settingsPath });
    const r2 = await installer.installPreToolUseHook({ assumeYes: true, dests, settingsPath });
    assert.deepEqual(r2.fileStatuses, ['already-current', 'already-current']);
    assert.equal(r2.settingsStatus, 'already-installed');
  });
});

test('installPreToolUseHook: dry-run writes nothing', async () => {
  await withHome(async ({ dests, settingsPath }) => {
    const r = await installer.installPreToolUseHook({ assumeYes: true, dryRun: true, dests, settingsPath });
    assert.deepEqual(r.fileStatuses, ['would-copy', 'would-copy']);
    assert.equal(r.settingsStatus, 'would-install');
    for (const d of dests) assert.ok(!fs.existsSync(d), 'no file written in dry-run');
    assert.ok(!fs.existsSync(settingsPath), 'no settings written in dry-run');
  });
});

test('installPreToolUseHook: malformed settings.json is NOT overwritten', async () => {
  await withHome(async ({ dests, settingsPath }) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ this is not json');
    const r = await installer.installPreToolUseHook({ assumeYes: true, dests, settingsPath });
    assert.equal(r.settingsStatus, 'malformed');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ this is not json', 'malformed file left intact');
  });
});

test('installPreToolUseHook: decline (assumeNo) installs nothing', async () => {
  await withHome(async ({ dests, settingsPath }) => {
    const r = await installer.installPreToolUseHook({ assumeNo: true, dests, settingsPath });
    assert.equal(r.settingsStatus, 'declined');
    for (const d of dests) assert.ok(!fs.existsSync(d));
  });
});

// ── migrateSettingsJsonPreToolUseEntry (init-mnestra) ─────────────────────────

test('migrateSettingsJsonPreToolUseEntry: installs, is idempotent, backs up', async () => {
  await withHome(async ({ settingsPath }) => {
    // fresh (no file) → installed, no backup
    let r = initMnestra.migrateSettingsJsonPreToolUseEntry({ settingsPath });
    assert.equal(r.status, 'installed');
    assert.equal(r.backup, null);
    // second run → already-installed
    r = initMnestra.migrateSettingsJsonPreToolUseEntry({ settingsPath });
    assert.equal(r.status, 'already-installed');
    // dry-run on a fresh path → would-installed, nothing written
    const fresh = path.join(path.dirname(settingsPath), 'fresh.json');
    const dr = initMnestra.migrateSettingsJsonPreToolUseEntry({ settingsPath: fresh, dryRun: true });
    assert.equal(dr.status, 'would-installed');
    assert.ok(!fs.existsSync(fresh));
  });
});

test('migrateSettingsJsonPreToolUseEntry: backs up an existing settings.json before write', async () => {
  await withHome(async ({ settingsPath }) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionEnd: [] } }));
    const r = initMnestra.migrateSettingsJsonPreToolUseEntry({ settingsPath });
    assert.equal(r.status, 'installed');
    assert.ok(r.backup && fs.existsSync(r.backup), 'a timestamped backup was written');
  });
});

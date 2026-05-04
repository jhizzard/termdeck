// Sprint 51.6 T3 — hook upgrade-gap regression suite.
//
// Closes Codex's GAP from 2026-05-03 20:11 ET: shipping a fixed bundled hook
// in `packages/stack-installer/assets/hooks/memory-session-end.js` is
// pointless if `npm install -g @jhizzard/termdeck@latest && termdeck init
// --mnestra` never refreshes ~/.claude/hooks/memory-session-end.js on the
// user's machine. v1.0.2 lands two layers:
//
//   (a) `init --mnestra` gains a `refreshBundledHookIfNewer()` step that
//       diffs the version stamp in the bundled hook against the installed
//       hook and overwrites if bundled is newer. Best-effort, timestamped
//       backup, fail-soft.
//   (b) stack-installer's `installSessionEndHook` becomes version-aware
//       under `--yes`: a strictly-newer bundled stamp triggers overwrite
//       (was `false` always, preserving stale installs).
//
// These tests pin both.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const initMnestra = require(path.join(repoRoot, 'packages', 'cli', 'src', 'init-mnestra.js'));
const stackInstaller = require(path.join(repoRoot, 'packages', 'stack-installer', 'src', 'index.js'));

const { refreshBundledHookIfNewer } = initMnestra;
const {
  _readHookSignatureVersion,
  _hookSignatureUpgradeAvailable,
  HOOK_SIGNATURE_REGEX,
} = stackInstaller;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-refresh-'));
}

function writeHook(dir, filename, body) {
  const p = path.join(dir, filename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// ── Version-stamp parsing ───────────────────────────────────────────────────

test('HOOK_SIGNATURE_REGEX matches the canonical comment shape', () => {
  assert.match('// @termdeck/stack-installer-hook v1', HOOK_SIGNATURE_REGEX);
  assert.match('// @termdeck/stack-installer-hook v42', HOOK_SIGNATURE_REGEX);
  assert.match(' * @termdeck/stack-installer-hook v3', HOOK_SIGNATURE_REGEX);
  // No match: typo / missing v / negative.
  assert.doesNotMatch('// @termdeck/stack-installer-hook 1', HOOK_SIGNATURE_REGEX);
  assert.doesNotMatch('// @termdeck/installer-hook v1', HOOK_SIGNATURE_REGEX);
});

test('_readHookSignatureVersion returns null when file missing or unsigned', () => {
  const dir = freshTmpDir();
  try {
    assert.equal(_readHookSignatureVersion(path.join(dir, 'absent.js')), null);
    const unsigned = writeHook(dir, 'unsigned.js', "// no version stamp here\n'use strict';\n");
    assert.equal(_readHookSignatureVersion(unsigned), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_readHookSignatureVersion parses positive integers from the marker', () => {
  const dir = freshTmpDir();
  try {
    const v1 = writeHook(dir, 'v1.js', "// @termdeck/stack-installer-hook v1\n'use strict';\n");
    assert.equal(_readHookSignatureVersion(v1), 1);
    const v42 = writeHook(dir, 'v42.js', " * @termdeck/stack-installer-hook v42\n");
    assert.equal(_readHookSignatureVersion(v42), 42);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Upgrade decision ────────────────────────────────────────────────────────

test('_hookSignatureUpgradeAvailable: bundled newer than installed → true', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'src.js', "// @termdeck/stack-installer-hook v2\n");
    const dest = writeHook(dir, 'dest.js', "// @termdeck/stack-installer-hook v1\n");
    assert.equal(_hookSignatureUpgradeAvailable(src, dest), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_hookSignatureUpgradeAvailable: bundled same as installed → false', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'src.js', "// @termdeck/stack-installer-hook v3\n");
    const dest = writeHook(dir, 'dest.js', "// @termdeck/stack-installer-hook v3\n");
    assert.equal(_hookSignatureUpgradeAvailable(src, dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_hookSignatureUpgradeAvailable: installed unsigned + TermDeck marker → true (treat as v0)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'src.js', "// @termdeck/stack-installer-hook v1\n");
    // Sprint 51.6 T4-CODEX safety gate: unsigned-installed needs a TermDeck
    // marker to qualify for auto-overwrite. Without one, the hook is
    // assumed to be a user-custom file and preserved.
    const dest = writeHook(dir, 'dest.js',
      "// TermDeck session-end memory hook (legacy, pre-Sprint-51.6, no stamp)\n");
    assert.equal(_hookSignatureUpgradeAvailable(src, dest), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_hookSignatureUpgradeAvailable: installed unsigned + NO TermDeck marker → false (preserve user-custom hook)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'src.js', "// @termdeck/stack-installer-hook v1\n");
    const dest = writeHook(dir, 'dest.js',
      "// my custom hook unrelated to TermDeck\nexports.foo = () => {};\n");
    assert.equal(_hookSignatureUpgradeAvailable(src, dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('_hookSignatureUpgradeAvailable: bundled unsigned → false (safety: do not auto-overwrite)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'src.js', "// no stamp in bundled — refuse to upgrade\n");
    const dest = writeHook(dir, 'dest.js', "// @termdeck/stack-installer-hook v1\n");
    assert.equal(_hookSignatureUpgradeAvailable(src, dest), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── refreshBundledHookIfNewer (init-mnestra step) ───────────────────────────

test('refreshBundledHookIfNewer: no installed hook → installs bundled', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/memory-session-end.js',
      "// @termdeck/stack-installer-hook v1\n// bundled body\n");
    const dest = path.join(dir, 'installed', 'memory-session-end.js');
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'installed');
    assert.equal(r.bundled, 1);
    assert.equal(fs.readFileSync(dest, 'utf8'), "// @termdeck/stack-installer-hook v1\n// bundled body\n");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: installed up-to-date → no overwrite', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// @termdeck/stack-installer-hook v1\n// bundled\n");
    const dest = writeHook(dir, 'installed/h.js', "// @termdeck/stack-installer-hook v1\n// installed (different body)\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'up-to-date');
    assert.equal(r.installed, 1);
    assert.equal(r.bundled, 1);
    // Body NOT overwritten.
    assert.match(fs.readFileSync(dest, 'utf8'), /installed \(different body\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: bundled newer → overwrites + creates timestamped backup', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// @termdeck/stack-installer-hook v2\n// new body\n");
    const dest = writeHook(dir, 'installed/h.js', "// @termdeck/stack-installer-hook v1\n// old body\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'refreshed');
    assert.equal(r.from, 1);
    assert.equal(r.to, 2);
    assert.match(r.backup, /\.bak\.\d{14}$/);
    // Body overwritten.
    assert.match(fs.readFileSync(dest, 'utf8'), /new body/);
    // Backup contains the OLD body.
    assert.match(fs.readFileSync(r.backup, 'utf8'), /old body/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: installed unsigned + TermDeck marker → overwrites (treats unsigned as v0)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// @termdeck/stack-installer-hook v1\n// bundled\n");
    // Sprint 51.6 T4-CODEX safety gate: unsigned-installed must look
    // TermDeck-managed to qualify for auto-overwrite.
    const dest = writeHook(dir, 'installed/h.js',
      "// TermDeck session-end memory hook (pre-stamp era)\n// old body\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'refreshed');
    assert.equal(r.from, null);
    assert.equal(r.to, 1);
    // Backup preserves the OLD body.
    assert.match(fs.readFileSync(r.backup, 'utf8'), /old body/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: installed unsigned + NO TermDeck marker → custom-hook-preserved (no overwrite)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// @termdeck/stack-installer-hook v1\n// bundled\n");
    // A genuinely user-custom hook (no TermDeck markers) — must NOT be
    // clobbered by the v1.0.2 upgrade flow under --yes.
    const dest = writeHook(dir, 'installed/h.js',
      "// my own session hook, unrelated to TermDeck\nrequire('./my-stuff');\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'custom-hook-preserved');
    assert.equal(r.bundled, 1);
    // Body NOT overwritten.
    assert.match(fs.readFileSync(dest, 'utf8'), /my own session hook/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: dry-run does not write', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// @termdeck/stack-installer-hook v2\n// new\n");
    const dest = writeHook(dir, 'installed/h.js', "// @termdeck/stack-installer-hook v1\n// old\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest, dryRun: true });
    assert.equal(r.status, 'would-refresh');
    assert.match(fs.readFileSync(dest, 'utf8'), /old/, 'dry-run must not overwrite');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: bundled hook absent → no-bundled status (fail-soft)', () => {
  const dir = freshTmpDir();
  try {
    const src = path.join(dir, 'bundled', 'absent.js');
    const dest = writeHook(dir, 'installed/h.js', "// @termdeck/stack-installer-hook v1\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'no-bundled');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refreshBundledHookIfNewer: bundled hook unsigned → bundled-unsigned status (no overwrite)', () => {
  const dir = freshTmpDir();
  try {
    const src = writeHook(dir, 'bundled/h.js', "// no stamp\n");
    const dest = writeHook(dir, 'installed/h.js', "// installed body\n");
    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'bundled-unsigned');
    assert.match(fs.readFileSync(dest, 'utf8'), /installed body/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

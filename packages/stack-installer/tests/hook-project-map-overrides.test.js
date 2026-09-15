// Local project-map overrides (2026-09-15).
//
// WHY THIS EXISTS. Some cwds must be tagged with a project but must NOT be
// named in `assets/hooks/memory-session-end.js` — that asset ships in a public
// repo and inside every @jhizzard/termdeck-stack tarball, so a directory name
// added there is published permanently. Untagged, such a cwd falls through to
// `global` and a session-end drain pushes an uncurated transcript into the
// cross-project-recallable tag.
//
// Before the overrides file, the only way to get the tag was to hand-edit the
// INSTALLED copy at ~/.claude/hooks/ — which the installer then overwrote on
// the next run, silently restoring the leak. These tests pin the durable
// mechanism: an out-of-tree file at ~/.termdeck/hook-project-map.local.json is
// merged over the bundled map, local entries win, and every malformed shape
// degrades to "no overrides" rather than breaking session capture.
//
// NOTE: every fixture below uses INVENTED paths. Using the real private path
// as a fixture would defeat the entire purpose of the mechanism.
//
// Run: node --test packages/stack-installer/tests/hook-project-map-overrides.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'assets', 'hooks', 'memory-session-end.js');

// The hook reads its overrides at module load, so each case needs a fresh
// require with TERMDECK_HOOK_PROJECT_MAP_PATH pointed at a fixture.
function loadHookWith(overridesPath) {
  const prev = process.env.TERMDECK_HOOK_PROJECT_MAP_PATH;
  if (overridesPath === null) delete process.env.TERMDECK_HOOK_PROJECT_MAP_PATH;
  else process.env.TERMDECK_HOOK_PROJECT_MAP_PATH = overridesPath;
  delete require.cache[require.resolve(HOOK)];
  try {
    return require(HOOK);
  } finally {
    if (prev === undefined) delete process.env.TERMDECK_HOOK_PROJECT_MAP_PATH;
    else process.env.TERMDECK_HOOK_PROJECT_MAP_PATH = prev;
    delete require.cache[require.resolve(HOOK)];
  }
}

function withTempFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-projmap-'));
  const file = path.join(dir, 'hook-project-map.local.json');
  if (contents !== null) fs.writeFileSync(file, contents, { mode: 0o600 });
  try { return fn(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const VALID = JSON.stringify({
  entries: [{ pattern: '\\/Clients\\/Acme Holdings(\\/|$)', project: 'acme-holdings' }],
});

// ── happy path ──────────────────────────────────────────────────────────────

test('a local entry tags a cwd the bundled map does not know', () => {
  withTempFile(VALID, (file) => {
    const m = loadHookWith(file);
    assert.strictEqual(m.detectProject('/Users/someone/Clients/Acme Holdings/matter'), 'acme-holdings');
    // Same cwd without the overrides file → falls through to global. This is
    // the leak the mechanism prevents, asserted directly.
    const clean = loadHookWith(path.join(path.dirname(file), 'does-not-exist.json'));
    assert.strictEqual(clean.detectProject('/Users/someone/Clients/Acme Holdings/matter'), 'global');
  });
});

test('the bare-array form is accepted too', () => {
  const arr = JSON.stringify([{ pattern: '\\/Vault\\/Redacted(\\/|$)', project: 'redacted' }]);
  withTempFile(arr, (file) => {
    assert.strictEqual(loadHookWith(file).detectProject('/Vault/Redacted/x'), 'redacted');
  });
});

test('matching is case-insensitive by default, and `flags` can override', () => {
  withTempFile(VALID, (file) => {
    assert.strictEqual(loadHookWith(file).detectProject('/users/someone/clients/ACME HOLDINGS/m'), 'acme-holdings');
  });
  const cased = JSON.stringify({ entries: [{ pattern: '\\/CaseSensitive(\\/|$)', project: 'cs', flags: '' }] });
  withTempFile(cased, (file) => {
    const m = loadHookWith(file);
    assert.strictEqual(m.detectProject('/CaseSensitive/x'), 'cs');
    assert.strictEqual(m.detectProject('/casesensitive/x'), 'global');
  });
});

// ── precedence ──────────────────────────────────────────────────────────────

test('local entries WIN over a bundled pattern that also matches', () => {
  // The bundled map ends in a /ChopinNashville/ catch-all. Appending locals
  // instead of prepending would let that catch-all shadow them — this is the
  // regression that would make "local wins" false while looking correct.
  const override = JSON.stringify({
    entries: [{ pattern: '\\/ChopinNashville\\/Private Matter(\\/|$)', project: 'private-matter' }],
  });
  withTempFile(override, (file) => {
    const m = loadHookWith(file);
    assert.strictEqual(m.detectProject('/x/ChopinNashville/Private Matter/notes'), 'private-matter');
    // …and an unrelated ChopinNashville cwd still hits the catch-all.
    assert.strictEqual(m.detectProject('/x/ChopinNashville/something-else'), 'chopin-nashville');
  });
});

test('_mergeProjectMap puts local first', () => {
  const m = loadHookWith(null);
  const merged = m._mergeProjectMap([{ pattern: /a/, project: 'local' }], [{ pattern: /a/, project: 'bundled' }]);
  assert.strictEqual(merged[0].project, 'local');
});

test('bundled behavior is unchanged when no overrides file exists', () => {
  const m = loadHookWith(path.join(os.tmpdir(), 'definitely-absent-overrides.json'));
  assert.deepStrictEqual(m.PROJECT_MAP.length, m.BUNDLED_PROJECT_MAP.length);
  assert.strictEqual(m.detectProject('/x/SideHustles/TermDeck'), 'termdeck');
  assert.strictEqual(m.detectProject('/x/Graciella/engram'), 'mnestra');
  assert.strictEqual(m.detectProject('/tmp/nowhere'), 'global');
});

// ── fail-soft ───────────────────────────────────────────────────────────────
// A capture hook must never be the reason a session fails to close, so every
// malformed shape degrades to the bundled map.

test('malformed overrides never throw and never change bundled behavior', () => {
  const cases = [
    ['invalid JSON', '{ not json'],
    ['wrong top-level type', '"a string"'],
    ['object without entries', '{"foo":1}'],
    ['entries not an array', '{"entries":{}}'],
    ['null', 'null'],
    ['empty file', ''],
  ];
  for (const [label, contents] of cases) {
    withTempFile(contents, (file) => {
      const m = loadHookWith(file);
      assert.strictEqual(m.PROJECT_MAP.length, m.BUNDLED_PROJECT_MAP.length, `${label}: should add nothing`);
      assert.strictEqual(m.detectProject('/x/SideHustles/TermDeck'), 'termdeck', `${label}: bundled still works`);
    });
  }
});

test('individual bad entries are skipped, good ones in the same file still load', () => {
  const mixed = JSON.stringify({
    entries: [
      { pattern: '[unclosed', project: 'bad-regex' },
      { pattern: 123, project: 'wrong-type' },
      { pattern: '\\/ok(\\/|$)', project: '' },
      { project: 'no-pattern' },
      { pattern: '\\/Good Path(\\/|$)', project: 'good' },
    ],
  });
  withTempFile(mixed, (file) => {
    const m = loadHookWith(file);
    assert.strictEqual(m._loadLocalProjectMap(file).length, 1, 'only the valid entry survives');
    assert.strictEqual(m.detectProject('/Good Path/x'), 'good');
  });
});

test('an over-long pattern is rejected (ReDoS bound)', () => {
  const huge = JSON.stringify({ entries: [{ pattern: 'a'.repeat(5000), project: 'huge' }] });
  withTempFile(huge, (file) => {
    assert.strictEqual(loadHookWith(file)._loadLocalProjectMap(file).length, 0);
  });
});

test('a directory in place of the file fails soft', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-projmap-dir-'));
  try {
    const m = loadHookWith(dir);
    assert.strictEqual(m.PROJECT_MAP.length, m.BUNDLED_PROJECT_MAP.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── installer must never clobber the overrides file ─────────────────────────

test('the installer writes no path that could overwrite the overrides file', () => {
  // The whole mechanism rests on the installer leaving this file alone. If a
  // future change starts writing it, the hand-edit-gets-overwritten failure
  // returns in a new costume — so pin it here rather than trusting review.
  const installerSrc = path.join(__dirname, '..', 'src');
  const files = fs.readdirSync(installerSrc).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'installer sources should be present');
  for (const f of files) {
    const text = fs.readFileSync(path.join(installerSrc, f), 'utf8');
    assert.ok(
      !text.includes('hook-project-map'),
      `${f} references hook-project-map — the installer must never write or remove the local overrides file`
    );
  }
});

test('no pattern from the operator overrides file has leaked into the published asset', () => {
  // Belt-and-suspenders against a hand-edit being committed upstream. This
  // reads the REAL overrides file when one exists and asserts none of its
  // patterns appear in the shipped asset — deliberately deriving the forbidden
  // strings at runtime rather than hard-coding them, because a literal private
  // path written into this test would itself be published, which is the exact
  // leak under test. Skips cleanly on CI / a machine with no overrides.
  const m = loadHookWith(null);
  let entries;
  try {
    entries = m._loadLocalProjectMap(m.LOCAL_PROJECT_MAP_PATH);
  } catch { entries = []; }
  if (!entries.length) return; // nothing configured locally — nothing to check

  const text = fs.readFileSync(HOOK, 'utf8');
  for (const e of entries) {
    assert.ok(
      !text.includes(e.pattern.source),
      `an operator override pattern (project="${e.project}") appears verbatim in the published asset — it must live only in ${m.LOCAL_PROJECT_MAP_PATH}`
    );
    assert.ok(
      !text.includes(`'${e.project}'`) && !text.includes(`"${e.project}"`),
      `operator override project tag "${e.project}" appears in the published asset`
    );
  }
});

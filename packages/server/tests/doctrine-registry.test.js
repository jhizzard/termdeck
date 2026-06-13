// Sprint 78 T1 — doctrine registry loader behavior (load / merge / validate /
// compile / forbidden-string screen). These are BEHAVIOR tests (not file-
// existence) per INSTALLER-PITFALLS ledger #16, and they live in
// packages/server/tests/ — the canonical npm-test glob. The repo-root tests/
// dir is NOT in the glob, so a suite placed there silently never runs.
//
// The forbidden-string screen test uses a CUSTOM temp gitleaks config with a
// benign sentinel rule rather than planting a real-secret-shaped literal in
// this committed file (which would trip the pre-commit gitleaks hook). The
// sentinel `FORBIDDEN-SENTINEL-9F3A` is not a secret pattern and not a
// forbidden string, so committing this file is safe.
//
// Run: node --test packages/server/tests/doctrine-registry.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctrine = require('../../../doctrine');

const GITLEAKS_BIN = '/usr/local/bin/gitleaks';
const SENTINEL = 'FORBIDDEN-SENTINEL-9F3A';
const REPO_REGISTRY = doctrine.defaultRepoRegistry();

// A guaranteed-absent path for "overlay absent" cases.
const ABSENT = path.join(os.tmpdir(), 'doctrine-absent-overlay-does-not-exist.jsonl');

// Create a temp dir + return helpers; cleaned up by the caller.
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A minimal entry that PASSES validateEntry, with overridable fields.
function validEntry(over = {}) {
  return Object.assign({
    id: 'tmp-entry',
    title: 'Temp entry',
    severity: 'low',
    scope: 'universal',
    audience: 'all',
    trigger: 'always',
    check: { type: 'manual' },
    enforcement: { surface: 'inject-advisory', max_severity: 'advise', ref: 'x' },
    advisory: { one_line: 'a clean advisory line', procedure_path: 'docs/x.md', cooldown_hours: 1 },
    status: 'active',
    version: 1,
  }, over);
}

test('loadDoctrine succeeds with BOTH overlays absent — returns repo entries, never throws', () => {
  doctrine.clearCache();
  const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: ABSENT, termdeckOverlayDir: ABSENT });
  assert.ok(Array.isArray(entries), 'returns an array');
  assert.ok(entries.length >= 12, `repo registry loads (got ${entries.length})`);
  // sanity: known seed entry present
  assert.ok(entries.some((e) => e.id === 'publish-before-push'), 'publish-before-push present');
});

test('every shipped repo entry passes validateEntry', () => {
  const raw = fs.readFileSync(REPO_REGISTRY, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  assert.ok(raw.length >= 12, 'registry has entries');
  for (const line of raw) {
    const obj = JSON.parse(line);
    const v = doctrine.validateEntry(obj);
    assert.equal(v.valid, true, `entry '${obj.id}' invalid: ${v.errors.join('; ')}`);
  }
});

test('validateEntry REJECTS block on an advisory surface (server-monitor)', () => {
  const v = doctrine.validateEntry(validEntry({
    id: 'bad-block-server-monitor',
    enforcement: { surface: 'server-monitor', max_severity: 'block', ref: 'x' },
  }));
  assert.equal(v.valid, false, 'block-on-server-monitor must be invalid');
  assert.ok(v.errors.some((e) => /block.*architecturally impossible|not permitted/i.test(e)), `errors mention block cap: ${v.errors.join('; ')}`);
});

test('validateEntry REJECTS block on inject-advisory and status-append', () => {
  for (const surface of ['inject-advisory', 'status-append']) {
    const v = doctrine.validateEntry(validEntry({ enforcement: { surface, max_severity: 'block', ref: 'x' } }));
    assert.equal(v.valid, false, `block on ${surface} must be invalid`);
  }
});

test('validateEntry ACCEPTS block on git-hook / preToolUse-deny / inject-refusal', () => {
  for (const surface of ['git-hook', 'preToolUse-deny', 'inject-refusal']) {
    const v = doctrine.validateEntry(validEntry({ enforcement: { surface, max_severity: 'block', ref: 'x' } }));
    assert.equal(v.valid, true, `block on ${surface} must be valid: ${v.errors.join('; ')}`);
  }
});

test('validateEntry rejects bad enum + over-long one_line', () => {
  assert.equal(doctrine.validateEntry(validEntry({ check: { type: 'bogus' } })).valid, false);
  assert.equal(doctrine.validateEntry(validEntry({ enforcement: { surface: 'nope', max_severity: 'warn' } })).valid, false);
  assert.equal(doctrine.validateEntry(validEntry({ scope: 'nope' })).valid, false);
  const longLine = 'x'.repeat(201);
  assert.equal(doctrine.validateEntry(validEntry({ advisory: { one_line: longLine } })).valid, false);
});

test('validateEntry enforces severity/status enums + requires max_severity (doc/code alignment)', () => {
  // severity must be a known enum
  assert.equal(doctrine.validateEntry(validEntry({ severity: 'ULTRA-BOGUS' })).valid, false, 'bad severity rejected');
  assert.equal(doctrine.validateEntry(validEntry({ severity: undefined })).valid, false, 'missing severity rejected');
  // status must be active|proposed|deprecated (Sprint 79 elevation keys off it)
  assert.equal(doctrine.validateEntry(validEntry({ status: 'retired' })).valid, false, 'bad status rejected');
  // enforcement.max_severity is required (SCHEMA marks the enforcement object required)
  assert.equal(doctrine.validateEntry(validEntry({ enforcement: { surface: 'inject-advisory', ref: 'x' } })).valid, false, 'missing max_severity rejected');
  // a fully-valid entry still passes
  assert.equal(doctrine.validateEntry(validEntry({ severity: 'high', status: 'proposed' })).valid, true);
});

test('compileTrigger is fail-soft on the exported surface (null/undefined do not throw)', () => {
  assert.doesNotThrow(() => doctrine.compileTrigger(null));
  assert.doesNotThrow(() => doctrine.compileTrigger(undefined));
  assert.equal(doctrine.compileTrigger(null), null);
  // a valid regex entry still compiles
  const compiled = doctrine.compileTrigger(validEntry({ check: { type: 'regex', pattern: 'EADDRINUSE' } }));
  assert.ok(compiled._checkRegex instanceof RegExp);
});

test('loadDoctrine drops an invalid overlay entry but returns the valid remainder', () => {
  const dir = tmpDir('doctrine-inv-');
  try {
    const overlay = path.join(dir, 'registry.local.jsonl');
    const good = validEntry({ id: 'overlay-good' });
    const bad = validEntry({ id: 'overlay-bad-block', enforcement: { surface: 'server-monitor', max_severity: 'block', ref: 'x' } });
    fs.writeFileSync(overlay, JSON.stringify(good) + '\n' + JSON.stringify(bad) + '\n');
    const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT });
    assert.ok(entries.some((e) => e.id === 'overlay-good'), 'valid overlay entry present');
    assert.ok(!entries.some((e) => e.id === 'overlay-bad-block'), 'invalid (block-on-server-monitor) overlay entry dropped');
    assert.ok(entries.some((e) => e.id === 'publish-before-push'), 'repo entries still present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-entry try/catch: a malformed regex drops only that entry; others survive', () => {
  const dir = tmpDir('doctrine-badre-');
  try {
    const overlay = path.join(dir, 'registry.local.jsonl');
    const badRe = validEntry({ id: 'overlay-bad-regex', check: { type: 'regex', pattern: '[' } }); // invalid regex
    const good = validEntry({ id: 'overlay-after-bad' });
    fs.writeFileSync(overlay, JSON.stringify(badRe) + '\n' + JSON.stringify(good) + '\n');
    const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT });
    assert.ok(!entries.some((e) => e.id === 'overlay-bad-regex'), 'malformed-regex entry dropped');
    assert.ok(entries.some((e) => e.id === 'overlay-after-bad'), 'subsequent valid entry survives');
    assert.ok(entries.some((e) => e.id === 'publish-before-push'), 'repo entries survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSONL line is skipped; valid lines on either side survive', () => {
  const dir = tmpDir('doctrine-badjson-');
  try {
    const overlay = path.join(dir, 'registry.local.jsonl');
    const a = validEntry({ id: 'overlay-json-a' });
    const b = validEntry({ id: 'overlay-json-b' });
    fs.writeFileSync(overlay, JSON.stringify(a) + '\n' + '{ this is not valid json ]\n' + JSON.stringify(b) + '\n');
    const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT });
    assert.ok(entries.some((e) => e.id === 'overlay-json-a'), 'entry before bad line survives');
    assert.ok(entries.some((e) => e.id === 'overlay-json-b'), 'entry after bad line survives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay overrides a repo entry by id (precedence)', () => {
  const dir = tmpDir('doctrine-override-');
  try {
    const overlay = path.join(dir, 'registry.local.jsonl');
    const override = validEntry({ id: 'publish-before-push', title: 'OVERRIDDEN TITLE' });
    fs.writeFileSync(overlay, JSON.stringify(override) + '\n');
    const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT });
    const e = entries.find((x) => x.id === 'publish-before-push');
    assert.equal(e.title, 'OVERRIDDEN TITLE', 'overlay overrides repo entry by id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forbidden-string screen drops a tripping entry (custom gitleaks config + sentinel)', () => {
  const dir = tmpDir('doctrine-screen-');
  try {
    const cfg = path.join(dir, 'screen.toml');
    fs.writeFileSync(cfg, `title = "doctrine screen test"\n[[rules]]\nid = "doctrine-test-sentinel"\ndescription = "test sentinel"\nregex = '''${SENTINEL}'''\n`);
    const overlay = path.join(dir, 'registry.local.jsonl');
    const clean = validEntry({ id: 'screen-clean' });
    const tripping = validEntry({ id: 'screen-tripping', advisory: { one_line: `leak ${SENTINEL} here`, procedure_path: 'docs/x.md', cooldown_hours: 1 } });
    fs.writeFileSync(overlay, JSON.stringify(clean) + '\n' + JSON.stringify(tripping) + '\n');
    const entries = doctrine.loadDoctrine({
      noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT,
      gitleaksBin: GITLEAKS_BIN, gitleaksConfig: cfg,
    });
    assert.ok(entries.some((e) => e.id === 'screen-clean'), 'clean entry kept');
    assert.ok(!entries.some((e) => e.id === 'screen-tripping'), 'entry whose advisory trips the screen is dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forbidden-string screen is FAIL-SOFT when gitleaks is absent (entry retained, no throw)', () => {
  const dir = tmpDir('doctrine-failsoft-');
  try {
    const overlay = path.join(dir, 'registry.local.jsonl');
    const tripping = validEntry({ id: 'failsoft-tripping', advisory: { one_line: `would-trip ${SENTINEL}`, procedure_path: 'docs/x.md', cooldown_hours: 1 } });
    fs.writeFileSync(overlay, JSON.stringify(tripping) + '\n');
    let entries;
    assert.doesNotThrow(() => {
      entries = doctrine.loadDoctrine({
        noCache: true, claudeOverlay: overlay, termdeckOverlayDir: ABSENT,
        gitleaksBin: '/nonexistent/path/to/gitleaks',
      });
    });
    // gitleaks absent ⇒ unscreened ⇒ entry retained (fail-soft, not fail-closed)
    assert.ok(entries.some((e) => e.id === 'failsoft-tripping'), 'gitleaks-absent ⇒ entry passes unscreened (fail-soft)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audience filter: Brad-baked (audience:all) excludes operator-only entries', () => {
  const all = doctrine.loadDoctrine({ noCache: true, claudeOverlay: ABSENT, termdeckOverlayDir: ABSENT, audience: 'all' });
  assert.ok(all.every((e) => e.audience === 'all'), 'audience filter keeps only audience:all');
  assert.ok(!all.some((e) => e.id === 'forbidden-string-scrub'), 'operator-local scrub stub excluded from Brad-baked copy');
  assert.ok(!all.some((e) => e.id === 'session-end-email'), 'operator-only entry excluded');
});

test('T-ERR event filter returns the regex error-advisory entries (closes the advisor-can-fire gap)', () => {
  const terr = doctrine.loadDoctrine({ noCache: true, claudeOverlay: ABSENT, termdeckOverlayDir: ABSENT, event: 'T-ERR', audience: 'all' });
  assert.ok(terr.length >= 5, `at least 5 T-ERR entries (got ${terr.length})`);
  // every returned entry is a compiled regex (so the advisor can match error text)
  for (const e of terr) {
    assert.ok(e._checkRegex instanceof RegExp, `${e.id} has a compiled regex`);
  }
  // realistic error text matches the right entry
  const pushErr = terr.find((e) => e.id === 'err-git-push-rejected');
  assert.ok(pushErr && pushErr._checkRegex.test('error: failed to push some refs (non-fast-forward)'), 'push-rejected regex matches a real error');
  // phase/lifecycle rules are NOT in the T-ERR set (won't spam on errors)
  assert.ok(!terr.some((e) => e.id === 'publish-before-push'), 'lifecycle rule excluded from T-ERR set');
});

test('the operator-local scrub stub carries NO pattern text (only references the overlay)', () => {
  const entries = doctrine.loadDoctrine({ noCache: true, claudeOverlay: ABSENT, termdeckOverlayDir: ABSENT });
  const stub = entries.find((e) => e.id === 'forbidden-string-scrub');
  assert.ok(stub, 'scrub stub present in repo registry');
  assert.equal(stub.scope, 'operator-local', 'scrub stub is operator-local scope');
  assert.ok(!stub.check || stub.check.pattern == null, 'scrub stub has NO check.pattern (pattern lives in the never-shipped overlay)');
});

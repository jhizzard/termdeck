// Sprint 83 T3 — vendored problem_signature core: parity with engram.
//
// ORCH ruling 2026-07-31 14:47 ET: ONE implementation of the normalizer,
// authored in engram, vendored byte-identically here. This test is the
// enforcement half of that ruling.
//
// WHY IT MATTERS. Three consumers must agree on `symptom_hash` byte-for-byte:
// mnestra's write side stamps it, the recall-side expansion matches on it, and
// this server hashes the live error line to look it up. If any of them drifts,
// NOTHING ERRORS — the hashes simply stop colliding and the lookup returns
// nothing, forever. A dead feature that looks alive is strictly worse than one
// that throws, so drift has to be caught by a test or it is not caught at all.
//
// PARITY IS PROVEN TWICE, on purpose:
//
//   1. BYTES — this copy is diffed against the engram original. Skipped, not
//      failed, when the engram checkout is absent: an external user running
//      `npm test` on @jhizzard/termdeck has no second repo on disk, and a
//      test that fails for them is a false alarm about their install.
//   2. BEHAVIOR — the shared golden vectors run against this copy. This is
//      what keeps the skip in (1) honest: in a checkout where the byte-diff
//      cannot run, parity is still asserted against real expected values
//      rather than assumed.
//
// Run: node --test packages/server/tests/problem-signature-vendor.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VENDORED = path.join(__dirname, '..', 'src', 'vendor', 'problem_signature_core.cjs');
const VENDORED_FIXTURE = path.join(__dirname, 'fixtures', 'problem-signature-vectors.json');

// The engram checkout, when this machine has one. Both the env override and
// the conventional path are tried before giving up.
const ENGRAM_ROOT = process.env.ENGRAM_ROOT
  || path.join(os.homedir(), 'Documents', 'Graciella', 'engram');
const UPSTREAM = path.join(ENGRAM_ROOT, 'src', 'problem_signature_core.cjs');
const UPSTREAM_FIXTURE = path.join(ENGRAM_ROOT, 'tests', 'fixtures', 'problem-signature-vectors.json');

const core = require('../src/vendor/problem_signature_core.cjs');
const fixture = JSON.parse(fs.readFileSync(VENDORED_FIXTURE, 'utf8'));

// ── 1. bytes ───────────────────────────────────────────────────────────────

test('vendored normalizer is byte-identical to the engram original', (t) => {
  if (!fs.existsSync(UPSTREAM)) {
    t.skip(`engram checkout not present at ${ENGRAM_ROOT} — behavior parity is covered by the golden vectors below`);
    return;
  }
  const mine = fs.readFileSync(VENDORED);
  const theirs = fs.readFileSync(UPSTREAM);
  assert.ok(
    mine.equals(theirs),
    `vendored copy has drifted from ${UPSTREAM}. Do NOT edit the vendored file — fix the upstream original and re-copy (see packages/server/src/vendor/README.md).`,
  );
});

test('vendored golden vectors are byte-identical to the engram fixture', (t) => {
  if (!fs.existsSync(UPSTREAM_FIXTURE)) {
    t.skip('engram fixture not present — vectors still run against the vendored copy below');
    return;
  }
  const mine = fs.readFileSync(VENDORED_FIXTURE);
  const theirs = fs.readFileSync(UPSTREAM_FIXTURE);
  assert.ok(mine.equals(theirs), 'the golden-vector fixture has drifted from engram\'s copy');
});

// ── 2. behavior ────────────────────────────────────────────────────────────

test('golden vectors: raw → normalized → symptom_hash → class', () => {
  assert.ok(fixture.vectors.length >= 10, 'fixture should cover a real spread of cases');
  for (const v of fixture.vectors) {
    const line = core.pickSymptomLine(v.raw);
    const normalized = core.normalizeSymptom(line);
    assert.equal(normalized, v.normalized, `normalized drift: ${v.name}`);
    assert.equal(core.symptomHash(normalized), v.symptom_hash, `HASH DRIFT: ${v.name} — the vendored copy no longer agrees with the write side`);
    const cls = core.classifyProblem(line) || core.freeClass(normalized);
    assert.equal(cls, v.class, `class drift: ${v.name}`);
  }
});

test('the read-side lookup key reproduces the same hash the write side stores', () => {
  // `problemLookupKey` is the entry point graph-expansion uses on the live
  // error line. If it disagreed with `normalizeSymptom`+`symptomHash`, the
  // read side would look up keys the write side never wrote.
  for (const v of fixture.vectors) {
    const key = core.problemLookupKey(v.raw);
    assert.ok(key, `lookup key should exist for: ${v.name}`);
    assert.equal(key.symptom_hash, v.symptom_hash, `lookup-key hash drift: ${v.name}`);
    assert.equal(key.class, v.class, `lookup-key class drift: ${v.name}`);
  }
});

test('signature version matches the fixture — a bump invalidates every stored hash', () => {
  assert.equal(
    core.PROBLEM_SIGNATURE_VERSION,
    fixture.signature_version,
    'PROBLEM_SIGNATURE_VERSION and the fixture disagree: stored hashes and freshly computed ones would silently stop matching',
  );
});

test('lookup key is null for input with no usable symptom, never a bogus hash', () => {
  for (const empty of ['', '   ', '\n\n', null, undefined]) {
    assert.equal(core.problemLookupKey(empty), null);
  }
});

test('the normalizer redacts secret shapes before hashing', () => {
  // `symptom` is stored, recalled, and exported to disk in the Obsidian vault.
  // A redaction miss here is durable, not transient.
  const withSecret = 'auth failed for sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const normalized = core.normalizeSymptom(core.pickSymptomLine(withSecret));
  assert.ok(!normalized.includes('sk-abcdefghijklmnopqrstuvwxyz'), `secret survived normalization: ${normalized}`);
});

// Sprint 78 T1 — stack-installer doctrine registry vendoring.
//
// The load-bearing test is the FULL-FILE-STAMP regression guard: a drift that
// sits PAST the first 4KB must still trigger a refresh. The legacy
// `_readHookSignatureVersion` (slice(0,4096)) would miss exactly that and
// mis-grade the file as current — the Sprint 51.6 failure this avoids by
// construction. We assert _doctrineRefreshNeeded catches a >4KB-offset drift.
//
// All cases drive installDoctrineRegistry with explicit sourcePath/destPath in
// a tempdir — no HOME mutation, no live filesystem dependence.
//
// Run: node --test packages/stack-installer/tests/doctrine-vendor.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installer = require('../src/index.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doctrine-vendor-')); }

test('FULL-FILE stamp: a drift PAST the first 4KB is detected (4KB-head regression guard)', () => {
  const dir = tmpDir();
  try {
    const head = 'A'.repeat(4096); // identical first 4KB in both files
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, head + 'TAIL-VERSION-ONE\n');
    fs.writeFileSync(b, head + 'TAIL-VERSION-TWO\n');
    // A 4KB-head compare would call these identical. Full-file hashing must not.
    assert.notEqual(installer._fileSha256(a), installer._fileSha256(b), 'full-file hashes differ on a >4KB-offset change');
    assert.equal(installer._doctrineRefreshNeeded(a, b), true, 'refresh needed when content differs past 4KB');
    assert.equal(installer._doctrineRefreshNeeded(a, a), false, 'no refresh when identical');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDoctrineRegistry copies to a missing dest and locks it read-only', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'src.jsonl');
    const dest = path.join(dir, 'sub', 'registry.shipped.jsonl');
    fs.writeFileSync(src, '{"id":"x","audience":"all","status":"active"}\n');
    const r = installer.installDoctrineRegistry({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'refreshed');
    assert.ok(fs.existsSync(dest), 'dest written');
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'), 'content copied verbatim');
    const mode = fs.statSync(dest).mode;
    assert.equal(mode & 0o222, 0, 'dest is read-only (no write bits)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDoctrineRegistry is idempotent — second call is already-current', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'src.jsonl');
    const dest = path.join(dir, 'registry.shipped.jsonl');
    fs.writeFileSync(src, 'content\n');
    assert.equal(installer.installDoctrineRegistry({ sourcePath: src, destPath: dest }).status, 'refreshed');
    assert.equal(installer.installDoctrineRegistry({ sourcePath: src, destPath: dest }).status, 'already-current');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDoctrineRegistry refreshes a drifted READ-ONLY dest (chmod-then-overwrite-then-relock)', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'src.jsonl');
    const dest = path.join(dir, 'registry.shipped.jsonl');
    fs.writeFileSync(src, 'NEW bundled content\n');
    // simulate a prior read-only install with stale content
    fs.writeFileSync(dest, 'OLD stale content\n');
    fs.chmodSync(dest, 0o444);
    const r = installer.installDoctrineRegistry({ sourcePath: src, destPath: dest });
    assert.equal(r.status, 'refreshed', 'drifted read-only dest is refreshed, not blocked by 0o444');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'NEW bundled content\n');
    assert.equal(fs.statSync(dest).mode & 0o222, 0, 're-locked read-only after refresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDoctrineRegistry dry-run does not write', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'src.jsonl');
    const dest = path.join(dir, 'registry.shipped.jsonl');
    fs.writeFileSync(src, 'content\n');
    const r = installer.installDoctrineRegistry({ sourcePath: src, destPath: dest, dryRun: true });
    assert.equal(r.status, 'would-refresh');
    assert.equal(fs.existsSync(dest), false, 'dry-run wrote nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installDoctrineRegistry is fail-soft when the bundled asset is missing (no throw)', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'does-not-exist.jsonl');
    const dest = path.join(dir, 'registry.shipped.jsonl');
    let r;
    assert.doesNotThrow(() => { r = installer.installDoctrineRegistry({ sourcePath: src, destPath: dest }); });
    assert.equal(r.status, 'no-bundled-asset');
    assert.equal(fs.existsSync(dest), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bundled doctrine asset exists and contains ONLY audience:all + active entries (Brad-safe)', () => {
  const src = installer.DOCTRINE_SHIPPED_SOURCE;
  assert.ok(fs.existsSync(src), `bundled doctrine asset present at ${src}`);
  const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  assert.ok(lines.length >= 9, `baked asset has entries (got ${lines.length})`);
  for (const line of lines) {
    const o = JSON.parse(line);
    assert.equal(o.audience, 'all', `baked entry '${o.id}' must be audience:all (no operator-only content reaches Brad)`);
    assert.equal(o.status, 'active', `baked entry '${o.id}' must be active`);
    assert.notEqual(o.scope, 'operator-local', `baked asset must not carry the operator-local stub ('${o.id}')`);
  }
});

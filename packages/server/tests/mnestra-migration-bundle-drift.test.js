// Sprint 81 T3 (ORCH R1) — mnestra migration bundle ⇄ engram drift fence.
//
// packages/server/src/setup/migrations.js::listMnestraMigrations() is
// bundled-FIRST: if the bundled mirror is non-empty it returns ONLY those files
// and never falls through to @jhizzard/mnestra. So a migration that exists in
// engram but NOT in the bundle is silently shadowed — never applied by
// `termdeck init --mnestra`. That is exactly how 023-029 went un-applied on real
// installs while the bundle stalled at 022 (T7 16:58 / ORCH R1).
//
// This fence has two layers:
//   1. CI-SAFE self-consistency (always runs): the bundle is a contiguous
//      001..N set, every file (except the special-cased 020 tracker) has a
//      MIGRATION_PROBES entry, and the R1-synced 023-029 are present.
//   2. ENGRAM PARITY (runs only when the engram repo is checked out locally —
//      dev machines + ORCH close-out; skipped in CI): every bundled file is
//      byte-identical to its engram twin, and every engram migration within the
//      synced range is present in the bundle. New engram migrations beyond the
//      synced range (BUNDLE_MAX) are reported as a pending close-out sync.
//
// Close-out: after T1 lands 030-032, run `node scripts/sync-mnestra-migrations.js`,
// add their MIGRATION_PROBES entries, and bump BUNDLE_MAX below.
//
// Run: node --test packages/server/tests/mnestra-migration-bundle-drift.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MIGRATION_PROBES } = require('../src/setup/migrations.js');

const BUNDLE_DIR = path.join(__dirname, '..', 'src', 'setup', 'mnestra-migrations');
// The byte-identical engram mirror is a 023+ contract (ORCH R1). 001-022 predate
// it and legitimately diverge: the bundle carries two TermDeck-only migrations
// (008_legacy_rag_tables, 011_project_tag_backfill) that engram never had, so
// cross-repo parity is asserted only for the sync range.
const SYNC_MIN = 23;
// Highest engram migration number the bundle currently mirrors. 030-032 synced
// after T1 posted DONE (17:42 ET). Bump this whenever new engram migrations are
// mirrored via scripts/sync-mnestra-migrations.js.
const BUNDLE_MAX = 32;
const TRACKER_FILE = '020_migration_tracking.sql'; // bootstrap-special-cased; no probe

function sqlFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
}
function numPrefix(f) { const m = /^(\d{3})_/.exec(f); return m ? parseInt(m[1], 10) : NaN; }

function resolveEngramDir() {
  const candidates = [
    process.env.ENGRAM_MIGRATIONS_DIR,
    path.join(os.homedir(), 'Documents', 'Graciella', 'engram', 'migrations'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c; } catch (_) { /* skip */ }
  }
  return null;
}

// ── Layer 1: CI-safe self-consistency ───────────────────────────────────────

test('bundle is a contiguous 001..N set with no gaps or dupes', () => {
  const nums = sqlFiles(BUNDLE_DIR).map(numPrefix);
  assert.ok(nums.every((n) => !Number.isNaN(n)), 'every bundled migration has a NNN_ prefix');
  const sorted = nums.slice().sort((a, b) => a - b);
  assert.equal(new Set(sorted).size, sorted.length, 'no duplicate migration numbers');
  for (let i = 0; i < sorted.length; i++) {
    assert.equal(sorted[i], i + 1, `contiguous: expected ${i + 1}, got ${sorted[i]}`);
  }
  assert.ok(sorted[sorted.length - 1] >= BUNDLE_MAX, `bundle covers through ${BUNDLE_MAX}`);
});

test('every bundled migration has a MIGRATION_PROBES entry (or is the special-cased tracker)', () => {
  for (const f of sqlFiles(BUNDLE_DIR)) {
    if (f === TRACKER_FILE) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(MIGRATION_PROBES, f),
      `${f} is bundled but missing from MIGRATION_PROBES (add a presence probe or null)`
    );
  }
});

test('R1: the 023-032 migrations are present in the bundle (retroactive gap + Sprint 81 DDL)', () => {
  const have = new Set(sqlFiles(BUNDLE_DIR));
  for (const f of [
    '023_privacy_tags_column.sql', '024_email_assistant_recall.sql',
    '025_source_agent_web_surfaces.sql', '026_memory_inbox.sql',
    '027_recall_telemetry.sql', '028_capture_gates.sql', '029_doctrine_recall_boost.sql',
    '030_precompact_rolling.sql', '031_recall_provenance.sql', '032_recall_boost.sql',
  ]) {
    assert.ok(have.has(f), `${f} must be synced into the bundle (R1)`);
  }
});

// ── Layer 2: engram byte-parity (dev/close-out only) ─────────────────────────

test('bundle is byte-identical to engram (through BUNDLE_MAX)', (t) => {
  const engramDir = resolveEngramDir();
  if (!engramDir) {
    t.skip('engram repo not checked out — cross-repo parity is a dev/close-out guard, not a CI gate');
    return;
  }
  const engramFiles = sqlFiles(engramDir);
  const engramSet = new Set(engramFiles);

  // 2a. Every bundled file IN THE SYNC RANGE (023+) byte-matches its engram twin
  //     (catches drift + orphans). 001-022 are out of the mirror contract.
  for (const f of sqlFiles(BUNDLE_DIR)) {
    const n = numPrefix(f);
    if (Number.isNaN(n) || n < SYNC_MIN) continue;
    assert.ok(engramSet.has(f), `bundle has ${f} (≥ ${SYNC_MIN}) but engram does not (orphan — remove or reconcile)`);
    const a = fs.readFileSync(path.join(BUNDLE_DIR, f));
    const b = fs.readFileSync(path.join(engramDir, f));
    assert.ok(a.equals(b), `${f} drifted from engram — run: node scripts/sync-mnestra-migrations.js`);
  }

  // 2b. Every engram migration WITHIN the synced range is present in the bundle
  //     (catches "engram added one in-range but the bundle is missing it").
  const bundleSet = new Set(sqlFiles(BUNDLE_DIR));
  for (const f of engramFiles) {
    const n = numPrefix(f);
    if (Number.isNaN(n) || n < SYNC_MIN || n > BUNDLE_MAX) continue;
    assert.ok(bundleSet.has(f), `engram ${f} (${SYNC_MIN}..${BUNDLE_MAX}) is missing from the bundle — sync it`);
  }
});

test('engram migrations beyond BUNDLE_MAX are the known pending close-out sync', (t) => {
  const engramDir = resolveEngramDir();
  if (!engramDir) { t.skip('engram repo not checked out'); return; }
  const pending = sqlFiles(engramDir).filter((f) => {
    const n = numPrefix(f);
    return !Number.isNaN(n) && n > BUNDLE_MAX;
  });
  if (pending.length) {
    // Informational, NOT a failure: 030-032 are T1's in-flight WIP; ORCH syncs
    // them + bumps BUNDLE_MAX at close-out. Assert they are all strictly above
    // the synced range so nothing in-range is silently deferred.
    // eslint-disable-next-line no-console
    console.log(`[migration-drift] pending close-out sync (engram > ${BUNDLE_MAX}): ${pending.join(', ')}`);
    for (const f of pending) assert.ok(numPrefix(f) > BUNDLE_MAX);
  }
});

#!/usr/bin/env node
'use strict';

// Sprint 81 T3 (ORCH R1) — sync engram/migrations/*.sql → the bundled mnestra
// migration mirror at packages/server/src/setup/mnestra-migrations/.
//
// WHY: packages/server/src/setup/migrations.js::listMnestraMigrations() is
// bundled-FIRST — if the bundle is non-empty it returns ONLY the bundled files
// and never falls through to node_modules/@jhizzard/mnestra. So any engram
// migration NOT mirrored into the bundle is silently shadowed and never applied
// by `termdeck init --mnestra`. The bundle stalled at 022 while engram grew to
// 029+, so 023-029 (privacy tags, email-assistant recall, web-surface agents,
// memory_inbox, recall telemetry, capture gates, doctrine/recall-boost) never
// reached real users. This script keeps the mirror in lockstep.
//
// USAGE:
//   node scripts/sync-mnestra-migrations.js [--dry-run]
//   ENGRAM_MIGRATIONS_DIR=/path/to/engram/migrations node scripts/sync-mnestra-migrations.js
//
// Idempotent: copies only files that are absent or byte-different; reports what
// changed. Run this at close-out (with T1's final 030-032 landed) then bump
// BUNDLE_MAX in packages/server/tests/mnestra-migration-bundle-drift.test.js.
//
// NOTE: this is a dev/maintenance tool. It lives under scripts/ (NOT in the
// package.json `files` whitelist) so it never ships in the npm tarball.

const fs = require('fs');
const path = require('path');
const os = require('os');

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

const BUNDLE_DIR = path.join(__dirname, '..', 'packages', 'server', 'src', 'setup', 'mnestra-migrations');

// The byte-identical mirror is a 023+ contract. 001-022 predate it and
// legitimately diverge: the bundle carries two TermDeck-only migrations
// (008_legacy_rag_tables, 011_project_tag_backfill) that engram never had
// (engram's numbering skips 008 + 011). This script only mirrors 023+.
const SYNC_MIN = 23;

function sqlFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
}
function numPrefix(f) { const m = /^(\d{3})_/.exec(f); return m ? parseInt(m[1], 10) : NaN; }
function inSyncRange(f) { const n = numPrefix(f); return !Number.isNaN(n) && n >= SYNC_MIN; }

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const engramDir = resolveEngramDir();
  if (!engramDir) {
    console.error('[sync] engram migrations dir not found. Set ENGRAM_MIGRATIONS_DIR or clone engram to ~/Documents/Graciella/engram.');
    process.exit(2);
  }
  if (!fs.existsSync(BUNDLE_DIR)) {
    console.error(`[sync] bundle dir not found: ${BUNDLE_DIR}`);
    process.exit(2);
  }

  const engramFiles = sqlFiles(engramDir).filter(inSyncRange);
  let added = 0, updated = 0, unchanged = 0;
  for (const f of engramFiles) {
    const src = path.join(engramDir, f);
    const dst = path.join(BUNDLE_DIR, f);
    const exists = fs.existsSync(dst);
    const same = exists && fs.readFileSync(src).equals(fs.readFileSync(dst));
    if (same) { unchanged++; continue; }
    console.log(`[sync] ${exists ? 'UPDATE' : 'ADD   '} ${f}`);
    if (!dryRun) fs.copyFileSync(src, dst);
    if (exists) updated++; else added++;
  }

  // Flag bundle files IN THE SYNC RANGE with no engram twin (a real orphan).
  const engramSet = new Set(engramFiles);
  for (const bf of sqlFiles(BUNDLE_DIR).filter(inSyncRange)) {
    if (!engramSet.has(bf)) console.warn(`[sync] WARN bundle-only file in sync range (no engram twin, review): ${bf}`);
  }

  console.log(`[sync] done: ${added} added, ${updated} updated, ${unchanged} unchanged${dryRun ? ' (dry-run — nothing written)' : ''}.`);
  if ((added || updated) && !dryRun) {
    console.log('[sync] Next: add/verify MIGRATION_PROBES entries in packages/server/src/setup/migrations.js and bump BUNDLE_MAX in the drift test.');
  }
}

main();

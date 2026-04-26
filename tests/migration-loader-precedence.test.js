// Regression tests for migration-source precedence in
// packages/server/src/setup/migrations.js (v0.6.8 candidate).
//
// Background — Brad's 2026-04-26 12:47 PM report: he upgraded TermDeck to
// v0.6.5 (which bundles a new migration 007_add_source_session_id.sql to
// fix the Mnestra/Rumen schema drift), ran `termdeck init --mnestra --yes`,
// got "6 migrations all applied cleanly," and the column was still missing.
//
// Root cause: the loader preferred `node_modules/@jhizzard/mnestra/
// migrations/*.sql` over the bundled directory. Brad's global mnestra was
// stuck at 0.2.1 (only 6 migrations) because `npm i -g @jhizzard/termdeck`
// doesn't touch the sibling `@jhizzard/mnestra` install. The bundled 007
// was never seen.
//
// v0.6.8 flips the precedence: bundled FIRST, node_modules as a fallback
// only when the bundled directory is empty. These fixtures pin that
// guarantee — if they had existed before v0.6.5, they would have caught
// the stale-shadow bug at test time.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

// Force a fresh require of the loader so module-level cache (notably the
// SETUP_DIR constant) reflects the per-test state we want.
function loadMigrations() {
  const id = require.resolve(path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'migrations.js'));
  delete require.cache[id];
  return require(id);
}

// Walk the actual bundled directory once to ground our assertions in
// real-on-disk state. If 007 ever gets removed accidentally, these tests
// will fail loudly.
const BUNDLED_DIR = path.join(repoRoot, 'packages', 'server', 'src', 'setup', 'mnestra-migrations');

test('bundled migration directory contains all expected files including 007', () => {
  // This is the lowest-level guard: if the bundled file goes missing for
  // any reason — accidental rm, .gitignore mistake, files-glob in
  // package.json drops it — this fails before anything else.
  const files = fs.readdirSync(BUNDLED_DIR).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files, [
    '001_mnestra_tables.sql',
    '002_mnestra_search_function.sql',
    '003_mnestra_event_webhook.sql',
    '004_mnestra_match_count_cap_and_explain.sql',
    '005_v0_1_to_v0_2_upgrade.sql',
    '006_memory_status_rpc.sql',
    '007_add_source_session_id.sql'
  ]);
});

test('listMnestraMigrations() returns 7 files in lexical order', () => {
  const m = loadMigrations();
  const list = m.listMnestraMigrations();
  assert.equal(list.length, 7, 'expected 7 mnestra migrations from v0.6.5+');
  const basenames = list.map((p) => path.basename(p));
  // Lexical order is what the SQL runner relies on — pin it.
  assert.deepEqual(basenames, [
    '001_mnestra_tables.sql',
    '002_mnestra_search_function.sql',
    '003_mnestra_event_webhook.sql',
    '004_mnestra_match_count_cap_and_explain.sql',
    '005_v0_1_to_v0_2_upgrade.sql',
    '006_memory_status_rpc.sql',
    '007_add_source_session_id.sql'
  ]);
});

test('listMnestraMigrations() resolves files inside the bundled directory, not node_modules', () => {
  // Pinning that bundled is preferred — the file paths returned should
  // start under packages/server/src/setup/mnestra-migrations/ regardless
  // of whether @jhizzard/mnestra is installed locally.
  const m = loadMigrations();
  const list = m.listMnestraMigrations();
  assert.ok(list.length > 0);
  for (const p of list) {
    assert.ok(
      p.includes(path.join('packages', 'server', 'src', 'setup', 'mnestra-migrations')),
      `migration path should be under bundled dir, got: ${p}`
    );
  }
});

// ── Brad's exact scenario: stale @jhizzard/mnestra in node_modules ──────────

test('listMnestraMigrations() prefers bundled even when a stale @jhizzard/mnestra is shadowing in node_modules', () => {
  // Simulate Brad's env: a fake @jhizzard/mnestra installed somewhere on
  // the require resolution path with only 6 migrations. The loader's old
  // behavior would have returned 6; the new behavior returns 7.
  const fakePkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-mnestra-'));
  const fakeNm = path.join(fakePkgRoot, 'node_modules', '@jhizzard', 'mnestra');
  fs.mkdirSync(path.join(fakeNm, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(fakeNm, 'package.json'), JSON.stringify({
    name: '@jhizzard/mnestra',
    version: '0.2.1',
    files: ['migrations']
  }, null, 2));
  // Six bogus migrations — same names as Mnestra 0.2.1 had.
  for (const f of [
    '001_mnestra_tables.sql',
    '002_mnestra_search_function.sql',
    '003_mnestra_event_webhook.sql',
    '004_mnestra_match_count_cap_and_explain.sql',
    '005_v0_1_to_v0_2_upgrade.sql',
    '006_memory_status_rpc.sql'
  ]) {
    fs.writeFileSync(path.join(fakeNm, 'migrations', f), '-- stale stub');
  }

  // Override require resolution to find the fake first by setting
  // NODE_PATH and re-requiring. Easier: wrap the loader call inside a
  // process.cwd swap so tryNodeModules' `paths: [process.cwd(), ...]`
  // resolves the fake.
  const realCwd = process.cwd();
  process.chdir(fakePkgRoot);
  try {
    const m = loadMigrations();
    const list = m.listMnestraMigrations();

    // Sanity: confirm the fake IS resolvable from this cwd. If it isn't,
    // this test is degenerate (passing for the wrong reason) — skip it.
    let fakeReachable = false;
    try {
      require.resolve('@jhizzard/mnestra/package.json', { paths: [process.cwd()] });
      fakeReachable = true;
    } catch (_e) { /* fake not reachable; the tryNodeModules path won't resolve either */ }

    assert.equal(list.length, 7, fakeReachable
      ? 'bundled (7) must win over a stale node_modules @jhizzard/mnestra (6)'
      : 'bundled fallback must still return 7 even when no @jhizzard/mnestra is reachable');
    // And the resolved paths must be the bundled ones, not the fake's.
    for (const p of list) {
      assert.ok(
        !p.startsWith(fakePkgRoot),
        `migration came from stale fake: ${p}`
      );
    }
  } finally {
    process.chdir(realCwd);
    fs.rmSync(fakePkgRoot, { recursive: true, force: true });
  }
});

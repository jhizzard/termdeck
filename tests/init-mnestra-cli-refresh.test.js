// Sprint 51.7 T1 — CLI-binary integration test for the wizard wire-up fix.
//
// Closes the test gap that allowed Sprint 51.6 Phase B (v1.0.2) to ship a
// hook refresh that worked in unit tests (tests/init-mnestra-hook-refresh
// .test.js calls refreshBundledHookIfNewer() directly) but did NOT fire
// when invoked via the actual `termdeck init --mnestra` user path.
//
// Root cause that escaped unit tests: refreshBundledHookIfNewer() was
// reachable only when every preceding DB step succeeded — pgRunner.connect,
// checkExistingStore, applyMigrations (replays 17 migrations), runMnestraAudit,
// writeYamlConfig. Joshua's 2026-05-03 Phase B run threw at
// applyMigrations() → 001_mnestra_tables.sql (`match_memories` return-type
// drift on petvetbid). The outer catch returned exit 5 and the refresh at
// the old call site (line 677 in v1.0.2) was never reached. Brad's
// jizzard-brain reproduced the same symptom under v1.0.2.
//
// Sprint 51.7 T1 fix: moved runHookRefresh() upstream of pg connect + DB
// phase. These tests pin that wire-up by spawning the actual binary path
// and asserting the refresh status reaches stdout AND the hook file
// actually changes (or, in dry-run, that "would-refresh" appears without
// writing).
//
// What "spawning the binary" means here: we drive `node packages/cli/src/
// index.js init --mnestra <flags>` as a child process. Using the source
// entry rather than the published `termdeck` binary keeps the test pinned
// to the in-tree wire-up — a future regression (e.g. someone adds a new
// gate before runHookRefresh) would fail this test even if the published
// global hasn't been re-published yet.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.js');
const BUNDLED_HOOK = path.join(REPO_ROOT, 'packages', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js');

// Stale-shape fixture matching Joshua's actual `.bak.20260504011632`:
// TermDeck-marked (so looksTermdeckManaged() returns true and the safety
// gate qualifies the hook for auto-overwrite) but unsigned (no v stamp).
// This is the exact failure shape Sprint 51.6 Phase B encountered.
const STALE_HOOK_BODY = [
  '#!/usr/bin/env node',
  '/**',
  ' * TermDeck session-end memory hook (legacy, pre-stamp era).',
  ' * Vendored into ~/.claude/hooks/memory-session-end.js by @jhizzard/termdeck-stack.',
  ' */',
  "'use strict';",
  "console.error('stale-fixture-hook');",
  '',
].join('\n');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-cli-refresh-'));
}

function seedStaleHook(home) {
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  fs.writeFileSync(hookPath, STALE_HOOK_BODY, 'utf-8');
  return hookPath;
}

// Spawn `node CLI init --mnestra <args>` against the given HOME, capture
// merged stdout+stderr. Strips inherited Mnestra/Supabase secrets so the
// host's real credentials never leak into the test child.
function runWizard(home, args, { extraEnv = {}, timeoutMs = 30000 } = {}) {
  const baseEnv = { ...process.env };
  for (const k of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY'
  ]) {
    delete baseEnv[k];
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, 'init', '--mnestra', ...args],
      {
        env: { ...baseEnv, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf-8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf-8'); });
    child.stdin.end();

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_e) { /* gone */ }
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err, merged: out + err });
    });
  });
}

const VALID_ENV = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  // 127.0.0.1:1 is reserved — guaranteed ECONNREFUSED. The DB phase will
  // fail; refresh must already have fired by then.
  DATABASE_URL: 'postgres://postgres:badpw@127.0.0.1:1/postgres',
  OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

// ── 1. The bug-fix proof ───────────────────────────────────────────────────
// Sprint 51.7 T1: hook refresh must fire BEFORE pg connect. Setting an
// unreachable DATABASE_URL guarantees the DB phase fails; if refresh is
// upstream, the hook still gets refreshed and stdout shows the refresh
// status. This is the test that would have caught Sprint 51.6 Phase B.

test('Sprint 51.7 T1 wire-up: refresh fires upstream of pg connect (port-1 ECONNREFUSED)', async () => {
  const home = freshHome();
  const hookPath = seedStaleHook(home);

  const r = await runWizard(home, ['--from-env'], { extraEnv: VALID_ENV });

  // pg connect MUST fail (port 1 ECONNREFUSED) — exit 3.
  assert.equal(r.code, 3, `expected exit 3 (pg connect fail) but got ${r.code}; output:\n${r.merged}`);

  // The refresh status MUST appear in stdout BEFORE the connect failure.
  // This is the wire-up assertion: refresh has to fire even when DB fails.
  assert.match(
    r.merged,
    /Refreshing ~\/\.claude\/hooks\/memory-session-end\.js \(if bundled is newer\)\.\.\. ✓ refreshed v0 → v\d+/,
    'refresh status must appear in stdout (proves wire-up fires before DB connect)'
  );

  // The refresh announcement must come BEFORE "Connecting to Supabase..."
  // — that's the architectural fix. If a regression moves refresh back
  // downstream of connect, this ordering check fails.
  const refreshIdx = r.merged.indexOf('Refreshing ~/.claude/hooks/memory-session-end.js');
  const connectIdx = r.merged.indexOf('Connecting to Supabase');
  assert.ok(refreshIdx > -1, 'refresh announcement missing entirely');
  assert.ok(connectIdx > -1, 'connect announcement missing entirely');
  assert.ok(refreshIdx < connectIdx,
    `refresh must precede connect; refreshIdx=${refreshIdx} connectIdx=${connectIdx}`);

  // The hook file MUST have changed on disk.
  const finalHook = fs.readFileSync(hookPath, 'utf-8');
  assert.ok(
    /@termdeck\/stack-installer-hook v\d/.test(finalHook),
    'installed hook should now carry a version stamp (refresh wrote bundled v1+)'
  );
  assert.notEqual(finalHook, STALE_HOOK_BODY, 'hook content should differ from stale fixture');

  // A timestamped backup MUST exist.
  const hookDir = path.dirname(hookPath);
  const backups = fs.readdirSync(hookDir)
    .filter((f) => /^memory-session-end\.js\.bak\.\d{14}$/.test(f));
  assert.equal(backups.length, 1, `expected 1 backup file; found: ${backups.join(', ') || '<none>'}`);

  // Backup MUST contain the original stale body.
  const backupBody = fs.readFileSync(path.join(hookDir, backups[0]), 'utf-8');
  assert.equal(backupBody, STALE_HOOK_BODY, 'backup must preserve original stale hook body');

  fs.rmSync(home, { recursive: true, force: true });
});

// ── 2. --dry-run now exercises refresh ─────────────────────────────────────
// Pre-Sprint 51.7, --dry-run early-returned BEFORE the refresh call site.
// T4-CODEX 2026-05-04 11:07 ET specifically called this out: "a new
// init-mnestra-cli-refresh.test.js that relies on --dry-run will NOT catch
// the Sprint 51.6 Phase B failure." Now that runHookRefresh() is upstream
// of the dry-run early-return, dry-run truthfully reports what WOULD
// happen on a live run — and reports it without writing.

test('Sprint 51.7 T1 --dry-run: refresh announces "would-refresh" without writing', async () => {
  const home = freshHome();
  const hookPath = seedStaleHook(home);
  const originalBody = fs.readFileSync(hookPath, 'utf-8');

  const r = await runWizard(home, ['--from-env', '--dry-run'], { extraEnv: VALID_ENV });

  // --dry-run completes successfully (exit 0).
  assert.equal(r.code, 0, `expected exit 0 (dry-run success) but got ${r.code}; output:\n${r.merged}`);

  // The refresh status under dry-run MUST be "would-refresh" (no writes).
  assert.match(
    r.merged,
    /Refreshing ~\/\.claude\/hooks\/memory-session-end\.js[^\n]+would-refresh v0 → v\d+ \(dry-run\)/,
    'dry-run must report would-refresh without writing'
  );

  // The hook file MUST be unchanged on disk.
  const finalBody = fs.readFileSync(hookPath, 'utf-8');
  assert.equal(finalBody, originalBody, 'dry-run must NOT mutate the installed hook');

  // No backup file should be created in dry-run mode.
  const hookDir = path.dirname(hookPath);
  const backups = fs.readdirSync(hookDir)
    .filter((f) => /^memory-session-end\.js\.bak\.\d{14}$/.test(f));
  assert.equal(backups.length, 0, 'dry-run must not write a backup');

  fs.rmSync(home, { recursive: true, force: true });
});

// ── 3. Up-to-date case: no spurious refresh on re-run ──────────────────────

test('Sprint 51.7 T1 idempotent: re-running with installed = bundled reports up-to-date', async () => {
  const home = freshHome();
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  // Pre-seed installed hook = bundled hook (byte-identical).
  fs.copyFileSync(BUNDLED_HOOK, hookPath);
  const beforeMtime = fs.statSync(hookPath).mtime.getTime();

  const r = await runWizard(home, ['--from-env'], { extraEnv: VALID_ENV });

  // Connect still fails (port 1). The point of this test is the up-to-date
  // refresh status before the connect.
  assert.equal(r.code, 3);

  assert.match(
    r.merged,
    /Refreshing ~\/\.claude\/hooks\/memory-session-end\.js[^\n]+up-to-date \(v\d+\)/,
    'when installed >= bundled, must report up-to-date'
  );

  // Hook file MUST NOT be touched (content identical, no backup written).
  const afterMtime = fs.statSync(hookPath).mtime.getTime();
  assert.equal(afterMtime, beforeMtime, 'up-to-date case must not rewrite the hook file');
  const backups = fs.readdirSync(hookDir)
    .filter((f) => /^memory-session-end\.js\.bak\.\d{14}$/.test(f));
  assert.equal(backups.length, 0, 'up-to-date case must not write a backup');

  fs.rmSync(home, { recursive: true, force: true });
});

// ── 4. Custom-hook-preserved case: user's own hook stays put ───────────────

test('Sprint 51.7 T1 safety gate: hook with no TermDeck markers is preserved', async () => {
  const home = freshHome();
  const hookDir = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookPath = path.join(hookDir, 'memory-session-end.js');
  const userBody = "// my own session hook, unrelated to TermDeck\nrequire('./my-stuff');\n";
  fs.writeFileSync(hookPath, userBody, 'utf-8');

  const r = await runWizard(home, ['--from-env'], { extraEnv: VALID_ENV });

  assert.equal(r.code, 3);
  assert.match(
    r.merged,
    /Refreshing[^\n]+custom-hook-preserved/,
    'genuinely custom hook must be preserved with explicit status'
  );

  // Body untouched.
  assert.equal(fs.readFileSync(hookPath, 'utf-8'), userBody);

  fs.rmSync(home, { recursive: true, force: true });
});

// ── 5. Debug instrumentation gate ──────────────────────────────────────────

test('Sprint 51.7 T1 TERMDECK_DEBUG_WIREUP=1 emits [wire-up-debug] stderr trace', async () => {
  const home = freshHome();
  seedStaleHook(home);

  const r = await runWizard(home, ['--from-env'], {
    extraEnv: { ...VALID_ENV, TERMDECK_DEBUG_WIREUP: '1' }
  });

  // Stderr (NOT stdout) should carry the [wire-up-debug] trace.
  assert.match(r.err, /\[wire-up-debug\] runHookRefresh entry: dryRun=false/);
  assert.match(r.err, /\[wire-up-debug\] runHookRefresh return: \{"status":"refreshed"/);

  // Stdout must NOT carry the debug noise (so production users don't see it).
  assert.doesNotMatch(r.out, /\[wire-up-debug\]/);

  fs.rmSync(home, { recursive: true, force: true });
});

// ── 6. Default off: debug instrumentation is silent without the env var ────

test('Sprint 51.7 T1 TERMDECK_DEBUG_WIREUP unset: no [wire-up-debug] noise', async () => {
  const home = freshHome();
  seedStaleHook(home);

  const r = await runWizard(home, ['--from-env'], { extraEnv: VALID_ENV });

  // Neither stream should carry the debug trace when env var is unset.
  assert.doesNotMatch(r.merged, /\[wire-up-debug\]/);

  fs.rmSync(home, { recursive: true, force: true });
});

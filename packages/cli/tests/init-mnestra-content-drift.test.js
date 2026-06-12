// Sprint 67 T1 — refreshBundledHookIfNewer content-drift gate regression suite.
//
// Pins the new byte-comparison sub-branch inside the `installed >= bundled`
// early-return at packages/cli/src/init-mnestra.js — see Sprint 67 STATUS.md
// for the full root-cause story. The pre-Sprint-67 gate stopped at stamp
// equality and returned `up-to-date` even when the bundled body had drifted
// within the same v-stamp (Sprints 62/63/64 grew the v2-stamped session-end
// body by ~1020 bytes without bumping; the daily-driver disk sat on the
// Sprint-51.7-era v2 body for ~2 weeks because the gate fired before any
// bytes were compared).
//
// Co-located under packages/cli/tests/ so the suite is picked up by the
// official `npm test` glob at package.json:34 — T4-CODEX Sprint 67 AUDIT-
// CONCERN 09:14 ET flagged that the historical repo-root hook suites are
// excluded from CI; new T1 coverage lands inside the glob.
//
// Run directly: node --test packages/cli/tests/init-mnestra-content-drift.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'packages', 'cli', 'src', 'index.js');
const BUNDLED_SESSION_END = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js'
);
const BUNDLED_PRE_COMPACT = path.join(
  REPO_ROOT, 'packages', 'stack-installer', 'assets', 'hooks', 'memory-pre-compact.js'
);
const initMnestra = require('../src/init-mnestra');
const { refreshBundledHookIfNewer } = initMnestra;

function freshTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'hook-content-drift-'));
}

// TermDeck-managed marker lifted from packages/stack-installer/src/index.js:606-609
// (`TERMDECK_MANAGED_MARKERS`). Any one of these in the head=4KB qualifies the
// installed file for auto-refresh. We embed the canonical SessionEnd marker
// because both `refreshBundledHookIfNewer` and `_looksTermdeckManaged` match
// it case-insensitively.
const TD_MARKER_HEADER = `/**\n * TermDeck session-end memory hook (Mnestra-direct, no rag-system dependency).\n * Vendored into ~/.claude/hooks/memory-session-end.js by @jhizzard/termdeck-stack.\n */\n`;

function writeStamped(filePath, stamp, body, { withMarker = true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const stampLine = ` * @termdeck/stack-installer-hook v${stamp}\n`;
  const head = withMarker ? TD_MARKER_HEADER : '';
  fs.writeFileSync(filePath, `${head}${stampLine}'use strict';\n${body}\n`, 'utf8');
}

// ── 1. stamp-equal + bytes-equal → up-to-date (regression-guard) ────────────

test('stamp-equal + bytes-equal returns up-to-date (no refresh, no backup)', () => {
  const dir = freshTmpDir();
  try {
    const src = path.join(dir, 'bundled', 'h.js');
    const dest = path.join(dir, 'installed', 'h.js');
    writeStamped(src, 2, '// identical body');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    const beforeMtime = fs.statSync(dest).mtime.getTime();

    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });

    assert.equal(r.status, 'up-to-date');
    assert.equal(r.installed, 2);
    assert.equal(r.bundled, 2);
    // Mtime preserved — no write happened.
    assert.equal(fs.statSync(dest).mtime.getTime(), beforeMtime);
    // No backup created.
    const siblings = fs.readdirSync(path.dirname(dest));
    assert.deepEqual(siblings.filter((f) => f.includes('.bak.')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 2. stamp-equal + bytes-differ + TermDeck-managed → refreshed-content-drift ─

test('stamp-equal + bytes-differ + TermDeck-managed refreshes with backup containing old body', () => {
  const dir = freshTmpDir();
  try {
    const src = path.join(dir, 'bundled', 'h.js');
    const dest = path.join(dir, 'installed', 'h.js');
    writeStamped(src, 2, '// bundled NEW body — Sprint 64 content additions');
    writeStamped(dest, 2, '// installed OLD body — Sprint 51.7 content');

    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });

    assert.equal(r.status, 'refreshed-content-drift');
    assert.equal(r.from, 2);
    assert.equal(r.to, 2);
    assert.match(r.backup, /\.bak\.\d{14}$/);
    // Disk content now matches bundled.
    assert.equal(fs.readFileSync(dest, 'utf8'), fs.readFileSync(src, 'utf8'));
    // Backup preserves the OLD body.
    assert.match(fs.readFileSync(r.backup, 'utf8'), /Sprint 51\.7 content/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 3. stamp-equal + bytes-differ + NOT TermDeck-managed → preserved ───────

test('stamp-equal + bytes-differ + no TermDeck markers preserves custom hook', () => {
  const dir = freshTmpDir();
  try {
    const src = path.join(dir, 'bundled', 'h.js');
    const dest = path.join(dir, 'installed', 'h.js');
    writeStamped(src, 2, '// bundled body');
    // Installed has the v2 stamp but no TermDeck-managed marker headers —
    // safety gate must preserve it as a user-custom hook.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(
      dest,
      `// my own session hook, just happens to carry the same stamp\n * @termdeck/stack-installer-hook v2\nrequire('./my-stuff');\n`,
      'utf8'
    );
    const beforeBody = fs.readFileSync(dest, 'utf8');

    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest });

    assert.equal(r.status, 'custom-hook-preserved-content-drift');
    assert.equal(r.installed, 2);
    assert.equal(r.bundled, 2);
    // Body untouched.
    assert.equal(fs.readFileSync(dest, 'utf8'), beforeBody);
    // No backup.
    const siblings = fs.readdirSync(path.dirname(dest));
    assert.deepEqual(siblings.filter((f) => f.includes('.bak.')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 4. dry-run does not write ──────────────────────────────────────────────

test('dry-run reports would-refresh-content-drift without writing', () => {
  const dir = freshTmpDir();
  try {
    const src = path.join(dir, 'bundled', 'h.js');
    const dest = path.join(dir, 'installed', 'h.js');
    writeStamped(src, 2, '// bundled NEW body');
    writeStamped(dest, 2, '// installed OLD body');
    const beforeBody = fs.readFileSync(dest, 'utf8');

    const r = refreshBundledHookIfNewer({ sourcePath: src, destPath: dest, dryRun: true });

    assert.equal(r.status, 'would-refresh-content-drift');
    assert.equal(r.from, 2);
    assert.equal(r.to, 2);
    // Body NOT overwritten.
    assert.equal(fs.readFileSync(dest, 'utf8'), beforeBody);
    // No backup written.
    const siblings = fs.readdirSync(path.dirname(dest));
    assert.deepEqual(siblings.filter((f) => f.includes('.bak.')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 5. lockstep refresh of both hooks ──────────────────────────────────────

test('both session-end and pre-compact refresh as a unit when both have content drift', () => {
  const dir = freshTmpDir();
  try {
    // Session-end: v2 stamp on both sides, drift in body.
    const seSrc = path.join(dir, 'bundled', 'memory-session-end.js');
    const seDest = path.join(dir, 'installed', 'memory-session-end.js');
    writeStamped(seSrc, 2, '// session-end NEW body');
    writeStamped(seDest, 2, '// session-end OLD body');

    // Pre-compact: v1 stamp on both sides, drift in body.
    const pcSrc = path.join(dir, 'bundled', 'memory-pre-compact.js');
    const pcDest = path.join(dir, 'installed', 'memory-pre-compact.js');
    writeStamped(pcSrc, 1, '// pre-compact NEW body');
    writeStamped(pcDest, 1, '// pre-compact OLD body');

    const rSe = refreshBundledHookIfNewer({ sourcePath: seSrc, destPath: seDest });
    const rPc = refreshBundledHookIfNewer({ sourcePath: pcSrc, destPath: pcDest });

    assert.equal(rSe.status, 'refreshed-content-drift');
    assert.equal(rPc.status, 'refreshed-content-drift');
    // Both disk copies now byte-identical to bundled.
    assert.equal(fs.readFileSync(seDest, 'utf8'), fs.readFileSync(seSrc, 'utf8'));
    assert.equal(fs.readFileSync(pcDest, 'utf8'), fs.readFileSync(pcSrc, 'utf8'));
    // Each has its own timestamped backup containing the old body.
    assert.match(rSe.backup, /memory-session-end\.js\.bak\.\d{14}$/);
    assert.match(rPc.backup, /memory-pre-compact\.js\.bak\.\d{14}$/);
    assert.match(fs.readFileSync(rSe.backup, 'utf8'), /session-end OLD body/);
    assert.match(fs.readFileSync(rPc.backup, 'utf8'), /pre-compact OLD body/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── 6. CLI-binary integration: daily-driver-shape stale state → both refreshed ─
//
// This is the load-bearing end-to-end test for INSTALLER-PITFALLS checklist
// item #13 ("lockstep local-FS components are migrated as a unit, e2e tests
// drive from the *previous* published version's starting state, not the
// developer's already-migrated current state"). Seed state mirrors the
// daily-driver pre-Sprint-67 shape: v2-stamped session-end body that
// matches the SHIPPING bundled file's first ~10KB but is then truncated
// (= a stamp-equal-bytes-differ shape), plus a v1-stamped pre-compact file
// at the same shape. Drive the real CLI binary against ECONNREFUSED so the
// DB phase fails AFTER the refresh fires; assert both hooks now match
// bundled byte-for-byte.

const VALID_ENV = {
  SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  DATABASE_URL: 'postgres://postgres:badpw@127.0.0.1:1/postgres',
  OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

function runWizard(home, args, { extraEnv = {}, timeoutMs = 30000 } = {}) {
  const baseEnv = { ...process.env };
  for (const k of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'DATABASE_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ]) {
    delete baseEnv[k];
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, 'init', '--mnestra', ...args],
      {
        env: { ...baseEnv, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.stdin.end();
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err, merged: out + err });
    });
  });
}

// ── 7. Sprint 75 T2 (part A) — wizard prompt-copy pins ─────────────────────
//
// The Supabase dashboard no longer surfaces the connection string under
// Project Settings → Database; the Connect modal's "Use IPv4 connection
// (Shared Pooler)" toggle is the canonical path, and the OFF default shows
// an IPv6-only URL that hangs on IPv4-only hosts (Brad R730 field report).
// Pin the wizard copy so a future edit can't silently revert to the dead
// dashboard path.

test('wizard copy: "Use IPv4 connection" present, "Project Settings → Database" gone (Sprint 75 part A)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'src', 'init-mnestra.js'), 'utf8');
  assert.match(src, /Use IPv4 connection \(Shared Pooler\)/,
    'prompt must name the Connect-modal IPv4 toggle');
  assert.ok(!src.includes('Project Settings → Database'),
    'dead dashboard path must not appear anywhere in the wizard copy');
  assert.ok(!src.includes('Direct Postgres connection string'),
    'prompt must no longer ask for a "Direct" connection string');
});

// ── 8. Sprint 75 T2 (part B) — --from-env warn-once drive ─────────────────
//
// Drive the real CLI with a direct-endpoint DATABASE_URL. The warn lines
// must print EXACTLY once (the --from-env ingress) and the exit code must
// be unchanged from the non-direct shape (3 = pg connect failure) — the
// warn-never-blocks invariant at the wizard level.

test('CLI --from-env: direct-endpoint URL warns exactly once and exit code is unchanged', async () => {
  const home = freshTmpDir('termdeck-endpoint-warn-cli-');
  try {
    const directEnv = {
      ...VALID_ENV,
      // Placeholder ref — resolves to NXDOMAIN, so the pg connect fails
      // fast without touching any real project. Exit 3 either way.
      DATABASE_URL: 'postgres://postgres:badpw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    };
    const r = await runWizard(home, ['--from-env'], { extraEnv: directEnv });

    assert.equal(r.code, 3, `warn must not change the exit code (expected 3 = pg connect fail); got ${r.code}; output:\n${r.merged}`);

    const warnHits = r.out.split('⚠ this is the IPv6-only endpoint').length - 1;
    assert.equal(warnHits, 1, `direct-endpoint warning must print exactly once; saw ${warnHits}; output:\n${r.out}`);
    assert.match(r.out, /Use IPv4 connection \(Shared Pooler\)/, 'warning names the Connect-modal toggle');
    assert.match(r.out, /aws-<n>-<region>\.pooler\.supabase\.com/, 'warning shows the pooler URL shape with placeholders');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: stamp-equal content drift on BOTH hooks → both refreshed before DB phase', async () => {
  const home = freshTmpDir('termdeck-content-drift-cli-');
  try {
    const hookDir = path.join(home, '.claude', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });

    // Seed session-end: truncated copy of bundled — keeps v2 stamp + the
    // TermDeck-managed marker (both live in the head), drops the rest of
    // the body. That is the stamp-equal-bytes-differ shape.
    const bundledSe = fs.readFileSync(BUNDLED_SESSION_END, 'utf8');
    const installedSeBody = bundledSe.slice(0, Math.max(2048, Math.floor(bundledSe.length * 0.6))) +
      '\n// content-drift test seed — Sprint 67 T1 — truncated bundled body\n';
    const seInstalledPath = path.join(hookDir, 'memory-session-end.js');
    fs.writeFileSync(seInstalledPath, installedSeBody, 'utf8');

    // Sanity-check pre-conditions:
    //  (a) the seed has the same v-stamp as the bundled file we're refreshing
    //      against (otherwise this test would exercise the normal v-bump
    //      refresh path, not the content-drift gate we're pinning).
    //  (b) bytes differ from bundled (so the gate has work to do).
    const stampRe = /@termdeck\/stack-installer-hook\s+v(\d+)/;
    const bundledSeStamp = (bundledSe.match(stampRe) || [])[1];
    const installedSeStamp = (installedSeBody.match(stampRe) || [])[1];
    assert.equal(installedSeStamp, bundledSeStamp,
      'seed must reuse bundled v-stamp so the test exercises the content-drift gate, not the v-bump path');
    assert.notEqual(installedSeBody, bundledSe, 'seed bytes must differ from bundled');

    // Seed pre-compact: same shape.
    const bundledPc = fs.readFileSync(BUNDLED_PRE_COMPACT, 'utf8');
    const installedPcBody = bundledPc.slice(0, Math.max(2048, Math.floor(bundledPc.length * 0.6))) +
      '\n// content-drift test seed — Sprint 67 T1 — truncated bundled body\n';
    const pcInstalledPath = path.join(hookDir, 'memory-pre-compact.js');
    fs.writeFileSync(pcInstalledPath, installedPcBody, 'utf8');
    const bundledPcStamp = (bundledPc.match(stampRe) || [])[1];
    const installedPcStamp = (installedPcBody.match(stampRe) || [])[1];
    assert.equal(installedPcStamp, bundledPcStamp);
    assert.notEqual(installedPcBody, bundledPc);

    // Drive the real CLI. DB phase will fail at ECONNREFUSED (port 1) — the
    // refresh must fire upstream of that, per Sprint 51.7's wire-up fix.
    const r = await runWizard(home, ['--from-env'], { extraEnv: VALID_ENV });

    assert.equal(r.code, 3, `expected exit 3 (pg connect fail) but got ${r.code}; output:\n${r.merged}`);

    // Both hooks must now be byte-identical to the bundled source.
    assert.equal(
      fs.readFileSync(seInstalledPath, 'utf8'),
      bundledSe,
      'session-end on disk must now match bundled (content-drift gate refreshed it)',
    );
    assert.equal(
      fs.readFileSync(pcInstalledPath, 'utf8'),
      bundledPc,
      'pre-compact on disk must now match bundled (content-drift gate refreshed it)',
    );

    // Each refresh emits the content-drift status in stdout.
    assert.match(
      r.merged,
      /Refreshing ~\/\.claude\/hooks\/memory-session-end\.js[^\n]+content-drift; backup:/,
      'session-end refresh must announce content-drift status in stdout',
    );
    assert.match(
      r.merged,
      /Refreshing ~\/\.claude\/hooks\/memory-pre-compact\.js[^\n]+content-drift; backup:/,
      'pre-compact refresh must announce content-drift status in stdout',
    );

    // Each refresh produced a timestamped backup containing the OLD body.
    const backups = fs.readdirSync(hookDir).filter((f) => /\.bak\.\d{14}$/.test(f));
    assert.equal(backups.length, 2, `expected 2 backups (session-end + pre-compact); found: ${backups.join(', ')}`);
    const seBackup = backups.find((f) => f.startsWith('memory-session-end.js'));
    const pcBackup = backups.find((f) => f.startsWith('memory-pre-compact.js'));
    assert.ok(seBackup, 'session-end backup missing');
    assert.ok(pcBackup, 'pre-compact backup missing');
    assert.equal(fs.readFileSync(path.join(hookDir, seBackup), 'utf8'), installedSeBody);
    assert.equal(fs.readFileSync(path.join(hookDir, pcBackup), 'utf8'), installedPcBody);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

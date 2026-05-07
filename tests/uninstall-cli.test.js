// Sprint 61 T1 — uninstall command regression suite.
//
// Surface: packages/stack-installer/src/uninstall.js — `async function
// uninstall(opts)` and the per-step primitives. Each test spins a fresh
// tempdir as a fake $HOME, populates the relevant subset of install-state
// fixtures, drives the uninstall path with `home`/`platform` injected via
// opts, and asserts post-state on disk + on the returned `summary` object.
//
// Pattern mirrors tests/stack-installer-hook-merge.test.js — node:test +
// node:assert/strict + freshTmpDir + silenceStdout + DI-by-opts (no
// monkey-patching of os.homedir()).
//
// 10 cases, matching the lane brief at docs/sprint-61-uninstall-and-install
// -harness/T1-uninstall-cli.md § Tests verbatim:
//
//   1. Synthetic full install state → all expected paths gone or moved-to-
//      bak, other MCP entries + other settings.json wirings preserved.
//   2. Idempotent second run.
//   3. Never-installed (empty $HOME).
//   4. --dry-run writes nothing.
//   5. --keep-secrets preserves secrets.env + secrets.env.bak.*
//   6. ~/.claude.json MCP splice preserves other entries + non-mcpServers
//      top-level keys.
//   7. ~/.claude/settings.json splice preserves unrelated SessionEnd entries
//      + untouched UserPromptSubmit wirings.
//   8. ~/.claude/hooks/memory-session-end.js → .bak.<ISO-8601>, not deleted.
//   9. LaunchAgent unload-then-remove ordering.
//  10. Malformed ~/.claude.json → non-zero exit + file bit-exact preserved.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const uninstallMod = require(path.join(repoRoot, 'packages', 'stack-installer', 'src', 'uninstall.js'));
const { uninstall } = uninstallMod;

// ── Test helpers ────────────────────────────────────────────────────

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-cli-test-'));
}

function silentStdout() {
  return { write: () => true };
}

// Build a recording spawnSync stub. Records each call into `callLog` and
// returns a fake { status: 0 } result so calls don't error out the step.
function recordingSpawnSync(callLog) {
  return (cmd, args, _opts) => {
    callLog.push({ cmd, args: Array.isArray(args) ? args.slice() : args });
    return { status: 0, stdout: '', stderr: '' };
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Populate the synthetic full-install state under `home`. The fixture mirrors
// what packages/stack-installer/src/index.js writes during a fresh install:
//   ~/.termdeck/                      (config + secrets + db + transcripts)
//   ~/.claude.json                    (mcpServers.mnestra + 2 unrelated)
//   ~/.claude/settings.json           (hooks.SessionEnd ours + 1 unrelated, plus
//                                      hooks.UserPromptSubmit untouched)
//   ~/.claude/hooks/memory-session-end.js
//   ~/Library/LaunchAgents/com.jhizzard.termdeck.test.plist
function populateFullInstall(home) {
  // ~/.termdeck/
  const termdeckDir = path.join(home, '.termdeck');
  fs.mkdirSync(path.join(termdeckDir, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(termdeckDir, 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(termdeckDir, 'config.yaml'), 'port: 3000\n');
  fs.writeFileSync(path.join(termdeckDir, 'secrets.env'), 'SUPABASE_URL=https://abc.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n', { mode: 0o600 });
  fs.writeFileSync(path.join(termdeckDir, 'secrets.env.bak.20260501T000000Z'), 'OLD=1\n');
  fs.writeFileSync(path.join(termdeckDir, 'termdeck.db'), Buffer.alloc(64));
  fs.writeFileSync(path.join(termdeckDir, 'termdeck.db-wal'), Buffer.alloc(32));
  fs.writeFileSync(path.join(termdeckDir, 'termdeck.db-shm'), Buffer.alloc(16));
  fs.writeFileSync(path.join(termdeckDir, 'transcripts', 'session-1.log'), 'sample\n');

  // ~/.claude.json with mnestra + 2 unrelated MCP servers + extra top-level keys.
  writeJson(path.join(home, '.claude.json'), {
    permissions: { allow: ['Bash(*)'] },
    env: { CUSTOM_VAR: 'value' },
    mcpServers: {
      mnestra: { type: 'stdio', command: 'mnestra', env: { SUPABASE_URL: 'https://abc.supabase.co' } },
      supabase: { type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'] },
      playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    },
  });

  // ~/.claude/settings.json — exercises both shape variants we've seen in
  // the wild (T3 finding 2026-05-07 18:50 ET): canonical group shape +
  // flat shape. Plus an untouched UserPromptSubmit and the legacy pre-
  // Sprint-48 Stop wiring our uninstall must migrate-then-splice.
  writeJson(path.join(home, '.claude', 'settings.json'), {
    hooks: {
      Stop: [
        // Canonical group shape pointing at our hook (must be spliced).
        { matcher: '', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 30 }] },
        // Flat shape pointing at our hook (must also be spliced).
        { type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 15 },
      ],
      SessionEnd: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 30 },
            { type: 'command', command: 'node ~/.claude/hooks/other-unrelated-hook.js', timeout: 10 },
          ],
        },
      ],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: 'echo prompt-fingerprint', timeout: 5 }] },
      ],
    },
  });

  // ~/.claude/hooks/memory-session-end.js
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'hooks', 'memory-session-end.js'),
    "// @termdeck/stack-installer-hook v3\n'use strict';\nconsole.log('hook');\n",
  );

  // macOS LaunchAgent
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'Library', 'LaunchAgents', 'com.jhizzard.termdeck.test.plist'),
    '<?xml version="1.0"?><plist><dict><key>Label</key><string>com.jhizzard.termdeck.test</string></dict></plist>\n',
  );
}

// Snapshot the contents of every regular file under `dir`, recursive. Used in
// dry-run and malformed cases to assert byte-identical pre/post state.
function snapshotTree(dir) {
  const out = new Map();
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const sub = path.join(d, e.name);
      if (e.isDirectory()) walk(sub);
      else if (e.isFile()) out.set(sub, fs.readFileSync(sub));
    }
  }
  walk(dir);
  return out;
}

function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !v.equals(w)) return false;
  }
  return true;
}

// ── Cases ───────────────────────────────────────────────────────────

test('1. synthetic full install state — all paths gone-or-bak, others preserved', async () => {
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const callLog = [];
    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync(callLog),
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);

    // ~/.termdeck/ gone.
    assert.equal(fs.existsSync(path.join(home, '.termdeck')), false);

    // ~/.claude.json mnestra removed; supabase + playwright + non-mcpServers
    // top-level keys preserved.
    const claudeJson = readJson(path.join(home, '.claude.json'));
    assert.deepEqual(Object.keys(claudeJson.mcpServers).sort(), ['playwright', 'supabase']);
    assert.deepEqual(claudeJson.permissions, { allow: ['Bash(*)'] });
    assert.deepEqual(claudeJson.env, { CUSTOM_VAR: 'value' });

    // settings.json: our hook entry removed from SessionEnd; the unrelated
    // SessionEnd entry is preserved; UserPromptSubmit untouched; Stop array
    // emptied → key deleted.
    const settings = readJson(path.join(home, '.claude', 'settings.json'));
    assert.equal(settings.hooks.Stop, undefined);
    assert.equal(settings.hooks.SessionEnd.length, 1);
    assert.equal(settings.hooks.SessionEnd[0].hooks.length, 1);
    assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /other-unrelated-hook\.js/);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'echo prompt-fingerprint');

    // Hook file moved to .bak.<timestamp>; original gone.
    assert.equal(fs.existsSync(path.join(home, '.claude', 'hooks', 'memory-session-end.js')), false);
    const hookDir = fs.readdirSync(path.join(home, '.claude', 'hooks'));
    const baks = hookDir.filter((n) => n.startsWith('memory-session-end.js.bak.'));
    assert.equal(baks.length, 1);

    // LaunchAgent gone; launchctl unload was called BEFORE the file was removed.
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.jhizzard.termdeck.test.plist');
    assert.equal(fs.existsSync(plist), false);
    const launchctlCalls = callLog.filter((c) => c.cmd === 'launchctl');
    assert.equal(launchctlCalls.length, 1);
    assert.deepEqual(launchctlCalls[0].args, ['unload', plist]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('2. idempotent second run — short-circuits with idempotencyState=already-uninstalled', async () => {
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const callLog = [];
    const first = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync(callLog),
    });
    assert.equal(first.exitCode, 0);
    assert.equal(first.summary.idempotencyState, null,
      'first run with live state present should NOT short-circuit');

    const second = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync(callLog),
    });
    assert.equal(second.ok, true);
    assert.equal(second.exitCode, 0);

    // Detection: every live bit is false; .bak file from prior uninstall present.
    assert.equal(second.summary.state.hasTermdeckDir, false);
    assert.equal(second.summary.state.hasMnestraMcpEntry, false);
    assert.equal(second.summary.state.hasOurHookInSettings, false);
    assert.equal(second.summary.state.hasHookFile, false);
    assert.equal(second.summary.state.launchAgents.length, 0);
    assert.ok(second.summary.state.hookBakFiles.length >= 1,
      'second run must see the prior-uninstall hook .bak file');

    // T4-CODEX 18:46 ET concern: "already uninstalled" message distinct
    // from "nothing to uninstall" on never-installed state.
    assert.equal(second.summary.idempotencyState, 'already-uninstalled');

    // Steps are NOT run on a clean second pass — short-circuit fires.
    assert.deepEqual(second.summary.steps, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('3. never-installed empty $HOME — idempotencyState=nothing-to-uninstall', async () => {
  const home = freshTmpDir();
  try {
    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.summary.steps, []);
    // T4-CODEX 18:46 ET concern: never-installed says "nothing to uninstall",
    // distinct from "already uninstalled" which case 2 covers.
    assert.equal(result.summary.idempotencyState, 'nothing-to-uninstall');
    // No files materialized in the empty home.
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('4. --dry-run writes nothing AND does not prompt (incl. --purge-supabase)', async () => {
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const before = snapshotTree(home);
    const callLog = [];
    // T4-CODEX 18:46 ET concern: dry-run with --purge-supabase must not
    // prompt for destructive confirmation. Wire stub prompts that THROW if
    // invoked — proves the dry-run path bypasses the prompt machinery.
    const promptYesNoBoom = () => { throw new Error('dry-run must not prompt yes/no'); };
    const promptInputMatchingBoom = () => { throw new Error('dry-run must not prompt input-matching'); };

    const result = await uninstall({
      home, platform: 'darwin', yes: true, dryRun: true, purgeSupabase: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync(callLog),
      _promptYesNo: promptYesNoBoom,
      _promptInputMatching: promptInputMatchingBoom,
    });
    assert.equal(result.ok, true);
    const after = snapshotTree(home);
    assert.equal(snapshotsEqual(before, after), true,
      'dry-run must not modify any file under $HOME');
    // No system commands under --dry-run (no launchctl, no psql, no which).
    assert.equal(callLog.length, 0, 'no spawnSync calls under --dry-run');
    // Summary should include a would-purge step (proving the purge path was
    // exercised but short-circuited before prompts/spawn).
    const purge = result.summary.steps.find((s) => s.name === 'purge-supabase');
    assert.ok(purge, 'expected purge-supabase step under --dry-run --purge-supabase');
    assert.equal(purge.status, 'would-purge');
    // Other steps report "would-*" verbs.
    const verbs = result.summary.steps.map((s) => s.status);
    assert.ok(verbs.filter((v) => v.startsWith('would-')).length >= 2,
      `expected at least 2 would-* steps (got ${verbs.join(',')})`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('5. --keep-secrets preserves secrets.env + secrets.env.bak.*', async () => {
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const result = await uninstall({
      home, platform: 'darwin', yes: true, keepSecrets: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);

    // ~/.termdeck/ still exists, but only contains the preserved files.
    const remaining = fs.readdirSync(path.join(home, '.termdeck')).sort();
    assert.deepEqual(remaining, ['secrets.env', 'secrets.env.bak.20260501T000000Z']);
    // Bytes preserved.
    assert.match(
      fs.readFileSync(path.join(home, '.termdeck', 'secrets.env'), 'utf8'),
      /SUPABASE_URL=https:\/\/abc\.supabase\.co/,
    );
    assert.match(
      fs.readFileSync(path.join(home, '.termdeck', 'secrets.env.bak.20260501T000000Z'), 'utf8'),
      /OLD=1/,
    );
    // The corresponding step reports preserved-secrets.
    const step = result.summary.steps.find((s) => s.name === 'termdeck-dir');
    assert.equal(step.status, 'preserved-secrets');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('6. ~/.claude.json splice preserves other entries + non-mcpServers top-level keys', async () => {
  const home = freshTmpDir();
  try {
    fs.mkdirSync(home, { recursive: true });
    writeJson(path.join(home, '.claude.json'), {
      // Non-mcpServers top-level keys must be preserved bit-exact.
      permissions: { allow: ['Bash(*)', 'WebFetch(*)'] },
      env: { CUSTOM_VAR: 'value' },
      defaultModel: 'opus',
      mcpServers: {
        mnestra: { type: 'stdio', command: 'mnestra' },
        supabase: { type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'] },
        playwright: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
      },
    });

    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);

    const after = readJson(path.join(home, '.claude.json'));
    // mnestra removed.
    assert.equal(after.mcpServers.mnestra, undefined);
    // Other MCP entries bit-exact preserved.
    assert.deepEqual(after.mcpServers.supabase, {
      type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'],
    });
    assert.deepEqual(after.mcpServers.playwright, {
      type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    });
    // Non-mcpServers top-level keys bit-exact preserved.
    assert.deepEqual(after.permissions, { allow: ['Bash(*)', 'WebFetch(*)'] });
    assert.deepEqual(after.env, { CUSTOM_VAR: 'value' });
    assert.equal(after.defaultModel, 'opus');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('7. ~/.claude/settings.json splice preserves unrelated SessionEnd + UserPromptSubmit', async () => {
  const home = freshTmpDir();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        SessionEnd: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 30 },
              { type: 'command', command: 'node ~/.claude/hooks/site-specific-cleanup.js', timeout: 15 },
            ],
          },
        ],
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'check-prompt --fast', timeout: 5 }] },
        ],
        PreCompact: [
          { matcher: '', hooks: [{ type: 'command', command: 'snapshot-context', timeout: 30 }] },
        ],
      },
    });

    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);

    const after = readJson(path.join(home, '.claude', 'settings.json'));
    // Our hook is gone from SessionEnd; the unrelated site-specific entry is preserved.
    assert.equal(after.hooks.SessionEnd.length, 1);
    assert.equal(after.hooks.SessionEnd[0].hooks.length, 1);
    assert.equal(after.hooks.SessionEnd[0].hooks[0].command, 'node ~/.claude/hooks/site-specific-cleanup.js');
    // UserPromptSubmit untouched.
    assert.deepEqual(after.hooks.UserPromptSubmit, [
      { matcher: '', hooks: [{ type: 'command', command: 'check-prompt --fast', timeout: 5 }] },
    ]);
    // PreCompact untouched.
    assert.deepEqual(after.hooks.PreCompact, [
      { matcher: '', hooks: [{ type: 'command', command: 'snapshot-context', timeout: 30 }] },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('8. hook file moved to .bak.<canonical-ISO-8601>, not deleted', async () => {
  const home = freshTmpDir();
  try {
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'hooks', 'memory-session-end.js'),
      "// @termdeck/stack-installer-hook v2\nconsole.log('hi');\n",
    );

    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);

    const dir = path.join(home, '.claude', 'hooks');
    // Original gone.
    assert.equal(fs.existsSync(path.join(dir, 'memory-session-end.js')), false);
    // Exactly one .bak.<canonical-ISO-8601> sibling.
    const baks = fs.readdirSync(dir).filter((n) => n.startsWith('memory-session-end.js.bak.'));
    assert.equal(baks.length, 1);
    // Canonical ISO-8601: YYYY-MM-DDTHH:MM:SS.mmmZ — exactly what
    // Date.prototype.toISOString() produces. T4-CODEX 18:46 ET concern.
    const stamp = baks[0].replace('memory-session-end.js.bak.', '');
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `expected canonical ISO-8601 timestamp, got "${stamp}"`);
    // Sanity: stamp parses back to a valid Date, confirming round-trip.
    const parsed = new Date(stamp);
    assert.ok(!Number.isNaN(parsed.getTime()), 'stamp must parse as a valid Date');
    // Body preserved bit-exact.
    assert.match(
      fs.readFileSync(path.join(dir, baks[0]), 'utf8'),
      /@termdeck\/stack-installer-hook v2/,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('9. LaunchAgent unload is called BEFORE the plist is removed', async () => {
  const home = freshTmpDir();
  try {
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.jhizzard.termdeck.daemon.plist');
    fs.writeFileSync(plist, '<plist></plist>\n');

    // Capture call timeline: each spawnSync entry records cmd+args, and our
    // _spawnSync stub asserts the file STILL EXISTS at the moment launchctl
    // unload is invoked. This proves unload happens BEFORE rm at runtime.
    const callLog = [];
    const spawnSyncStub = (cmd, args, _opts) => {
      callLog.push({ cmd, args: Array.isArray(args) ? args.slice() : args, plistExistedAtCallTime: fs.existsSync(plist) });
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: spawnSyncStub,
    });
    assert.equal(result.ok, true);

    // launchctl was invoked exactly once.
    const lc = callLog.filter((c) => c.cmd === 'launchctl');
    assert.equal(lc.length, 1);
    assert.deepEqual(lc[0].args, ['unload', plist]);
    // At the time launchctl ran, the plist still existed (i.e. unload BEFORE rm).
    assert.equal(lc[0].plistExistedAtCallTime, true);
    // After the run, the plist is gone.
    assert.equal(fs.existsSync(plist), false);
    // The step's recorded actions also reflect the order.
    const step = result.summary.steps.find((s) => s.name === 'launch-agents');
    const unloadIdx = step.actions.findIndex((a) => a.kind === 'unload');
    const rmIdx = step.actions.findIndex((a) => a.kind === 'rm');
    assert.ok(unloadIdx >= 0 && rmIdx >= 0);
    assert.ok(unloadIdx < rmIdx, `expected unload (idx ${unloadIdx}) BEFORE rm (idx ${rmIdx})`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('10. malformed ~/.claude.json — abort BEFORE any destructive step', async () => {
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const claudeJson = path.join(home, '.claude.json');
    const broken = '{ ';
    fs.writeFileSync(claudeJson, broken);
    const beforeTree = snapshotTree(home);
    const callLog = [];

    // T4-CODEX 18:48 ET concern: even with --purge-supabase set, malformed
    // claude.json must abort BEFORE the purge step, the ~/.termdeck removal,
    // and the splice steps. Wire prompt stubs that THROW if invoked — proves
    // we never reached the destructive prompt path either.
    const promptYesNoBoom = () => { throw new Error('preflight abort must not prompt yes/no'); };
    const promptInputMatchingBoom = () => { throw new Error('preflight abort must not prompt input-matching'); };

    const result = await uninstall({
      home, platform: 'darwin', yes: true, purgeSupabase: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync(callLog),
      _promptYesNo: promptYesNoBoom,
      _promptInputMatching: promptInputMatchingBoom,
    });

    assert.notEqual(result.exitCode, 0, 'malformed ~/.claude.json must produce non-zero exit');
    assert.equal(result.ok, false);

    // File preserved bit-exact AND every other tracked file in $HOME is
    // bit-exact (proof no destructive step ran).
    const afterTree = snapshotTree(home);
    assert.equal(snapshotsEqual(beforeTree, afterTree), true,
      'malformed claude.json must abort with the entire $HOME tree bit-exact');

    // No spawnSync calls (no launchctl, no psql, no which).
    assert.equal(callLog.length, 0, 'preflight abort must not invoke spawnSync');

    // Summary contains EXACTLY one step — the fatal preflight entry — and
    // preflightAborted flag is set so callers can branch on it.
    assert.equal(result.summary.steps.length, 1,
      `expected exactly 1 step (the preflight fatal); got ${result.summary.steps.length}`);
    const step = result.summary.steps[0];
    assert.equal(step.name, 'claude-json-mcp');
    assert.equal(step.status, 'malformed');
    assert.equal(step.fatal, true);
    assert.equal(result.summary.preflightAborted, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('12. settings.json flat-shape splice (T3 fixture) — entries preserved when unrelated', async () => {
  // T3 reinstall harness (2026-05-07 18:50 ET FINDING) seeds settings.json
  // with the alternative flat shape — `SessionEnd: [{ type, command }]`
  // directly, no nested matcher/hooks group. T1 must handle both this AND
  // the canonical group shape; install-side only writes the group shape, but
  // user hand-edits and older installers can leave the flat shape on disk.
  const home = freshTmpDir();
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeJson(path.join(home, '.claude', 'settings.json'), {
      hooks: {
        SessionEnd: [
          { type: 'command', command: `${home}/.claude/hooks/memory-session-end.js` },
        ],
        Stop: [
          { type: 'command', command: '/usr/local/lib/some/other/preserved/hook.sh' },
        ],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    });

    const result = await uninstall({
      home, platform: 'darwin', yes: true,
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
    });
    assert.equal(result.ok, true);

    const after = readJson(path.join(home, '.claude', 'settings.json'));
    // Our flat-shape SessionEnd entry: spliced (so SessionEnd was emptied
    // and the key deleted).
    assert.equal(after.hooks.SessionEnd, undefined);
    // The unrelated flat-shape Stop entry must survive bit-exact.
    assert.deepEqual(after.hooks.Stop, [
      { type: 'command', command: '/usr/local/lib/some/other/preserved/hook.sh' },
    ]);
    // Top-level non-hooks keys preserved.
    assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('11. interactive --keep-secrets prompt — defaults respect user answer', async () => {
  // T4-CODEX 18:46 ET concern: in interactive mode (no --yes, no --keep-secrets),
  // when ~/.termdeck/secrets.env exists, the user must see a prompt asking
  // whether to preserve secrets. The general "Proceed?" prompt is separate.
  const home = freshTmpDir();
  try {
    populateFullInstall(home);
    const promptCalls = [];
    // Stub: first call (preserve secrets?) → true; second call (proceed?) → true.
    const promptYesNo = (q, def) => {
      promptCalls.push({ q, def });
      // Ordering: first prompt is for keep-secrets (default true), second is
      // for proceed (default false). We answer "true" to both for this case.
      return Promise.resolve(true);
    };
    const result = await uninstall({
      home, platform: 'darwin', // NOT yes — interactive path
      _stdout: silentStdout(),
      _spawnSync: recordingSpawnSync([]),
      _promptYesNo: promptYesNo,
    });
    assert.equal(result.ok, true);
    // Two prompts fired in order: keep-secrets, then proceed.
    assert.equal(promptCalls.length, 2);
    assert.match(promptCalls[0].q, /Preserve.*secrets\.env/i);
    assert.equal(promptCalls[0].def, true);
    assert.match(promptCalls[1].q, /Proceed with uninstall/i);
    assert.equal(promptCalls[1].def, false);
    // Secrets preserved (user said "true" to keep-secrets prompt).
    const remaining = fs.readdirSync(path.join(home, '.termdeck')).sort();
    assert.deepEqual(remaining, ['secrets.env', 'secrets.env.bak.20260501T000000Z']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

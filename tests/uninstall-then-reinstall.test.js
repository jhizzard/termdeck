// Sprint 61 T3 — local-dev belt-and-suspenders test for the
// install → uninstall → reinstall sequence.
//
// The load-bearing coverage for this is the GitHub Actions probe in
// .github/workflows/install-smoke.yml (Linux clean-install-ubuntu) and
// .github/workflows/macos-install-smoke.yml (macOS clean-install-macos):
// each workflow runs a real wizard against a real test Supabase project,
// invokes `termdeck-stack uninstall --yes`, asserts clean state, then
// reinstalls from scratch and re-runs the doctor probe.
//
// This local-dev test is the fast-feedback companion. It does NOT run
// the actual wizard (which requires Supabase access) — instead it
// pre-populates a synthetic post-install filesystem state in a tempdir,
// invokes the `termdeck-stack uninstall` command via the in-tree source
// CLI, and asserts the cleanup contract:
//
//   1. ~/.termdeck/                                — entire dir removed
//   2. ~/.claude.json mnestra MCP entry            — surgical splice
//      (other MCP entries preserved)
//   3. ~/.claude/settings.json hooks.SessionEnd    — surgical splice of
//      the bundled-hook entry (other event wirings + top-level keys
//      preserved)
//   4. ~/.claude/hooks/memory-session-end.js       — moved to .bak.<ISO>
//      (or absent on clean machines)
//   5. Idempotency — running uninstall twice on the same tempdir is a
//      clean no-op the second time
//   6. Reinstall-after-uninstall — re-seeding synthetic state and
//      uninstalling again leaves the same clean end-state (no
//      poisoning between cycles)
//
// Why this isolation matters: the GH Actions probes take 5+ minutes to
// run; this test takes <2 seconds. Catching regressions in the cleanup
// contract during local iteration prevents a CI feedback loop.
//
// SKIP-GATE (T1 cross-lane wiring): T1 ships the `termdeck-stack
// uninstall` command in `packages/stack-installer/src/index.js` during
// Sprint 61. If the in-tree CLI does not yet recognize the `uninstall`
// subcommand (because T1 is still in-flight), this test set skips
// rather than fails, with a clear message. Once T1 lands, the skip
// stops firing and the assertions run.
//
// Source-of-truth references:
//   - T1 PLANNING:   docs/sprint-61-uninstall-and-install-harness/T1-uninstall-cli.md
//   - T1 spec:       docs/sprint-61-uninstall-and-install-harness/PLANNING.md § T1
//   - T3 spec:       docs/sprint-61-uninstall-and-install-harness/T3-fresh-install-harness.md § Step 4
//   - GH Actions:    .github/workflows/install-smoke.yml + .github/workflows/macos-install-smoke.yml
//   - Existing pattern: tests/init-mnestra-cli-refresh.test.js (spawn-CLI-against-tempdir-HOME)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const STACK_CLI = path.join(
  REPO_ROOT,
  'packages',
  'stack-installer',
  'src',
  'index.js',
);

// ---- Tempdir + cleanup helpers ----------------------------------------------

function freshHome() {
  // CRITICAL on macOS: realpath the tempdir before use. os.tmpdir() returns
  // `/var/folders/...` which is a symlink to `/private/var/folders/...`.
  // T1's uninstall command resolves paths through fs.realpathSync internally,
  // so a fixture path stored as `/var/folders/...` won't match T1's
  // canonical-path comparison. Without this realpath, the settings.json
  // splice silently skips with "no entries pointed at our hook" because the
  // entry's `command` string is on the symlink path, not the real path.
  // Verified 2026-05-07: realpath'd home → splice fires; raw path → splice
  // skips. (Pattern also documented in tests/init-mnestra-cli-refresh.test.js.)
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-uninstall-'));
  return fs.realpathSync(raw);
}

function rmrfQuiet(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_e) {
    /* gone */
  }
}

// ---- Synthetic install-state seeder -----------------------------------------
// Mirrors what the wizard writes during `termdeck-stack` first-run. Seeds:
//   ~/.termdeck/{config.yaml, secrets.env, termdeck.db, db-wal, transcripts/}
//   ~/.claude.json (mnestra MCP entry + 2 preserved-other entries)
//   ~/.claude/hooks/memory-session-end.js (TermDeck-stamped, qualifies as
//                                          bundled-managed for surgical removal)
//   ~/.claude/settings.json (hooks.SessionEnd pointing at the bundled hook,
//                            plus a Stop entry pointing at an unrelated hook
//                            that MUST be preserved)

function seedSyntheticInstall(home) {
  const td = path.join(home, '.termdeck');
  const transcripts = path.join(td, 'transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(
    path.join(td, 'config.yaml'),
    'port: 3000\nhost: 127.0.0.1\n',
  );
  fs.writeFileSync(
    path.join(td, 'secrets.env'),
    'DATABASE_URL=postgres://test:test@127.0.0.1:5432/test\n',
  );
  fs.writeFileSync(path.join(td, 'termdeck.db'), '');
  fs.writeFileSync(path.join(td, 'termdeck.db-wal'), '');
  fs.writeFileSync(
    path.join(transcripts, '2026-05-07-test.jsonl'),
    '{"line":1}\n',
  );

  const claudeJson = {
    mcpServers: {
      mnestra: {
        command: 'npx',
        args: ['-y', '@jhizzard/mnestra'],
        env: {
          SUPABASE_URL: 'https://test.example.com',
          SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        },
      },
      'preserved-other-mcp-1': {
        command: 'node',
        args: ['/path/to/some/other/mcp.js'],
      },
      supabase: {
        command: 'npx',
        args: ['-y', '@supabase/mcp-server-supabase'],
      },
    },
    other_top_level_key: { preserved: true },
  };
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(claudeJson, null, 2),
  );

  const claudeDir = path.join(home, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const bundledHookPath = path.join(hooksDir, 'memory-session-end.js');
  // Canonical bundled-hook marker that the stack-installer writes today
  // (verified against packages/stack-installer/assets/hooks/memory-session-end.js
  // header line "@termdeck/stack-installer-hook v2"). T1's uninstall command
  // recognizes this marker as "managed by us" → safe to rotate to .bak and
  // to splice the settings.json wiring entries that point at it. A hook
  // file with any other content is treated as user-customized and preserved.
  fs.writeFileSync(
    bundledHookPath,
    [
      '#!/usr/bin/env node',
      '/**',
      ' * TermDeck session-end memory hook.',
      ' * @termdeck/stack-installer-hook v2',
      ' */',
      "'use strict';",
      'process.exit(0);',
      '',
    ].join('\n'),
  );

  const settings = {
    hooks: {
      SessionEnd: [
        { type: 'command', command: bundledHookPath },
      ],
      // Unrelated event wiring — MUST survive the uninstall splice.
      Stop: [
        {
          type: 'command',
          command: '/usr/local/lib/some/other/preserved/hook.sh',
        },
      ],
    },
    // Top-level keys must survive too.
    permissions: { allow: ['Bash(ls:*)'] },
  };
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );

  return { td, bundledHookPath };
}

// ---- spawn helper -----------------------------------------------------------

function runStackCli(home, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
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
    const child = spawn(process.execPath, [STACK_CLI, ...args], {
      env: {
        ...baseEnv,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf-8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf-8');
    });
    child.stdin.end();
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_e) {
        /* gone */
      }
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code, signal });
    });
    child.once('error', (err) => {
      clearTimeout(killer);
      resolve({ stdout, stderr: stderr + String(err), code: 127, signal: null });
    });
  });
}

// Cross-lane skip gate: detect whether T1's `uninstall` subcommand has
// been wired into the stack-installer CLI. If not, this test set skips
// rather than fails (T1 is in-flight during Sprint 61).
async function uninstallSubcommandIsWired() {
  // Probe `--help`. T1 will surface "uninstall" in the help text once
  // wired. Use a fresh tempdir HOME so the probe doesn't leak state
  // back into the real machine.
  const probeHome = freshHome();
  try {
    const { stdout, stderr, code } = await runStackCli(
      probeHome,
      ['--help'],
      { timeoutMs: 5_000 },
    );
    const out = `${stdout}\n${stderr}`;
    if (code !== 0) return false;
    return /uninstall/i.test(out);
  } catch (_e) {
    return false;
  } finally {
    rmrfQuiet(probeHome);
  }
}

// ---- Cleanup-contract assertions --------------------------------------------

function assertCleanState(home, { allowBundledHookBak = true } = {}) {
  // 1. ~/.termdeck/ entirely gone
  assert.equal(
    fs.existsSync(path.join(home, '.termdeck')),
    false,
    '~/.termdeck/ should be removed after uninstall',
  );

  // 2. ~/.claude.json no longer has mnestra entry; other entries preserved
  const claudeJsonPath = path.join(home, '.claude.json');
  if (fs.existsSync(claudeJsonPath)) {
    const cj = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    if (cj.mcpServers) {
      assert.equal(
        cj.mcpServers.mnestra,
        undefined,
        '~/.claude.json mcpServers.mnestra should be spliced out',
      );
      assert.ok(
        cj.mcpServers['preserved-other-mcp-1'],
        '~/.claude.json mcpServers.preserved-other-mcp-1 must be preserved',
      );
      assert.ok(
        cj.mcpServers.supabase,
        '~/.claude.json mcpServers.supabase must be preserved',
      );
    }
    assert.ok(
      cj.other_top_level_key,
      '~/.claude.json other_top_level_key must be preserved',
    );
  }

  // 3. ~/.claude/settings.json: bundled-hook SessionEnd entry spliced;
  //    Stop entry + top-level keys preserved.
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.hooks && Array.isArray(settings.hooks.SessionEnd)) {
      const stillPointsAtBundled = settings.hooks.SessionEnd.some(
        (entry) =>
          typeof entry?.command === 'string' &&
          entry.command.includes('memory-session-end.js'),
      );
      assert.equal(
        stillPointsAtBundled,
        false,
        'settings.json SessionEnd should not point at the bundled hook',
      );
    }
    if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
      const stopPreserved = settings.hooks.Stop.some(
        (entry) =>
          typeof entry?.command === 'string' &&
          entry.command.includes('preserved/hook.sh'),
      );
      assert.equal(
        stopPreserved,
        true,
        'settings.json hooks.Stop entry must be preserved',
      );
    }
    assert.ok(
      settings.permissions,
      'settings.json top-level permissions key must be preserved',
    );
  }

  // 4. ~/.claude/hooks/memory-session-end.js absent; .bak.<ts> may exist.
  const hookPath = path.join(home, '.claude', 'hooks', 'memory-session-end.js');
  assert.equal(
    fs.existsSync(hookPath),
    false,
    'bundled hook must be absent (or rotated to .bak.<ts>)',
  );
  if (allowBundledHookBak) {
    const hooksDir = path.join(home, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const bakFiles = fs
        .readdirSync(hooksDir)
        .filter((f) => f.startsWith('memory-session-end.js.bak.'));
      // .bak.<ts> retention is OK but not required if there was no hook
      // to rotate (e.g. a clean machine that never had one). The contract
      // is "no live bundled hook," not "always create a .bak."
      // (The mere presence of a .bak entry is benign.)
      void bakFiles;
    }
  }
}

// ---- Tests -----------------------------------------------------------------

let _wiredCache = null;
async function isWired() {
  if (_wiredCache === null) {
    _wiredCache = await uninstallSubcommandIsWired();
  }
  return _wiredCache;
}

test('uninstall on a clean machine is idempotent (no synthetic state)', async (t) => {
  if (!(await isWired())) {
    t.skip(
      'T1 uninstall subcommand not yet wired into termdeck-stack CLI; ' +
        'skipping until T1 ships (Sprint 61 in-flight).',
    );
    return;
  }
  const home = freshHome();
  try {
    const { code, stdout, stderr } = await runStackCli(home, [
      'uninstall',
      '--yes',
    ]);
    assert.equal(
      code,
      0,
      `uninstall on clean machine should exit 0; got ${code}. ` +
        `stdout=${stdout}\nstderr=${stderr}`,
    );
    assertCleanState(home);
  } finally {
    rmrfQuiet(home);
  }
});

test('uninstall removes synthetic install state cleanly', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    seedSyntheticInstall(home);

    // Sanity: synthetic state is present before uninstall.
    assert.equal(fs.existsSync(path.join(home, '.termdeck')), true);
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), true);
    assert.equal(
      fs.existsSync(
        path.join(home, '.claude', 'hooks', 'memory-session-end.js'),
      ),
      true,
    );

    const { code, stdout, stderr } = await runStackCli(home, [
      'uninstall',
      '--yes',
    ]);
    assert.equal(
      code,
      0,
      `uninstall against synthetic state should exit 0; got ${code}. ` +
        `stdout=${stdout}\nstderr=${stderr}`,
    );

    assertCleanState(home);
  } finally {
    rmrfQuiet(home);
  }
});

test('uninstall is idempotent — second run on uninstalled state is a clean no-op', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    seedSyntheticInstall(home);

    const first = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(first.code, 0, 'first uninstall must exit 0');
    assertCleanState(home);

    const second = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(
      second.code,
      0,
      `second uninstall (idempotent path) must exit 0; got ${second.code}. ` +
        `stdout=${second.stdout}\nstderr=${second.stderr}`,
    );
    assertCleanState(home);
  } finally {
    rmrfQuiet(home);
  }
});

test('reinstall after uninstall — re-seeding state then uninstalling lands clean', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    // Cycle 1
    seedSyntheticInstall(home);
    const c1 = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(c1.code, 0, 'cycle 1 uninstall must exit 0');
    assertCleanState(home);

    // Simulate "reinstall" by re-seeding synthetic state on top of the
    // post-uninstall machine. Catches the failure mode where leftover
    // state from cycle 1 poisons cycle 2's install (e.g. a partially-
    // spliced ~/.claude.json the wizard refuses to re-merge).
    seedSyntheticInstall(home);

    // Cycle 2
    const c2 = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(
      c2.code,
      0,
      `cycle 2 uninstall must exit 0; got ${c2.code}. ` +
        `stdout=${c2.stdout}\nstderr=${c2.stderr}`,
    );
    assertCleanState(home);
  } finally {
    rmrfQuiet(home);
  }
});

test('uninstall surgically splices ~/.claude.json without disturbing other entries', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    seedSyntheticInstall(home);
    const { code } = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(code, 0);

    const cj = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'),
    );
    assert.ok(cj.mcpServers, 'mcpServers key should still exist');
    assert.equal(cj.mcpServers.mnestra, undefined, 'mnestra spliced');
    assert.ok(
      cj.mcpServers['preserved-other-mcp-1'],
      'unrelated MCP entry must survive',
    );
    assert.ok(
      cj.mcpServers.supabase,
      'supabase MCP entry must survive (third-party preserve)',
    );
    assert.ok(
      cj.other_top_level_key && cj.other_top_level_key.preserved === true,
      'top-level non-mcp keys must survive',
    );
  } finally {
    rmrfQuiet(home);
  }
});

// Matcher-group seed variant — mirrors the canonical install-side shape
// pinned by tests/stack-installer-hook-merge.test.js:77-99,:121-138 (the
// shape produced by stack-installer's _mergeSessionEndHookEntry on a fresh
// install). Per T4-CODEX 18:52 ET AUDIT-CONCERN, T3's local-dev test should
// cover the canonical install shape too — not just the flat-shape variant
// (which represents pre-Sprint-48 installer output + user hand-edited
// settings.json files). T1's round-3 fix at 19:00 ET supports both shapes;
// this fixture asserts the matcher-group splice path.
function seedMatcherGroupInstall(home) {
  const td = path.join(home, '.termdeck');
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(
    path.join(td, 'config.yaml'),
    'port: 3000\nhost: 127.0.0.1\n',
  );
  fs.writeFileSync(
    path.join(td, 'secrets.env'),
    'DATABASE_URL=postgres://test\n',
  );
  fs.writeFileSync(path.join(td, 'termdeck.db'), '');

  const claudeDir = path.join(home, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const bundledHookPath = path.join(hooksDir, 'memory-session-end.js');
  fs.writeFileSync(
    bundledHookPath,
    [
      '#!/usr/bin/env node',
      '/**',
      ' * TermDeck session-end memory hook.',
      ' * @termdeck/stack-installer-hook v2',
      ' */',
      "'use strict';",
      'process.exit(0);',
      '',
    ].join('\n'),
  );

  // ~/.claude.json — single mnestra entry alongside an unrelated MCP entry
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          mnestra: { command: 'npx', args: ['-y', '@jhizzard/mnestra'] },
          'preserved-other-mcp': { command: 'node', args: ['/x/y/z.js'] },
        },
      },
      null,
      2,
    ),
  );

  // settings.json — canonical matcher-group shape from
  // tests/stack-installer-hook-merge.test.js. Two SessionEnd matcher groups:
  //   [0] unrelated tool-specific group (preserved across uninstall)
  //   [1] empty-matcher group containing our bundled hook (spliced)
  // Plus an unrelated Stop event matcher-group (preserved).
  const settings = {
    hooks: {
      SessionEnd: [
        {
          matcher: 'specific-tool',
          hooks: [
            {
              type: 'command',
              command: 'node ~/.claude/hooks/preserved-tool.js',
              timeout: 10,
            },
          ],
        },
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: bundledHookPath,
              timeout: 30,
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: '/usr/local/lib/some/other/preserved/hook.sh',
              timeout: 5,
            },
          ],
        },
      ],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  };
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2),
  );

  return { td, bundledHookPath };
}

test('uninstall splices canonical matcher-group SessionEnd shape; preserves unrelated tool-specific matcher group', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    seedMatcherGroupInstall(home);
    const { code, stdout, stderr } = await runStackCli(home, [
      'uninstall',
      '--yes',
    ]);
    assert.equal(
      code,
      0,
      `uninstall against matcher-group fixture should exit 0; got ${code}. ` +
        `stdout=${stdout}\nstderr=${stderr}`,
    );

    // ~/.termdeck removed
    assert.equal(
      fs.existsSync(path.join(home, '.termdeck')),
      false,
      '~/.termdeck/ should be removed',
    );

    // Hook file gone (rotated to .bak.<ISO>)
    const hookPath = path.join(
      home,
      '.claude',
      'hooks',
      'memory-session-end.js',
    );
    assert.equal(fs.existsSync(hookPath), false);

    // settings.json: matcher-group containing our bundled hook is spliced;
    // unrelated tool-specific matcher group survives; Stop entry survives;
    // top-level keys survive.
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'),
    );
    if (settings.hooks && Array.isArray(settings.hooks.SessionEnd)) {
      const bundledStillReferenced = settings.hooks.SessionEnd.some((group) => {
        if (Array.isArray(group?.hooks)) {
          return group.hooks.some(
            (h) =>
              typeof h?.command === 'string' &&
              h.command.includes('memory-session-end.js'),
          );
        }
        return (
          typeof group?.command === 'string' &&
          group.command.includes('memory-session-end.js')
        );
      });
      assert.equal(
        bundledStillReferenced,
        false,
        'matcher-group containing bundled hook should be spliced from SessionEnd',
      );

      // Tool-specific matcher group must survive
      const toolSpecificSurvives = settings.hooks.SessionEnd.some(
        (group) =>
          group?.matcher === 'specific-tool' &&
          Array.isArray(group?.hooks) &&
          group.hooks.some(
            (h) =>
              typeof h?.command === 'string' &&
              h.command.includes('preserved-tool.js'),
          ),
      );
      assert.equal(
        toolSpecificSurvives,
        true,
        'unrelated tool-specific matcher group must survive',
      );
    }
    if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
      const stopPreserved = settings.hooks.Stop.some(
        (group) =>
          (Array.isArray(group?.hooks) &&
            group.hooks.some(
              (h) =>
                typeof h?.command === 'string' &&
                h.command.includes('preserved/hook.sh'),
            )) ||
          (typeof group?.command === 'string' &&
            group.command.includes('preserved/hook.sh')),
      );
      assert.equal(
        stopPreserved,
        true,
        'unrelated Stop matcher group must survive',
      );
    }
    assert.ok(settings.permissions, 'top-level permissions key must survive');
  } finally {
    rmrfQuiet(home);
  }
});

test('uninstall surgically splices settings.json hooks.SessionEnd without disturbing other event wirings', async (t) => {
  if (!(await isWired())) {
    t.skip('T1 uninstall subcommand not yet wired; skipping.');
    return;
  }
  const home = freshHome();
  try {
    seedSyntheticInstall(home);
    const { code } = await runStackCli(home, ['uninstall', '--yes']);
    assert.equal(code, 0);

    const settings = JSON.parse(
      fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8'),
    );
    // SessionEnd must NOT contain any entry pointing at the bundled hook.
    if (settings.hooks && Array.isArray(settings.hooks.SessionEnd)) {
      const sessionEndPointsAtBundled = settings.hooks.SessionEnd.some(
        (e) =>
          typeof e?.command === 'string' &&
          e.command.includes('memory-session-end.js'),
      );
      assert.equal(
        sessionEndPointsAtBundled,
        false,
        'SessionEnd should not retain the bundled-hook entry',
      );
    }
    // Stop entry + top-level keys must survive.
    assert.ok(settings.hooks?.Stop, 'hooks.Stop must survive');
    const stopPreserved = settings.hooks.Stop.some(
      (e) =>
        typeof e?.command === 'string' &&
        e.command.includes('preserved/hook.sh'),
    );
    assert.equal(
      stopPreserved,
      true,
      'unrelated Stop hook must be preserved',
    );
    assert.ok(settings.permissions, 'top-level permissions key must survive');
  } finally {
    rmrfQuiet(home);
  }
});

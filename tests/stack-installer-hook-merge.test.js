// Regression tests for stack-installer's session-end hook bundling
// (Sprint 36 T4 — packages/stack-installer/src/index.js).
//
// Two surfaces under test:
//   1. The pure merge primitive _mergeSessionEndHookEntry(settings) that mutates
//      a parsed ~/.claude/settings.json object to include our Stop-hook entry.
//      Idempotent — running twice produces no change after the first call.
//   2. The orchestrator installSessionEndHook(opts) that drives prompt → file
//      copy → settings.json merge end-to-end against an isolated temp dir.
//
// Why both: the merge primitive is the contract Joshua-and-fresh-users-alike
// depend on for "don't clobber my settings." The orchestrator test pins the
// idempotent-second-run behavior end-to-end, including byte-identical
// settings.json on rerun.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installer = require(path.resolve(
  __dirname, '..', 'packages', 'stack-installer', 'src', 'index.js'
));
const {
  _mergeSessionEndHookEntry,
  _readSettingsJson,
  _writeSettingsJson,
  _isSessionEndHookEntry,
  _compareHookFiles,
  installSessionEndHook,
  HOOK_COMMAND,
  HOOK_TIMEOUT_SECONDS,
  HOOK_SOURCE,
} = installer;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stack-installer-hook-test-'));
}

// Suppress installer's stdout chatter during tests by swapping the write
// function. Each test that drives installSessionEndHook wraps with this.
function silenceStdout(fn) {
  return async () => {
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
  };
}

// ── _isSessionEndHookEntry ──────────────────────────────────────────

test('_isSessionEndHookEntry recognizes our hook by command substring', () => {
  assert.equal(_isSessionEndHookEntry({ command: 'node ~/.claude/hooks/memory-session-end.js' }), true);
  assert.equal(_isSessionEndHookEntry({ command: 'node /Users/x/.claude/hooks/memory-session-end.js' }), true);
  assert.equal(_isSessionEndHookEntry({ command: 'node $HOME/.claude/hooks/memory-session-end.js' }), true);
});

test('_isSessionEndHookEntry rejects unrelated entries and bad input', () => {
  // Function uses && short-circuit so falsy-but-not-`false` is fine —
  // assert truthiness shape, not strict-equal-false.
  assert.ok(!_isSessionEndHookEntry({ command: 'node ~/.claude/hooks/other-hook.js' }));
  assert.ok(!_isSessionEndHookEntry({ command: '' }));
  assert.ok(!_isSessionEndHookEntry({}));
  assert.ok(!_isSessionEndHookEntry(null));
  assert.ok(!_isSessionEndHookEntry(undefined));
});

// ── _mergeSessionEndHookEntry ───────────────────────────────────────

test('merge into empty settings creates the full hooks.Stop structure', () => {
  const settings = {};
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.ok(Array.isArray(settings.hooks.Stop));
  assert.equal(settings.hooks.Stop.length, 1);
  const group = settings.hooks.Stop[0];
  assert.equal(group.matcher, '');
  assert.equal(group.hooks.length, 1);
  assert.deepEqual(group.hooks[0], {
    type: 'command',
    command: HOOK_COMMAND,
    timeout: HOOK_TIMEOUT_SECONDS,
  });
});

test('merge into settings with empty hooks.Stop appends a new matcher group', () => {
  const settings = { hooks: { Stop: [] } };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].matcher, '');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);
});

test('merge appends into an existing empty-matcher group rather than creating a new one', () => {
  const settings = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/other.js', timeout: 10 }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.Stop.length, 1, 'no new matcher group created');
  assert.equal(settings.hooks.Stop[0].hooks.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node ~/.claude/hooks/other.js');
  assert.equal(settings.hooks.Stop[0].hooks[1].command, HOOK_COMMAND);
});

test('merge with a non-empty matcher group present creates a new empty-matcher group', () => {
  const settings = {
    hooks: {
      Stop: [
        {
          matcher: 'specific-tool',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/specific.js' }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].matcher, 'specific-tool');
  assert.equal(settings.hooks.Stop[1].matcher, '');
  assert.equal(settings.hooks.Stop[1].hooks[0].command, HOOK_COMMAND);
});

test('merge is idempotent — second invocation reports already-installed and does not duplicate', () => {
  const settings = {};
  _mergeSessionEndHookEntry(settings);
  const before = JSON.stringify(settings);
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'already-installed');
  assert.equal(JSON.stringify(settings), before, 'second merge is a no-op');
});

test('merge detects pre-existing hook in any matcher group regardless of matcher value', () => {
  const settings = {
    hooks: {
      Stop: [
        {
          matcher: 'somefilter',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js' }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'already-installed');
  assert.equal(settings.hooks.Stop.length, 1, 'no new group added when already present');
});

test('merge preserves unrelated top-level keys and unrelated hooks (PreToolUse, etc)', () => {
  const settings = {
    permissions: { allow: ['Bash(git status)'] },
    enabledPlugins: ['vercel-plugin'],
    skipAutoPermissionPrompt: false,
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo before' }] }],
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo start' }] }],
    },
  };
  _mergeSessionEndHookEntry(settings);
  assert.deepEqual(settings.permissions, { allow: ['Bash(git status)'] });
  assert.deepEqual(settings.enabledPlugins, ['vercel-plugin']);
  assert.equal(settings.skipAutoPermissionPrompt, false);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo before');
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo start');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);
});

test('merge tolerates a non-object hooks key by replacing it (defensive)', () => {
  const settings = { hooks: 'invalid' };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(typeof settings.hooks, 'object');
  assert.ok(Array.isArray(settings.hooks.Stop));
});

test('merge accepts custom command and timeout via opts', () => {
  const settings = {};
  _mergeSessionEndHookEntry(settings, { command: 'node /custom/path.js', timeout: 5 });
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node /custom/path.js');
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 5);
});

// ── _readSettingsJson / _writeSettingsJson ──────────────────────────

test('_readSettingsJson returns no-file status when path does not exist', () => {
  const dir = freshTmpDir();
  const r = _readSettingsJson(path.join(dir, 'nope.json'));
  assert.equal(r.status, 'no-file');
  assert.deepEqual(r.settings, {});
});

test('_readSettingsJson returns empty status for whitespace-only file', () => {
  const dir = freshTmpDir();
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, '   \n  ');
  const r = _readSettingsJson(p);
  assert.equal(r.status, 'empty');
});

test('_readSettingsJson returns malformed for invalid JSON', () => {
  const dir = freshTmpDir();
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, '{ "broken": ');
  const r = _readSettingsJson(p);
  assert.equal(r.status, 'malformed');
  assert.ok(r.error);
});

test('_readSettingsJson returns malformed for non-object top-level (array)', () => {
  const dir = freshTmpDir();
  const p = path.join(dir, 'settings.json');
  fs.writeFileSync(p, '[1, 2, 3]');
  const r = _readSettingsJson(p);
  assert.equal(r.status, 'malformed');
});

test('_writeSettingsJson writes mode 0600 atomically', () => {
  const dir = freshTmpDir();
  const p = path.join(dir, 'sub', 'settings.json'); // sub-dir auto-created
  _writeSettingsJson(p, { hooks: { Stop: [] } });
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.equal(stat.mode & 0o777, 0o600);
  // Tmp file should not be lying around.
  assert.equal(fs.existsSync(p + '.tmp'), false);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(parsed, { hooks: { Stop: [] } });
});

// ── _compareHookFiles ───────────────────────────────────────────────

test('_compareHookFiles returns missing-dest when destination does not exist', () => {
  const dir = freshTmpDir();
  const src = path.join(dir, 'src.js');
  fs.writeFileSync(src, 'hello');
  assert.equal(_compareHookFiles(src, path.join(dir, 'dest.js')), 'missing-dest');
});

test('_compareHookFiles returns identical for byte-identical files', () => {
  const dir = freshTmpDir();
  const src = path.join(dir, 'src.js');
  const dest = path.join(dir, 'dest.js');
  fs.writeFileSync(src, 'hello world');
  fs.writeFileSync(dest, 'hello world');
  assert.equal(_compareHookFiles(src, dest), 'identical');
});

test('_compareHookFiles returns different for byte-divergent files', () => {
  const dir = freshTmpDir();
  const src = path.join(dir, 'src.js');
  const dest = path.join(dir, 'dest.js');
  fs.writeFileSync(src, 'hello world');
  fs.writeFileSync(dest, 'hello earth');
  assert.equal(_compareHookFiles(src, dest), 'different');
});

// ── installSessionEndHook (orchestrator integration) ────────────────

test('installSessionEndHook on fresh dir copies file and merges settings.json', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE,
    destPath,
    settingsPath,
    promptInstall: async () => true,
  });

  assert.equal(result.fileStatus, 'copied');
  assert.equal(result.settingsStatus, 'installed');
  assert.ok(fs.existsSync(destPath));
  assert.ok(fs.existsSync(settingsPath));
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);

  // File contents byte-identical to vendored source.
  assert.ok(fs.readFileSync(HOOK_SOURCE).equals(fs.readFileSync(destPath)));
}));

test('installSessionEndHook is idempotent — second invocation produces zero diff', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
  });
  const settingsAfterFirst = fs.readFileSync(settingsPath, 'utf8');
  const hookAfterFirst = fs.readFileSync(destPath);

  const second = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
  });

  assert.equal(second.fileStatus, 'already-current');
  assert.equal(second.settingsStatus, 'already-installed');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsAfterFirst, 'settings.json byte-identical');
  assert.ok(fs.readFileSync(destPath).equals(hookAfterFirst), 'hook file byte-identical');
}));

test('installSessionEndHook honors user decline — no file, no settings change', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => false,
  });

  assert.equal(result.fileStatus, 'declined');
  assert.equal(result.settingsStatus, 'declined');
  assert.equal(fs.existsSync(destPath), false);
  assert.equal(fs.existsSync(settingsPath), false);
}));

test('installSessionEndHook with existing different hook prompts and respects keep-existing default', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, '// older Joshua-customized version\n');
  const originalBytes = fs.readFileSync(destPath);

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
    promptOverwrite: async () => false, // user declines overwrite
  });

  assert.equal(result.fileStatus, 'kept-existing');
  // Settings.json merge should still proceed (the file is the user's; the
  // settings entry is what makes Claude Code call it).
  assert.equal(result.settingsStatus, 'installed');
  assert.ok(fs.readFileSync(destPath).equals(originalBytes), 'existing hook untouched');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);
}));

test('installSessionEndHook with existing different hook + overwrite=true replaces it', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, '// stale version\n');

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
    promptOverwrite: async () => true,
  });

  assert.equal(result.fileStatus, 'overwritten');
  assert.ok(fs.readFileSync(HOOK_SOURCE).equals(fs.readFileSync(destPath)));
}));

test('installSessionEndHook preserves unrelated settings.json keys end-to-end', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  const original = {
    permissions: { allow: ['Bash(git status)', 'Bash(npm test)'] },
    enabledPlugins: ['vercel-plugin'],
    extraKnownMarketplaces: ['some-marketplace'],
    skipAutoPermissionPrompt: false,
    agentPushNotifEnabled: true,
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo before' }] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

  await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
  });

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.enabledPlugins, original.enabledPlugins);
  assert.deepEqual(after.extraKnownMarketplaces, original.extraKnownMarketplaces);
  assert.equal(after.skipAutoPermissionPrompt, false);
  assert.equal(after.agentPushNotifEnabled, true);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'echo before');
  assert.equal(after.hooks.Stop[0].hooks[0].command, HOOK_COMMAND);
}));

test('installSessionEndHook with malformed settings.json reports without modifying file', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  const malformed = '{ "broken": ';
  fs.writeFileSync(settingsPath, malformed);

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath,
    promptInstall: async () => true,
  });

  assert.equal(result.fileStatus, 'copied'); // file copy still happens
  assert.equal(result.settingsStatus, 'malformed');
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformed, 'malformed file untouched');
}));

test('installSessionEndHook dry-run touches nothing', silenceStdout(async () => {
  const dir = freshTmpDir();
  const destPath = path.join(dir, 'hooks', 'memory-session-end.js');
  const settingsPath = path.join(dir, 'settings.json');

  const result = await installSessionEndHook({
    sourcePath: HOOK_SOURCE, destPath, settingsPath, dryRun: true,
    promptInstall: async () => true,
  });

  assert.equal(result.fileStatus, 'would-copy');
  assert.equal(result.settingsStatus, 'would-install');
  assert.equal(fs.existsSync(destPath), false);
  assert.equal(fs.existsSync(settingsPath), false);
}));

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

test('merge into empty settings creates the full hooks.SessionEnd structure', () => {
  const settings = {};
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.ok(Array.isArray(settings.hooks.SessionEnd));
  assert.equal(settings.hooks.SessionEnd.length, 1);
  const group = settings.hooks.SessionEnd[0];
  assert.equal(group.matcher, '');
  assert.equal(group.hooks.length, 1);
  assert.deepEqual(group.hooks[0], {
    type: 'command',
    command: HOOK_COMMAND,
    timeout: HOOK_TIMEOUT_SECONDS,
  });
});

test('merge into settings with empty hooks.SessionEnd appends a new matcher group', () => {
  const settings = { hooks: { SessionEnd: [] } };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.SessionEnd.length, 1);
  assert.equal(settings.hooks.SessionEnd[0].matcher, '');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('merge appends into an existing empty-matcher group rather than creating a new one', () => {
  const settings = {
    hooks: {
      SessionEnd: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/other.js', timeout: 10 }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.SessionEnd.length, 1, 'no new matcher group created');
  assert.equal(settings.hooks.SessionEnd[0].hooks.length, 2);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, 'node ~/.claude/hooks/other.js');
  assert.equal(settings.hooks.SessionEnd[0].hooks[1].command, HOOK_COMMAND);
});

test('merge with a non-empty matcher group present creates a new empty-matcher group', () => {
  const settings = {
    hooks: {
      SessionEnd: [
        {
          matcher: 'specific-tool',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/specific.js' }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(settings.hooks.SessionEnd.length, 2);
  assert.equal(settings.hooks.SessionEnd[0].matcher, 'specific-tool');
  assert.equal(settings.hooks.SessionEnd[1].matcher, '');
  assert.equal(settings.hooks.SessionEnd[1].hooks[0].command, HOOK_COMMAND);
});

test('merge is idempotent — second invocation reports already-installed and does not duplicate', () => {
  const settings = {};
  _mergeSessionEndHookEntry(settings);
  const before = JSON.stringify(settings);
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'already-installed');
  assert.equal(JSON.stringify(settings), before, 'second merge is a no-op');
});

test('merge migrates pre-Sprint-48 Stop registration to SessionEnd', () => {
  // Simulate an install from @jhizzard/termdeck-stack@<=0.5.0 where the
  // hook was wired under hooks.Stop. The merge function should detect our
  // hook in Stop, remove it, and add it to SessionEnd. Status reports
  // 'migrated-from-stop' so the wizard can tell the user the migration
  // happened (and explains why their session-summary rows might suddenly
  // start landing).
  const settings = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 30 }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'migrated-from-stop');
  assert.equal(settings.hooks.Stop, undefined, 'orphaned Stop key removed');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('merge migration preserves unrelated Stop hooks that are NOT ours', () => {
  // The user might have a separate Stop hook (e.g. a personal logger).
  // The migration must only touch entries matching our hook command;
  // anything else stays put under Stop.
  const settings = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js', timeout: 30 },
            { type: 'command', command: 'node ~/my-personal-logger.js' },
          ],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'migrated-from-stop');
  assert.ok(Array.isArray(settings.hooks.Stop), 'Stop key kept because the user-owned logger is still there');
  assert.equal(settings.hooks.Stop[0].hooks.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node ~/my-personal-logger.js');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('merge detects pre-existing hook in any matcher group regardless of matcher value', () => {
  const settings = {
    hooks: {
      SessionEnd: [
        {
          matcher: 'somefilter',
          hooks: [{ type: 'command', command: 'node ~/.claude/hooks/memory-session-end.js' }],
        },
      ],
    },
  };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'already-installed');
  assert.equal(settings.hooks.SessionEnd.length, 1, 'no new group added when already present');
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
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
});

test('merge tolerates a non-object hooks key by replacing it (defensive)', () => {
  const settings = { hooks: 'invalid' };
  const { status } = _mergeSessionEndHookEntry(settings);
  assert.equal(status, 'installed');
  assert.equal(typeof settings.hooks, 'object');
  assert.ok(Array.isArray(settings.hooks.SessionEnd));
});

test('merge accepts custom command and timeout via opts', () => {
  const settings = {};
  _mergeSessionEndHookEntry(settings, { command: 'node /custom/path.js', timeout: 5 });
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, 'node /custom/path.js');
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, 5);
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
  _writeSettingsJson(p, { hooks: { SessionEnd: [] } });
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.equal(stat.mode & 0o777, 0o600);
  // Tmp file should not be lying around.
  assert.equal(fs.existsSync(p + '.tmp'), false);
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(parsed, { hooks: { SessionEnd: [] } });
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
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);

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
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
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
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, HOOK_COMMAND);
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

// ── bundled hook content tests ──────────────────────────────────────
// Sprint 38 P0: the hook itself was rewritten from rag-system-delegation
// to direct OpenAI embeddings + Supabase REST. These tests pin the new
// contract (env-var validation, transcript-summary extraction, OpenAI
// call signature, Supabase POST shape) by importing the hook module
// and exercising its exported helpers with mocked fetch.

const hookModule = require(path.resolve(
  __dirname, '..', 'packages', 'stack-installer', 'assets', 'hooks', 'memory-session-end.js'
));
const {
  detectProject,
  readEnv,
  buildSummary,
  embedText,
  postMemoryItem,
  processStdinPayload,
  PROJECT_MAP,
} = hookModule;

// Drop the LOG_FILE so test runs don't pollute the user's hook log.
// The hook's `log()` is fail-soft (try/catch around appendFileSync), so
// pointing it at a non-writable path is safe — errors swallow.
process.env.HOME = process.env.HOME; // keep real HOME; the hook's log is fail-soft

function freshTmpFile(content) {
  const p = path.join(os.tmpdir(), `hook-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, content);
  return p;
}

function withMockedFetch(impl, fn) {
  return async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try { await fn(); } finally { globalThis.fetch = orig; }
  };
}

function withEnv(vars, fn) {
  return async () => {
    const restore = {};
    for (const k of Object.keys(vars)) {
      restore[k] = process.env[k];
      if (vars[k] === null) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try { await fn(); }
    finally {
      for (const k of Object.keys(restore)) {
        if (restore[k] === undefined) delete process.env[k];
        else process.env[k] = restore[k];
      }
    }
  };
}

test('PROJECT_MAP defaults to empty (users extend in place)', () => {
  assert.equal(Array.isArray(PROJECT_MAP), true);
  assert.equal(PROJECT_MAP.length, 0, 'bundled hook ships with no project mappings — users add their own');
});

test('detectProject returns "global" with empty PROJECT_MAP', () => {
  assert.equal(detectProject('/Users/whatever/some/project'), 'global');
  assert.equal(detectProject(''), 'global');
});

test('detectProject matches when entries are added at runtime',
  // PROJECT_MAP is a const exported reference; mutating it is the same
  // as what users do when editing the file. Push, test, pop.
  () => {
    PROJECT_MAP.push({ pattern: /\/myproject\//i, project: 'my-project' });
    try {
      assert.equal(detectProject('/Users/x/myproject/src'), 'my-project');
      assert.equal(detectProject('/Users/x/other/dir'), 'global');
    } finally {
      PROJECT_MAP.length = 0;
    }
  }
);

// Sprint 48 close-out: readEnv() now calls loadTermdeckSecretsFallback()
// before validating, so tests pin TERMDECK_HOOK_SECRETS_PATH at a non-
// existent path to keep the fallback a no-op. Otherwise the developer's
// real ~/.termdeck/secrets.env would leak in and these tests would
// false-pass with concrete values.
test('readEnv returns null + logs when SUPABASE_URL missing', withEnv({
  SUPABASE_URL: null,
  SUPABASE_SERVICE_ROLE_KEY: 'k', OPENAI_API_KEY: 'sk-x',
  TERMDECK_HOOK_SECRETS_PATH: '/nonexistent/secrets.env',
}, () => {
  assert.equal(readEnv(), null);
}));

test('readEnv returns null when all three missing', withEnv({
  SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null, OPENAI_API_KEY: null,
  TERMDECK_HOOK_SECRETS_PATH: '/nonexistent/secrets.env',
}, () => {
  assert.equal(readEnv(), null);
}));

test('readEnv returns trimmed config with all three present', withEnv({
  SUPABASE_URL: 'https://abc.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-value',
  OPENAI_API_KEY: 'sk-test',
  TERMDECK_HOOK_SECRETS_PATH: '/nonexistent/secrets.env',
}, () => {
  const env = readEnv();
  assert.equal(env.supabaseUrl, 'https://abc.supabase.co'); // trailing slash stripped
  assert.equal(env.supabaseKey, 'service-key-value');
  assert.equal(env.openaiKey, 'sk-test');
}));

test('readEnv loads ~/.termdeck/secrets.env when env vars are missing', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `termdeck-test-secrets-${Date.now()}.env`);
  fs.writeFileSync(tmp,
    'SUPABASE_URL=https://from-secrets.supabase.co\n' +
    'SUPABASE_SERVICE_ROLE_KEY=secrets-key\n' +
    'OPENAI_API_KEY="sk-from-quoted"\n'
  );
  return withEnv({
    SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null, OPENAI_API_KEY: null,
    TERMDECK_HOOK_SECRETS_PATH: tmp,
  }, () => {
    try {
      const env = readEnv();
      assert.ok(env, 'readEnv should return a config when fallback fires');
      assert.equal(env.supabaseUrl, 'https://from-secrets.supabase.co');
      assert.equal(env.supabaseKey, 'secrets-key');
      assert.equal(env.openaiKey, 'sk-from-quoted'); // quotes stripped
    } finally {
      fs.unlinkSync(tmp);
    }
  })();
});

test('readEnv treats unexpanded ${VAR} placeholders as missing', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `termdeck-test-secrets-${Date.now()}-pl.env`);
  fs.writeFileSync(tmp,
    'SUPABASE_URL=https://override.supabase.co\n' +
    'SUPABASE_SERVICE_ROLE_KEY=override-key\n' +
    'OPENAI_API_KEY=sk-override\n'
  );
  return withEnv({
    // process.env contains the broken placeholder shape from a buggy MCP
    // wiring or stack-installer regression — the fallback should override.
    SUPABASE_URL: '${SUPABASE_URL}',
    SUPABASE_SERVICE_ROLE_KEY: '${SUPABASE_SERVICE_ROLE_KEY}',
    OPENAI_API_KEY: '${OPENAI_API_KEY}',
    TERMDECK_HOOK_SECRETS_PATH: tmp,
  }, () => {
    try {
      const env = readEnv();
      assert.ok(env, 'placeholder-shaped values must not block the fallback');
      assert.equal(env.supabaseUrl, 'https://override.supabase.co');
      assert.equal(env.supabaseKey, 'override-key');
      assert.equal(env.openaiKey, 'sk-override');
    } finally {
      fs.unlinkSync(tmp);
    }
  })();
});

test('buildSummary returns null for missing transcript file', () => {
  assert.equal(buildSummary('/nonexistent/transcript.jsonl'), null);
});

test('buildSummary returns null when fewer than 5 messages', () => {
  const lines = [
    { message: { role: 'user', content: 'hi' } },
    { message: { role: 'assistant', content: 'hello' } },
  ].map(JSON.stringify).join('\n');
  const p = freshTmpFile(lines);
  try {
    assert.equal(buildSummary(p), null);
  } finally { fs.unlinkSync(p); }
});

test('buildSummary builds header + tail of message excerpts', () => {
  const lines = [];
  for (let i = 0; i < 8; i++) {
    lines.push(JSON.stringify({ message: { role: i % 2 ? 'assistant' : 'user', content: `msg-${i}` } }));
  }
  const p = freshTmpFile(lines.join('\n'));
  try {
    const summary = buildSummary(p);
    assert.match(summary, /^Session with 8 messages\./);
    assert.match(summary, /\[user\] msg-0/);
    assert.match(summary, /\[assistant\] msg-7/);
  } finally { fs.unlinkSync(p); }
});

test('buildSummary handles array-shape content (Claude Code format)', () => {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({
      message: {
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: `block-${i}` }, { type: 'tool_use', input: {} }],
      },
    }));
  }
  const p = freshTmpFile(lines.join('\n'));
  try {
    const summary = buildSummary(p);
    assert.match(summary, /block-0/);
    assert.match(summary, /block-5/);
  } finally { fs.unlinkSync(p); }
});

test('buildSummary truncates to 7000 chars', () => {
  // Each message body is sliced to 400 chars in the tail builder.
  // We need at least ceil(7000 / ~410-with-prefix) ≈ 18 tail messages
  // to push the joined output past the 7000 cap. Use 30+ to be sure.
  const big = 'x'.repeat(500); // larger than the 400-char per-message cap
  const lines = Array.from({ length: 35 }, (_, i) =>
    JSON.stringify({ message: { role: i % 2 ? 'assistant' : 'user', content: big } })
  ).join('\n');
  const p = freshTmpFile(lines);
  try {
    const summary = buildSummary(p);
    assert.equal(summary.length, 7000);
  } finally { fs.unlinkSync(p); }
});

test('buildSummary skips malformed JSONL lines without crashing', () => {
  const lines = [
    'NOT VALID JSON',
    JSON.stringify({ message: { role: 'user', content: 'a' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'b' } }),
    JSON.stringify({ message: { role: 'user', content: 'c' } }),
    JSON.stringify({ message: { role: 'assistant', content: 'd' } }),
    JSON.stringify({ message: { role: 'user', content: 'e' } }),
    'ALSO NOT JSON',
  ].join('\n');
  const p = freshTmpFile(lines);
  try {
    const summary = buildSummary(p);
    assert.match(summary, /Session with 5 messages\./);
  } finally { fs.unlinkSync(p); }
});

// Sprint 45 T2: Gemini transcript format (single JSON object, NOT JSONL).
// Pins the stop-gap dispatch in buildSummary so a Gemini-shape transcript
// produces the same summary header + tail as Claude/Codex JSONL formats.
test('buildSummary handles Gemini single-JSON-object transcript', () => {
  const messages = [];
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0) {
      messages.push({
        id: `id-${i}`,
        timestamp: '2026-05-01T18:38:38.699Z',
        type: 'user',
        content: [{ text: `gem-msg-${i}` }],
      });
    } else {
      messages.push({
        id: `id-${i}`,
        timestamp: '2026-05-01T18:38:40.438Z',
        type: 'gemini',
        content: `gem-msg-${i}`,
        thoughts: [],
        tokens: { input: 100, output: 5, total: 105 },
        model: 'gemini-3-flash-preview',
      });
    }
  }
  const transcript = JSON.stringify({
    sessionId: 'ae971ece-a035-4f37-953d-083b41dcbfcc',
    projectHash: '07218df2',
    startTime: '2026-05-01T18:38:38.699Z',
    lastUpdated: '2026-05-01T18:38:40.438Z',
    kind: 'main',
    messages,
  });
  const p = freshTmpFile(transcript);
  try {
    const summary = buildSummary(p);
    assert.match(summary, /^Session with 6 messages\./,
      'Gemini transcript should yield a 6-message summary');
    assert.match(summary, /\[user\] gem-msg-0/);
    assert.match(summary, /\[assistant\] gem-msg-5/,
      'type=gemini → role=assistant in the summary header');
  } finally { fs.unlinkSync(p); }
});

test('buildSummary Gemini-detection does NOT swallow Claude JSONL', () => {
  // A Claude JSONL file's first line starts with `{` and parses as JSON,
  // but JSON.parse on the WHOLE file fails (multi-line concatenated objects).
  // Make sure the Gemini short-circuit's try/catch falls through cleanly.
  const lines = Array.from({ length: 6 }, (_, i) =>
    JSON.stringify({ message: { role: i % 2 ? 'assistant' : 'user', content: `claude-${i}` } })
  ).join('\n');
  const p = freshTmpFile(lines);
  try {
    const summary = buildSummary(p);
    assert.match(summary, /Session with 6 messages\./);
    assert.match(summary, /claude-0/);
    assert.match(summary, /claude-5/);
  } finally { fs.unlinkSync(p); }
});

test('embedText calls OpenAI with the right shape and returns embedding', withMockedFetch(
  async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['Authorization'], 'Bearer sk-fake');
    assert.equal(opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'text-embedding-3-small');
    assert.equal(body.input, 'sample summary');
    return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
  },
  async () => {
    const result = await embedText('sample summary', 'sk-fake');
    assert.deepEqual(result, [0.1, 0.2, 0.3]);
  }
));

test('embedText returns null on non-2xx HTTP', withMockedFetch(
  async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
  async () => {
    assert.equal(await embedText('text', 'sk-bad'), null);
  }
));

test('embedText returns null on fetch exception', withMockedFetch(
  async () => { throw new Error('network down'); },
  async () => {
    assert.equal(await embedText('text', 'sk-x'), null);
  }
));

test('postMemoryItem POSTs the right shape to /rest/v1/memory_items', withMockedFetch(
  async (url, opts) => {
    assert.equal(url, 'https://abc.supabase.co/rest/v1/memory_items');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.headers['apikey'], 'service-key');
    assert.equal(opts.headers['Authorization'], 'Bearer service-key');
    assert.equal(opts.headers['Prefer'], 'return=minimal');
    const body = JSON.parse(opts.body);
    assert.equal(body.content, 'summary text');
    assert.equal(body.embedding, '[0.1,0.2,0.3]');
    assert.equal(body.source_type, 'session_summary');
    assert.equal(body.category, 'workflow');
    assert.equal(body.project, 'termdeck');
    assert.equal(body.source_session_id, 'sess-abc');
    return { ok: true };
  },
  async () => {
    const ok = await postMemoryItem({
      supabaseUrl: 'https://abc.supabase.co',
      supabaseKey: 'service-key',
      content: 'summary text',
      embedding: [0.1, 0.2, 0.3],
      project: 'termdeck',
      sessionId: 'sess-abc',
    });
    assert.equal(ok, true);
  }
));

test('postMemoryItem returns false on non-2xx', withMockedFetch(
  async () => ({ ok: false, status: 400, text: async () => 'bad request' }),
  async () => {
    const ok = await postMemoryItem({
      supabaseUrl: 'https://abc.supabase.co',
      supabaseKey: 'k', content: 'c', embedding: [1, 2], project: 'p', sessionId: 's',
    });
    assert.equal(ok, false);
  }
));

test('postMemoryItem returns false on fetch exception', withMockedFetch(
  async () => { throw new Error('refused'); },
  async () => {
    const ok = await postMemoryItem({
      supabaseUrl: 'u', supabaseKey: 'k', content: 'c', embedding: [1], project: 'p', sessionId: 's',
    });
    assert.equal(ok, false);
  }
));

test('processStdinPayload skips on missing transcript_path', async () => {
  // No fetch should fire; if it does, this will throw via nullify.
  const orig = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('should not fetch'); };
  try {
    await processStdinPayload(JSON.stringify({ cwd: '/tmp' }));
  } finally { globalThis.fetch = orig; }
});

test('processStdinPayload skips on small transcript', async () => {
  const small = freshTmpFile('hi'); // 2 bytes
  try {
    const orig = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('should not fetch'); };
    try {
      await processStdinPayload(JSON.stringify({ transcript_path: small, cwd: '/tmp' }));
    } finally { globalThis.fetch = orig; }
  } finally { fs.unlinkSync(small); }
});

test('processStdinPayload end-to-end: env present + good transcript → embed + post fire', async () => {
  // Build a valid transcript above the 5KB threshold
  const lines = [];
  for (let i = 0; i < 25; i++) {
    lines.push(JSON.stringify({
      message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(300) },
    }));
  }
  const transcriptPath = freshTmpFile(lines.join('\n'));

  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url.includes('openai.com')) {
      return { ok: true, json: async () => ({ data: [{ embedding: new Array(1536).fill(0) }] }) };
    }
    return { ok: true };
  };

  const setEnv = withEnv({
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc',
    OPENAI_API_KEY: 'sk-x',
  }, withMockedFetch(fetchMock, async () => {
    await processStdinPayload(JSON.stringify({
      transcript_path: transcriptPath,
      cwd: '/Users/x/some/dir',
      session_id: 'sess-42',
    }));
  }));

  try {
    await setEnv();
    assert.equal(calls.length, 2, 'expected one OpenAI call + one Supabase call');
    assert.match(calls[0].url, /openai\.com\/v1\/embeddings/);
    assert.equal(calls[0].body.model, 'text-embedding-3-small');
    assert.match(calls[1].url, /\/rest\/v1\/memory_items$/);
    assert.equal(calls[1].body.source_type, 'session_summary');
    assert.equal(calls[1].body.project, 'global');
    assert.equal(calls[1].body.source_session_id, 'sess-42');
  } finally { fs.unlinkSync(transcriptPath); }
});

test('processStdinPayload skips when env vars missing (no fetch call)', async () => {
  const lines = Array.from({ length: 25 }, (_, i) =>
    JSON.stringify({ message: { role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(300) } })
  );
  const transcriptPath = freshTmpFile(lines.join('\n'));
  const orig = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('should not fetch'); };
  const setEnv = withEnv({
    SUPABASE_URL: null, SUPABASE_SERVICE_ROLE_KEY: null, OPENAI_API_KEY: null,
  }, async () => {
    await processStdinPayload(JSON.stringify({
      transcript_path: transcriptPath, cwd: '/Users/x/dir',
    }));
  });
  try {
    await setEnv();
  } finally {
    globalThis.fetch = orig;
    fs.unlinkSync(transcriptPath);
  }
});

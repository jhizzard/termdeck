// Sprint 64 T1 (ORCH SCOPE 16:29 ET item 4) — PTY env exclusion fence.
//
// Pins that management-grade tokens (Supabase PAT, GitHub PAT, OpenAI Admin
// key, NPM token) NEVER flow from ~/.termdeck/secrets.env into a spawned
// child PTY's env, even when an operator manually pastes one into the file
// post-install. Defense-in-depth complementing the T1 wizard's explicit
// non-persistence of `SUPABASE_ACCESS_TOKEN` (see
// `packages/cli/src/init.js` Phase 3 + the AUDIT-RED 16:26 resolution
// comment). Resolves T4-CODEX AUDIT-RED 2026-05-14 16:26 ET.
//
// Strategy: HOME-override harness via mkdtempSync — write a synthetic
// secrets.env containing both excluded keys AND legit per-project keys,
// reset the module-level cache, call `readTermdeckSecretsForPty()`, and
// assert the excluded keys are absent while the legit keys pass through.
//
// Run: node --test packages/cli/tests/spawn-env-exclusion.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readTermdeckSecretsForPty,
  _resetTermdeckSecretsCache,
  SECRETS_EXCLUDED_FROM_PTY,
  SECRETS_EXCLUDED_FROM_SPAWN_ENV,
  scrubSpawnEnv,
} = require('../../server/src/index');

const fakeSupabasePat = () => 'sbp_' + 'a'.repeat(41);
const fakeNpmToken = () => 'npm_' + 'a'.repeat(16);

// ─────────────────────────────────────────────────────────────────────────
// HOME-override harness.

function withTempHome(secretsEnvContent, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exclusion-test-'));
  fs.mkdirSync(path.join(tmp, '.termdeck'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.termdeck', 'secrets.env'), secretsEnvContent);
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  _resetTermdeckSecretsCache();
  try {
    return fn(tmp);
  } finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EXCLUSION list shape.

test('SECRETS_EXCLUDED_FROM_PTY — contains SUPABASE_ACCESS_TOKEN (AUDIT-RED 16:26 closure)', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY instanceof Set);
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_ACCESS_TOKEN'),
    'SUPABASE_ACCESS_TOKEN must be in PTY-env exclusion list');
});

test('SECRETS_EXCLUDED_FROM_PTY — contains GITHUB_TOKEN + GITHUB_PAT', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('GITHUB_TOKEN'));
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('GITHUB_PAT'));
});

test('SECRETS_EXCLUDED_FROM_PTY — contains OPENAI_ADMIN_KEY (distinct from per-project OPENAI_API_KEY)', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('OPENAI_ADMIN_KEY'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('OPENAI_API_KEY'),
    'OPENAI_API_KEY is per-project and MUST flow to the Mnestra hook env');
});

test('SECRETS_EXCLUDED_FROM_PTY — contains NPM_TOKEN', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_PTY.has('NPM_TOKEN'));
});

test('SECRETS_EXCLUDED_FROM_PTY — does NOT contain per-project keys (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL)', () => {
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_URL'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(!SECRETS_EXCLUDED_FROM_PTY.has('DATABASE_URL'));
});

// ─────────────────────────────────────────────────────────────────────────
// Sprint 71 B-T2 — THE BILLING FENCE.
//
// `ANTHROPIC_API_KEY` moved INTO the exclusion set on 2026-08-05. It used to
// be asserted OUT of it, two tests down — the assertion this block replaces.
// The reversal is not a preference; it is a billing-correctness invariant:
//
//   A Claude Code panel that inherits ANTHROPIC_API_KEY stops billing the
//   operator's subscription login and starts burning API credits — or, worse
//   for an unattended sprint, strands boot on the interactive "use the
//   detected API key?" dialog, which reads externally as a wedged panel.
//
// This is the fence the acceptance criterion names: it MUST go red the moment
// someone deletes 'ANTHROPIC_API_KEY' from SECRETS_EXCLUDED_FROM_PTY. Both
// halves are load-bearing and neither implies the other — the constant is the
// declaration, the merge is the behavior, and a filter bug could satisfy one
// while breaking the other.
//
// NOTE for anyone tempted to "fix" this back: the server-side consumers that
// legitimately need the key (session-logger and friends) read their own
// process env, NOT this merge. In-panel Mnestra write-time extraction degrades
// gracefully and rumen's extract-sweep backfills it nightly. Excluding the key
// here is loss-free for the running stack.

test('BILLING FENCE — ANTHROPIC_API_KEY is in SECRETS_EXCLUDED_FROM_PTY (declaration half)', () => {
  assert.ok(
    SECRETS_EXCLUDED_FROM_PTY.has('ANTHROPIC_API_KEY'),
    'ANTHROPIC_API_KEY must be excluded from the PTY env merge: a panel that '
    + 'inherits it bills API credits instead of the operator subscription, or '
    + 'strands boot on the detect-key dialog. See INSTALLER-PITFALLS ledger #23.',
  );
});

test('BILLING FENCE — ANTHROPIC_API_KEY in secrets.env never reaches the PTY env (behavior half)', () => {
  withTempHome(
    [
      'SUPABASE_URL=https://billing.supabase.co',
      'ANTHROPIC_API_KEY=sk-ant-api03-should_NOT_be_in_pty_env',
      'OPENAI_API_KEY=sk-proj-legit',
    ].join('\n') + '\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('ANTHROPIC_API_KEY' in out),
        'ANTHROPIC_API_KEY must be filtered out of the PTY env merge');
      // The sibling per-project keys are untouched — the fence is surgical,
      // not a blanket drop of everything provider-shaped.
      assert.equal(out.SUPABASE_URL, 'https://billing.supabase.co');
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-legit');
      assert.ok(!JSON.stringify(out).includes('should_NOT_be_in_pty_env'),
        'the key value must not survive anywhere in the merged env');
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Sprint 71 B-T2 — the INHERITED-ENV half of the billing fence.
//
// The secrets.env filter above cannot see a key the server process already
// carries, and the PTY spawn site builds its env from `...process.env`. These
// pin `scrubSpawnEnv`, which closes that path.

test('BILLING FENCE (inherited) — SECRETS_EXCLUDED_FROM_SPAWN_ENV contains ANTHROPIC_API_KEY', () => {
  assert.ok(SECRETS_EXCLUDED_FROM_SPAWN_ENV instanceof Set);
  assert.ok(SECRETS_EXCLUDED_FROM_SPAWN_ENV.has('ANTHROPIC_API_KEY'),
    'the inherited-env scrub is the only thing standing between a server '
    + 'launched from a key-exporting shell and every panel it spawns');
});

test('BILLING FENCE (inherited) — scrubSpawnEnv drops an inherited ANTHROPIC_API_KEY', () => {
  const out = scrubSpawnEnv(
    { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-inherited', TERM: 'xterm-256color' },
    {},
  );
  assert.ok(!('ANTHROPIC_API_KEY' in out));
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.TERM, 'xterm-256color');
});

test('BILLING FENCE (inherited) — scrubSpawnEnv is pure (input object untouched)', () => {
  const input = { ANTHROPIC_API_KEY: 'sk-ant-x', FOO: 'bar' };
  const out = scrubSpawnEnv(input, {});
  assert.equal(input.ANTHROPIC_API_KEY, 'sk-ant-x', 'must not mutate the caller\'s object');
  assert.ok(!('ANTHROPIC_API_KEY' in out));
  assert.notEqual(out, input, 'must return a fresh object');
});

test('BILLING FENCE (inherited) — TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY=1 restores inheritance', () => {
  const out = scrubSpawnEnv(
    { ANTHROPIC_API_KEY: 'sk-ant-deliberate' },
    { TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY: '1' },
  );
  assert.equal(out.ANTHROPIC_API_KEY, 'sk-ant-deliberate',
    'the escape hatch exists so an operator who genuinely wants API-credit '
    + 'billing in panels is not forced to patch the source');
});

test('BILLING FENCE (inherited) — the escape hatch is exact-match, not truthy', () => {
  for (const v of ['0', '', 'true', 'yes', 'TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY']) {
    const out = scrubSpawnEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' }, { TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY: v });
    assert.ok(!('ANTHROPIC_API_KEY' in out), `value ${JSON.stringify(v)} must NOT open the hatch`);
  }
});

test('BILLING FENCE (inherited) — scrub does NOT over-reach into keys panels legitimately use', () => {
  // Deliberately narrower than SECRETS_EXCLUDED_FROM_PTY: a panel running
  // `gh` may need GITHUB_TOKEN, and the secrets.env-merge exclusion is the
  // only contract those keys were ever given.
  const out = scrubSpawnEnv({
    GITHUB_TOKEN: 'ghp_x',
    SUPABASE_ACCESS_TOKEN: 'sbp_x',
    OPENAI_API_KEY: 'sk-proj-x',
    NPM_TOKEN: 'npm_x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
  }, {});
  assert.equal(out.GITHUB_TOKEN, 'ghp_x');
  assert.equal(out.SUPABASE_ACCESS_TOKEN, 'sbp_x');
  assert.equal(out.OPENAI_API_KEY, 'sk-proj-x');
  assert.equal(out.NPM_TOKEN, 'npm_x');
  assert.ok(!('ANTHROPIC_API_KEY' in out), 'only the billing key is scrubbed here');
});

test('BILLING FENCE (inherited) — the PTY spawn site actually calls scrubSpawnEnv', () => {
  // Source-level fence. The unit tests above prove the function is correct;
  // this proves it is WIRED. A correct scrubber that nobody calls is exactly
  // the shape of INSTALLER-PITFALLS Class M (architectural omission), and it
  // would pass every other assertion in this file.
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'server', 'src', 'index.js'), 'utf8',
  );
  const spawnCall = src.slice(src.indexOf('const term = pty.spawn(spawnShell, args, {'));
  assert.ok(spawnCall.length > 0, 'pty.spawn call site not found — did it get renamed?');
  const envLine = spawnCall.slice(0, spawnCall.indexOf('...process.env'));
  assert.match(envLine, /env:\s*scrubSpawnEnv\(\{/,
    'the pty.spawn env literal must be wrapped in scrubSpawnEnv(...)');
});

// ─────────────────────────────────────────────────────────────────────────
// readTermdeckSecretsForPty — filtering behavior.

test('readTermdeckSecretsForPty — drops SUPABASE_ACCESS_TOKEN when present in secrets.env (AUDIT-RED closure)', () => {
  withTempHome(
    [
      'SUPABASE_URL=https://abc.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_service_role_xyz12345',
      'DATABASE_URL=postgres://x:y@host:6543/postgres',
      'OPENAI_API_KEY=sk-proj-aaaaa',
      `SUPABASE_ACCESS_TOKEN=${fakeSupabasePat()}`,
    ].join('\n') + '\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('SUPABASE_ACCESS_TOKEN' in out),
        'SUPABASE_ACCESS_TOKEN must be filtered out');
      // Legit per-project keys pass through.
      assert.equal(out.SUPABASE_URL, 'https://abc.supabase.co');
      assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_service_role_xyz12345');
      assert.equal(out.DATABASE_URL, 'postgres://x:y@host:6543/postgres');
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-aaaaa');
    }
  );
});

test('readTermdeckSecretsForPty — drops GITHUB_TOKEN', () => {
  withTempHome(
    'SUPABASE_URL=https://x.supabase.co\nGITHUB_TOKEN=ghp_aaaa1234bbbb\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('GITHUB_TOKEN' in out));
      assert.equal(out.SUPABASE_URL, 'https://x.supabase.co');
    }
  );
});

test('readTermdeckSecretsForPty — drops OPENAI_ADMIN_KEY but keeps OPENAI_API_KEY', () => {
  withTempHome(
    'OPENAI_API_KEY=sk-proj-legit\nOPENAI_ADMIN_KEY=sk-admin-secret\n',
    () => {
      const out = readTermdeckSecretsForPty();
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-legit', 'per-project key must pass through');
      assert.ok(!('OPENAI_ADMIN_KEY' in out), 'admin key must be filtered out');
    }
  );
});

test('readTermdeckSecretsForPty — drops NPM_TOKEN', () => {
  withTempHome(
    `NPM_TOKEN=${fakeNpmToken()}\nSUPABASE_URL=https://x.supabase.co\n`,
    () => {
      const out = readTermdeckSecretsForPty();
      assert.ok(!('NPM_TOKEN' in out));
      assert.equal(out.SUPABASE_URL, 'https://x.supabase.co');
    }
  );
});

test('readTermdeckSecretsForPty — empty secrets.env yields empty result (no exclusion-on-empty failure)', () => {
  withTempHome('', () => {
    const out = readTermdeckSecretsForPty();
    assert.deepEqual(out, {});
  });
});

test('readTermdeckSecretsForPty — missing secrets.env yields empty result', () => {
  const origHome = process.env.HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-exclusion-test-missing-'));
  process.env.HOME = tmp;
  _resetTermdeckSecretsCache();
  try {
    const out = readTermdeckSecretsForPty();
    assert.deepEqual(out, {});
  } finally {
    process.env.HOME = origHome;
    _resetTermdeckSecretsCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
});

test('readTermdeckSecretsForPty — multi-exclusion + multi-passthrough in one file (mixed reality)', () => {
  withTempHome(
    [
      '# Comment line — should be skipped',
      'SUPABASE_URL=https://reality.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_real_service_key',
      'SUPABASE_ACCESS_TOKEN=sbp_should_NOT_be_in_pty_env',
      'GITHUB_TOKEN=ghp_should_NOT_be_in_pty_env',
      'OPENAI_API_KEY=sk-proj-real',
      'OPENAI_ADMIN_KEY=sk-admin_should_NOT_be_in_pty_env',
      'DATABASE_URL=postgres://x:y@host:5432/db',
      'NPM_TOKEN=npm_should_NOT_be_in_pty_env',
      'ANTHROPIC_API_KEY=sk-ant-should_NOT_be_in_pty_env',
    ].join('\n') + '\n',
    () => {
      const out = readTermdeckSecretsForPty();
      // Excluded:
      assert.ok(!('SUPABASE_ACCESS_TOKEN' in out));
      assert.ok(!('GITHUB_TOKEN' in out));
      assert.ok(!('OPENAI_ADMIN_KEY' in out));
      assert.ok(!('NPM_TOKEN' in out));
      // Sprint 71 B-T2 — joined the excluded set for BILLING reasons rather
      // than blast-radius ones; see the billing-fence block above.
      assert.ok(!('ANTHROPIC_API_KEY' in out));
      // Passthrough:
      assert.equal(out.SUPABASE_URL, 'https://reality.supabase.co');
      assert.equal(out.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_real_service_key');
      assert.equal(out.OPENAI_API_KEY, 'sk-proj-real');
      assert.equal(out.DATABASE_URL, 'postgres://x:y@host:5432/db');
      // Verify NO excluded substring leaks anywhere.
      const serialized = JSON.stringify(out);
      assert.ok(!serialized.includes('should_NOT_be_in_pty_env'),
        'no excluded canary should appear anywhere in the output');
    }
  );
});

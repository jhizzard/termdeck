// Regression tests for the `termdeck init --mnestra` resume / persist-first
// behavior shipped in v0.6.3.
//
// Background: Brad reported on 2026-04-25 18:30 ET that the wizard was
// "killing before writing the file. Postgrep line not added to my existing
// file, so it wasn't changed." Root cause was that writeLocalConfig() ran
// AFTER pgRunner.connect + applyMigrations — so any pg failure aborted the
// wizard before the user's typed-in DATABASE_URL ever hit secrets.env.
//
// v0.6.3 fix:
//   1. Persist secrets.env immediately after collectInputs returns, before
//      any pg work. A later pg connect or migration failure leaves the
//      saved keys intact so the user can re-run --yes and skip prompts.
//   2. On wizard restart, detect a complete saved set and offer to reuse
//      it (or auto-reuse with --yes).
//
// These tests spawn the actual CLI binary against a temp HOME and assert
// against the on-disk secrets.env. Driven via piped stdin (the prompts
// module supports both TTY and non-TTY input).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'index.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'termdeck-init-'));
}

function readSecrets(home) {
  const p = path.join(home, '.termdeck', 'secrets.env');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

// Spawn `termdeck init --mnestra <args>` against the given HOME and pipe
// `stdinLines` into stdin. Resolves to { code, out } once the child exits.
// Pass `extraEnv` to override / inject environment variables (used by the
// --from-env tests below to provide secrets without prompts).
function runWizard(home, args, stdinLines, { timeoutMs = 30000, extraEnv = {} } = {}) {
  // Strip any inherited Mnestra/Supabase secrets from process.env so the
  // host's real credentials never leak into a test child. Tests opt-in to
  // env vars via the `extraEnv` parameter.
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
    child.stdout.on('data', (b) => { out += b.toString('utf-8'); });
    child.stderr.on('data', (b) => { out += b.toString('utf-8'); });
    if (stdinLines && stdinLines.length > 0) {
      child.stdin.write(stdinLines.join('\n') + '\n');
    }
    child.stdin.end();

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_e) { /* gone */ }
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, out });
    });
  });
}

// ── Brad's bug: pg failure must not lose the typed-in secrets ──────────────

test('persist-first: pg connect failure leaves DATABASE_URL on disk', async () => {
  const home = freshHome();

  // Postgres on 127.0.0.1:1 is guaranteed ECONNREFUSED (port 1 is reserved
  // and nothing listens there). The wizard collects inputs, writes
  // secrets.env, then attempts pgRunner.connect which fails fast.
  const answers = [
    'https://abcdefghijklmnopqrst.supabase.co',                     // SUPABASE_URL
    'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',                    // service_role
    'postgres://postgres:badpw@127.0.0.1:1/postgres',                // DATABASE_URL (will fail)
    'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',                      // OpenAI
    ''                                                                // Anthropic (optional)
  ];

  const { code, out } = await runWizard(home, [], answers);

  // Wizard exits with code 3 when pg connect fails.
  assert.equal(code, 3, `expected exit 3 (pg connect fail) but got ${code}; output:\n${out}`);

  const secrets = readSecrets(home);
  assert.ok(secrets, 'secrets.env should exist after collectInputs even when pg fails');
  assert.match(secrets, /^DATABASE_URL=/m, 'DATABASE_URL line must be persisted before pg connect');
  assert.match(secrets, /^SUPABASE_URL=https:\/\/abcdefghijklmnopqrst\.supabase\.co/m);
  assert.match(secrets, /^OPENAI_API_KEY=sk-proj-/m);

  // The error path must point the user at the resume command.
  assert.match(out, /termdeck init --mnestra --yes/, 'should hint at --yes resume');
});

// ── Resume: --yes + complete saved secrets skips prompts ───────────────────

test('resume: --yes with complete saved secrets does not re-prompt', async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.termdeck'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.termdeck', 'secrets.env'),
    [
      'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'DATABASE_URL=postgres://postgres:badpw@127.0.0.1:1/postgres',
      'OPENAI_API_KEY=sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ''
    ].join('\n')
  );

  // No stdin input — if --yes still tries to prompt, the wizard would hang
  // until our timeout kills it. We assert it exits via pg connect failure
  // (exit 3) instead — which means it skipped prompts and went straight to
  // the database step.
  const { code, out } = await runWizard(home, ['--yes'], []);

  assert.equal(code, 3, `expected exit 3 (pg connect fail) but got ${code}; output:\n${out}`);
  assert.match(out, /Reusing saved secrets/, 'should announce reuse path');
  assert.doesNotMatch(out, /\? Supabase Project URL/, 'must not re-prompt for project URL');
  assert.doesNotMatch(out, /\? OpenAI API key/, 'must not re-prompt for OpenAI key');
});

// ── --reset ignores saved secrets and re-prompts ───────────────────────────

test('--reset bypasses saved secrets and re-prompts from scratch', async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.termdeck'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.termdeck', 'secrets.env'),
    [
      'SUPABASE_URL=https://oldoldoldoldoldoldol.supabase.co',
      'SUPABASE_SERVICE_ROLE_KEY=sb_secret_oldoldoldoldoldoldoldoldoldoldol',
      'DATABASE_URL=postgres://postgres:old@127.0.0.1:1/postgres',
      'OPENAI_API_KEY=sk-proj-oldoldoldoldoldoldoldoldoldoldol',
      ''
    ].join('\n')
  );

  const answers = [
    'https://newnewnewnewnewnewne.supabase.co',
    'sb_secret_newnewnewnewnewnewnewnewnewnewnew',
    'postgres://postgres:new@127.0.0.1:1/postgres',
    'sk-proj-newnewnewnewnewnewnewnewnewnewnew',
    ''
  ];

  const { out } = await runWizard(home, ['--reset'], answers);

  assert.match(out, /\? Supabase Project URL/, '--reset must re-prompt for project URL');

  const secrets = readSecrets(home);
  assert.match(secrets, /SUPABASE_URL=https:\/\/newnewnewnewnewnewne\.supabase\.co/,
    'saved secrets should be overwritten with the new values');
});

// ── --from-env: skip every prompt, read secrets from environment ───────────

test('--from-env reads all secrets from env vars and never invokes askSecret', async () => {
  const home = freshHome();

  const env = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DATABASE_URL: 'postgres://postgres:bad@127.0.0.1:1/postgres',  // fails fast
    OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ANTHROPIC_API_KEY: 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };

  const { code, out } = await runWizard(home, ['--from-env'], [], { extraEnv: env });

  assert.equal(code, 3, `expected exit 3 (pg connect fail) but got ${code}; output:\n${out}`);

  // Critical: no prompts were rendered (askSecret never ran).
  assert.doesNotMatch(out, /\? Supabase Project URL/, 'must skip Supabase URL prompt');
  assert.doesNotMatch(out, /\? Supabase service_role key/, 'must skip service_role prompt');
  assert.doesNotMatch(out, /\? Direct Postgres connection string/, 'must skip postgres URL prompt');
  assert.doesNotMatch(out, /\? OpenAI API key/, 'must skip OpenAI prompt');
  assert.doesNotMatch(out, /\? Anthropic API key/, 'must skip Anthropic prompt');
  assert.match(out, /Reading secrets from environment variables/, 'must announce --from-env mode');

  // Persist-first still applies — secrets.env written before pg.
  const secrets = readSecrets(home);
  assert.match(secrets, /^DATABASE_URL=postgres:\/\/postgres:bad@127\.0\.0\.1:1\/postgres/m);
  assert.match(secrets, /^ANTHROPIC_API_KEY=sk-ant-/m, 'optional Anthropic key should be persisted when env-supplied');
});

test('--from-env exits 2 with an actionable message when a required env var is missing', async () => {
  const home = freshHome();

  const env = {
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    // SUPABASE_SERVICE_ROLE_KEY intentionally omitted
    DATABASE_URL: 'postgres://postgres:bad@127.0.0.1:1/postgres',
    OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };

  const { code, out } = await runWizard(home, ['--from-env'], [], { extraEnv: env });

  assert.equal(code, 2, 'missing required env should exit 2 (config error path)');
  assert.match(out, /SUPABASE_SERVICE_ROLE_KEY/, 'must name the missing variable');
  assert.match(out, /termdeck init --mnestra --from-env/, 'must show the corrected invocation');
});

test('--from-env validates secret shapes and rejects malformed values', async () => {
  const home = freshHome();

  const env = {
    SUPABASE_URL: 'not-a-url',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    DATABASE_URL: 'postgres://postgres:bad@127.0.0.1:1/postgres',
    OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  };

  const { code, out } = await runWizard(home, ['--from-env'], [], { extraEnv: env });

  assert.equal(code, 2, 'malformed required env should exit 2');
  assert.match(out, /SUPABASE_URL is malformed/);

  // No secrets.env should have been created — we bailed before the write.
  const secrets = readSecrets(home);
  assert.equal(secrets, null, 'no secrets.env should be written when --from-env validation fails');
});

// ── Existing tests already cover prompts.askSecret reliability. ────────────
// See tests/setup-prompts.test.js for the CRLF / ANSI / Ctrl-C regressions.

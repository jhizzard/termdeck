// Regression tests for wireAccessTokenInMcpJson() in
// packages/cli/src/init-rumen.js (v0.6.7 candidate).
//
// Background: the meta-installer (`@jhizzard/termdeck-stack`) writes the
// Supabase MCP server entry into ~/.claude/mcp.json with a literal
// placeholder string `SUPABASE_PAT_HERE` for SUPABASE_ACCESS_TOKEN. Users
// were expected to manually replace it after install. v0.6.4 told users to
// `export SUPABASE_ACCESS_TOKEN=...` for `supabase link`, but the export
// only affected their shell — Claude Code's Supabase MCP server kept the
// placeholder. Brad reported this 2026-04-26 after fixing it manually.
//
// v0.6.7 closes the loop: when `termdeck init --rumen` runs and the env
// has SUPABASE_ACCESS_TOKEN, the wizard backfills it into the placeholder
// in ~/.claude/mcp.json. These fixtures pin the helper's contract:
//   - only fires when env token is present
//   - no-op when file missing
//   - no-op when supabase entry missing
//   - no-op when JSON malformed (with status='malformed' for caller to log)
//   - replaces placeholder
//   - preserves real token already set
//   - preserves all other mcpServers entries verbatim
//   - atomic write with mode 0600

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const initRumen = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'init-rumen.js'));
const wireAccessTokenInMcpJson = initRumen._wireAccessTokenInMcpJson;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-json-test-'));
}

// Helper to write a baseline mcp.json with a Supabase entry whose token is
// the literal placeholder, plus a sibling Mnestra entry that must be
// preserved untouched.
function writePlaceholderMcpJson(filePath, supabaseTokenValue = 'SUPABASE_PAT_HERE') {
  const cfg = {
    mcpServers: {
      mnestra: {
        command: 'mnestra',
        args: ['serve'],
        env: {
          SUPABASE_URL: 'https://example.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_xxx'
        }
      },
      supabase: {
        command: 'npx',
        args: ['-y', '@supabase/mcp-server-supabase@latest'],
        env: {
          SUPABASE_ACCESS_TOKEN: supabaseTokenValue
        }
      }
    }
  };
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// ── Brad's case: placeholder gets replaced ──────────────────────────────────

test('placeholder SUPABASE_PAT_HERE is replaced with the env token', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file);

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_real_token_value_1234',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'updated');
  assert.equal(r.path, file);

  const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(cfg.mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN, 'sbp_real_token_value_1234');
});

test('siblings (Mnestra entry) and other env keys are preserved verbatim', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file);

  wireAccessTokenInMcpJson({
    token: 'sbp_real_token_value_1234',
    mcpJsonPath: file
  });

  const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(cfg.mcpServers.mnestra.command, 'mnestra');
  assert.deepEqual(cfg.mcpServers.mnestra.args, ['serve']);
  assert.equal(cfg.mcpServers.mnestra.env.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(cfg.mcpServers.mnestra.env.SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_xxx');
});

test('written file has mode 0600', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file);

  wireAccessTokenInMcpJson({
    token: 'sbp_real_token_value_1234',
    mcpJsonPath: file
  });

  const stat = fs.statSync(file);
  // Mask off file-type bits, compare permission bits.
  assert.equal(stat.mode & 0o777, 0o600);
});

// ── Idempotence and conservatism ────────────────────────────────────────────

test('a real token already in place is never overwritten', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file, 'sbp_user_already_set_this');

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_DIFFERENT_token_from_env',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'already-set');

  const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(cfg.mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN, 'sbp_user_already_set_this');
});

test('the same token already set returns already-set without rewriting', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file, 'sbp_same_token_value');

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_same_token_value',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'already-set');
});

// ── No-op paths (silent in caller) ──────────────────────────────────────────

test('returns no-token-in-env when neither arg nor process.env has a token', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  writePlaceholderMcpJson(file);

  const saved = process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  try {
    const r = wireAccessTokenInMcpJson({ mcpJsonPath: file });
    assert.equal(r.status, 'no-token-in-env');
    // File must NOT be modified.
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(cfg.mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN, 'SUPABASE_PAT_HERE');
  } finally {
    if (saved !== undefined) process.env.SUPABASE_ACCESS_TOKEN = saved;
  }
});

test('returns no-file when ~/.claude/mcp.json does not exist', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'definitely-not-here.json');

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_token',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'no-file');
});

test('returns no-supabase-entry when mcp.json has no supabase MCP server', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  // mcp.json with only Mnestra — no supabase entry.
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        mnestra: { command: 'mnestra', args: ['serve'], env: {} }
      }
    }, null, 2),
    { mode: 0o600 }
  );

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_token',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'no-supabase-entry');
});

test('malformed JSON returns status=malformed without throwing', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{ this is not valid json', { mode: 0o600 });

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_token',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'malformed');
  assert.equal(r.path, file);
  assert.ok(r.error, 'should include the parse error');
});

// ── Edge case: supabase entry exists but has no env block ───────────────────

test('supabase entry without an env block gets one created and the token set', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        supabase: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest'] }
      }
    }, null, 2),
    { mode: 0o600 }
  );

  const r = wireAccessTokenInMcpJson({
    token: 'sbp_real_token',
    mcpJsonPath: file
  });

  assert.equal(r.status, 'updated');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(cfg.mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN, 'sbp_real_token');
});

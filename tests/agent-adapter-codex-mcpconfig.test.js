// Sprint 48 T1 — Codex-specific assertions on the adapter's `mcpConfig`
// field. Pins the TOML shape, the path, the detection regex, and the env
// rendering rules. Sister test file alongside agent-adapter-codex.test.js;
// kept separate so the Sprint 48 contract additions don't get tangled with
// the Sprint 45 snapshot suite.
//
// Run: node --test tests/agent-adapter-codex-mcpconfig.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const codexAdapter = require('../packages/server/src/agent-adapters/codex');

test('codex.mcpConfig: declares the canonical Codex config path', () => {
  assert.equal(codexAdapter.mcpConfig.path, '~/.codex/config.toml');
});

test('codex.mcpConfig: format is TOML (Codex is the only TOML agent)', () => {
  assert.equal(codexAdapter.mcpConfig.format, 'toml');
});

test('codex.mcpConfig: required functions are present', () => {
  assert.equal(typeof codexAdapter.mcpConfig.mnestraBlock, 'function');
  assert.equal(typeof codexAdapter.mcpConfig.detectExisting, 'function');
});

test('codex.mcpConfig.detectExisting: matches a `[mcp_servers.mnestra]` table header', () => {
  const yes = '[mcp_servers.mnestra]\ncommand = "mnestra"\n';
  const no = '[mcp_servers.other]\ncommand = "other"\n';
  const mixedFile = 'model = "gpt-5.5"\n\n[mcp_servers.mnestra]\ncommand = "mnestra"\n';
  assert.equal(codexAdapter.mcpConfig.detectExisting(yes), true);
  assert.equal(codexAdapter.mcpConfig.detectExisting(no), false);
  assert.equal(codexAdapter.mcpConfig.detectExisting(''), false);
  assert.equal(codexAdapter.mcpConfig.detectExisting(mixedFile), true);
});

test('codex.mcpConfig.detectExisting: does not false-positive on unrelated mentions', () => {
  // A `mnestra` substring inside another table or a comment should not
  // trip the detector — only the table header itself counts.
  const commentOnly = '# notes about mcp_servers.mnestra\nmodel = "x"\n';
  const otherTable = '[mcp_servers.mnestra_alt]\ncommand = "alt"\n';
  assert.equal(codexAdapter.mcpConfig.detectExisting(commentOnly), false);
  assert.equal(codexAdapter.mcpConfig.detectExisting(otherTable), false);
});

test('codex.mcpConfig.mnestraBlock: renders all three secret keys when provided', () => {
  const block = codexAdapter.mcpConfig.mnestraBlock({
    secrets: {
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb-svc-key',
      OPENAI_API_KEY: 'sk-test',
    },
  });
  assert.equal(typeof block, 'string');
  assert.match(block, /^\[mcp_servers\.mnestra\]$/m);
  assert.match(block, /^command = "mnestra"$/m);
  assert.match(block, /^\[mcp_servers\.mnestra\.env\]$/m);
  assert.match(block, /^SUPABASE_URL = "https:\/\/abc\.supabase\.co"$/m);
  assert.match(block, /^SUPABASE_SERVICE_ROLE_KEY = "sb-svc-key"$/m);
  assert.match(block, /^OPENAI_API_KEY = "sk-test"$/m);
});

test('codex.mcpConfig.mnestraBlock: omits env block entirely when no secrets supplied', () => {
  // Concrete-or-omit discipline — never write an empty `${VAR}` placeholder.
  // mnestra's own secrets.env fallback fills missing values at process start.
  const block = codexAdapter.mcpConfig.mnestraBlock({ secrets: {} });
  assert.match(block, /^\[mcp_servers\.mnestra\]$/m);
  assert.match(block, /^command = "mnestra"$/m);
  assert.doesNotMatch(block, /\[mcp_servers\.mnestra\.env\]/);
});

test('codex.mcpConfig.mnestraBlock: drops keys whose secret values are empty strings', () => {
  const block = codexAdapter.mcpConfig.mnestraBlock({
    secrets: {
      SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: '',
      OPENAI_API_KEY: undefined,
    },
  });
  assert.match(block, /^SUPABASE_URL = "https:\/\/abc\.supabase\.co"$/m);
  assert.doesNotMatch(block, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(block, /OPENAI_API_KEY/);
});

test('codex.mcpConfig.mnestraBlock: TOML-escapes backslashes and quotes in values', () => {
  const block = codexAdapter.mcpConfig.mnestraBlock({
    secrets: { OPENAI_API_KEY: 'has"quote\\and-backslash' },
  });
  assert.match(block, /^OPENAI_API_KEY = "has\\"quote\\\\and-backslash"$/m);
});

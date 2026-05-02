// Sprint 48 T2 — Snapshot tests for the Gemini adapter `mcpConfig` field.
//
// Pins the shape the shared `mcp-autowire.js` helper (Sprint 48 T1) consumes
// when ensuring the Mnestra MCP block is present in `~/.gemini/settings.json`
// before a Gemini panel boots. Schema reference:
// https://www.geminicli.com/docs/tools/mcp-server (verified 2026-05-02).
//
// The integration test that actually runs `ensureMnestraBlock(geminiAdapter)`
// against a temp settings.json lives in `tests/mcp-autowire.test.js` (T1
// owns that file). This file pins the per-adapter contract: top-level key,
// transport choice, env-key omission discipline, and stable mnestraBlock
// output.
//
// Run: node --test tests/agent-adapter-gemini-mcpconfig.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const geminiAdapter = require('../packages/server/src/agent-adapters/gemini');

test('mcpConfig: required fields present with documented values', () => {
  const cfg = geminiAdapter.mcpConfig;
  assert.ok(cfg && typeof cfg === 'object', 'mcpConfig must be an object');
  assert.equal(cfg.path, '~/.gemini/settings.json');
  assert.equal(cfg.format, 'json');
  assert.equal(cfg.mcpServersKey, 'mcpServers',
    'Gemini schema uses camelCase mcpServers (not mcp_servers)');
  assert.equal(typeof cfg.mnestraBlock, 'function');
});

test('mnestraBlock: returns { mnestra: { command, env } } merge-shape', () => {
  const block = geminiAdapter.mcpConfig.mnestraBlock({
    secrets: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sbsr_xxx',
      OPENAI_API_KEY: 'sk-xxx',
    },
  });
  assert.deepEqual(block, {
    mnestra: {
      command: 'mnestra',
      env: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'sbsr_xxx',
        OPENAI_API_KEY: 'sk-xxx',
      },
    },
  });
});

test('mnestraBlock: omits empty/missing secrets rather than writing empty strings', () => {
  // Matches stack-installer concrete-or-omit discipline. Gemini, like Claude
  // Code, does not shell-expand ${VAR} references in MCP env; placeholders
  // would be passed literally to mnestra and rejected as an invalid URL.
  const partial = geminiAdapter.mcpConfig.mnestraBlock({
    secrets: { SUPABASE_URL: 'https://only-this.supabase.co' },
  });
  assert.deepEqual(partial.mnestra.env, { SUPABASE_URL: 'https://only-this.supabase.co' });
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in partial.mnestra.env, false);
  assert.equal('OPENAI_API_KEY' in partial.mnestra.env, false);

  const allEmpty = geminiAdapter.mcpConfig.mnestraBlock({ secrets: {} });
  assert.deepEqual(allEmpty.mnestra.env, {});

  const noArg = geminiAdapter.mcpConfig.mnestraBlock();
  assert.deepEqual(noArg.mnestra.env, {});
});

test('mnestraBlock: omits the `type` field (Gemini infers transport from command)', () => {
  // `type: 'stdio'` is a Claude-Code extension; Gemini's documented schema
  // doesn't recognize it. The adapter must not emit it for Gemini.
  const block = geminiAdapter.mcpConfig.mnestraBlock({
    secrets: { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', OPENAI_API_KEY: 'x' },
  });
  assert.equal('type' in block.mnestra, false);
  assert.equal(block.mnestra.command, 'mnestra');
});

test('mnestraBlock: deterministic across calls (idempotency precondition)', () => {
  // The shared helper detects "already present" by comparing the rendered
  // block to what's already in the file. Output must be deep-equal across
  // calls with the same secrets so the second run is a no-op.
  const secrets = {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'sbsr',
    OPENAI_API_KEY: 'sk',
  };
  const a = geminiAdapter.mcpConfig.mnestraBlock({ secrets });
  const b = geminiAdapter.mcpConfig.mnestraBlock({ secrets });
  assert.deepEqual(a, b);
});

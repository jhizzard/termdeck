// Sprint 48 T3 — Snapshot tests for the Grok adapter `mcpConfig` field.
//
// Pins the shape the shared `mcp-autowire.js` helper (Sprint 48 T1) consumes
// when ensuring the Mnestra MCP block is present in `~/.grok/user-settings.json`
// before a Grok panel boots. Schema reference verified 2026-05-02 against
// the bundled grok-dev v1.1.5 source at
// `/usr/local/lib/node_modules/grok-dev/dist/utils/settings.{d.ts,js}`.
//
// Grok deviates from Codex (TOML-append) and Gemini (JSON record-merge): its
// `mcp.servers` is an ARRAY of objects with explicit `id`/`label`/`enabled`/
// `transport` fields. The adapter therefore declares a `merge` escape-hatch
// on `mcpConfig` instead of `mcpServersKey + mnestraBlock`. The merge function
// owns parse + mutate + serialize; the helper still owns tilde-expansion,
// parent-dir creation, atomic write, and idempotency reporting.
//
// The integration test that actually runs `ensureMnestraBlock(grokAdapter)`
// against a temp settings.json lives in `tests/mcp-autowire.test.js` (T1
// owns that file). This file pins the per-adapter contract: required field
// values, array-merge correctness, env omission discipline, idempotency, and
// preservation of unrelated top-level keys.
//
// Run: node --test tests/agent-adapter-grok-mcpconfig.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const grokAdapter = require('../packages/server/src/agent-adapters/grok');

const FULL_SECRETS = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sbsr_xxx',
  OPENAI_API_KEY: 'sk-xxx',
};

test('mcpConfig: required fields present with documented values', () => {
  const cfg = grokAdapter.mcpConfig;
  assert.ok(cfg && typeof cfg === 'object', 'mcpConfig must be an object');
  assert.equal(cfg.path, '~/.grok/user-settings.json');
  assert.equal(cfg.format, 'json');
  assert.equal(typeof cfg.merge, 'function',
    'Grok declares a merge escape-hatch (not mcpServersKey + mnestraBlock)');
  // Grok intentionally does NOT use the record-merge shape Gemini uses, so
  // the helper must dispatch on `merge` first. Document that here.
  assert.equal(cfg.mcpServersKey, undefined,
    'Grok must not declare mcpServersKey — schema is mcp.servers[] array');
  assert.equal(cfg.mnestraBlock, undefined,
    'Grok must not declare mnestraBlock — adapter owns serialization via merge');
});

test('merge: empty file → writes mcp.servers[] with mnestra entry', () => {
  const { changed, output } = grokAdapter.mcpConfig.merge('', { secrets: FULL_SECRETS });
  assert.equal(changed, true);
  const parsed = JSON.parse(output);
  assert.ok(parsed.mcp && Array.isArray(parsed.mcp.servers));
  assert.equal(parsed.mcp.servers.length, 1);
  assert.deepEqual(parsed.mcp.servers[0], {
    id: 'mnestra',
    label: 'Mnestra',
    enabled: true,
    transport: 'stdio',
    command: 'mnestra',
    args: [],
    env: {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sbsr_xxx',
      OPENAI_API_KEY: 'sk-xxx',
    },
  });
  assert.ok(output.endsWith('\n'), 'output ends with trailing newline');
});

test('merge: preserves existing top-level keys (defaultModel, etc.)', () => {
  // Joshua's actual ~/.grok/user-settings.json shape on 2026-05-02 — the
  // most important regression to lock down: writing the mcp block must NOT
  // clobber his configured defaultModel.
  const before = JSON.stringify({ defaultModel: 'grok-4.20-0309-reasoning' });
  const { changed, output } = grokAdapter.mcpConfig.merge(before, { secrets: FULL_SECRETS });
  assert.equal(changed, true);
  const parsed = JSON.parse(output);
  assert.equal(parsed.defaultModel, 'grok-4.20-0309-reasoning');
  assert.ok(parsed.mcp && Array.isArray(parsed.mcp.servers));
  assert.equal(parsed.mcp.servers[0].id, 'mnestra');
});

test('merge: idempotent — second run on already-wired file is a no-op', () => {
  const first = grokAdapter.mcpConfig.merge('', { secrets: FULL_SECRETS });
  assert.equal(first.changed, true);
  const second = grokAdapter.mcpConfig.merge(first.output, { secrets: FULL_SECRETS });
  assert.equal(second.changed, false);
  assert.equal(second.output, first.output, 'no-op returns original text byte-for-byte');
});

test('merge: refreshes mnestra entry when env values drift', () => {
  // If the user has stale credentials wired (e.g. rotated SUPABASE key),
  // the next spawn should bring the env block back in line with secrets.env.
  // Other top-level keys + non-mnestra servers stay untouched.
  const stale = {
    defaultModel: 'grok-4.20-0309-reasoning',
    mcp: {
      servers: [
        { id: 'other', label: 'Other', enabled: true, transport: 'stdio', command: 'other-cmd' },
        {
          id: 'mnestra',
          label: 'Mnestra',
          enabled: true,
          transport: 'stdio',
          command: 'mnestra',
          args: [],
          env: { SUPABASE_URL: 'https://stale.supabase.co' },
        },
      ],
    },
  };
  const { changed, output } = grokAdapter.mcpConfig.merge(JSON.stringify(stale, null, 2), {
    secrets: FULL_SECRETS,
  });
  assert.equal(changed, true);
  const parsed = JSON.parse(output);
  assert.equal(parsed.defaultModel, 'grok-4.20-0309-reasoning');
  assert.equal(parsed.mcp.servers.length, 2);
  // Sibling server preserved.
  const other = parsed.mcp.servers.find((s) => s.id === 'other');
  assert.deepEqual(other, {
    id: 'other', label: 'Other', enabled: true, transport: 'stdio', command: 'other-cmd',
  });
  // Mnestra entry refreshed with current secrets.
  const mnestra = parsed.mcp.servers.find((s) => s.id === 'mnestra');
  assert.deepEqual(mnestra.env, FULL_SECRETS);
});

test('merge: drops empty/missing/${VAR} placeholders from env', () => {
  // Concrete-or-omit discipline — matches stack-installer/src/index.js Sprint
  // 47.5 hotfix and the Gemini adapter. Grok does not shell-expand `${VAR}`
  // in MCP env, so writing placeholders would be passed literally to mnestra
  // and rejected as an invalid URL.
  const partial = grokAdapter.mcpConfig.merge('', {
    secrets: {
      SUPABASE_URL: 'https://only-this.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: '',
      OPENAI_API_KEY: '${OPENAI_API_KEY}',
    },
  });
  assert.equal(partial.changed, true);
  const parsed = JSON.parse(partial.output);
  const env = parsed.mcp.servers[0].env;
  assert.deepEqual(env, { SUPABASE_URL: 'https://only-this.supabase.co' });
  assert.equal('SUPABASE_SERVICE_ROLE_KEY' in env, false);
  assert.equal('OPENAI_API_KEY' in env, false);

  const noSecrets = grokAdapter.mcpConfig.merge('', { secrets: {} });
  assert.equal(noSecrets.changed, true);
  assert.deepEqual(JSON.parse(noSecrets.output).mcp.servers[0].env, {});

  const noOpts = grokAdapter.mcpConfig.merge('');
  assert.equal(noOpts.changed, true);
  assert.deepEqual(JSON.parse(noOpts.output).mcp.servers[0].env, {});
});

test('merge: preserves user-added sibling fields on existing mnestra entry', () => {
  // If a user has hand-edited the mnestra entry to add `cwd` or other fields
  // outside our managed set, the equality check should treat it as drift
  // (since we don't deep-equal those fields) and refresh — but the refresh
  // overwrites with our canonical shape. Document this behavior so users
  // know hand-edits to the mnestra entry don't survive a respawn. (For
  // truly bespoke configs, users should rename the entry id and add a
  // sibling server.)
  const handEdited = {
    mcp: {
      servers: [
        {
          id: 'mnestra',
          label: 'Mnestra (custom label)',
          enabled: true,
          transport: 'stdio',
          command: 'mnestra',
          args: ['--verbose'],
          env: FULL_SECRETS,
          cwd: '/tmp',
        },
      ],
    },
  };
  const { changed, output } = grokAdapter.mcpConfig.merge(JSON.stringify(handEdited), {
    secrets: FULL_SECRETS,
  });
  assert.equal(changed, true, 'hand-edited label drift triggers refresh to canonical shape');
  const parsed = JSON.parse(output);
  const mnestra = parsed.mcp.servers[0];
  assert.equal(mnestra.label, 'Mnestra', 'label refreshed to canonical');
  assert.deepEqual(mnestra.args, [], 'args refreshed to canonical');
});

test('merge: malformed JSON falls back to fresh write rather than throwing', () => {
  // Helper guarantees atomic write so we never leave a half-written file —
  // but if the input file is already corrupt, we replace it with a clean
  // settings.json that has the mnestra entry. Better than throwing on an
  // unreadable file (which would leave the user without MCP wiring forever).
  const garbage = '{ this is not valid json';
  const { changed, output } = grokAdapter.mcpConfig.merge(garbage, { secrets: FULL_SECRETS });
  assert.equal(changed, true);
  const parsed = JSON.parse(output);
  assert.equal(parsed.mcp.servers[0].id, 'mnestra');
});

test('merge: rejects array root and replaces with object root', () => {
  // A JSON array at the root is invalid for user-settings.json (Grok expects
  // an object). Treat it the same as malformed: clean replacement.
  const arrayRoot = '[]';
  const { changed, output } = grokAdapter.mcpConfig.merge(arrayRoot, { secrets: FULL_SECRETS });
  assert.equal(changed, true);
  const parsed = JSON.parse(output);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  assert.equal(parsed.mcp.servers[0].id, 'mnestra');
});

test('merge: deterministic output across calls (helper idempotency precondition)', () => {
  // The helper detects "already present" by comparing rendered output to
  // existing file contents. Output must be byte-stable across calls with
  // the same input + secrets so the second run is a no-op.
  const a = grokAdapter.mcpConfig.merge('', { secrets: FULL_SECRETS });
  const b = grokAdapter.mcpConfig.merge('', { secrets: FULL_SECRETS });
  assert.equal(a.output, b.output);
});

// Sprint 48 T1 — Tests for the shared MCP auto-wire helper.
//
// Covers all three adapter shapes the helper supports:
//   • TOML-append (Codex)        — mnestraBlock: () => string + detectExisting
//   • JSON-record-merge (Gemini) — mcpServersKey + mnestraBlock: () => object
//   • Escape-hatch merge (Grok)  — merge: (raw, {secrets}) => {changed, output}
// Plus contract enforcement, idempotency, tilde-expansion, parent dir
// creation, secrets parser (quoted values, comments, `${VAR}` rejection),
// and an opt-in Codex CLI integration smoke that runs only when the binary
// is on PATH.
//
// Run: node --test tests/mcp-autowire.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  ensureMnestraBlock,
  readSecrets,
  expandTilde,
  _internals,
} = require('../packages/server/src/mcp-autowire');

const codexAdapter = require('../packages/server/src/agent-adapters/codex');
const claudeAdapter = require('../packages/server/src/agent-adapters/claude');

// ─────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-autowire-'));
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function tomlAdapter(targetPath, blockText) {
  return {
    name: 'fake-toml',
    mcpConfig: {
      path: targetPath,
      format: 'toml',
      mnestraBlock: () => blockText,
      detectExisting: (text) => /\[mcp_servers\.mnestra\]/m.test(text),
    },
  };
}

function jsonRecordAdapter(targetPath, blockObj) {
  return {
    name: 'fake-json',
    mcpConfig: {
      path: targetPath,
      format: 'json',
      mcpServersKey: 'mcpServers',
      mnestraBlock: () => blockObj,
    },
  };
}

function mergeAdapter(targetPath, mergeFn) {
  return {
    name: 'fake-merge',
    mcpConfig: { path: targetPath, format: 'json', merge: mergeFn },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// expandTilde
// ─────────────────────────────────────────────────────────────────────────

test('expandTilde: expands ~ alone to homedir', () => {
  assert.equal(expandTilde('~'), os.homedir());
});

test('expandTilde: expands ~/foo to homedir/foo', () => {
  assert.equal(expandTilde('~/foo'), path.join(os.homedir(), 'foo'));
});

test('expandTilde: leaves absolute paths untouched', () => {
  assert.equal(expandTilde('/etc/passwd'), '/etc/passwd');
});

test('expandTilde: leaves relative paths starting with letters untouched', () => {
  assert.equal(expandTilde('foo/bar'), 'foo/bar');
});

// ─────────────────────────────────────────────────────────────────────────
// readSecrets
// ─────────────────────────────────────────────────────────────────────────

test('readSecrets: returns {} when file is absent', () => {
  const dir = tmpDir();
  const out = readSecrets(path.join(dir, 'never-exists.env'));
  assert.deepEqual(out, {});
});

test('readSecrets: parses KEY=VAL pairs and ignores comments / blanks', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'secrets.env');
  writeFile(p, [
    '# comment line',
    '',
    'SUPABASE_URL=https://abc.supabase.co',
    'OPENAI_API_KEY=sk-test-123',
    '   ',
  ].join('\n'));
  const out = readSecrets(p);
  assert.deepEqual(out, {
    SUPABASE_URL: 'https://abc.supabase.co',
    OPENAI_API_KEY: 'sk-test-123',
  });
});

test('readSecrets: strips matched single + double quotes', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'secrets.env');
  writeFile(p, 'A="quoted"\nB=\'single\'\nC=bare\n');
  const out = readSecrets(p);
  assert.deepEqual(out, { A: 'quoted', B: 'single', C: 'bare' });
});

test('readSecrets: rejects literal ${VAR} placeholder shapes (returns key as unset)', () => {
  // Same defense the mnestra MCP stdio fallback applies — Claude Code does
  // not expand ${VAR} in MCP env, so writing one through is worse than
  // omitting it.
  const dir = tmpDir();
  const p = path.join(dir, 'secrets.env');
  writeFile(p, 'GOOD=real-value\nBAD=${SUPABASE_URL}\n');
  const out = readSecrets(p);
  assert.deepEqual(out, { GOOD: 'real-value' });
});

// ─────────────────────────────────────────────────────────────────────────
// ensureMnestraBlock — contract enforcement
// ─────────────────────────────────────────────────────────────────────────

test('ensureMnestraBlock: skips when adapter is null', () => {
  const out = ensureMnestraBlock(null);
  assert.deepEqual(out, { skipped: true, reason: 'no-mcpConfig' });
});

test('ensureMnestraBlock: skips when adapter.mcpConfig is null (Claude case)', () => {
  const out = ensureMnestraBlock(claudeAdapter);
  assert.deepEqual(out, { skipped: true, reason: 'no-mcpConfig' });
});

test('ensureMnestraBlock: skips when adapter.mcpConfig is undefined', () => {
  const out = ensureMnestraBlock({ name: 'shapeless' });
  assert.deepEqual(out, { skipped: true, reason: 'no-mcpConfig' });
});

test('ensureMnestraBlock: skips when mcpConfig is missing required fields', () => {
  const out = ensureMnestraBlock({
    name: 'broken',
    mcpConfig: { path: '/tmp/x', format: 'toml' /* no functions */ },
  });
  assert.deepEqual(out, { skipped: true, reason: 'malformed-mcpConfig' });
});

test('ensureMnestraBlock: skips when mcpConfig.path is non-string', () => {
  const out = ensureMnestraBlock({
    name: 'broken',
    mcpConfig: { path: null, format: 'toml', mnestraBlock: () => '', detectExisting: () => false },
  });
  assert.deepEqual(out, { skipped: true, reason: 'malformed-mcpConfig' });
});

// ─────────────────────────────────────────────────────────────────────────
// ensureMnestraBlock — TOML-append (Codex shape)
// ─────────────────────────────────────────────────────────────────────────

test('TOML: writes block to absent file', () => {
  const dir = tmpDir();
  const target = path.join(dir, '.codex', 'config.toml');
  const out = ensureMnestraBlock(
    tomlAdapter(target, '[mcp_servers.mnestra]\ncommand = "mnestra"\n'),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  assert.equal(out.path, target);
  assert.match(fs.readFileSync(target, 'utf8'), /\[mcp_servers\.mnestra\]/);
});

test('TOML: appends without disturbing pre-existing servers', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'config.toml');
  const original = [
    'model = "gpt-5.5"', '',
    '[mcp_servers.other]', 'command = "other"', '',
    '[mcp_servers.another]', 'command = "another"', '',
  ].join('\n');
  writeFile(target, original);
  const out = ensureMnestraBlock(
    tomlAdapter(target, '[mcp_servers.mnestra]\ncommand = "mnestra"\n'),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  const written = fs.readFileSync(target, 'utf8');
  assert.ok(written.startsWith(original), 'original content preserved at file head');
  assert.match(written, /\[mcp_servers\.mnestra\]/);
  assert.match(written, /\[mcp_servers\.other\]/);
  assert.match(written, /\[mcp_servers\.another\]/);
});

test('TOML: idempotent — second call returns unchanged', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'config.toml');
  const adapter = tomlAdapter(target, '[mcp_servers.mnestra]\ncommand = "mnestra"\n');
  assert.equal(ensureMnestraBlock(adapter, { secrets: {} }).wrote, true);
  const before = fs.readFileSync(target, 'utf8');
  const second = ensureMnestraBlock(adapter, { secrets: {} });
  assert.deepEqual(second, { unchanged: true, path: target });
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('TOML: tilde-expands the path', () => {
  const fakeHome = tmpDir();
  const realHome = os.homedir();
  process.env.HOME = fakeHome;
  try {
    const out = ensureMnestraBlock(
      tomlAdapter('~/test-codex/config.toml', '[mcp_servers.mnestra]\ncommand = "mnestra"\n'),
      { secrets: {} },
    );
    assert.equal(out.wrote, true);
    assert.equal(out.path, path.join(fakeHome, 'test-codex', 'config.toml'));
    assert.ok(fs.existsSync(out.path));
  } finally {
    process.env.HOME = realHome;
  }
});

test('TOML: creates parent directory when missing', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'deeply', 'nested', 'path', 'config.toml');
  const out = ensureMnestraBlock(
    tomlAdapter(target, '[mcp_servers.mnestra]\ncommand = "mnestra"\n'),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  assert.ok(fs.existsSync(target));
});

// ─────────────────────────────────────────────────────────────────────────
// ensureMnestraBlock — JSON record-merge (Gemini shape)
// ─────────────────────────────────────────────────────────────────────────

test('JSON-record: writes block to absent file', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  const out = ensureMnestraBlock(
    jsonRecordAdapter(target, { mnestra: { command: 'mnestra', env: {} } }),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.mcpServers.mnestra.command, 'mnestra');
});

test('JSON-record: deep-merges into existing object preserving siblings', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  const original = {
    defaultModel: 'grok-4',
    mcpServers: { other: { command: 'other-bin' } },
    unrelatedKey: { keep: 'me' },
  };
  writeFile(target, JSON.stringify(original));
  const out = ensureMnestraBlock(
    jsonRecordAdapter(target, { mnestra: { command: 'mnestra', env: {} } }),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.defaultModel, 'grok-4');
  assert.deepEqual(parsed.unrelatedKey, { keep: 'me' });
  assert.equal(parsed.mcpServers.other.command, 'other-bin');
  assert.equal(parsed.mcpServers.mnestra.command, 'mnestra');
});

test('JSON-record: idempotent — detects existing mnestra entry', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  const adapter = jsonRecordAdapter(target, { mnestra: { command: 'mnestra', env: {} } });
  ensureMnestraBlock(adapter, { secrets: {} });
  const before = fs.readFileSync(target, 'utf8');
  const second = ensureMnestraBlock(adapter, { secrets: {} });
  assert.equal(second.unchanged, true);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('JSON-record: refuses to clobber existing malformed JSON', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  writeFile(target, '{ this is not json');
  const out = ensureMnestraBlock(
    jsonRecordAdapter(target, { mnestra: { command: 'mnestra' } }),
    { secrets: {} },
  );
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'existing-json-malformed');
  assert.equal(fs.readFileSync(target, 'utf8'), '{ this is not json');
});

test('JSON-record: passes secrets through to mnestraBlock', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'settings.json');
  let captured;
  const adapter = {
    name: 'gem-like',
    mcpConfig: {
      path: target,
      format: 'json',
      mcpServersKey: 'mcpServers',
      mnestraBlock: ({ secrets }) => {
        captured = secrets;
        return { mnestra: { command: 'mnestra', env: { ...secrets } } };
      },
    },
  };
  ensureMnestraBlock(adapter, { secrets: { SUPABASE_URL: 'https://x' } });
  assert.deepEqual(captured, { SUPABASE_URL: 'https://x' });
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.mcpServers.mnestra.env.SUPABASE_URL, 'https://x');
});

// ─────────────────────────────────────────────────────────────────────────
// ensureMnestraBlock — Escape-hatch merge (Grok shape)
// ─────────────────────────────────────────────────────────────────────────

test('merge escape-hatch: adapter owns full parse/mutate/serialize', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'user-settings.json');
  writeFile(target, JSON.stringify({ defaultModel: 'grok-4' }));

  const out = ensureMnestraBlock(
    mergeAdapter(target, (raw) => {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      const next = { ...parsed };
      next.mcp = next.mcp || {};
      next.mcp.servers = (next.mcp.servers || []).concat([{ id: 'mnestra' }]);
      return { changed: true, output: JSON.stringify(next, null, 2) + '\n' };
    }),
    { secrets: {} },
  );
  assert.equal(out.wrote, true);
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.defaultModel, 'grok-4');
  assert.ok(Array.isArray(parsed.mcp.servers));
  assert.equal(parsed.mcp.servers[0].id, 'mnestra');
});

test('merge escape-hatch: returns unchanged when adapter reports no change', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'user-settings.json');
  writeFile(target, '{}');
  const out = ensureMnestraBlock(
    mergeAdapter(target, () => ({ changed: false, output: '{}' })),
    { secrets: {} },
  );
  assert.deepEqual(out, { unchanged: true, path: target });
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('merge escape-hatch: surfaces thrown errors as skipped', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'user-settings.json');
  const out = ensureMnestraBlock(
    mergeAdapter(target, () => { throw new Error('boom'); }),
    { secrets: {} },
  );
  assert.equal(out.skipped, true);
  assert.match(out.reason, /^merge-threw-/);
});

// ─────────────────────────────────────────────────────────────────────────
// _internals (kept callable so future refactors hit a unit test)
// ─────────────────────────────────────────────────────────────────────────

test('_internals.mergeJson: deep-merges one level under matching object keys', () => {
  const out = _internals.mergeJson(
    { mcpServers: { a: { x: 1 } } },
    { mcpServers: { b: { y: 2 } } },
  );
  assert.deepEqual(out, { mcpServers: { a: { x: 1 }, b: { y: 2 } } });
});

test('_internals.appendTomlBlock: ensures one blank line between existing and new', () => {
  const out = _internals.appendTomlBlock(
    'model = "x"\n',
    '[mcp_servers.mnestra]\ncommand = "mnestra"\n',
  );
  assert.equal(out, 'model = "x"\n\n[mcp_servers.mnestra]\ncommand = "mnestra"\n');
});

test('_internals.jsonAlreadyHasMnestra: checks nested key safely', () => {
  assert.equal(_internals.jsonAlreadyHasMnestra({ mcpServers: { mnestra: {} } }, 'mcpServers'), true);
  assert.equal(_internals.jsonAlreadyHasMnestra({ mcpServers: {} }, 'mcpServers'), false);
  assert.equal(_internals.jsonAlreadyHasMnestra({}, 'mcpServers'), false);
  assert.equal(_internals.jsonAlreadyHasMnestra(null, 'mcpServers'), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Codex CLI integration smoke — runs only when codex binary is present.
//
//   1. ensureMnestraBlock against the real codex adapter writes a parseable
//      [mcp_servers.mnestra] block.
//   2. `codex --help` accepts the resulting config.toml without complaining.
//      A malformed TOML config would trip an early error before --help runs.
//
// HOME points at a temp dir so the user's real ~/.codex/config.toml is
// never touched — safe to run on the dev box and in CI.
// ─────────────────────────────────────────────────────────────────────────

const codexBinary = (() => {
  const r = spawnSync('which', ['codex'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
})();

test('Codex integration: ensureMnestraBlock + codex --help round-trip',
  { skip: !codexBinary }, () => {
    const fakeHome = tmpDir();
    const realHome = os.homedir();
    process.env.HOME = fakeHome;
    try {
      const target = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'model = "gpt-5.5"\n');

      const out = ensureMnestraBlock(codexAdapter, { secrets: {} });
      assert.equal(out.wrote, true, `expected wrote, got ${JSON.stringify(out)}`);
      const written = fs.readFileSync(target, 'utf8');
      assert.match(written, /^\s*\[mcp_servers\.mnestra\]\s*$/m);

      const r = spawnSync(codexBinary, ['--help'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
        timeout: 10000,
      });
      assert.equal(r.status, 0,
        `codex --help exited ${r.status}; stderr=${r.stderr}`);

      const second = ensureMnestraBlock(codexAdapter, { secrets: {} });
      assert.equal(second.unchanged, true);
    } finally {
      process.env.HOME = realHome;
    }
  });

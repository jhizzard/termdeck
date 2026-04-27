// Sprint 36 T2 — packages/cli/src/mcp-config.js contract tests.
//
// Pin the read/merge/write/migrate primitives that every installer and
// CLI code path depends on for Claude Code MCP wiring. ~/.claude.json
// (canonical) lives alongside ~55 unrelated top-level keys Claude Code
// owns; ~/.claude/mcp.json (legacy) is single-purpose. The contract:
//   - readMcpServers tolerates missing / malformed / empty files
//   - mergeMcpServers makes current win on key collision
//   - writeMcpServers preserves every other top-level key byte-equivalent
//   - migrateLegacyIfPresent is idempotent and never deletes legacy

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mcpConfig = require(path.resolve(__dirname, '..', 'packages', 'cli', 'src', 'mcp-config.js'));
const {
  CLAUDE_MCP_PATH_CANONICAL,
  CLAUDE_MCP_PATH_LEGACY,
  readMcpServers,
  mergeMcpServers,
  writeMcpServers,
  migrateLegacyIfPresent,
} = mcpConfig;

function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
}

function writeJson(filePath, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', { mode });
}

// ── Path constants ─────────────────────────────────────────────────────────

test('CLAUDE_MCP_PATH_CANONICAL points at ~/.claude.json', () => {
  assert.equal(CLAUDE_MCP_PATH_CANONICAL, path.join(os.homedir(), '.claude.json'));
});

test('CLAUDE_MCP_PATH_LEGACY points at ~/.claude/mcp.json', () => {
  assert.equal(CLAUDE_MCP_PATH_LEGACY, path.join(os.homedir(), '.claude', 'mcp.json'));
});

// ── readMcpServers ────────────────────────────────────────────────────────

test('readMcpServers reports missing for a nonexistent file', () => {
  const dir = freshTmpDir();
  const r = readMcpServers(path.join(dir, 'absent.json'));
  assert.equal(r.missing, true);
  assert.equal(r.malformed, false);
  assert.deepEqual(r.servers, {});
});

test('readMcpServers reports malformed for invalid JSON', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ this is not json', { mode: 0o600 });
  const r = readMcpServers(file);
  assert.equal(r.malformed, true);
  assert.equal(r.missing, false);
  assert.ok(r.error, 'should carry the parse error');
});

test('readMcpServers reports malformed when top-level is an array', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'array.json');
  writeJson(file, ['not', 'an', 'object']);
  const r = readMcpServers(file);
  assert.equal(r.malformed, true);
});

test('readMcpServers returns empty servers when file has no .mcpServers key', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeJson(file, { oauthAccount: { id: 'abc' }, projects: {} });
  const r = readMcpServers(file);
  assert.equal(r.malformed, false);
  assert.deepEqual(r.servers, {});
  // raw must carry the unrelated keys for the round-trip writer.
  assert.equal(r.raw.oauthAccount.id, 'abc');
  assert.deepEqual(r.raw.projects, {});
});

test('readMcpServers reads a top-level mcpServers map', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeJson(file, {
    mcpServers: {
      mnestra: { type: 'stdio', command: 'mnestra' },
      memory: { type: 'http', url: 'https://example' },
    },
  });
  const r = readMcpServers(file);
  assert.equal(r.malformed, false);
  assert.equal(r.servers.mnestra.command, 'mnestra');
  assert.equal(r.servers.memory.url, 'https://example');
});

// ── mergeMcpServers ────────────────────────────────────────────────────────

test('mergeMcpServers takes everything from legacy when current is empty', () => {
  const merged = mergeMcpServers({}, { a: { command: 'a' }, b: { command: 'b' } });
  assert.deepEqual(merged, { a: { command: 'a' }, b: { command: 'b' } });
});

test('mergeMcpServers takes everything from current when legacy is empty', () => {
  const merged = mergeMcpServers({ a: { command: 'a' } }, {});
  assert.deepEqual(merged, { a: { command: 'a' } });
});

test('mergeMcpServers returns the union when keys are disjoint', () => {
  const merged = mergeMcpServers(
    { current: { command: 'c' } },
    { legacy: { command: 'l' } },
  );
  assert.deepEqual(merged, {
    current: { command: 'c' },
    legacy: { command: 'l' },
  });
});

test('mergeMcpServers keeps the current entry on key collision (current wins)', () => {
  const merged = mergeMcpServers(
    { mnestra: { command: 'mnestra-canonical', env: { MARK: 'current' } } },
    { mnestra: { command: 'mnestra-legacy', env: { MARK: 'legacy' } } },
  );
  assert.equal(merged.mnestra.command, 'mnestra-canonical');
  assert.equal(merged.mnestra.env.MARK, 'current');
});

test('mergeMcpServers tolerates null/undefined inputs', () => {
  assert.deepEqual(mergeMcpServers(null, undefined), {});
  assert.deepEqual(
    mergeMcpServers(undefined, { a: { command: 'a' } }),
    { a: { command: 'a' } },
  );
});

// ── writeMcpServers ────────────────────────────────────────────────────────

test('writeMcpServers preserves all unrelated top-level keys', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeJson(file, {
    oauthAccount: { id: 'abc-123', email: 'x@y' },
    projects: { '/some/path': { lastUsed: 1234 } },
    installMethod: 'unknown',
    mcpServers: { old: { command: 'old' } },
  });

  writeMcpServers(file, { newby: { type: 'stdio', command: 'newby' } });

  const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(reread.oauthAccount.id, 'abc-123');
  assert.equal(reread.oauthAccount.email, 'x@y');
  assert.deepEqual(reread.projects, { '/some/path': { lastUsed: 1234 } });
  assert.equal(reread.installMethod, 'unknown');
  // .mcpServers replaced wholesale.
  assert.deepEqual(reread.mcpServers, { newby: { type: 'stdio', command: 'newby' } });
});

test('writeMcpServers creates a minimal file when none exists', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'sub', 'cfg.json');
  writeMcpServers(file, { mnestra: { type: 'stdio', command: 'mnestra' } });
  const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(reread, {
    mcpServers: { mnestra: { type: 'stdio', command: 'mnestra' } },
  });
});

test('writeMcpServers leaves the file at mode 0600', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeMcpServers(file, { a: { type: 'stdio', command: 'a' } });
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('writeMcpServers cleans up the .tmp file after rename', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeMcpServers(file, { a: { type: 'stdio', command: 'a' } });
  // No stale tmp files left behind in the parent dir.
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp.'));
  assert.deepEqual(leftovers, []);
});

test('writeMcpServers is idempotent on identical input', () => {
  const dir = freshTmpDir();
  const file = path.join(dir, 'cfg.json');
  writeJson(file, {
    oauthAccount: { id: 'x' },
    mcpServers: { a: { type: 'stdio', command: 'a' } },
  });
  writeMcpServers(file, { a: { type: 'stdio', command: 'a' } });
  const first = fs.readFileSync(file, 'utf8');
  writeMcpServers(file, { a: { type: 'stdio', command: 'a' } });
  const second = fs.readFileSync(file, 'utf8');
  assert.equal(first, second);
});

// ── migrateLegacyIfPresent ─────────────────────────────────────────────────

test('migrateLegacyIfPresent is a no-op when legacy is missing', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, { mcpServers: { keep: { command: 'k' } } });

  const r = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(r.migrated, []);
  assert.equal(r.wrote, false);
  // Canonical untouched.
  const reread = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  assert.deepEqual(reread.mcpServers, { keep: { command: 'k' } });
});

test('migrateLegacyIfPresent copies legacy-only entries forward', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, {
    oauthAccount: { id: 'preserve-me' },
    mcpServers: { current: { command: 'c' } },
  });
  writeJson(legacy, { mcpServers: { legacy_only: { command: 'l' } } });

  const r = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(r.migrated, ['legacy_only']);
  assert.deepEqual(r.kept, []);
  assert.equal(r.wrote, true);

  const reread = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  assert.equal(reread.oauthAccount.id, 'preserve-me');
  assert.deepEqual(Object.keys(reread.mcpServers).sort(), ['current', 'legacy_only']);

  // Legacy file untouched.
  assert.equal(fs.existsSync(legacy), true);
  const legacyContents = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  assert.deepEqual(legacyContents.mcpServers, { legacy_only: { command: 'l' } });
});

test('migrateLegacyIfPresent is idempotent — second run reports migrated=[]', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, { mcpServers: {} });
  writeJson(legacy, { mcpServers: { foo: { command: 'foo' } } });

  const first = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(first.migrated, ['foo']);
  assert.equal(first.wrote, true);

  const second = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(second.migrated, []);
  assert.equal(second.wrote, false);
  assert.deepEqual(second.kept, ['foo']);
});

test('migrateLegacyIfPresent has current win on key overlap', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, {
    mcpServers: { mnestra: { command: 'canonical-mnestra' } },
  });
  writeJson(legacy, {
    mcpServers: { mnestra: { command: 'legacy-mnestra' } },
  });

  const r = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(r.migrated, []);
  assert.deepEqual(r.kept, ['mnestra']);
  // Canonical entry preserved verbatim — no spurious write.
  assert.equal(r.wrote, false);
  const reread = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  assert.equal(reread.mcpServers.mnestra.command, 'canonical-mnestra');
});

test('migrateLegacyIfPresent dryRun reports the plan without writing', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, { mcpServers: {} });
  writeJson(legacy, { mcpServers: { x: { command: 'x' } } });

  const r = migrateLegacyIfPresent({
    canonicalPath: canonical,
    legacyPath: legacy,
    dryRun: true,
  });
  assert.deepEqual(r.migrated, ['x']);
  assert.equal(r.wrote, false);

  // Canonical NOT written.
  const reread = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  assert.deepEqual(reread.mcpServers, {});
});

test('migrateLegacyIfPresent creates the canonical file when missing', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(legacy, { mcpServers: { only: { command: 'only' } } });

  const r = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(r.migrated, ['only']);
  assert.equal(r.wrote, true);
  assert.equal(fs.existsSync(canonical), true);
  const reread = JSON.parse(fs.readFileSync(canonical, 'utf8'));
  assert.deepEqual(reread.mcpServers, { only: { command: 'only' } });
});

test('migrateLegacyIfPresent surfaces malformed legacy without writing', () => {
  const dir = freshTmpDir();
  const canonical = path.join(dir, 'canonical.json');
  const legacy = path.join(dir, 'legacy.json');
  writeJson(canonical, { mcpServers: { keep: { command: 'k' } } });
  fs.writeFileSync(legacy, '{ definitely not json', { mode: 0o600 });

  const r = migrateLegacyIfPresent({ canonicalPath: canonical, legacyPath: legacy });
  assert.deepEqual(r.migrated, []);
  assert.equal(r.wrote, false);
  assert.ok(r.malformed && r.malformed.legacy, 'legacy malformed flag should be set');
});

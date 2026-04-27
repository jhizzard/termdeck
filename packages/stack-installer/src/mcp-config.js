'use strict';

// Canonical schema/CRUD for the Claude Code MCP server config.
//
// SIBLING COPY of packages/cli/src/mcp-config.js. Two physical copies
// exist so each published npm package (@jhizzard/termdeck and
// @jhizzard/termdeck-stack) stays self-contained — the stack-installer's
// `files` field publishes only `src/**` and cannot require() into the
// CLI package. Same exports, same semantics. Keep in sync.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_MCP_PATH_CANONICAL = path.join(os.homedir(), '.claude.json');
const CLAUDE_MCP_PATH_LEGACY = path.join(os.homedir(), '.claude', 'mcp.json');

function readMcpServers(filePath) {
  if (!fs.existsSync(filePath)) {
    return { servers: {}, raw: {}, missing: true, malformed: false };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { servers: {}, raw: {}, missing: false, malformed: true, error: err.message };
  }
  if (text.trim() === '') {
    return { servers: {}, raw: {}, missing: false, malformed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { servers: {}, raw: {}, missing: false, malformed: true, error: err.message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, raw: {}, missing: false, malformed: true, error: 'top-level must be an object' };
  }
  const servers = (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers))
    ? parsed.mcpServers
    : {};
  return { servers, raw: parsed, missing: false, malformed: false };
}

function mergeMcpServers(currentServers, legacyServers) {
  const out = {};
  const legacy = (legacyServers && typeof legacyServers === 'object') ? legacyServers : {};
  const current = (currentServers && typeof currentServers === 'object') ? currentServers : {};
  for (const [name, entry] of Object.entries(legacy)) {
    out[name] = entry;
  }
  for (const [name, entry] of Object.entries(current)) {
    out[name] = entry;
  }
  return out;
}

function writeMcpServers(filePath, servers) {
  const existing = readMcpServers(filePath);
  const next = (existing.malformed || existing.missing)
    ? {}
    : { ...existing.raw };
  next.mcpServers = servers || {};

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_e) { /* best-effort */ }
}

function migrateLegacyIfPresent(opts = {}) {
  const dryRun = !!opts.dryRun;
  const canonicalPath = opts.canonicalPath || CLAUDE_MCP_PATH_CANONICAL;
  const legacyPath = opts.legacyPath || CLAUDE_MCP_PATH_LEGACY;

  const canonical = readMcpServers(canonicalPath);
  const legacy = readMcpServers(legacyPath);

  const malformed = {};
  if (canonical.malformed) malformed.canonical = canonical.error || true;
  if (legacy.malformed) malformed.legacy = legacy.error || true;

  if (legacy.missing || legacy.malformed) {
    return {
      migrated: [],
      kept: [],
      wrote: false,
      canonicalPath,
      legacyPath,
      malformed: Object.keys(malformed).length ? malformed : undefined,
    };
  }

  const migrated = [];
  const kept = [];
  const merged = { ...canonical.servers };
  for (const [name, entry] of Object.entries(legacy.servers)) {
    if (Object.prototype.hasOwnProperty.call(canonical.servers, name)) {
      kept.push(name);
    } else {
      merged[name] = entry;
      migrated.push(name);
    }
  }

  if (migrated.length === 0) {
    return {
      migrated: [],
      kept,
      wrote: false,
      canonicalPath,
      legacyPath,
      malformed: Object.keys(malformed).length ? malformed : undefined,
    };
  }

  if (!dryRun) writeMcpServers(canonicalPath, merged);

  return {
    migrated,
    kept,
    wrote: !dryRun,
    canonicalPath,
    legacyPath,
    malformed: Object.keys(malformed).length ? malformed : undefined,
  };
}

module.exports = {
  CLAUDE_MCP_PATH_CANONICAL,
  CLAUDE_MCP_PATH_LEGACY,
  readMcpServers,
  mergeMcpServers,
  writeMcpServers,
  migrateLegacyIfPresent,
};

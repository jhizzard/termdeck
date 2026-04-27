'use strict';

// Canonical schema/CRUD for the Claude Code MCP server config.
//
// Sprint 36 T2: Claude Code v2.1.119+ reads its MCP config from
// ~/.claude.json (top-level `mcpServers` key, alongside ~55 other internal
// keys it owns). Earlier installs wrote to ~/.claude/mcp.json, which the
// current Claude Code never reads. Fresh users hit this as "the install is
// broken" — Mnestra was wired into the wrong file.
//
// This module is the single source of truth for path constants and the
// read-modify-write helpers all installer/CLI code paths use. Two physical
// copies exist (this one + packages/stack-installer/src/mcp-config.js) so
// each published npm package stays self-contained. The stack-installer
// copy must stay in sync with this one — same exports, same semantics.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_MCP_PATH_CANONICAL = path.join(os.homedir(), '.claude.json');
const CLAUDE_MCP_PATH_LEGACY = path.join(os.homedir(), '.claude', 'mcp.json');

// readMcpServers(filePath) → { servers, raw, missing, malformed, error }
//
//   servers   the .mcpServers map (always an object, never undefined)
//   raw       the full parsed top-level object (for structure-preserving
//             write-back). Empty object on missing/malformed.
//   missing   true when the file doesn't exist
//   malformed true when the file exists but JSON.parse failed
//   error     parse error message when malformed
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

// mergeMcpServers(currentServers, legacyServers) → merged map
//
// Current wins on key collision — current is the source of truth, legacy
// is a migration source. Both inputs are tolerated as null/undefined.
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

// writeMcpServers(filePath, servers) — atomic, structure-preserving.
//
// If the file exists with other top-level keys (the common case for
// ~/.claude.json), only `.mcpServers` is replaced; everything else
// survives byte-equivalent through JSON.parse → JSON.stringify. If the
// file is missing or empty, writes a minimal `{ mcpServers: {...} }`.
// Atomic via tmp-and-rename. Mode 0600.
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

// migrateLegacyIfPresent({ dryRun, canonicalPath, legacyPath })
//   → { migrated, kept, wrote, canonicalPath, legacyPath, malformed }
//
//   migrated  array of server names copied from legacy → canonical
//   kept      array of names that existed in both (canonical wins,
//             legacy version skipped)
//   wrote     true if the canonical file was written
//   malformed { canonical?: error, legacy?: error } when either parse failed
//
// Idempotent: a second invocation with no new legacy entries returns
// migrated: []. Never deletes or modifies the legacy file.
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

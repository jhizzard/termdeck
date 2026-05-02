// Sprint 48 T1 — Shared per-agent MCP auto-wire helper.
//
// Single export: ensureMnestraBlock(adapter, opts?). Idempotent. T1/T2/T3
// agent adapters (codex, gemini, grok) each ship an `mcpConfig` field
// describing where their MCP-server config lives, what format it's in,
// and how to merge a Mnestra entry into it. This helper is the agent-
// agnostic glue: read the file, dispatch on shape, render+merge+write
// using the secrets in ~/.termdeck/secrets.env.
//
// Why this exists: cross-project memory recall (Mnestra MCP) was unavailable
// to non-Claude agents by default in Sprint 47's Grok smoke — those CLIs
// ship without an MCP block and outside users would hit memory_recall
// failures the first time they spawned a non-Claude lane. This is the
// v1.0.0 gate-blocker fix.
//
// Three adapter shapes are supported (precedence top → bottom):
//
//   1. Escape-hatch (Grok-style — array-shape JSON or anything bespoke):
//        mcpConfig: { path, format, merge: (rawText, {secrets}) =>
//                                          ({ changed: bool, output: string }) }
//      Adapter owns parse + mutate + serialize entirely. Helper still owns
//      tilde expand, mkdir, read, atomic write, return shape.
//
//   2. JSON-record (Gemini-style — `{mcpServers: {NAME: {...}}}`):
//        mcpConfig: { path, format: 'json', mcpServersKey: 'mcpServers',
//                     mnestraBlock: ({secrets}) => ({mnestra: {command, env}}) }
//      Helper deep-merges the returned object under `config[mcpServersKey]`.
//      Existence detected by checking `existing[mcpServersKey]?.mnestra`.
//
//   3. TOML-append (Codex-style — `[mcp_servers.NAME]` tables):
//        mcpConfig: { path, format: 'toml',
//                     mnestraBlock: ({secrets}) => '[mcp_servers.mnestra]\n...',
//                     detectExisting: (text) => /\[mcp_servers\.mnestra\]/m.test(text) }
//      Helper appends the rendered string to the file with one blank-line
//      separator. Idempotent via the adapter's `detectExisting` predicate.
//
// Claude is intentionally exempt — its MCP config (~/.claude.json) is
// owned by the user and `claude mcp add`. Adding a Mnestra block here
// would conflict with that surface. Claude's adapter declares
// `mcpConfig: null` to satisfy the contract-parity tests.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SECRETS_PATH = path.join(os.homedir(), '.termdeck', 'secrets.env');

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// dotenv-subset parser. Mirrors stack-installer's readTermdeckSecrets so the
// two stay byte-equivalent (KEY=value, optional matched single/double quotes,
// `#` comments, blanks ignored). Returns {} on absent / unreadable file.
// Rejects literal `${VAR}` placeholder shapes — same defense as the mnestra
// MCP stdio fallback (Claude Code et al. don't shell-expand them, so writing
// the literal placeholder is worse than omitting the key entirely).
function readSecrets(secretsPath = SECRETS_PATH) {
  try {
    const text = fs.readFileSync(secretsPath, 'utf8');
    const out = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (
        v.length >= 2
        && (v[0] === '"' || v[0] === "'")
        && v[v.length - 1] === v[0]
      ) {
        v = v.slice(1, -1);
      }
      if (v.startsWith('${') && v.endsWith('}')) continue;
      out[m[1]] = v;
    }
    return out;
  } catch (_err) {
    return {};
  }
}

// One-level-deep merge sufficient for the `mcpServers.NAME` shape. Nested
// objects under matching keys are themselves merged shallowly; arrays +
// primitives are replaced.
function mergeJson(base, addition) {
  const out = { ...base };
  for (const [k, v] of Object.entries(addition)) {
    if (
      v && typeof v === 'object' && !Array.isArray(v)
      && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
    ) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Append a TOML block to existing file content with one blank-line separator
// (or none if the file is empty). Codex's TOML parser accepts tables in any
// order so appending is the safe operation; we don't try to surgically
// rewrite mid-file.
function appendTomlBlock(existing, block) {
  const trailing = existing.endsWith('\n') ? '' : '\n';
  const sep = existing.length === 0 ? '' : trailing + '\n';
  const blockTail = block.endsWith('\n') ? '' : '\n';
  return existing + sep + block + blockTail;
}

// Detect whether a JSON-shape object already has a Mnestra entry under
// `mcpServersKey`. Tolerant of the key being absent or non-object.
function jsonAlreadyHasMnestra(parsedConfig, mcpServersKey) {
  const bag = parsedConfig && parsedConfig[mcpServersKey];
  return !!(bag && typeof bag === 'object' && !Array.isArray(bag) && bag.mnestra);
}

// Idempotent. Returns one of:
//   { skipped: true, reason: '...' }     — adapter omits or malforms mcpConfig
//   { unchanged: true, path }            — block already present
//   { wrote: true, path, bytes }         — block written / appended
//
// opts.secretsPath overrides the default ~/.termdeck/secrets.env (used by
// tests); opts.secrets passes a pre-parsed object directly (also tests).
function ensureMnestraBlock(adapter, opts = {}) {
  if (!adapter || !adapter.mcpConfig) {
    return { skipped: true, reason: 'no-mcpConfig' };
  }
  const cfg = adapter.mcpConfig;
  if (typeof cfg.path !== 'string') {
    return { skipped: true, reason: 'malformed-mcpConfig' };
  }

  const useMerge = typeof cfg.merge === 'function';
  const useJsonRecord = !useMerge
    && cfg.format === 'json'
    && typeof cfg.mcpServersKey === 'string'
    && typeof cfg.mnestraBlock === 'function';
  const useTomlAppend = !useMerge && !useJsonRecord
    && cfg.format === 'toml'
    && typeof cfg.mnestraBlock === 'function'
    && typeof cfg.detectExisting === 'function';
  const useJsonAppend = !useMerge && !useJsonRecord && !useTomlAppend
    && cfg.format === 'json'
    && typeof cfg.mnestraBlock === 'function'
    && typeof cfg.detectExisting === 'function';

  if (!useMerge && !useJsonRecord && !useTomlAppend && !useJsonAppend) {
    return { skipped: true, reason: 'malformed-mcpConfig' };
  }

  const target = expandTilde(cfg.path);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let existing = '';
  try { existing = fs.readFileSync(target, 'utf8'); } catch (_) { existing = ''; }

  const secrets = opts.secrets || readSecrets(opts.secretsPath || SECRETS_PATH);

  // 1. Escape-hatch — adapter owns the merge entirely.
  if (useMerge) {
    let result;
    try { result = cfg.merge(existing, { secrets, adapter }); }
    catch (e) { return { skipped: true, reason: `merge-threw-${e.message}` }; }
    if (!result || typeof result !== 'object') {
      return { skipped: true, reason: 'merge-bad-return' };
    }
    if (!result.changed) return { unchanged: true, path: target };
    if (typeof result.output !== 'string') {
      return { skipped: true, reason: 'merge-output-not-string' };
    }
    fs.writeFileSync(target, result.output, { mode: 0o600 });
    return { wrote: true, path: target, bytes: Buffer.byteLength(result.output) };
  }

  // 2. JSON record-merge (Gemini shape).
  if (useJsonRecord) {
    let parsed = {};
    if (existing.trim() !== '') {
      try { parsed = JSON.parse(existing); }
      catch (_) { return { skipped: true, reason: 'existing-json-malformed' }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    }
    if (jsonAlreadyHasMnestra(parsed, cfg.mcpServersKey)) {
      return { unchanged: true, path: target };
    }
    let block;
    try { block = cfg.mnestraBlock({ secrets, adapter }); }
    catch (e) { return { skipped: true, reason: `mnestraBlock-threw-${e.message}` }; }
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return { skipped: true, reason: 'mnestraBlock-not-object' };
    }
    const next = { ...parsed };
    const bag = (next[cfg.mcpServersKey] && typeof next[cfg.mcpServersKey] === 'object'
                 && !Array.isArray(next[cfg.mcpServersKey]))
      ? { ...next[cfg.mcpServersKey] }
      : {};
    Object.assign(bag, block);
    next[cfg.mcpServersKey] = bag;
    const serialized = JSON.stringify(next, null, 2) + '\n';
    fs.writeFileSync(target, serialized, { mode: 0o600 });
    return { wrote: true, path: target, bytes: Buffer.byteLength(serialized) };
  }

  // 3 & 4. detectExisting + mnestraBlock-string paths (TOML or JSON-append).
  if (cfg.detectExisting(existing)) {
    return { unchanged: true, path: target };
  }
  let block;
  try { block = cfg.mnestraBlock({ secrets, adapter }); }
  catch (e) { return { skipped: true, reason: `mnestraBlock-threw-${e.message}` }; }
  if (typeof block !== 'string') {
    return { skipped: true, reason: 'mnestraBlock-not-string' };
  }

  let next;
  if (useTomlAppend) {
    next = appendTomlBlock(existing, block);
  } else {
    // useJsonAppend — original brief shape: mnestraBlock returns JSON text,
    // helper deep-merges. Used by adapters that prefer to control the
    // serialization but don't want the escape-hatch's full responsibility.
    let parsed = {};
    if (existing.trim() !== '') {
      try { parsed = JSON.parse(existing); }
      catch (_) { return { skipped: true, reason: 'existing-json-malformed' }; }
    }
    let blockObj;
    try { blockObj = JSON.parse(block); }
    catch (_) { return { skipped: true, reason: 'mnestraBlock-not-parseable-json' }; }
    const merged = mergeJson(parsed, blockObj);
    next = JSON.stringify(merged, null, 2) + '\n';
  }

  fs.writeFileSync(target, next, { mode: 0o600 });
  return { wrote: true, path: target, bytes: Buffer.byteLength(next) };
}

module.exports = {
  ensureMnestraBlock,
  readSecrets,
  expandTilde,
  // Internals exposed for unit tests; not part of the public API.
  _internals: { mergeJson, appendTomlBlock, jsonAlreadyHasMnestra, SECRETS_PATH },
};

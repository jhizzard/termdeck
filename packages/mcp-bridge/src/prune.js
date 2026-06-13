'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MCP Bridge — `prune-stale-clients` maintenance command  (v1.10.2)
//
// Why this exists: the Bridge persists DCR (RFC 7591) clients and HASHED refresh
// tokens to ~/.termdeck/bridge-auth.json. Each refresh token records the
// canonical RFC 8707 *resource* it was minted against (mintRefreshToken stamps
// resourceUrl.href). When the Bridge's public URL changes — the classic case is
// an ephemeral *.trycloudflare.com tunnel rotating — old grants stay in the file
// bound to a DEAD resource. A connector replaying one of those grants triggers
// the confusing "stale OAuth grant → 400 / couldn't connect your account"
// failure this command (with the exchangeRefreshToken stale-resource guard in
// auth.js) is designed to make recoverable.
//
// This module is the SELECTION + REWRITE engine. It is intentionally pure and
// HTTP-free so it is unit-testable and so the live server need not be running
// (and MUST NOT be running's auth state mutated out from under it):
//
//   • DRY-RUN BY DEFAULT. Nothing is written unless { apply: true }.
//   • Conservative selection. A refresh token is stale iff its bound resource
//     does not normalize-equal the current canonical resource. A DCR client is
//     stale iff it HAS refresh tokens AND every one of them is stale — a client
//     with NO refresh tokens (e.g. registered but never completed a grant) is
//     LEFT ALONE; we cannot prove it is stale and removing it could strand a
//     connector mid-authorize. Static clients never appear in this file.
//   • Atomic apply. Writes a backup (<file>.bak-<ts>) then temp-file + rename,
//     mode 0600 — never a partial in-place rewrite.
//   • No secrets in output. Client ids are masked; refresh-token HASHES (the map
//     keys) are NEVER printed; client_secret / jwtSecret are NEVER read out.
// ─────────────────────────────────────────────────────────────────────────────

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { normalizeResource } = require('./auth');

function defaultStatePath() {
  return path.join(os.homedir(), '.termdeck', 'bridge-auth.json');
}

// Derive the Bridge's current canonical resource exactly as createBridgeAuth
// does: resource = <issuer>/mcp, issuer = TERMDECK_BRIDGE_PUBLIC_URL (or the
// localhost:PORT dev fallback). An explicit override wins (used by tests).
function resolveCanonicalResource(options = {}) {
  if (options.resourceUrl) return new URL(options.resourceUrl).href;
  const issuer = new URL(
    options.issuerUrl ||
      process.env.TERMDECK_BRIDGE_PUBLIC_URL ||
      `http://localhost:${options.port || process.env.PORT || 8870}`,
  );
  return new URL('/mcp', issuer).href;
}

// Mask a client id for human-readable output: keep a short visible prefix so an
// operator can correlate, redact the rest. Never reveals enough to forge.
function maskClientId(id) {
  const s = String(id || '');
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 8) + '…' + s.slice(-2);
}

// Mask a resource URL: origin host is partially hidden, path kept (paths are not
// secret, but the host of a private tunnel is mildly sensitive).
function maskResource(href) {
  try {
    const u = new URL(href);
    const host = u.host.replace(/^([^.]{0,3})[^.]*/, '$1***');
    return `${u.protocol}//${host}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

// Read + parse the state file. Returns a fresh empty shape if missing/unreadable
// (fail-soft, same posture as createFileStore) with `existed: false` so callers
// can distinguish "nothing to do" from "file present, nothing stale".
function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      existed: true,
      state: {
        jwtSecret: parsed.jwtSecret || null,
        clients: parsed.clients || {},
        refresh: parsed.refresh || {},
      },
    };
  } catch {
    return { existed: false, state: { jwtSecret: null, clients: {}, refresh: {} } };
  }
}

// Pure selection: given a parsed state and the canonical resource, compute what
// WOULD be removed. No I/O. Exported for unit tests.
//
// Returns:
//   {
//     canonicalResource,
//     staleRefreshHashes: string[]   // map keys to delete (NEVER printed)
//     staleRefreshCount, validRefreshCount,
//     staleClientIds: string[]       // DCR client ids to delete
//     keptClientIds: string[]        // clients left alone (valid or no-grant)
//     report: [{ clientId(masked), reason, resources:[masked] }]
//   }
function selectStale(state, canonicalResource) {
  const canon = normalizeResource(canonicalResource);
  const refresh = state.refresh || {};
  const clients = state.clients || {};

  // Pass 1: classify refresh tokens, and build client_id -> {stale[], valid[]}.
  const staleRefreshHashes = [];
  let validRefreshCount = 0;
  const perClient = new Map(); // client_id -> { stale: Set<resource>, valid: number }

  for (const [hash, rec] of Object.entries(refresh)) {
    const cid = rec && rec.client_id;
    const boundResource = rec && rec.resource;
    const isStale = !!boundResource && normalizeResource(boundResource) !== canon;
    if (!perClient.has(cid)) perClient.set(cid, { stale: new Set(), valid: 0 });
    const bucket = perClient.get(cid);
    if (isStale) {
      staleRefreshHashes.push(hash);
      bucket.stale.add(boundResource);
    } else {
      validRefreshCount++;
      bucket.valid++;
    }
  }

  // Pass 2: a DCR client is stale iff it has refresh tokens and ALL are stale.
  // (A client with valid grants, or with no grants at all, is preserved.)
  const staleClientIds = [];
  const keptClientIds = [];
  const report = [];
  for (const cid of Object.keys(clients)) {
    const bucket = perClient.get(cid);
    if (bucket && bucket.valid === 0 && bucket.stale.size > 0) {
      staleClientIds.push(cid);
      report.push({
        clientId: maskClientId(cid),
        reason: 'all grants bound to a non-current resource',
        resources: [...bucket.stale].map(maskResource),
      });
    } else {
      keptClientIds.push(cid);
    }
  }

  // Stale refresh tokens whose client is NOT itself being removed (e.g. a client
  // that ALSO has a valid grant): we still drop the stale token rows, but the
  // client stays. Surface those as a separate, client-masked line.
  const removedClientSet = new Set(staleClientIds);
  const orphanStaleByClient = new Map();
  for (const [hash, rec] of Object.entries(refresh)) {
    const cid = rec && rec.client_id;
    const boundResource = rec && rec.resource;
    const isStale = !!boundResource && normalizeResource(boundResource) !== canon;
    if (isStale && !removedClientSet.has(cid)) {
      if (!orphanStaleByClient.has(cid)) orphanStaleByClient.set(cid, new Set());
      orphanStaleByClient.get(cid).add(boundResource);
    }
  }
  for (const [cid, resources] of orphanStaleByClient) {
    report.push({
      clientId: maskClientId(cid),
      reason: 'stale refresh token(s) removed; client retained (still has a current grant)',
      resources: [...resources].map(maskResource),
    });
  }

  return {
    canonicalResource,
    staleRefreshHashes,
    staleRefreshCount: staleRefreshHashes.length,
    validRefreshCount,
    staleClientIds,
    keptClientIds,
    report,
  };
}

// Apply the selection to a state object IN PLACE (delete the chosen keys).
function applySelection(state, selection) {
  for (const hash of selection.staleRefreshHashes) delete state.refresh[hash];
  for (const cid of selection.staleClientIds) delete state.clients[cid];
  return state;
}

// Atomic write: backup the existing file (timestamped), then temp + rename.
// mode 0600 throughout. Returns the backup path written (or null if no prior
// file existed to back up).
function writeStateAtomic(file, state) {
  let backupPath = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* dir may already exist */
  }
  if (fs.existsSync(file)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${file}.bak-${ts}`;
    fs.copyFileSync(file, backupPath);
    try {
      fs.chmodSync(backupPath, 0o600);
    } catch {
      /* best-effort */
    }
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
  return backupPath;
}

// ── CLI orchestration ────────────────────────────────────────────────────────
// Parse just the flags this command cares about. Unknown flags are ignored
// (forward-compatible). `--apply` switches off dry-run; `--file <path>` and
// `--resource <url>` are test/advanced overrides.
function parsePruneArgs(argv) {
  const out = { apply: false, file: null, resource: null, json: false };
  const a = argv || [];
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (tok === '--apply') out.apply = true;
    else if (tok === '--json') out.json = true;
    else if (tok === '--file') out.file = a[++i];
    else if (tok === '--resource') out.resource = a[++i];
    else if (tok && tok.startsWith('--file=')) out.file = tok.slice('--file='.length);
    else if (tok && tok.startsWith('--resource=')) out.resource = tok.slice('--resource='.length);
  }
  return out;
}

// Run the command. `print` defaults to stdout; injectable for tests. Returns a
// structured result (also used by tests) — NEVER contains secrets or token
// hashes.
function runPrune(argv, { print, env, statePath } = {}) {
  const args = parsePruneArgs(argv);
  const log = print || ((s) => process.stdout.write(s + '\n'));
  const file = statePath || args.file || defaultStatePath();
  const prevEnv = env || process.env;

  const canonicalResource = resolveCanonicalResource({
    resourceUrl: args.resource,
    issuerUrl: prevEnv.TERMDECK_BRIDGE_PUBLIC_URL,
    port: prevEnv.PORT,
  });

  const { existed, state } = readState(file);
  if (!existed) {
    const out = {
      mode: 'dry-run',
      file,
      canonicalResource,
      fileFound: false,
      staleClients: 0,
      staleRefreshTokens: 0,
    };
    log(`bridge prune-stale-clients — no state file at ${file} (nothing to do)`);
    return out;
  }

  const selection = selectStale(state, canonicalResource);
  const mode = args.apply ? 'apply' : 'dry-run';

  if (args.json) {
    log(
      JSON.stringify({
        mode,
        file,
        canonicalResource: maskResource(canonicalResource),
        staleClients: selection.staleClientIds.length,
        staleRefreshTokens: selection.staleRefreshCount,
        keptClients: selection.keptClientIds.length,
        validRefreshTokens: selection.validRefreshCount,
        report: selection.report,
      }),
    );
  } else {
    log(`bridge prune-stale-clients (${mode})`);
    log(`  state file        : ${file}`);
    log(`  current resource  : ${maskResource(canonicalResource)}`);
    log(`  stale DCR clients : ${selection.staleClientIds.length}`);
    log(`  stale refresh tok : ${selection.staleRefreshCount}`);
    log(`  kept clients      : ${selection.keptClientIds.length}`);
    log(`  valid refresh tok : ${selection.validRefreshCount}`);
    if (selection.report.length) {
      log('  ── would remove ──');
      for (const r of selection.report) {
        log(`    client ${r.clientId} — ${r.reason}`);
        for (const res of r.resources) log(`        bound to: ${res}`);
      }
    } else {
      log('  nothing stale — all grants are bound to the current resource.');
    }
  }

  const result = {
    mode,
    file,
    canonicalResource,
    fileFound: true,
    staleClients: selection.staleClientIds.length,
    staleRefreshTokens: selection.staleRefreshCount,
    keptClients: selection.keptClientIds.length,
    validRefreshTokens: selection.validRefreshCount,
    backupPath: null,
    wrote: false,
  };

  if (!args.apply) {
    if (selection.staleClientIds.length || selection.staleRefreshCount) {
      log('  (dry-run — re-run with --apply to write these changes)');
    }
    return result;
  }

  // --apply path
  if (!selection.staleClientIds.length && !selection.staleRefreshCount) {
    log('  nothing to apply.');
    return result;
  }
  applySelection(state, selection);
  const backupPath = writeStateAtomic(file, state);
  result.backupPath = backupPath;
  result.wrote = true;
  log(`  applied. backup written to: ${backupPath}`);
  return result;
}

module.exports = {
  runPrune,
  parsePruneArgs,
  selectStale,
  applySelection,
  resolveCanonicalResource,
  readState,
  writeStateAtomic,
  defaultStatePath,
  maskClientId,
  maskResource,
};

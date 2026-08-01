'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TermDeck API base resolver — finds the LIVE deck's HTTP API base.
//
// Bug this fixes (claude.ai feedback + 2026-06-13 bug_fix memory): the panel
// tools (list_panels / recent_activity / panel_status) reached TermDeck via a
// hardcoded http://127.0.0.1:3000. When the live deck runs on another port
// (:3001, :3002 and :3099 have all been seen in the wild), every panel tool
// reported "no visible panels" even though the deck was up and serving.
//
// Resolution order (first hit wins):
//   1. Explicit override — TERMDECK_API_BASE / TERMDECK_BASE_URL env (or a
//      baseUrl injected by the caller). Authoritative: never probed, never
//      cache-invalidated. Set it to pin the bridge to one specific deck.
//   2. Runtime state — ~/.termdeck/ports.json, written by the TermDeck server
//      at listen-time as { version, decks: [{ port, pid, startedAt }] }.
//      Entries whose pid is no longer alive are skipped (prune-on-read; the
//      SERVER rewrites/prunes the file on its next boot — this reader stays
//      write-free because the bridge is a read-only process by design).
//      Candidates are tried freshest-startedAt first, and each one is STILL
//      verified with a live probe before acceptance, so a stale entry (pid
//      reuse, wedged server) can never capture the bridge.
//   3. Port probe — GET /api/sessions on 3000, 3001, 3002, 3099 in order,
//      ~500ms timeout each; the first port answering HTTP 2xx with a JSON
//      array (the TermDeck sessions shape) wins. NOTE: :3100 is deliberately
//      NOT in this list — a non-TermDeck app server lives there on the
//      reference host; never probe it as TermDeck.
//
// Ambiguity rule (multiple decks live at once): the state file's freshest
// startedAt wins; absent usable state, the FIRST answering port in the fixed
// probe order wins (deterministic, and keeps the historical :3000 default as
// the top preference).
//
// The resolved base is cached for a short TTL (~60s) so tool calls don't
// re-probe constantly; reportFailure() drops the cache so a deck restart on a
// different port heals on the very next call.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { requestJson } = require('./http');

const DEFAULT_BASE = 'http://127.0.0.1:3000';
const PROBE_PORTS = [3000, 3001, 3002, 3099];
const PROBE_TIMEOUT_MS = 500;
const CACHE_TTL_MS = 60_000;

function defaultPortsPath() {
  return path.join(os.homedir(), '.termdeck', 'ports.json');
}

// pid liveness via signal 0. EPERM = alive but owned by someone else; any
// other error (ESRCH) = dead.
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

// createBaseResolver({ env?, fetchImpl?, fsImpl?, portsPath?, probePorts?,
//                      probeTimeoutMs?, ttlMs?, now?, isPidAlive? })
// → { resolve(): Promise<string>, reportFailure(): void }
function createBaseResolver(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl;
  const fsImpl = opts.fsImpl || fs;
  const portsPath = opts.portsPath || defaultPortsPath();
  const probePorts = opts.probePorts || PROBE_PORTS;
  const probeTimeoutMs = opts.probeTimeoutMs || PROBE_TIMEOUT_MS;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : CACHE_TTL_MS;
  const now = opts.now || Date.now;
  const isPidAlive = opts.isPidAlive || defaultIsPidAlive;

  let cached = null; // { base, at }

  function explicitBase() {
    const raw = env.TERMDECK_API_BASE || env.TERMDECK_BASE_URL;
    return raw ? String(raw).replace(/\/+$/, '') : null;
  }

  // A port is a live TermDeck iff GET /api/sessions answers 2xx with a JSON
  // array (the TermDeck sessions shape). Anything else — refused, timeout,
  // non-2xx, non-array body (some other app squatting the port) — is "not
  // this port". The probe is a plain GET: read-only by construction, same as
  // every other request this package makes.
  async function probe(base) {
    try {
      const data = await requestJson(`${base}/api/sessions`, { fetchImpl, timeoutMs: probeTimeoutMs });
      return Array.isArray(data);
    } catch {
      return false;
    }
  }

  // Read ports.json, skipping entries whose pid is dead (prune-on-read).
  // Freshest startedAt first. Best-effort: any read/parse trouble → [].
  function stateCandidates() {
    let raw;
    try {
      raw = fsImpl.readFileSync(portsPath, 'utf8');
    } catch {
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const decks = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.decks) ? parsed.decks : [];
    return decks
      .filter((d) => d && Number.isInteger(d.port) && d.port > 0 && d.port < 65536)
      .filter((d) => isPidAlive(d.pid))
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  }

  async function resolve() {
    const explicit = explicitBase();
    if (explicit) return explicit;

    if (cached && now() - cached.at < ttlMs) return cached.base;

    // (2b) runtime state file — trusted only after a live probe.
    for (const deck of stateCandidates()) {
      const base = `http://127.0.0.1:${deck.port}`;
      if (await probe(base)) {
        cached = { base, at: now() };
        return base;
      }
    }

    // (2c) fixed probe list.
    for (const port of probePorts) {
      const base = `http://127.0.0.1:${port}`;
      if (await probe(base)) {
        cached = { base, at: now() };
        return base;
      }
    }

    // Nothing answered. Return the historical default UNCACHED so the
    // caller's error names a concrete URL and the very next call re-resolves.
    return DEFAULT_BASE;
  }

  function reportFailure() {
    cached = null;
  }

  return { resolve, reportFailure };
}

module.exports = {
  createBaseResolver,
  DEFAULT_BASE,
  PROBE_PORTS,
  defaultPortsPath,
  // exported for direct unit coverage
  _defaultIsPidAlive: defaultIsPidAlive,
};

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TermDeck state client — READ-ONLY wrapper over the local TermDeck HTTP API.
//
// READ PATHS ONLY. This module exposes NO write surface: there is no method that
// hits POST /api/sessions/:id/input, /poke, /resize, /upload, PATCH, or DELETE.
// Read-only is enforced here by construction (a reviewer can confirm by grep:
// every call below is an HTTP GET). The tools layer further allowlists which
// fields of these responses ever reach a consumer chat.
//
// BASE URL: an explicit base (injected baseUrl, or TERMDECK_API_BASE /
// TERMDECK_BASE_URL env) pins the client, exactly as before. With NO explicit
// base the client no longer assumes :3000 — it resolves the live deck via
// ./termdeck-base (~/.termdeck/ports.json state file, then a fixed port
// probe), caches the answer ~60s, and re-resolves after transport failures so
// a deck restart on a different port heals itself. See termdeck-base.js for
// the full resolution-order contract.
//
// Endpoint shapes (verified against packages/server/src/index.js):
//   GET /api/sessions               → [ { id, pid, meta } ]  (exited excluded
//                                       unless ?includeExited=true)
//   GET /api/sessions/:id           → { id, pid, meta }
//   GET /api/sessions/:id/buffer    → { ok, pid, inputBufferLength,
//                                       inputBufferPreview, lastActivity, status,
//                                       statusDetail, replyCount }
//                                       (INPUT box + status — NOT terminal output)
//   GET /api/transcripts/:id        → { content, lines, chunks }  (terminal OUTPUT)
//   GET /api/transcripts/recent    → { sessions: [ { session_id, chunks } ] }
// ─────────────────────────────────────────────────────────────────────────────

const { requestJson } = require('./http');
const { createBaseResolver, DEFAULT_BASE } = require('./termdeck-base');

function createTermdeckClient(opts = {}) {
  const env = opts.env || process.env;
  // Explicit base (injected or env) → legacy static behavior, never probed.
  const explicit = opts.baseUrl || env.TERMDECK_API_BASE || env.TERMDECK_BASE_URL;
  const staticBase = explicit ? String(explicit).replace(/\/+$/, '') : null;
  // No explicit base → resolve the live deck dynamically (state file → probe).
  const resolver = staticBase
    ? null
    : opts.baseResolver
      || createBaseResolver({ env, fetchImpl: opts.fetchImpl, ...(opts.resolverOptions || {}) });
  const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 5000 };

  const enc = (id) => encodeURIComponent(String(id));

  // GET wrapper. Dynamic mode resolves the base per call (cached inside the
  // resolver); on a TRANSPORT failure (no .status — refused / timed out, i.e.
  // the deck moved or died) it drops the resolver cache, re-resolves, and
  // retries ONCE iff the base actually moved. HTTP-level errors (.status set)
  // pass through untouched — the deck answered; that is not a routing problem.
  async function tdGet(pathAndQuery) {
    if (staticBase) return requestJson(`${staticBase}${pathAndQuery}`, reqOpts);
    const base = await resolver.resolve();
    try {
      return await requestJson(`${base}${pathAndQuery}`, reqOpts);
    } catch (err) {
      if (err && err.status != null) throw err;
      resolver.reportFailure();
      const fresh = await resolver.resolve();
      if (fresh && fresh !== base) return requestJson(`${fresh}${pathAndQuery}`, reqOpts);
      throw err;
    }
  }

  return {
    // Static pin, or null in dynamic mode (the live base can vary per call).
    baseUrl: staticBase,

    async listSessions({ includeExited = false } = {}) {
      const data = await tdGet(`/api/sessions${includeExited ? '?includeExited=true' : ''}`);
      return Array.isArray(data) ? data : [];
    },

    async getSession(id) {
      return tdGet(`/api/sessions/${enc(id)}`);
    },

    async getBuffer(id) {
      return tdGet(`/api/sessions/${enc(id)}/buffer`);
    },

    async getTranscript(id, { limit, since } = {}) {
      const qs = new URLSearchParams();
      if (limit != null) qs.set('limit', String(limit));
      if (since != null) qs.set('since', String(since));
      const q = qs.toString();
      return tdGet(`/api/transcripts/${enc(id)}${q ? `?${q}` : ''}`);
    },

    async getRecentTranscripts({ minutes, limit } = {}) {
      const qs = new URLSearchParams();
      if (minutes != null) qs.set('minutes', String(minutes));
      if (limit != null) qs.set('limit', String(limit));
      const q = qs.toString();
      const data = await tdGet(`/api/transcripts/recent${q ? `?${q}` : ''}`);
      return data && Array.isArray(data.sessions) ? data.sessions : [];
    },
  };
}

module.exports = { createTermdeckClient, DEFAULT_TERMDECK_BASE: DEFAULT_BASE };

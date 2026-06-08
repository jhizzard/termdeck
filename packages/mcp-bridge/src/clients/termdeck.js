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
// Endpoint shapes (verified against packages/server/src/index.js):
//   GET /api/sessions               → [ { id, pid, meta } ]  (exited excluded
//                                       unless ?includeExited=true)
//   GET /api/sessions/:id           → { id, pid, meta }
//   GET /api/sessions/:id/buffer    → { ok, pid, inputBufferLength,
//                                       inputBufferPreview, lastActivity, status,
//                                       statusDetail, replyCount }
//                                       (INPUT box + status — NOT terminal output)
//   GET /api/transcripts/:id        → { content, lines, chunks }  (terminal OUTPUT)
//   GET /api/transcripts/recent     → { sessions: [ { session_id, chunks } ] }
// ─────────────────────────────────────────────────────────────────────────────

const { requestJson } = require('./http');

const DEFAULT_BASE = 'http://127.0.0.1:3000';

function createTermdeckClient(opts = {}) {
  const env = opts.env || process.env;
  const baseUrl = String(opts.baseUrl || env.TERMDECK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 5000 };

  const enc = (id) => encodeURIComponent(String(id));

  return {
    baseUrl,

    async listSessions({ includeExited = false } = {}) {
      const url = `${baseUrl}/api/sessions${includeExited ? '?includeExited=true' : ''}`;
      const data = await requestJson(url, reqOpts);
      return Array.isArray(data) ? data : [];
    },

    async getSession(id) {
      return requestJson(`${baseUrl}/api/sessions/${enc(id)}`, reqOpts);
    },

    async getBuffer(id) {
      return requestJson(`${baseUrl}/api/sessions/${enc(id)}/buffer`, reqOpts);
    },

    async getTranscript(id, { limit, since } = {}) {
      const qs = new URLSearchParams();
      if (limit != null) qs.set('limit', String(limit));
      if (since != null) qs.set('since', String(since));
      const q = qs.toString();
      return requestJson(`${baseUrl}/api/transcripts/${enc(id)}${q ? `?${q}` : ''}`, reqOpts);
    },

    async getRecentTranscripts({ minutes, limit } = {}) {
      const qs = new URLSearchParams();
      if (minutes != null) qs.set('minutes', String(minutes));
      if (limit != null) qs.set('limit', String(limit));
      const q = qs.toString();
      const data = await requestJson(`${baseUrl}/api/transcripts/recent${q ? `?${q}` : ''}`, reqOpts);
      return data && Array.isArray(data.sessions) ? data.sessions : [];
    },
  };
}

module.exports = { createTermdeckClient, DEFAULT_TERMDECK_BASE: DEFAULT_BASE };

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mnestra client — READ-ONLY wrapper over the Mnestra webhook server.
//
// Transport: POST ${MNESTRA_WEBHOOK_URL | http://localhost:37778/mnestra} with
//   { op, ...args }. The webhook supports remember/recall/search/status/index/
//   timeline/get; this client ONLY ever emits the READ ops 'recall', 'search',
//   'status'. There is deliberately NO generic `post(op)` exported and NO write
//   op (no 'remember' / 'forget'), so the Bridge is read-only-by-construction.
//
// We mirror the proven `packages/server/src/mnestra-bridge/index.js` queryWebhook
// path rather than importing that 318-line bridge — it additionally carries a
// `direct` mode (OpenAI key in-process) and an `mcp` mode (child-process spawn),
// capabilities we keep OUT of the egress-sensitive Bridge process on purpose.
//
// Each returned row is projected to a bounded allowlist of fields (normalizeRow)
// so the SHAPE of what egresses is fixed here, before redaction runs downstream.
// ─────────────────────────────────────────────────────────────────────────────

const { requestJson } = require('./http');

const DEFAULT_WEBHOOK = 'http://localhost:37778/mnestra';

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function normalizeRow(m) {
  if (!m || typeof m !== 'object') return { content: m == null ? '' : String(m) };
  return {
    content: m.content,
    source_type: m.source_type,
    project: m.project,
    similarity: m.similarity != null ? m.similarity : (m.score != null ? m.score : null),
    created_at: m.created_at,
  };
}

function createMnestraClient(opts = {}) {
  const env = opts.env || process.env;
  const webhookUrl = String(opts.webhookUrl || env.MNESTRA_WEBHOOK_URL || DEFAULT_WEBHOOK);
  const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 8000 };

  // Internal — the ONLY way this module talks to Mnestra. `op` is always one of
  // the three read ops below; callers cannot inject an arbitrary op.
  async function readOp(op, args) {
    const body = await requestJson(webhookUrl, { method: 'POST', body: { op, ...args }, ...reqOpts });
    return body || {};
  }

  return {
    webhookUrl,

    async recall({ query, project, minResults } = {}) {
      if (!query || !String(query).trim()) throw new Error('memory_recall requires a non-empty query');
      const data = await readOp('recall', {
        question: String(query),
        project: project || null,
        min_results: clampInt(minResults, 5, 1, 25),
      });
      // The Mnestra webhook `recall` op returns rows under `hits` (RAG shape:
      // { ok, hits, text, tokens_used }) — NOT `memories`. Read `hits` first and
      // fall back to `memories` for forward/back-compat (mirrors search()).
      // Until 2026-06-08 this read `data.memories` only, so recall returned empty
      // end-to-end; the mocked unit test asserted a `{memories:[...]}` shape the
      // live webhook never emits, hiding it until the live connector smoke test.
      const rows = Array.isArray(data.hits)
        ? data.hits
        : (Array.isArray(data.memories) ? data.memories : []);
      return { memories: rows.map(normalizeRow), total: rows.length };
    },

    async search({ query, project, sourceType, category, minResults } = {}) {
      if (!query || !String(query).trim()) throw new Error('memory_search requires a non-empty query');
      const data = await readOp('search', {
        query: String(query),
        project: project || null,
        source_type: sourceType || null,
        category: category || null,
        min_results: clampInt(minResults, 10, 1, 25),
      });
      const rows = Array.isArray(data.hits)
        ? data.hits
        : (Array.isArray(data.memories) ? data.memories : []);
      return { hits: rows.map(normalizeRow), total: rows.length };
    },

    async status() {
      return readOp('status', {});
    },
  };
}

module.exports = { createMnestraClient, DEFAULT_MNESTRA_WEBHOOK: DEFAULT_WEBHOOK, _normalizeRow: normalizeRow };

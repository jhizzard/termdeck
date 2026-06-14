'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mnestra client — wrapper over the Mnestra webhook server.
//
// Transport: POST ${MNESTRA_WEBHOOK_URL | http://localhost:37778/mnestra} with
//   { op, ...args }. The webhook supports remember/recall/search/status/index/
//   timeline/get/propose; this client emits the READ ops 'recall', 'search',
//   'status' — plus, since Sprint 76, exactly ONE write op: 'propose', which
//   appends to engram's QUARANTINED memory_inbox (status='pending', invisible
//   to every recall path until Rumen promotes it). There is deliberately NO
//   generic `post(op)` exported and NO canonical-write op (no 'remember' /
//   no 'forget' — those names cannot even mount past policy.assertReadOnly),
//   so the Bridge stays read-only-plus-one-quarantined-proposal-channel by
//   construction.
//
// We mirror the proven `packages/server/src/mnestra-bridge/index.js` queryWebhook
// path rather than importing that 318-line bridge — it additionally carries a
// `direct` mode (OpenAI key in-process) and an `mcp` mode (child-process spawn),
// capabilities we keep OUT of the egress-sensitive Bridge process on purpose.
//
// Each returned row is projected to a bounded allowlist of fields (normalizeRow
// for reads; { id, status } only for propose — never the full inbox row back)
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

  // The Mnestra webhook (mnestra ≥ 0.7.0) is fail-CLOSED: every op except
  // /healthz is rejected 401 unless the caller presents the shared secret. We
  // read it from the same source the webhook does — MNESTRA_WEBHOOK_SECRET,
  // sourced into this process's env from ~/.termdeck/secrets.env by the
  // launcher — and attach it as `x-mnestra-secret` on every request.
  // Backward-compatible by construction: no secret configured ⇒ no header ⇒
  // unchanged behavior against a pre-0.7.0 ungated webhook. The secret is a
  // HEADER only — never in a request body, a returned row, or (since requestJson
  // logs only status + the server's { error } reason) a log line.
  const secret = opts.secret != null ? String(opts.secret) : (env.MNESTRA_WEBHOOK_SECRET || '');
  const authHeaders = secret ? { 'x-mnestra-secret': secret } : undefined;
  const reqOpts = { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs || 8000, headers: authHeaders };

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

    // The ONE write op (Sprint 76): submit a proposal to the quarantined
    // memory_inbox via the webhook 'propose' op (engram T1 contract:
    // { op:'propose', source_agent, text, project_hint?, metadata? } →
    // 200 { ok, id, status:'pending' } | 400 { ok:false, error }).
    // `op` is hardcoded — this is NOT a generic post(op), and no other write
    // op exists on this client. sourceAgent arrives server-derived from the
    // tool layer (never caller-supplied). Webhook 400s are rethrown with the
    // webhook's reason so the connector sees WHY a proposal was refused.
    async propose({ sourceAgent, text, projectHint, metadata } = {}) {
      if (!sourceAgent || !String(sourceAgent).trim()) {
        throw new Error('memory_propose requires a resolved source agent');
      }
      if (!text || !String(text).trim()) {
        throw new Error('memory_propose requires non-empty text');
      }
      const args = { source_agent: String(sourceAgent), text: String(text) };
      if (projectHint != null && String(projectHint).trim()) args.project_hint = String(projectHint);
      if (metadata != null) args.metadata = metadata;
      let body;
      try {
        body = await requestJson(webhookUrl, { method: 'POST', body: { op: 'propose', ...args }, ...reqOpts });
      } catch (err) {
        if (err && err.status === 400) {
          // requestJson already folded the webhook's { error } reason into the
          // message — reframe it as a refusal so the connector can relay why.
          throw new Error(`proposal refused by the memory inbox: ${err.message}`);
        }
        throw err;
      }
      if (!body || body.ok !== true || !body.id) {
        throw new Error('memory inbox returned an unexpected propose response');
      }
      // Bounded projection — id + status only, never the full row back.
      return { id: String(body.id), status: body.status ? String(body.status) : 'pending' };
    },
  };
}

module.exports = { createMnestraClient, DEFAULT_MNESTRA_WEBHOOK: DEFAULT_WEBHOOK, _normalizeRow: normalizeRow };

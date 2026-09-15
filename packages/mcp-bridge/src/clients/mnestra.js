'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Mnestra client — wrapper over the Mnestra webhook server.
//
// Transport: POST ${MNESTRA_WEBHOOK_URL | http://localhost:37778/mnestra} with
//   { op, ...args }. The webhook supports remember/recall/search/status/index/
//   timeline/get/propose/session_record; this client emits the READ ops
//   'recall', 'search', 'status' — plus exactly TWO write ops, both landing in
//   a table no recall path reads:
//     'propose'        (Sprint 76) → memory_inbox, status='pending', invisible
//                                    until Rumen promotes it.
//     'session_record' (Sprint 84) → memory_sessions, the Rumen tick's input
//                                    queue; its synthesis pass is the gate.
//   There is deliberately NO generic `post(op)` exported and NO canonical-write
//   op (no 'remember' / no 'forget' — those names cannot even mount past
//   policy.assertReadOnly), so the Bridge stays read-only-plus-quarantined-
//   writes by construction.
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
  // the read ops below (recall/search/status/propose_status/inbox_staleness);
  // callers cannot inject an arbitrary op.
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

    // ── write-VISIBILITY reads (Sprint 86) ───────────────────────────────────
    // A proposal is fire-and-forget by design: it lands in quarantine and an
    // asynchronous pass promotes or rejects it later. Until now the proposer
    // had no way to learn WHICH — so a rejected proposal was indistinguishable
    // from a working one, and the whole channel could sit dead for weeks
    // without anyone noticing. These two ops close that blind spot. Both are
    // READS (no argument mutates anything) and both tolerate an older webhook.

    // propose_status: one proposal's disposition.
    //   request  { op:'propose_status', id }   ('proposal_id' is accepted as an
    //                                           alias by the store; we send the
    //                                           canonical `id`)
    //   200 known   { ok:true, found:true,  id, status, rejection_reason,
    //                 promoted_memory_id, proposed_at, detail }
    //   200 unknown { ok:true, found:false, id, status:null, detail }
    //   400 malformed id · 501 pre-0.14.0 build
    //
    // UNKNOWN IS A 200, NOT A 404. That matters: `found:false` must render as
    // "unknown", never as "pending". Reporting an aged-out or mistyped id as
    // still-queued would tell the user their memory is on its way when nothing
    // is on its way — the exact false-reassurance this whole channel exists to
    // remove. So `found` is carried through explicitly rather than inferred
    // from a missing status.
    async proposeStatus({ proposalId } = {}) {
      if (!proposalId || !String(proposalId).trim()) {
        throw new Error('memory_propose_status requires a proposal id');
      }
      const id = String(proposalId).trim();
      let data;
      try {
        data = await readOp('propose_status', { id });
      } catch (err) {
        if (err && err.status === 404) {
          // Not the contract (unknown is a 200), but a defensive mapping so an
          // older/proxied build still reads as "unknown" rather than an outage.
          return { found: false, id, status: null, rejectionReason: null, promotedMemoryId: null, proposedAt: null, detail: null };
        }
        if (err && err.status === 501) {
          const e = new Error(
            'this Mnestra build has no propose_status op (upgrade @jhizzard/mnestra to the release carrying it)',
          );
          e.unsupported = true;
          throw e;
        }
        throw err;
      }
      const found = !!(data && data.ok !== false && data.found === true && data.status);
      // Bounded projection — never hand back the proposal TEXT. The caller
      // already sent it; echoing it would re-egress content through the
      // provider cloud for no benefit. `detail` IS passed straight through:
      // it is the store's own explanation and is what makes an unknown or a
      // rejection actionable.
      return {
        found,
        id: data && data.id != null ? String(data.id) : id,
        status: found ? String(data.status) : null,
        rejectionReason: data && data.rejection_reason != null ? String(data.rejection_reason) : null,
        promotedMemoryId: data && data.promoted_memory_id != null ? String(data.promoted_memory_id) : null,
        proposedAt: data && data.proposed_at != null ? String(data.proposed_at) : null,
        detail: data && data.detail != null ? String(data.detail) : null,
      };
    },

    // inbox_staleness: how long since anything landed in the inbox / was
    // promoted to items, per scope+agent, plus a precomputed `overall`.
    //   request { op:'inbox_staleness' }
    //   200     { ok:true, count, overall:{…}, rows:[…] }
    //   501     pre-0.14.0 build
    // Powers the /healthz `inbox` field — the tripwire for "the write path has
    // been silently dead for N days".
    //
    // A NULL stale_hours means NEVER WROTE, which is not the same as zero and
    // not the same as unknown. It is preserved as null all the way out; any
    // coercion here would turn "nothing has ever landed" into "landed just
    // now", which is the most dangerous possible misreading of this field.
    async inboxStaleness() {
      let data;
      try {
        data = await readOp('inbox_staleness', {});
      } catch (err) {
        if (err && err.status === 501) {
          const e = new Error(
            'this Mnestra build has no inbox_staleness op (upgrade @jhizzard/mnestra to the release carrying it)',
          );
          e.unsupported = true;
          throw e;
        }
        throw err;
      }
      const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      const str = (v) => (v != null ? String(v) : null);
      const row = (r) => (r && typeof r === 'object' ? {
        scope: str(r.scope),
        source_agent: str(r.source_agent),
        inbox_last_at: str(r.inbox_last_at),
        inbox_stale_hours: num(r.inbox_stale_hours),
        inbox_pending: num(r.inbox_pending),
        items_last_at: str(r.items_last_at),
        items_stale_hours: num(r.items_stale_hours),
      } : null);

      const rows = Array.isArray(data.rows) ? data.rows : [];
      return {
        count: num(data.count),
        // The store precomputes `overall`; fall back to finding it among rows
        // so a build that only ships `rows` still powers /healthz.
        overall: row(data.overall)
          || row(rows.find((r) => r && String(r.scope || '').toLowerCase() === 'overall'))
          || null,
        rows: rows.map(row).filter(Boolean),
      };
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

    // The SECOND (and, as of Sprint 84, last) write op: end-of-conversation
    // capture for web surfaces, via the webhook 'session_record' op (mnestra
    // contract: { op:'session_record', source_agent, conversation_key, summary,
    // project?, messages_count?, started_at?, ended_at?, topics?, metadata? } →
    // 200 { ok, id, session_id } | 400 { ok:false, error } | 501 when the
    // Mnestra build predates the op).
    //
    // It writes memory_sessions, which no recall path reads — it is the Rumen
    // tick's input queue, and that tick's synthesis pass is the gate. Like
    // propose: `op` is hardcoded, sourceAgent arrives server-derived from the
    // tool layer, and there is deliberately NO session_id argument — Mnestra
    // mints it as web:<agent>:<key> so this surface cannot address a
    // CLI-written session row.
    async sessionRecord({
      sourceAgent, conversationKey, summary,
      project, messagesCount, startedAt, endedAt, topics, metadata,
    } = {}) {
      if (!sourceAgent || !String(sourceAgent).trim()) {
        throw new Error('memory_session_record requires a resolved source agent');
      }
      if (!conversationKey || !String(conversationKey).trim()) {
        throw new Error('memory_session_record requires a conversation key');
      }
      if (!summary || !String(summary).trim()) {
        throw new Error('memory_session_record requires a non-empty summary');
      }
      const args = {
        source_agent: String(sourceAgent),
        conversation_key: String(conversationKey),
        summary: String(summary),
      };
      if (project != null && String(project).trim()) args.project = String(project);
      if (Number.isFinite(messagesCount)) args.messages_count = Math.trunc(messagesCount);
      if (startedAt != null) args.started_at = String(startedAt);
      if (endedAt != null) args.ended_at = String(endedAt);
      if (Array.isArray(topics)) args.topics = topics;
      if (metadata != null) args.metadata = metadata;
      let body;
      try {
        body = await requestJson(webhookUrl, { method: 'POST', body: { op: 'session_record', ...args }, ...reqOpts });
      } catch (err) {
        if (err && err.status === 400) {
          throw new Error(`session record refused: ${err.message}`);
        }
        if (err && err.status === 501) {
          // Old Mnestra behind the webhook. Say so plainly — the alternative
          // (a generic 5xx) reads as a transient failure worth retrying.
          throw new Error(
            'this Mnestra build has no session_record op (upgrade @jhizzard/mnestra to the release carrying migration 035)',
          );
        }
        throw err;
      }
      if (!body || body.ok !== true || !body.id) {
        throw new Error('memory store returned an unexpected session_record response');
      }
      // Bounded projection — the row id + the minted key only.
      return { id: String(body.id), sessionId: body.session_id ? String(body.session_id) : null };
    },
  };
}

module.exports = { createMnestraClient, DEFAULT_MNESTRA_WEBHOOK: DEFAULT_WEBHOOK, _normalizeRow: normalizeRow };
